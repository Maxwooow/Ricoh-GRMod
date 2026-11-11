package io.github.maxwooow.grmod.push;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;
import android.view.WindowManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * The page's way to the camera: Bluetooth scan, the firmware file, and a {@link PushSession}.
 *
 * Events: "found" (a camera seen while scanning), "stage", "progress", "log", "finished".
 */
@SuppressLint("MissingPermission")
@CapacitorPlugin(
        name = "GrCamera",
        permissions = {
                @Permission(alias = "bluetooth", strings = {Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT}),
                @Permission(alias = "location", strings = {Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION}),
                @Permission(alias = "nearby", strings = {Manifest.permission.NEARBY_WIFI_DEVICES})
        })
public class GrCameraPlugin extends Plugin {
    static final UUID ADV_INFO = UUID.fromString("9a5ed1c5-74cc-4c50-b5b6-66a48e7ccff1");
    static final UUID ADV_PAIRING = UUID.fromString("0f291746-0c80-4726-87a7-3c501fd3b4b6");

    private File staging;
    private FileOutputStream stagingOut;
    private File firmware;
    private PushSession session;
    private ScanCallback scanCallback;

    // ------------------------------------------------------------------ permissions

    private String[] neededAliases() {
        List<String> a = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) a.add("bluetooth");
        if (Build.VERSION.SDK_INT <= 32) a.add("location");      // BLE scan before 12, Wi-Fi requests before 13
        if (Build.VERSION.SDK_INT >= 33) a.add("nearby");
        return a.toArray(new String[0]);
    }

    private boolean granted() {
        for (String a : neededAliases()) if (getPermissionState(a) != PermissionState.GRANTED) return false;
        return true;
    }

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        if (granted()) { call.resolve(status()); return; }
        requestPermissionForAliases(neededAliases(), call, "permissionsDone");
    }

    @PermissionCallback
    private void permissionsDone(PluginCall call) {
        if (granted()) call.resolve(status());
        else call.reject("没有得到蓝牙 / 附近设备权限", "permission");
    }

    private JSObject status() {
        JSObject o = new JSObject();
        BluetoothAdapter ad = adapter();
        o.put("bluetooth", ad != null && ad.isEnabled());
        o.put("permissions", granted());
        o.put("sdk", Build.VERSION.SDK_INT);
        return o;
    }

    @PluginMethod
    public void getStatus(PluginCall call) { call.resolve(status()); }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    // ------------------------------------------------------------------ scan

    private static boolean looksLikeCamera(String name, ScanRecord rec) {
        if (name != null && (name.startsWith("GR_") || name.toUpperCase(Locale.ROOT).contains("RICOH"))) return true;
        if (rec != null && rec.getServiceUuids() != null) {
            for (ParcelUuid u : rec.getServiceUuids()) {
                if (ADV_INFO.equals(u.getUuid()) || ADV_PAIRING.equals(u.getUuid())) return true;
            }
        }
        return false;
    }

    private static JSObject deviceJson(BluetoothDevice d, String name, int rssi) {
        JSObject o = new JSObject();
        o.put("address", d.getAddress());
        o.put("name", name != null ? name : d.getName());
        o.put("rssi", rssi);
        o.put("bonded", d.getBondState() == BluetoothDevice.BOND_BONDED);
        return o;
    }

    /** Cameras the phone is paired with (they may not advertise while another app is connected). */
    @PluginMethod
    public void bondedCameras(PluginCall call) {
        if (!granted()) { call.reject("先授权", "permission"); return; }
        BluetoothAdapter ad = adapter();
        JSArray list = new JSArray();
        if (ad != null) {
            for (BluetoothDevice d : ad.getBondedDevices()) {
                if (looksLikeCamera(d.getName(), null)) list.put(deviceJson(d, d.getName(), 0));
            }
        }
        JSObject r = new JSObject();
        r.put("devices", list);
        call.resolve(r);
    }

    @PluginMethod
    public void scan(final PluginCall call) {
        if (!granted()) { call.reject("先授权", "permission"); return; }
        BluetoothAdapter ad = adapter();
        if (ad == null || !ad.isEnabled()) { call.reject("蓝牙没有打开", "bluetooth-off"); return; }
        final BluetoothLeScanner sc = ad.getBluetoothLeScanner();
        if (sc == null) { call.reject("蓝牙没有打开", "bluetooth-off"); return; }
        stopScan();
        final Map<String, JSObject> found = new LinkedHashMap<>();
        scanCallback = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult r) {
                ScanRecord rec = r.getScanRecord();
                String name = rec != null && rec.getDeviceName() != null ? rec.getDeviceName() : r.getDevice().getName();
                if (!looksLikeCamera(name, rec)) return;
                JSObject o = deviceJson(r.getDevice(), name, r.getRssi());
                boolean fresh = !found.containsKey(r.getDevice().getAddress());
                found.put(r.getDevice().getAddress(), o);
                if (fresh) notifyListeners("found", o);
            }
            @Override public void onScanFailed(int code) {
                notifyListeners("log", line("蓝牙扫描失败，code=" + code, true));
            }
        };
        ScanSettings s = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        sc.startScan(null, s, scanCallback);
        long ms = call.getLong("ms", 8000L);
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            stopScan();
            JSArray list = new JSArray();
            for (JSObject o : found.values()) list.put(o);
            JSObject r = new JSObject();
            r.put("devices", list);
            call.resolve(r);
        }, ms);
    }

    private void stopScan() {
        ScanCallback cb = scanCallback;
        scanCallback = null;
        if (cb == null) return;
        BluetoothAdapter ad = adapter();
        if (ad != null && ad.getBluetoothLeScanner() != null) {
            try { ad.getBluetoothLeScanner().stopScan(cb); } catch (Exception ignored) { }
        }
    }

    // ------------------------------------------------------------------ the firmware file (sent in base64 chunks)

    private File dir(String name) {
        File d = new File(getContext().getFilesDir(), name);
        if (!d.isDirectory()) d.mkdirs();
        return d;
    }

    @PluginMethod
    public void fileBegin(PluginCall call) {
        try {
            if (stagingOut != null) stagingOut.close();
            staging = new File(dir("firmware"), "incoming.bin");
            stagingOut = new FileOutputStream(staging);
            call.resolve();
        } catch (IOException e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void fileAppend(PluginCall call) {
        try {
            if (stagingOut == null) { call.reject("fileBegin first"); return; }
            stagingOut.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (IOException | IllegalArgumentException e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void fileEnd(PluginCall call) {
        try {
            if (stagingOut == null) { call.reject("fileBegin first"); return; }
            stagingOut.close();
            stagingOut = null;
            File target = new File(dir("firmware"), "fwdc248b.bin");
            if (target.exists() && !target.delete()) throw new IOException("cannot replace " + target);
            if (!staging.renameTo(target)) throw new IOException("cannot rename " + staging);
            firmware = target;
            call.resolve(infoJson(FirmwareInfo.read(firmware)));
        } catch (IOException e) { call.reject(e.getMessage()); }
    }

    static JSObject infoJson(FirmwareInfo i) {
        JSObject o = new JSObject();
        o.put("size", i.size);
        o.put("sha256", i.sha256);
        o.put("container", i.container);
        o.put("error", i.error);
        o.put("official", i.official);
        o.put("version", i.version);
        o.put("date", i.date);
        o.put("describe", i.describe());
        JSArray m = new JSArray();
        for (FirmwareInfo.Model x : i.models) {
            JSObject r = new JSObject();
            r.put("name", x.name);
            r.put("version", x.version);
            m.put(r);
        }
        o.put("models", m);
        return o;
    }

    // ------------------------------------------------------------------ the session

    private JSObject line(String text, boolean detail) {
        JSObject o = new JSObject();
        o.put("text", text);
        o.put("detail", detail);
        return o;
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!granted()) { call.reject("先授权", "permission"); return; }
        if (session != null) { call.reject("已经有一次推送在进行", "busy"); return; }
        String address = call.getString("address");
        String modeName = call.getString("mode", "INFO");
        PushSession.Mode mode;
        try { mode = PushSession.Mode.valueOf(modeName.toUpperCase(Locale.ROOT).replace('-', '_')); }
        catch (IllegalArgumentException e) { call.reject("mode?"); return; }
        if (mode != PushSession.Mode.INFO && firmware == null) { call.reject("还没有选固件文件", "no-file"); return; }
        BluetoothAdapter ad = adapter();
        if (ad == null || !ad.isEnabled()) { call.reject("蓝牙没有打开", "bluetooth-off"); return; }
        if (address == null || !BluetoothAdapter.checkBluetoothAddress(address)) { call.reject("相机地址不对", "address"); return; }
        stopScan();
        BluetoothDevice dev = ad.getRemoteDevice(address);
        PushLog log = new PushLog(dir("logs"), (text, detail) -> notifyListeners("log", line(text, detail)));
        log.add("GR Mod Android，模式 " + mode + "，相机 " + address + "，Android " + Build.VERSION.RELEASE + " (" + Build.MODEL + ")");
        keepScreenOn(true);
        session = new PushSession(getContext(), dev, firmware, mode, log, new PushSession.Events() {
            @Override public void stage(String id, String text) {
                JSObject o = new JSObject();
                o.put("id", id);
                o.put("text", text);
                notifyListeners("stage", o);
            }
            @Override public void progress(long sent, long total) {
                JSObject o = new JSObject();
                o.put("sent", sent);
                o.put("total", total);
                notifyListeners("progress", o);
            }
            @Override public void finished(JSONObject result) {
                session = null;
                keepScreenOn(false);
                try { notifyListeners("finished", JSObject.fromJSONObject(result)); }
                catch (org.json.JSONException e) { notifyListeners("finished", new JSObject()); }
            }
        });
        session.start();
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        PushSession s = session;
        if (s != null) s.cancel();
        call.resolve();
    }

    private void keepScreenOn(boolean on) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    /** Opens Android's share sheet with a log as text (to send it by mail, chat, Drive…). */
    @PluginMethod
    public void shareLog(PluginCall call) {
        String path = call.getString("path");
        try {
            File f = new File(path == null ? "" : path);
            File logs = dir("logs");
            if (!f.getCanonicalPath().startsWith(logs.getCanonicalPath())) { call.reject("not a log"); return; }
            String text = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("text/plain");
            i.putExtra(Intent.EXTRA_SUBJECT, "GR Mod 推送日志 " + f.getName());
            i.putExtra(Intent.EXTRA_TEXT, text);
            getActivity().startActivity(Intent.createChooser(i, "发送日志"));
            call.resolve();
        } catch (IOException e) { call.reject(e.getMessage()); }
    }

    @Override
    protected void handleOnDestroy() {
        stopScan();
        PushSession s = session;
        if (s != null) s.cancel();
    }
}
