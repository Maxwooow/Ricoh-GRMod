package io.github.maxwooow.grmod.push;

import android.bluetooth.BluetoothDevice;
import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * One wireless firmware update, the way GR WORLD does it (verified on a GR IV HDF, 2026-11-11):
 *
 *  1. Bluetooth: connect (pair first if the phone is not paired: the camera must be in pairing mode),
 *     WLAN NetworkType = 1 (camera Wi-Fi on), read SSID and passphrase.
 *  2. Join the camera's access point; GET /v1/props, check model / version / battery against the file.
 *  3. Keep ws://192.168.0.1/v1/changes open; POST /v1/configs/firmware/prepare (filesize=N);
 *     PUT /v1/configs/firmware?storage=in&reboot=true with the whole file.
 *  4. The camera turns Wi-Fi and Bluetooth off and shows "waiting for update". Reconnect Bluetooth and
 *     write 01 to CameraService FirmwareUpdateStart (5F0A7BA9); the result comes in FirmwareUpdateResult
 *     (39879AAC): 1 success, 2 failure. Without the 01 the camera gives up after a few minutes and
 *     shows "processing failed", unchanged.
 *
 * Nothing is retried once the PUT has started; before that every failure ends with a cancel.
 */
@android.annotation.SuppressLint("MissingPermission")
public final class PushSession implements Runnable {
    public enum Mode { INFO, PREPARE_TEST, PUSH }

    public interface Events {
        void stage(String id, String text);
        void progress(long sent, long total);
        void finished(JSONObject result);
    }

    static final UUID WLAN = UUID.fromString("f37f568f-9071-445d-a938-5441f2e82399");
    static final UUID NETWORK_TYPE = UUID.fromString("9111cdd0-9f01-45c4-a2d4-e09e8fb0424d");
    static final UUID SSID = UUID.fromString("90638e5a-e77d-409d-b550-78f7e1ca5ab4");
    static final UUID PASSPHRASE = UUID.fromString("0f38279c-fe9e-461b-8596-81287e8c9a81");
    static final UUID CAMERA = UUID.fromString("4b445988-caa0-4dd3-941d-37b4f52aca86");
    static final UUID FW_START = UUID.fromString("5f0a7ba9-ae46-4645-abac-58ab2a1f4fe4");
    static final UUID FW_RESULT = UUID.fromString("39879aac-0af6-44b5-afbb-ca50053fa575");

    /** Refuse below this battery level (percent). GR WORLD's own limit is not known; the camera reports battery_too_low. */
    public static final int MIN_BATTERY = 50;
    static final long RESULT_WINDOW_MS = 200_000;   // GR WORLD waits 200 s for FirmwareUpdateResult
    static final long START_AFTER_UPLOAD_MS = 30_000;
    static final long START_AFTER_LINK_MS = 6_000;

    private final Context ctx;
    private final BluetoothDevice device;
    private final File file;
    private final Mode mode;
    private final Events ev;
    public final PushLog log;
    private volatile boolean cancelled;
    private volatile Integer fwResult;
    private volatile boolean bleDropped;
    private Thread thread;

    public PushSession(Context ctx, BluetoothDevice device, File file, Mode mode, PushLog log, Events ev) {
        this.ctx = ctx; this.device = device; this.file = file; this.mode = mode; this.log = log; this.ev = ev;
    }

    public void start() {
        thread = new Thread(this, "grmod-push");
        thread.start();
    }

    /** Stops before the upload; once the camera has the file there is nothing to stop. */
    public void cancel() {
        cancelled = true;
        Thread t = thread;
        if (t != null) t.interrupt();
    }

    private void check() throws InterruptedException {
        if (cancelled) throw new InterruptedException();
    }

    private static String text(byte[] b) {
        int n = 0;
        while (n < b.length && b[n] != 0) n++;
        return new String(b, 0, n, StandardCharsets.UTF_8);
    }

    // FirmwareUpdateResult 0 ("invalid") right after the start: the camera did not take it (it is only noted: the
    // wait for 1 / 2 goes on, in case 0 is also sent on the way to a success) (seen 2026-11-11 22:07
    // when the start went out 7 s after Bluetooth came back: the camera then sat on "updating" with the bar at 0
    // until it was switched off and on, unchanged).
    private volatile boolean startSent = false, fwInvalid = false;

    private final Ble.Listener bleListener = new Ble.Listener() {
        @Override public void onNotify(UUID uuid, byte[] value) {
            String hex = hex(value);
            if (FW_RESULT.equals(uuid) && value.length > 0) {
                int v = value[0] & 0xff;
                log.add("FirmwareUpdateResult: " + hex + (v == 1 ? "（成功）" : v == 2 ? "（失败）" : v == 0 ? "（invalid：相机不接受）" : ""));
                if (v == 1 || v == 2) fwResult = v;
                else if (v == 0 && startSent) fwInvalid = true;
            } else {
                log.detail("蓝牙通知 " + Ble.short8(uuid) + ": " + hex);
            }
        }
        @Override public void onDisconnected(int status) {
            bleDropped = true;
            log.detail("蓝牙断开，status=" + status);
        }
    };

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    @Override public void run() {
        JSONObject result = new JSONObject();
        Ble ble = new Ble(ctx, device, bleListener, log);
        CameraNet net = new CameraNet(ctx, log);
        CameraNet.Changes ws = null;
        boolean prepared = false, uploaded = false;
        try {
            put(result, "mode", mode.name());
            FirmwareInfo info = null;
            if (mode != Mode.INFO) {
                info = FirmwareInfo.read(file);
                log.add("固件：" + info.describe() + "，" + info.size + " 字节，SHA-256 " + info.sha256);
                if (!info.container) throw new Fail("file", info.error);
            }

            // 1. Bluetooth
            ev.stage("ble", "连接相机蓝牙…");
            connect(ble, 3);
            if (!ble.isBonded()) {
                ev.stage("pair", "配对：请确认手机和相机上显示的数字一致，并在两边都按确定");
                ble.bond(120_000);
                log.add("配对完成");
            }
            check();
            byte[] nt;
            try {
                nt = ble.read(WLAN, NETWORK_TYPE);
            } catch (Ble.BleException e) {
                log.add("读相机 Wi-Fi 状态失败：" + e.getMessage());
                throw new Fail("ble-auth", "相机不接受这台手机的蓝牙连接。如果相机里已经删掉了这台手机：在手机的蓝牙设置里对 "
                        + device.getName() + " 选「取消配对」，再让相机进入配对状态，重新推送");
            }
            if (nt.length == 0 || nt[0] != 1) {
                ble.write(WLAN, NETWORK_TYPE, new byte[]{1});
                log.add("已通过蓝牙打开相机 Wi-Fi");
                Thread.sleep(1500);
            }
            String ssid = text(ble.read(WLAN, SSID));
            String pass = text(ble.read(WLAN, PASSPHRASE));
            log.add("相机热点：" + ssid);
            check();

            // 2. Wi-Fi + checks
            boolean vpn = CameraNet.vpnActive(ctx);
            if (vpn) log.add("注意：手机正在用 VPN。如果 VPN 不允许 App 绕过，就连不上相机 Wi-Fi 里的 192.168.0.1");
            ev.stage("wifi", "连接相机 Wi-Fi「" + ssid + "」：请在系统弹窗里选择它");
            net.join(ssid, pass, 120_000);
            CameraNet.Reply props = null;
            long until = System.currentTimeMillis() + 30_000;
            while (props == null) {
                check();
                try {
                    props = net.get("/v1/props", 10_000);
                } catch (java.io.IOException e) {
                    if (CameraNet.isBindRefused(e)) {
                        log.add("Android 拒绝把连接绑到相机 Wi-Fi：" + e.getMessage());
                        throw new Fail("vpn", (vpn ? "手机上的 VPN 不允许 GR Mod 直接连相机的 Wi-Fi。" : "Android 不允许 GR Mod 直接连相机的 Wi-Fi（通常是 VPN 造成的）。")
                                + "请先关掉 VPN（或在 VPN 设置里关掉「阻止未使用 VPN 的连接」、把 GR Mod 设为不走 VPN），再重新推送");
                    }
                    if (System.currentTimeMillis() > until) throw new Fail("wifi", "连上了相机 Wi-Fi，但访问不到 192.168.0.1：" + e.getMessage());
                    Thread.sleep(1000);
                }
            }
            if (props.json == null) throw new Fail("camera", "读不到相机信息：" + props.describe());
            JSONObject p = props.json;
            JSONObject cam = new JSONObject();
            put(cam, "model", p.optString("model"));
            put(cam, "firmwareVersion", p.optString("firmwareVersion"));
            put(cam, "battery", p.optInt("battery", -1));
            put(cam, "hot", p.optBoolean("hot", false));
            put(cam, "serialNo", p.optString("serialNo"));
            put(result, "camera", cam);
            log.add("相机：" + p.optString("model") + "，固件 " + p.optString("firmwareVersion") + "，电量 " + p.optInt("battery", -1) + "%");
            if (mode == Mode.INFO) {
                put(result, "ok", true);
                ev.stage("done", "已读到相机信息");
                return;
            }

            FirmwareInfo.Model rec = info.modelFor(p.optString("model"));
            if (rec == null) throw new Fail("model", "这个固件不是给 " + p.optString("model") + " 的（文件里的机型：" + info.describe() + "）");
            String camBase = FirmwareInfo.baseOf(p.optString("firmwareVersion"));
            if (!rec.base().equals(camBase)) {
                throw new Fail("version", "相机是 " + p.optString("firmwareVersion") + "，这个固件对它来说是 " + rec.version
                        + "。目前只支持推送同一基础版本的固件（跨版本请用存储卡更新）");
            }
            int battery = p.optInt("battery", -1);
            if (battery >= 0 && battery < MIN_BATTERY) throw new Fail("battery", "相机电量 " + battery + "%，请充到 " + MIN_BATTERY + "% 以上再推送");
            if (p.optBoolean("hot", false)) throw new Fail("hot", "相机过热，请等它凉下来");
            check();

            // 3. prepare + upload
            ws = net.changes();
            ws.open();
            ev.stage("prepare", "准备上传…");
            CameraNet.Reply r = net.post("/v1/configs/firmware/prepare", "filesize=" + file.length(), 60_000);
            log.add("prepare：" + r.describe());
            if (!r.ok()) throw new Fail("prepare", "相机没有接受：" + r.describe());
            prepared = true;
            if (mode == Mode.PREPARE_TEST) {
                cancelUpdate(net);
                prepared = false;
                put(result, "ok", true);
                ev.stage("done", "prepare 被接受（已取消，没有传文件）");
                return;
            }
            check();
            ev.stage("upload", "上传固件…");
            final long[] lastShown = {0};
            long t0 = System.currentTimeMillis();
            uploaded = true;   // from here on: no cancel, no retry
            final long[] putDone = {0};
            r = net.putFile("/v1/configs/firmware?storage=in&reboot=true", file, (done, total) -> {
                long now = System.currentTimeMillis();
                if (now - lastShown[0] > 200 || done == total) { lastShown[0] = now; ev.progress(done, total); }
            }, 180_000);
            putDone[0] = System.currentTimeMillis();
            log.add("上传：" + r.describe() + "，用时 " + (putDone[0] - t0) / 1000 + " 秒");
            if (!r.ok()) {
                cancelUpdate(net);
                throw new Fail("upload", "相机没有接受这个固件：" + r.describe());
            }

            // 4. the camera drops Wi-Fi and Bluetooth, then waits for FirmwareUpdateStart
            ev.stage("waiting", "相机收到固件，正在进入「等待更新」…");
            long dropBy = System.currentTimeMillis() + 40_000;
            while (ble.isConnected() && System.currentTimeMillis() < dropBy) Thread.sleep(500);
            long wsBy = System.currentTimeMillis() + 15_000;
            while (ws.alive() && System.currentTimeMillis() < wsBy) Thread.sleep(500);
            ws.close();
            ws = null;
            net.release();
            Thread.sleep(2000);

            ev.stage("start", "重连蓝牙，发送「开始更新」…");
            long deadline = System.currentTimeMillis() + START_AFTER_UPLOAD_MS + RESULT_WINDOW_MS;
            boolean started = false, reconnected = false;
            long linkSince = 0;
            while (fwResult == null && System.currentTimeMillis() < deadline) {
                if (!ble.isConnected()) {
                    try {
                        ble.connect(15_000);
                        log.add("蓝牙已重连");
                        reconnected = true;
                        linkSince = System.currentTimeMillis();
                    } catch (Ble.BleException e) {
                        log.detail("重连失败：" + e.getMessage());
                        Thread.sleep(3000);
                        continue;
                    }
                    try { ble.subscribe(CAMERA, FW_RESULT); } catch (Ble.BleException e) { log.detail("订阅结果失败：" + e.getMessage()); }
                    if (started) {
                        try {
                            byte[] v = ble.read(CAMERA, FW_RESULT);
                            log.detail("FirmwareUpdateResult 当前值 " + hex(v));
                            if (v.length > 0 && ((v[0] & 0xff) == 1 || (v[0] & 0xff) == 2)) fwResult = v[0] & 0xff;
                        } catch (Ble.BleException e) { log.detail("读结果失败：" + e.getMessage()); }
                    }
                }
                if (!started && ble.isConnected()) {
                    if (!reconnected) {
                        // Bluetooth never dropped after the upload: subscribe on this link before starting.
                        try { ble.subscribe(CAMERA, FW_RESULT); } catch (Ble.BleException e) { log.detail("订阅结果失败：" + e.getMessage()); }
                        reconnected = true;
                        linkSince = System.currentTimeMillis();
                    }
                    // Give the camera time to settle into "waiting for update" (it is still storing the file
                    // after the upload): at least START_AFTER_UPLOAD_MS after the upload and START_AFTER_LINK_MS
                    // on the new link. It waits minutes for the start, so this costs nothing.
                    long now = System.currentTimeMillis();
                    long ready = Math.max(putDone[0] + START_AFTER_UPLOAD_MS, linkSince + START_AFTER_LINK_MS);
                    if (now < ready) {
                        log.detail("等相机准备好，" + (ready - now + 999) / 1000 + " 秒后发送「开始更新」");
                        Thread.sleep(Math.min(1000, ready - now));
                        continue;
                    }
                    try {
                        startSent = true;
                        ble.write(CAMERA, FW_START, new byte[]{1});
                        started = true;
                        put(result, "started", true);
                        log.add("已发送「开始更新」");
                        ev.stage("updating", "相机正在更新固件：不要关机、不要拔电池，等它自己重启");
                    } catch (Ble.BleException e) {
                        log.detail("发送「开始更新」失败：" + e.getMessage());
                        Thread.sleep(3000);
                        continue;
                    }
                }
                Thread.sleep(1000);
            }
            ble.close();
            if (fwInvalid && fwResult == null) {
                put(result, "ok", false);
                put(result, "reason", "start-invalid");
                ev.stage("failed", "相机回应「开始更新」无效（invalid）。看相机屏幕：如果显示处理失败或回到正常画面，固件没有变化，可以重新推送；"
                        + "如果停在「正在更新」且进度条长时间完全不动，不要拔电池，先等几分钟再长按电源键关机重开");
            } else if (fwResult != null && fwResult == 1) {
                put(result, "ok", true);
                ev.stage("done", "相机报告更新成功。等相机重启后，在设置里确认固件版本");
            } else if (fwResult != null) {
                put(result, "ok", false);
                put(result, "reason", "update-failed");
                ev.stage("failed", "相机报告更新失败。相机的固件应该没有变化；可以重新推送，或用存储卡更新");
            } else {
                put(result, "ok", false);
                put(result, "reason", started ? "no-result" : "not-started");
                ev.stage("failed", started
                        ? "已发送「开始更新」，但没收到结果。相机可能还在更新：不要关机，看相机屏幕，更新完成后它会自己重启"
                        : "没能发送「开始更新」。相机会在几分钟后显示处理失败，固件不变；可以重新推送");
            }
        } catch (Fail f) {
            put(result, "ok", false);
            put(result, "reason", f.code);
            put(result, "message", f.getMessage());
            log.add("停止：" + f.getMessage());
            if (prepared && !uploaded) cancelUpdate(net);
            ev.stage("failed", f.getMessage());
        } catch (InterruptedException e) {
            put(result, "ok", false);
            put(result, "reason", "cancelled");
            log.add("已取消");
            if (prepared && !uploaded) cancelUpdate(net);
            ev.stage("failed", uploaded ? "已停止等待；相机可能还在处理，看相机屏幕" : "已取消");
        } catch (Exception e) {
            put(result, "ok", false);
            put(result, "reason", "error");
            put(result, "message", String.valueOf(e.getMessage()));
            log.add("出错：" + e);
            if (prepared && !uploaded) cancelUpdate(net);
            ev.stage("failed", uploaded
                    ? "上传期间出错（" + e.getMessage() + "）。不要马上重试：先看相机屏幕"
                    : "出错：" + e.getMessage());
        } finally {
            if (ws != null) ws.close();
            net.release();
            ble.close();
            put(result, "log", log.file == null ? null : log.file.getAbsolutePath());
            log.close();
            ev.finished(result);
        }
    }

    private void connect(Ble ble, int tries) throws Exception {
        Exception last = null;
        for (int i = 0; i < tries; i++) {
            check();
            try { ble.connect(15_000); return; } catch (Ble.BleException e) { last = e; log.detail("蓝牙连接第 " + (i + 1) + " 次失败：" + e.getMessage()); Thread.sleep(2000); }
        }
        throw new Fail("ble", "蓝牙连不上相机：相机开着吗？手机上的 GR WORLD 关掉了吗？（" + (last == null ? "" : last.getMessage()) + "）");
    }

    private void cancelUpdate(CameraNet net) {
        try {
            CameraNet.Reply r = net.post("/v1/configs/firmware/cancel", "", 30_000);
            log.add("cancel：" + r.describe());
        } catch (Exception e) {
            log.add("cancel 失败：" + e.getMessage());
        }
    }

    static final class Fail extends Exception {
        final String code;
        Fail(String code, String m) { super(m); this.code = code; }
    }

    static void put(JSONObject o, String k, Object v) {
        try { o.put(k, v == null ? JSONObject.NULL : v); } catch (JSONException ignored) { }
    }
}
