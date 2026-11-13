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
                log.add("FirmwareUpdateResult: " + hex + (v == 1 ? L.s("（成功）", " (success)") : v == 2 ? L.s("（失败）", " (failure)") : v == 0 ? L.s("（invalid：照相机未接受）", " (invalid: the camera did not take it)") : ""));
                if (v == 1 || v == 2) fwResult = v;
                else if (v == 0 && startSent) fwInvalid = true;
            } else {
                log.detail(L.s("Bluetooth® 通知 ", "Bluetooth notification ") + Ble.short8(uuid) + ": " + hex);
            }
        }
        @Override public void onDisconnected(int status) {
            bleDropped = true;
            log.detail(L.s("Bluetooth® 断开，status=", "Bluetooth dropped, status=") + status);
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
                log.add(L.s("固件：", "Firmware: ") + info.describe() + L.s("，", ", ") + info.size + L.s(" 字节，SHA-256 ", " bytes, SHA-256 ") + info.sha256);
                if (!info.container) throw new Fail("file", info.error);
            }

            // 1. Bluetooth
            ev.stage("ble", L.s("正在通过 Bluetooth® 连接照相机…", "Connecting to the camera over Bluetooth…"));
            connect(ble, 3);
            if (!ble.isBonded()) {
                ev.stage("pair", L.s("配对：请确认设备与照相机显示的验证码一致，并在两端确认。", "Pairing: check that the device and the camera show the same number, and confirm on both"));
                ble.bond(120_000);
                log.add(L.s("配对完成", "Paired"));
            }
            check();
            byte[] nt;
            try {
                nt = ble.read(WLAN, NETWORK_TYPE);
            } catch (Ble.BleException e) {
                log.add(L.s("读取照相机无线局域网状态失败：", "Reading the camera's Wi-Fi state failed: ") + e.getMessage());
                throw new Fail("ble-auth", L.s("照相机不接受此设备的 Bluetooth® 连接。若已在照相机中删除此设备，请在设备的 Bluetooth® 设定中对 "
                        + device.getName() + " 选择[取消配对]，再将照相机设为配对状态并重新推送。",
                        "The camera does not accept this device over Bluetooth. If the device was removed in the camera: unpair "
                        + device.getName() + " in the device's Bluetooth settings, put the camera in pairing mode and send again"));
            }
            if (nt.length == 0 || nt[0] != 1) {
                ble.write(WLAN, NETWORK_TYPE, new byte[]{1});
                log.add(L.s("已通过 Bluetooth® 开启照相机无线局域网", "Camera Wi-Fi turned on over Bluetooth"));
                Thread.sleep(1500);
            }
            String ssid = text(ble.read(WLAN, SSID));
            String pass = text(ble.read(WLAN, PASSPHRASE));
            log.add(L.s("照相机热点：", "Camera network: ") + ssid);
            check();

            // 2. Wi-Fi + checks
            boolean vpn = CameraNet.vpnActive(ctx);
            if (vpn) log.add(L.s("注意：设备正在使用 VPN。若 VPN 不允许应用程序绕过，则无法连接照相机无线局域网中的 192.168.0.1", "Note: a VPN is on. If it does not let apps bypass it, 192.168.0.1 on the camera's Wi-Fi cannot be reached"));
            ev.stage("wifi", L.s("正在连接照相机的无线局域网[" + ssid + "]。若 1 分钟后仍无响应，请在系统的无线局域网设定中手动添加。", "Connecting to the camera's Wi-Fi “" + ssid + "”; if nothing happens within a minute, add it on the system's Wi-Fi page"));
            net.join(ssid, pass, 120_000);
            CameraNet.Reply props = null;
            long until = System.currentTimeMillis() + 30_000;
            while (props == null) {
                check();
                try {
                    props = net.get("/v1/props", 10_000);
                } catch (java.io.IOException e) {
                    if (CameraNet.isBindRefused(e)) {
                        log.add(L.s("Android 拒绝将连接绑定至照相机无线局域网：", "Android refused to bind the connection to the camera's Wi-Fi: ") + e.getMessage());
                        throw new Fail("vpn", L.s((vpn ? "设备上的 VPN 不允许 GR Mod 直接连接照相机的无线局域网。" : "Android 不允许 GR Mod 直接连接照相机的无线局域网，通常由 VPN 导致。")
                                + "请关闭 VPN，或在 VPN 设定中关闭[阻止未使用 VPN 的连接]。",
                                (vpn ? "The VPN on the device does not let GR Mod reach the camera's Wi-Fi directly. " : "Android does not let GR Mod reach the camera's Wi-Fi directly (usually because of a VPN). ")
                                + "Switch the VPN off first (or turn off \"Block connections without VPN\" in its settings)"));
                    }
                    if (System.currentTimeMillis() > until) throw new Fail("wifi", L.s("已连接照相机的无线局域网，但无法访问 192.168.0.1：", "On the camera's Wi-Fi, but 192.168.0.1 cannot be reached: ") + e.getMessage());
                    Thread.sleep(1000);
                }
            }
            if (props.json == null) throw new Fail("camera", L.s("无法读取照相机信息：", "Cannot read the camera's details: ") + props.describe());
            JSONObject p = props.json;
            JSONObject cam = new JSONObject();
            put(cam, "model", p.optString("model"));
            put(cam, "firmwareVersion", p.optString("firmwareVersion"));
            put(cam, "battery", p.optInt("battery", -1));
            put(cam, "hot", p.optBoolean("hot", false));
            put(cam, "serialNo", p.optString("serialNo"));
            put(result, "camera", cam);
            log.add(L.s("照相机：", "Camera: ") + p.optString("model") + L.s("，固件 ", ", firmware ") + p.optString("firmwareVersion") + L.s("，电池电量 ", ", battery ") + p.optInt("battery", -1) + "%");
            if (mode == Mode.INFO) {
                put(result, "ok", true);
                ev.stage("done", L.s("已读取照相机信息", "Camera details read"));
                return;
            }

            FirmwareInfo.Model rec = info.modelFor(p.optString("model"));
            if (rec == null) throw new Fail("model", L.s("此固件不适用于 " + p.optString("model") + "（文件中的机型：" + info.describe() + "）", "This firmware is not for the " + p.optString("model") + " (models in the file: " + info.describe() + ")"));
            String camBase = FirmwareInfo.baseOf(p.optString("firmwareVersion"));
            if (!rec.base().equals(camBase)) {
                throw new Fail("version", L.s("照相机当前版本为 " + p.optString("firmwareVersion") + "，此固件对应版本为 " + rec.version
                        + "。目前仅支持推送同一基础版本的固件；跨版本时，请使用存储卡更新。",
                        "The camera runs " + p.optString("firmwareVersion") + "; for it this firmware is " + rec.version
                        + ". Only a firmware of the same base version can be sent (across versions, update from a memory card)"));
            }
            int battery = p.optInt("battery", -1);
            if (battery >= 0 && battery < MIN_BATTERY) throw new Fail("battery", L.s("照相机电池电量为 " + battery + "%。请充电至 " + MIN_BATTERY + "% 以上后再推送。", "The camera's battery is at " + battery + "%: charge it above " + MIN_BATTERY + "% first"));
            if (p.optBoolean("hot", false)) throw new Fail("hot", L.s("照相机过热，请等待其冷却。", "The camera is too hot: let it cool down"));
            check();

            // 3. prepare + upload
            ws = net.changes();
            ws.open();
            ev.stage("prepare", L.s("正在准备上传…", "Preparing the upload…"));
            CameraNet.Reply r = net.post("/v1/configs/firmware/prepare", "filesize=" + file.length(), 60_000);
            log.add(L.s("prepare：", "prepare: ") + r.describe());
            if (!r.ok()) throw new Fail("prepare", L.s("照相机未接受：", "The camera did not accept it: ") + r.describe());
            prepared = true;
            if (mode == Mode.PREPARE_TEST) {
                cancelUpdate(net);
                prepared = false;
                put(result, "ok", true);
                ev.stage("done", L.s("prepare 已接受（已取消，未传输文件）", "prepare accepted (cancelled, no file sent)"));
                return;
            }
            check();
            ev.stage("upload", L.s("正在上传固件…", "Uploading the firmware…"));
            final long[] lastShown = {0};
            long t0 = System.currentTimeMillis();
            uploaded = true;   // from here on: no cancel, no retry
            final long[] putDone = {0};
            r = net.putFile("/v1/configs/firmware?storage=in&reboot=true", file, (done, total) -> {
                long now = System.currentTimeMillis();
                if (now - lastShown[0] > 200 || done == total) { lastShown[0] = now; ev.progress(done, total); }
            }, 180_000);
            putDone[0] = System.currentTimeMillis();
            log.add(L.s("上传：", "Upload: ") + r.describe() + L.s("，耗时 ", ", ") + (putDone[0] - t0) / 1000 + L.s(" 秒", " s"));
            if (!r.ok()) {
                cancelUpdate(net);
                throw new Fail("upload", L.s("照相机未接受此固件：", "The camera did not accept this firmware: ") + r.describe());
            }

            // 4. the camera drops Wi-Fi and Bluetooth, then waits for FirmwareUpdateStart
            ev.stage("waiting", L.s("照相机已接收固件，正在准备更新…", "The camera has the firmware and is getting ready to update…"));
            long dropBy = System.currentTimeMillis() + 40_000;
            while (ble.isConnected() && System.currentTimeMillis() < dropBy) Thread.sleep(500);
            long wsBy = System.currentTimeMillis() + 15_000;
            while (ws.alive() && System.currentTimeMillis() < wsBy) Thread.sleep(500);
            ws.close();
            ws = null;
            net.release();
            Thread.sleep(2000);

            ev.stage("start", L.s("正在开始更新…", "Starting the update…"));
            long deadline = System.currentTimeMillis() + START_AFTER_UPLOAD_MS + RESULT_WINDOW_MS;
            boolean started = false, reconnected = false;
            long linkSince = 0;
            while (fwResult == null && System.currentTimeMillis() < deadline) {
                if (!ble.isConnected()) {
                    try {
                        ble.connect(15_000);
                        log.add(L.s("Bluetooth® 已重新连接", "Bluetooth reconnected"));
                        reconnected = true;
                        linkSince = System.currentTimeMillis();
                    } catch (Ble.BleException e) {
                        log.detail(L.s("重新连接失败：", "Reconnecting failed: ") + e.getMessage());
                        Thread.sleep(3000);
                        continue;
                    }
                    try { ble.subscribe(CAMERA, FW_RESULT); } catch (Ble.BleException e) { log.detail(L.s("订阅结果失败：", "Subscribing to the result failed: ") + e.getMessage()); }
                    if (started) {
                        try {
                            byte[] v = ble.read(CAMERA, FW_RESULT);
                            log.detail(L.s("FirmwareUpdateResult 当前值 ", "FirmwareUpdateResult now ") + hex(v));
                            if (v.length > 0 && ((v[0] & 0xff) == 1 || (v[0] & 0xff) == 2)) fwResult = v[0] & 0xff;
                        } catch (Ble.BleException e) { log.detail(L.s("读取结果失败：", "Reading the result failed: ") + e.getMessage()); }
                    }
                }
                if (!started && ble.isConnected()) {
                    if (!reconnected) {
                        // Bluetooth never dropped after the upload: subscribe on this link before starting.
                        try { ble.subscribe(CAMERA, FW_RESULT); } catch (Ble.BleException e) { log.detail(L.s("订阅结果失败：", "Subscribing to the result failed: ") + e.getMessage()); }
                        reconnected = true;
                        linkSince = System.currentTimeMillis();
                    }
                    // Give the camera time to settle into "waiting for update" (it is still storing the file
                    // after the upload): at least START_AFTER_UPLOAD_MS after the upload and START_AFTER_LINK_MS
                    // on the new link. It waits minutes for the start, so this costs nothing.
                    long now = System.currentTimeMillis();
                    long ready = Math.max(putDone[0] + START_AFTER_UPLOAD_MS, linkSince + START_AFTER_LINK_MS);
                    if (now < ready) {
                        log.detail(L.s("等待照相机准备就绪，", "Waiting for the camera: \"start update\" in ") + (ready - now + 999) / 1000 + L.s(" 秒后发送[开始更新]", " s"));
                        Thread.sleep(Math.min(1000, ready - now));
                        continue;
                    }
                    try {
                        startSent = true;
                        ble.write(CAMERA, FW_START, new byte[]{1});
                        started = true;
                        put(result, "started", true);
                        log.add(L.s("已发送[开始更新]", "\"Start update\" sent"));
                        ev.stage("updating", L.s("正在更新固件。请勿关闭照相机电源或取出电池，并等待照相机自动重启。", "Updating the firmware: do not switch the camera off or take the battery out; it restarts by itself"));
                    } catch (Ble.BleException e) {
                        log.detail(L.s("发送[开始更新]失败：", "Sending \"start update\" failed: ") + e.getMessage());
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
                ev.stage("failed", L.s("照相机返回[开始更新]无效（invalid）。若显示处理失败或返回正常画面，固件未发生变更，可重新推送；"
                        + "若停留在[正在更新]且进度条长时间不动，请勿取出电池。请等待数分钟，再长按电源按钮关闭照相机后重试。",
                        "The camera answered \"start update\" with invalid. If it shows that processing failed, or goes back to its normal screen, "
                        + "the firmware has not changed and you can send again; if it stays on \"updating\" with the bar not moving for a long time, "
                        + "do not take the battery out: wait a few minutes, then hold the power button to switch it off and try again"));
            } else if (fwResult != null && fwResult == 1) {
                put(result, "ok", true);
                ev.stage("done", L.s("照相机固件更新成功。", "The camera updated successfully."));
            } else if (fwResult != null) {
                put(result, "ok", false);
                put(result, "reason", "update-failed");
                ev.stage("failed", L.s("照相机报告更新失败。固件可能未发生变更。请重新推送，或使用存储卡更新。", "The camera reports that the update failed. Its firmware should be unchanged; send again, or update from a memory card"));
            } else {
                put(result, "ok", false);
                put(result, "reason", started ? "no-result" : "not-started");
                ev.stage("failed", started
                        ? L.s("已发送[开始更新]，但未收到结果。照相机可能仍在更新。", "\"Start update\" was sent, but no result came back. The camera may still be updating")
                        : L.s("未能发送[开始更新]。照相机将在数分钟后显示处理失败，固件不会发生变更；可重新推送。", "\"Start update\" could not be sent. In a few minutes the camera shows that processing failed, with its firmware unchanged; you can send again"));
            }
        } catch (Fail f) {
            put(result, "ok", false);
            put(result, "reason", f.code);
            put(result, "message", f.getMessage());
            log.add(L.s("停止：", "Stopped: ") + f.getMessage());
            if (prepared && !uploaded) cancelUpdate(net);
            ev.stage("failed", f.getMessage());
        } catch (InterruptedException e) {
            put(result, "ok", false);
            put(result, "reason", "cancelled");
            log.add(L.s("已取消", "Cancelled"));
            if (prepared && !uploaded) cancelUpdate(net);
            ev.stage("failed", uploaded ? L.s("已停止等待。照相机可能仍在处理，请查看照相机显示屏", "Stopped waiting; the camera may still be at work: look at its screen") : L.s("已取消", "Cancelled"));
        } catch (Exception e) {
            put(result, "ok", false);
            put(result, "reason", "error");
            put(result, "message", String.valueOf(e.getMessage()));
            log.add(L.s("错误：", "Error: ") + e);
            if (prepared && !uploaded) cancelUpdate(net);
            ev.stage("failed", uploaded
                    ? L.s("上传期间发生错误（" + e.getMessage() + "）。请勿立即重试，请先查看照相机显示屏", "Error during the upload (" + e.getMessage() + "). Do not try again at once: look at the camera's screen first")
                    : L.s("错误：", "Error: ") + e.getMessage());
        } finally {
            if (ws != null) ws.close();
            net.release();
            ble.close();
            put(result, "log", log.file == null ? null : log.file.getAbsolutePath());
            put(result, "uploaded", uploaded);   // the page offers to try again only when nothing was sent
            log.close();
            ev.finished(result);
        }
    }

    private void connect(Ble ble, int tries) throws Exception {
        Exception last = null;
        for (int i = 0; i < tries; i++) {
            check();
            try { ble.connect(15_000); return; } catch (Ble.BleException e) { last = e; log.detail(L.s("第 " + (i + 1) + " 次 Bluetooth® 连接失败：", "Bluetooth connection attempt " + (i + 1) + " failed: ") + e.getMessage()); Thread.sleep(2000); }
        }
        throw new Fail("ble", L.s("无法通过 Bluetooth® 连接照相机。请确认照相机已开启，并已退出此设备上的 GR WORLD。（", "Cannot connect to the camera over Bluetooth: is it on? Is GR WORLD closed on this device? (") + (last == null ? "" : last.getMessage()) + L.s("）", ")"));
    }

    private void cancelUpdate(CameraNet net) {
        try {
            CameraNet.Reply r = net.post("/v1/configs/firmware/cancel", "", 30_000);
            log.add(L.s("cancel：", "cancel: ") + r.describe());
        } catch (Exception e) {
            log.add(L.s("cancel 失败：", "cancel failed: ") + e.getMessage());
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
