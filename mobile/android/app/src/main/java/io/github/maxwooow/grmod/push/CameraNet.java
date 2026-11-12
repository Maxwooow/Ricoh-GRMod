package io.github.maxwooow.grmod.push;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiNetworkSpecifier;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The camera's Wi-Fi: joins its access point with a network request of the app's own (so the rest of the
 * phone keeps its own connection), and talks HTTP and WebSocket to 192.168.0.1 over that network only.
 * The camera's access point has no internet, so nothing here may go through the phone's default network.
 */
public final class CameraNet {
    public static final String HOST = "192.168.0.1";

    public interface Progress { void sent(long done, long total); }

    public static final class Reply {
        public final int status;
        public final String body;
        public final JSONObject json;
        Reply(int status, String body) {
            this.status = status; this.body = body;
            JSONObject j = null;
            try { j = new JSONObject(body); } catch (Exception ignored) { }
            this.json = j;
        }
        public boolean ok() { return json != null && json.optInt("errCode", 0) == 200; }
        public String describe() {
            if (json == null) return "HTTP " + status + " " + (body.length() > 200 ? body.substring(0, 200) : body);
            StringBuilder sb = new StringBuilder("HTTP " + status + L.s("，errCode=", ", errCode=") + json.optInt("errCode") + " " + json.optString("errMsg"));
            Object d = json.opt("detail");
            if (d instanceof JSONObject) d = ((JSONObject) d).opt("reason");
            if (d != null) sb.append(" reason=").append(d);
            String hint = hint(d instanceof String ? (String) d : json.optString("errMsg"));
            if (hint != null) sb.append(L.s("（", " (")).append(hint).append(L.s("）", ")"));
            return sb.toString();
        }
        public static String hint(String errMsg) {
            switch (errMsg == null ? "" : errMsg) {
                case "err_fw_same": return L.s("相机认为版本相同，拒绝", "the camera has this version already and refused it");
                // seen 2026-11-11 after an update that hung and was switched off: the camera still ran 1.20 and
                // turned down 1.20 files; flashing the file once from a memory card set it right
                case "err_fw_old": return L.s("相机认为版本更旧，拒绝。如果相机显示的版本和这个文件一样（比如上次更新中途卡住、关过机），用存储卡刷一次相同文件即可恢复，之后可再无线推送",
                        "the camera takes this for an older version and refused it. If the camera shows the same version as this file (say an update got stuck and the camera was switched off), flashing the same file once from a memory card sets it right; after that, sending works again");
                case "err_fw_broken": return L.s("相机认为文件损坏", "the camera takes the file for damaged");
                case "battery_too_low": return L.s("相机电量不足", "the camera's battery is too low");
                default: return null;
            }
        }
    }

    private final Context ctx;
    private final PushLog log;
    private ConnectivityManager.NetworkCallback callback;
    private volatile Network network;
    private volatile boolean lost;

    public CameraNet(Context ctx, PushLog log) { this.ctx = ctx; this.log = log; }

    public boolean isLost() { return lost; }

    /**
     * True when a VPN is up. A VPN that does not allow apps to bypass it (Always-on with "Block connections
     * without VPN", or a VPN app that does not allow bypass) makes Android refuse to bind sockets to the camera's
     * network: "Binding socket to network N failed: EPERM".
     */
    public static boolean vpnActive(Context ctx) {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        try {
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities c = cm.getNetworkCapabilities(n);
                if (c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true;
            }
        } catch (Exception ignored) { }
        return false;
    }

    public static boolean isBindRefused(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            String m = String.valueOf(t.getMessage());
            if (m.contains("EPERM") || m.contains("Operation not permitted")) return true;
        }
        return false;
    }

    /** Joins the camera's access point. Android asks the user once per request (a system dialog). */
    public void join(String ssid, String passphrase, long timeoutMs) throws IOException, InterruptedException {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        WifiNetworkSpecifier spec = new WifiNetworkSpecifier.Builder()
                .setSsid(ssid).setWpa2Passphrase(passphrase).build();
        NetworkRequest req = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(spec).build();
        final CountDownLatch got = new CountDownLatch(1);
        final boolean[] unavailable = {false};
        lost = false;
        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { network = n; got.countDown(); }
            @Override public void onUnavailable() { unavailable[0] = true; got.countDown(); }
            @Override public void onLost(Network n) { lost = true; log.detail(L.s("相机 Wi-Fi 断开（onLost）", "Camera Wi-Fi lost (onLost)")); }
        };
        cm.requestNetwork(req, callback);
        if (!got.await(timeoutMs, TimeUnit.MILLISECONDS) || network == null) {
            release();
            throw new IOException(unavailable[0] ? L.s("没有连上相机 Wi-Fi（被取消或找不到热点）", "Not connected to the camera's Wi-Fi (cancelled, or the network was not found)") : L.s("连相机 Wi-Fi 超时", "Connecting to the camera's Wi-Fi timed out"));
        }
    }

    public void release() {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        ConnectivityManager.NetworkCallback c = callback;
        callback = null;
        network = null;
        if (c != null) {
            try { cm.unregisterNetworkCallback(c); } catch (Exception ignored) { }
        }
    }

    private HttpURLConnection open(String method, String path, int timeoutMs) throws IOException {
        Network n = network;
        if (n == null) throw new IOException(L.s("没有连着相机 Wi-Fi", "Not on the camera's Wi-Fi"));
        HttpURLConnection c = (HttpURLConnection) n.openConnection(new URL("http://" + HOST + path));
        c.setRequestMethod(method);
        c.setConnectTimeout(10000);
        c.setReadTimeout(timeoutMs);
        c.setUseCaches(false);
        c.setRequestProperty("Accept-Encoding", "identity");
        return c;
    }

    private static String readAll(HttpURLConnection c) throws IOException {
        InputStream in;
        try { in = c.getInputStream(); } catch (IOException e) { in = c.getErrorStream(); }
        if (in == null) return "";
        try (InputStream i = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = i.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString("UTF-8");
        }
    }

    public Reply get(String path, int timeoutMs) throws IOException {
        HttpURLConnection c = open("GET", path, timeoutMs);
        try {
            int st = c.getResponseCode();
            Reply r = new Reply(st, readAll(c));
            log.detail("GET " + path + " -> " + r.status + " " + clip(r.body));
            return r;
        } finally { c.disconnect(); }
    }

    public Reply post(String path, String form, int timeoutMs) throws IOException {
        HttpURLConnection c = open("POST", path, timeoutMs);
        try {
            byte[] body = form.getBytes(StandardCharsets.US_ASCII);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            c.setFixedLengthStreamingMode(body.length);
            try (OutputStream o = c.getOutputStream()) { o.write(body); }
            int st = c.getResponseCode();
            Reply r = new Reply(st, readAll(c));
            log.detail("POST " + path + " [" + form + "] -> " + r.status + " " + clip(r.body));
            return r;
        } finally { c.disconnect(); }
    }

    /** One PUT of the whole file, as GR WORLD does it. */
    public Reply putFile(String path, File f, Progress p, int timeoutMs) throws IOException {
        HttpURLConnection c = open("PUT", path, timeoutMs);
        try {
            long total = f.length();
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/octet-stream");
            c.setFixedLengthStreamingMode(total);
            long done = 0;
            try (OutputStream o = c.getOutputStream(); InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[256 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    o.write(buf, 0, n);
                    done += n;
                    p.sent(done, total);
                }
            }
            int st = c.getResponseCode();
            Reply r = new Reply(st, readAll(c));
            log.detail("PUT " + path + " (" + total + L.s(" 字节) -> ", " bytes) -> ") + r.status + " " + clip(r.body));
            return r;
        } finally { c.disconnect(); }
    }

    static String clip(String s) { return s.length() > 1500 ? s.substring(0, 1500) + "…" : s; }

    /**
     * ws://192.168.0.1/v1/changes. The camera cancels a firmware update when this closes while the file is
     * still coming in, so it stays open for the whole push. A ping every 10 seconds, the camera's pings are
     * answered (the same as the desktop test tool that worked).
     */
    public final class Changes {
        private Socket sock;
        private InputStream in;
        private OutputStream out;
        private volatile boolean alive;
        private final SecureRandom rnd = new SecureRandom();

        public boolean alive() { return alive; }

        public void open() throws IOException {
            Network n = network;
            if (n == null) throw new IOException(L.s("没有连着相机 Wi-Fi", "Not on the camera's Wi-Fi"));
            sock = n.getSocketFactory().createSocket();
            sock.connect(new InetSocketAddress(HOST, 80), 10000);
            sock.setSoTimeout(10000);
            in = sock.getInputStream();
            out = sock.getOutputStream();
            byte[] k = new byte[16];
            rnd.nextBytes(k);
            String key = android.util.Base64.encodeToString(k, android.util.Base64.NO_WRAP);
            out.write(("GET /v1/changes HTTP/1.1\r\nHost: " + HOST + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            StringBuilder head = new StringBuilder();
            int c;
            while ((c = in.read()) >= 0) {
                head.append((char) c);
                int l = head.length();
                if (l >= 4 && head.charAt(l - 4) == '\r' && head.charAt(l - 3) == '\n' && head.charAt(l - 2) == '\r' && head.charAt(l - 1) == '\n') break;
                if (l > 8192) throw new IOException(L.s("WebSocket 握手回复太长", "WebSocket handshake reply too long"));
            }
            String first = head.toString().split("\r\n", 2)[0];
            log.detail(L.s("WebSocket 握手: ", "WebSocket handshake: ") + first);
            if (!first.contains(" 101 ")) throw new IOException(L.s("WebSocket 握手失败: ", "WebSocket handshake failed: ") + first);
            sock.setSoTimeout(0);
            alive = true;
            Thread r = new Thread(this::reader, "changes-reader");
            r.setDaemon(true);
            r.start();
            Thread p = new Thread(this::pinger, "changes-ping");
            p.setDaemon(true);
            p.start();
        }

        private byte[] readN(int n) throws IOException {
            byte[] b = new byte[n];
            int o = 0;
            while (o < n) {
                int r = in.read(b, o, n - o);
                if (r < 0) throw new IOException("closed");
                o += r;
            }
            return b;
        }

        private void reader() {
            try {
                while (true) {
                    byte[] h = readN(2);
                    int op = h[0] & 0x0f;
                    long len = h[1] & 0x7f;
                    if (len == 126) { byte[] e = readN(2); len = ((e[0] & 0xff) << 8) | (e[1] & 0xff); }
                    else if (len == 127) { byte[] e = readN(8); len = 0; for (byte x : e) len = (len << 8) | (x & 0xff); }
                    byte[] mask = (h[1] & 0x80) != 0 ? readN(4) : null;
                    if (len > 4 * 1024 * 1024) throw new IOException("frame too long");
                    byte[] payload = readN((int) len);
                    if (mask != null) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
                    if (op == 9) { send(10, payload); continue; }
                    if (op == 10) continue;
                    if (op == 8) { log.detail(L.s("相机关闭了 WebSocket", "The camera closed the WebSocket")); break; }
                    log.detail("[changes] " + clip(new String(payload, StandardCharsets.UTF_8)));
                }
            } catch (IOException e) {
                log.detail(L.s("WebSocket 断开: ", "WebSocket closed: ") + e.getMessage());
            }
            alive = false;
        }

        private void pinger() {
            while (alive) {
                try { Thread.sleep(10000); } catch (InterruptedException e) { return; }
                try { send(9, "grmod".getBytes(StandardCharsets.US_ASCII)); } catch (IOException e) { return; }
            }
        }

        private synchronized void send(int op, byte[] payload) throws IOException {
            byte[] mask = new byte[4];
            rnd.nextBytes(mask);
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            b.write(0x80 | op);
            if (payload.length < 126) b.write(0x80 | payload.length);
            else { b.write(0x80 | 126); b.write(payload.length >> 8); b.write(payload.length & 0xff); }
            b.write(mask);
            for (int i = 0; i < payload.length; i++) b.write(payload[i] ^ mask[i % 4]);
            out.write(b.toByteArray());
            out.flush();
        }

        public void close() {
            if (sock == null) return;
            try { send(8, new byte[]{0x03, (byte) 0xe8}); } catch (Exception ignored) { }
            try { sock.close(); } catch (Exception ignored) { }
            alive = false;
        }
    }

    public Changes changes() { return new Changes(); }
}
