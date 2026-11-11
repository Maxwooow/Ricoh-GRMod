package io.github.maxwooow.grmod.push;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;

import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * One GATT connection to the camera, used from a single worker thread: every call blocks until the
 * camera answered (Android runs one GATT operation at a time).
 */
@SuppressLint("MissingPermission") // the plugin asks for BLUETOOTH_CONNECT / location before a session starts
public final class Ble {
    public interface Listener {
        void onNotify(UUID uuid, byte[] value);
        void onDisconnected(int status);
    }

    public static final class BleException extends Exception {
        public BleException(String m) { super(m); }
    }

    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private final Context ctx;
    private final BluetoothDevice device;
    private final Listener listener;
    private final PushLog log;
    private BluetoothGatt gatt;
    private volatile boolean connected;
    private volatile CountDownLatch connectLatch, discoverLatch, opLatch;
    private volatile int opStatus;
    private volatile byte[] opValue;

    public Ble(Context ctx, BluetoothDevice device, Listener listener, PushLog log) {
        this.ctx = ctx; this.device = device; this.listener = listener; this.log = log;
    }

    public boolean isConnected() { return connected; }
    public BluetoothDevice device() { return device; }

    private final BluetoothGattCallback cb = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            if (state == BluetoothProfile.STATE_CONNECTED) {
                connected = true;
                CountDownLatch l = connectLatch; if (l != null) l.countDown();
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                boolean was = connected;
                connected = false;
                CountDownLatch l = connectLatch; if (l != null) l.countDown();
                l = discoverLatch; if (l != null) l.countDown();
                l = opLatch; if (l != null) { opStatus = -1; l.countDown(); }
                if (was) listener.onDisconnected(status);
                else log.add("蓝牙连接失败，status=" + status);
            }
        }
        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            opStatus = status;
            CountDownLatch l = discoverLatch; if (l != null) l.countDown();
        }
        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int status) {
            done(status, value);
        }
        @SuppressWarnings("deprecation")
        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (Build.VERSION.SDK_INT < 33) done(status, c.getValue());
        }
        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            done(status, null);
        }
        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            done(status, null);
        }
        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            listener.onNotify(c.getUuid(), value);
        }
        @SuppressWarnings("deprecation")
        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            if (Build.VERSION.SDK_INT < 33) listener.onNotify(c.getUuid(), c.getValue());
        }
    };

    private void done(int status, byte[] value) {
        opStatus = status; opValue = value;
        CountDownLatch l = opLatch; if (l != null) l.countDown();
    }

    /** Connects and discovers the services. */
    public void connect(long timeoutMs) throws BleException, InterruptedException {
        close();
        connectLatch = new CountDownLatch(1);
        gatt = device.connectGatt(ctx, false, cb, BluetoothDevice.TRANSPORT_LE);
        if (gatt == null) throw new BleException("connectGatt 返回空");
        if (!connectLatch.await(timeoutMs, TimeUnit.MILLISECONDS) || !connected) {
            close();
            throw new BleException("蓝牙连不上相机");
        }
        discoverLatch = new CountDownLatch(1);
        opStatus = -1;
        if (!gatt.discoverServices()) throw new BleException("discoverServices 失败");
        if (!discoverLatch.await(15, TimeUnit.SECONDS) || !connected || opStatus != BluetoothGatt.GATT_SUCCESS) {
            throw new BleException("读不到相机的蓝牙服务（status=" + opStatus + "）");
        }
    }

    public boolean isBonded() { return device.getBondState() == BluetoothDevice.BOND_BONDED; }

    /**
     * Pairs over the current connection. The camera has to be in pairing mode; Android shows the number,
     * the camera shows the same number and the user confirms on both.
     */
    public void bond(long timeoutMs) throws BleException, InterruptedException {
        if (isBonded()) return;
        final CountDownLatch l = new CountDownLatch(1);
        final int[] last = {BluetoothDevice.BOND_NONE};
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                BluetoothDevice d = Build.VERSION.SDK_INT >= 33
                        ? i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice.class)
                        : legacyDevice(i);
                if (d == null || !d.getAddress().equals(device.getAddress())) return;
                int s = i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE);
                int prev = i.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.BOND_NONE);
                last[0] = s;
                if (s == BluetoothDevice.BOND_BONDED || (s == BluetoothDevice.BOND_NONE && prev == BluetoothDevice.BOND_BONDING)) l.countDown();
            }
        };
        IntentFilter f = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, f, Context.RECEIVER_EXPORTED);
        else ctx.registerReceiver(r, f);
        try {
            if (!device.createBond()) throw new BleException("没能开始配对");
            if (!l.await(timeoutMs, TimeUnit.MILLISECONDS)) throw new BleException("配对超时");
            if (last[0] != BluetoothDevice.BOND_BONDED) throw new BleException("配对没有成功（相机在配对状态吗？数字确认了吗？）");
        } finally {
            ctx.unregisterReceiver(r);
        }
    }

    @SuppressWarnings("deprecation")
    private static BluetoothDevice legacyDevice(Intent i) { return i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE); }

    private BluetoothGattCharacteristic find(UUID svc, UUID ch) throws BleException {
        if (gatt == null) throw new BleException("没有蓝牙连接");
        BluetoothGattService s = gatt.getService(svc);
        BluetoothGattCharacteristic c = s == null ? null : s.getCharacteristic(ch);
        if (c == null) throw new BleException("相机没有特征值 " + ch);
        return c;
    }

    private void await(String what) throws BleException, InterruptedException {
        if (!opLatch.await(10, TimeUnit.SECONDS)) throw new BleException(what + " 超时");
        if (!connected) throw new BleException(what + " 时蓝牙断开");
        if (opStatus != BluetoothGatt.GATT_SUCCESS) throw new BleException(what + " 失败（GATT 错误 0x" + Integer.toHexString(opStatus) + "）");
    }

    @SuppressWarnings("deprecation")
    public byte[] read(UUID svc, UUID ch) throws BleException, InterruptedException {
        BluetoothGattCharacteristic c = find(svc, ch);
        opLatch = new CountDownLatch(1);
        if (!gatt.readCharacteristic(c)) throw new BleException("读 " + ch + " 没能发出");
        await("读 " + short8(ch));
        return opValue == null ? new byte[0] : opValue;
    }

    @SuppressWarnings("deprecation")
    public void write(UUID svc, UUID ch, byte[] value) throws BleException, InterruptedException {
        BluetoothGattCharacteristic c = find(svc, ch);
        opLatch = new CountDownLatch(1);
        boolean sent;
        if (Build.VERSION.SDK_INT >= 33) {
            sent = gatt.writeCharacteristic(c, value, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == android.bluetooth.BluetoothStatusCodes.SUCCESS;
        } else {
            c.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            c.setValue(value);
            sent = gatt.writeCharacteristic(c);
        }
        if (!sent) throw new BleException("写 " + ch + " 没能发出");
        await("写 " + short8(ch));
    }

    @SuppressWarnings("deprecation")
    public void subscribe(UUID svc, UUID ch) throws BleException, InterruptedException {
        BluetoothGattCharacteristic c = find(svc, ch);
        if (!gatt.setCharacteristicNotification(c, true)) throw new BleException("打开通知失败 " + ch);
        BluetoothGattDescriptor d = c.getDescriptor(CCCD);
        if (d == null) return;
        byte[] v = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE;
        opLatch = new CountDownLatch(1);
        boolean sent;
        if (Build.VERSION.SDK_INT >= 33) sent = gatt.writeDescriptor(d, v) == android.bluetooth.BluetoothStatusCodes.SUCCESS;
        else { d.setValue(v); sent = gatt.writeDescriptor(d); }
        if (!sent) throw new BleException("订阅 " + ch + " 没能发出");
        await("订阅 " + short8(ch));
    }

    public void close() {
        BluetoothGatt g = gatt;
        gatt = null;
        connected = false;
        if (g != null) {
            try { g.disconnect(); } catch (Exception ignored) { }
            try { g.close(); } catch (Exception ignored) { }
        }
    }

    static String short8(UUID u) { return u.toString().substring(0, 8).toUpperCase(Locale.ROOT); }
}
