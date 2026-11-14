package io.github.maxwooow.grmod.push;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * GR Mod's own updates on Android (the APK is not from a store).
 *
 * The page fetches the release's update-android.json and its Ed25519 signature through {@link #fetchText} and
 * checks the signature itself (ui/src/update-android.ts), with the key the desktop app uses. Only then does it ask
 * for the APK: {@link #download} keeps the file only if its size and SHA-256 are the signed ones, and
 * {@link #install} hands it to the system's package installer, which also refuses an APK not signed with the
 * installed app's key. GitHub only: the addresses are checked here as well.
 */
final class Updater {
    interface Progress { void on(long received, long total); }
    interface Status { void on(int status, String message); }

    static final String ACTION = "io.github.maxwooow.grmod.UPDATE_STATUS";
    private static final long MAX_TEXT = 64 * 1024;
    private static final long MAX_APK = 200L * 1024 * 1024;

    private final Context context;
    private volatile boolean cancelled;
    private BroadcastReceiver receiver;

    Updater(Context context) { this.context = context.getApplicationContext(); }

    private static void checkHost(URL u) throws IOException {
        String h = u.getHost().toLowerCase(Locale.ROOT);
        boolean ok = "https".equalsIgnoreCase(u.getProtocol())
            && (h.equals("github.com") || h.endsWith(".githubusercontent.com"));
        if (!ok) throw new IOException("not a GitHub address: " + u);
    }

    private HttpURLConnection open(String url) throws IOException {
        URL u = new URL(url);
        checkHost(u);
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(40000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "GRMod");
        int code = c.getResponseCode();
        checkHost(c.getURL());
        if (code == 404) { c.disconnect(); throw new IOException("404"); }
        if (code / 100 != 2) { c.disconnect(); throw new IOException("HTTP " + code); }
        return c;
    }

    /** A small text file (the manifest, its signature). */
    String fetchText(String url) throws IOException {
        HttpURLConnection c = open(url);
        try (InputStream in = c.getInputStream()) {
            byte[] buf = new byte[8192];
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_TEXT) throw new IOException("too long");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally { c.disconnect(); }
    }

    File apkFile() { return new File(context.getCacheDir(), "update/GRMod-update.apk"); }

    void cancel() { cancelled = true; }

    /** The APK into the app's cache; kept only when it is the signed size and SHA-256. */
    File download(String url, long size, String sha256, Progress progress) throws Exception {
        cancelled = false;
        if (size <= 0 || size > MAX_APK) throw new IOException("size");
        File f = apkFile();
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("no cache folder");
        HttpURLConnection c = open(url);
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        long got = 0;
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            long last = 0;
            while ((n = in.read(buf)) > 0) {
                if (cancelled) throw new IOException("cancelled");
                got += n;
                if (got > size) throw new IOException("larger than announced");
                md.update(buf, 0, n);
                out.write(buf, 0, n);
                long now = System.currentTimeMillis();
                if (now - last > 150) { last = now; progress.on(got, size); }
            }
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            throw e;
        } finally { c.disconnect(); }
        progress.on(got, size);
        String hex = hex(md.digest());
        if (got != size || !hex.equalsIgnoreCase(sha256)) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            throw new IOException("checksum");
        }
        return f;
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x));
        return s.toString();
    }

    /** May GR Mod hand an APK to the installer? (The user allows it once, in the system's settings.) */
    boolean canInstall() {
        return Build.VERSION.SDK_INT < 26 || context.getPackageManager().canRequestPackageInstalls();
    }

    /** The system page where the user allows GR Mod to install apps. */
    Intent permissionIntent() {
        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return i;
    }

    /**
     * Hands the checked APK to the package installer. The system asks the user to confirm (status
     * STATUS_PENDING_USER_ACTION: its screen is shown here); on Android 12 and later, once GR Mod has installed
     * itself, later updates may go through without asking. When the update succeeds, the system ends this app.
     */
    void install(File apk, Status status) throws IOException {
        if (!apk.isFile()) throw new IOException("no file");
        listen(status);
        PackageInstaller pi = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        p.setAppPackageName(context.getPackageName());
        p.setSize(apk.length());
        if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(p);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("GRMod.apk", 0, apk.length())) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                s.fsync(out);
            }
            Intent cb = new Intent(ACTION).setPackage(context.getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pend = PendingIntent.getBroadcast(context, id, cb, flags);
            s.commit(pend.getIntentSender());
        } catch (IOException | RuntimeException e) {
            try { pi.abandonSession(id); } catch (Exception ignored) { /* already gone */ }
            throw e;
        }
    }

    private synchronized void listen(Status status) {
        if (receiver != null) { try { context.unregisterReceiver(receiver); } catch (Exception ignored) { /* not registered */ } }
        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent intent) {
                int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = Build.VERSION.SDK_INT >= 33
                        ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                        : intent.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        try { context.startActivity(confirm); } catch (Exception e) { status.on(PackageInstaller.STATUS_FAILURE, String.valueOf(e.getMessage())); return; }
                    }
                }
                status.on(st, msg == null ? "" : msg);
            }
        };
        IntentFilter f = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
        else context.registerReceiver(receiver, f);
    }
}
