package io.github.maxwooow.grmod.push;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * The official firmware on RICOH IMAGING's site: a port of the desktop shell's package ricoh
 * (shell/internal/ricoh/ricoh.go) and of its /api/firmware/latest and /download (server/firmware.go).
 * The release is read from the site's pages every time; the releases GR Mod also builds on that are no longer
 * listed (GR IV 1.11, GR III 2.10, GR IIIx 1.60) are fetched by their fixed addresses. Every request stays on
 * the site's host.
 */
public final class Ricoh {
    public static final String SITE = "https://www.ricoh-imaging.co.jp";
    static final String INDEX = "/english/support/download_digital.html";
    static final int MAX_PAGE = 4 << 20;
    static final long MAX_ARCHIVE = 160L << 20, MAX_FIRMWARE = 160L << 20;

    public interface Progress { void update(long received, long total); }

    public static final class Release {
        public String model, name, applies, version, date, page, file, url, sha256;
        public long size;

        JSONObject json() {
            JSONObject o = new JSONObject();
            try {
                o.put("model", model); o.put("name", name); o.put("applies", applies); o.put("version", version);
                o.put("date", date == null ? "" : date); o.put("page", page); o.put("file", file); o.put("size", size);
            } catch (JSONException ignored) { }
            return o;
        }
        Release copy() {
            Release r = new Release();
            r.model = model; r.name = name; r.applies = applies; r.version = version; r.date = date; r.page = page;
            r.file = file; r.url = url; r.sha256 = sha256; r.size = size;
            return r;
        }
    }

    static final Map<String, String> MODELS = new HashMap<>();
    /** The releases GR Mod builds on, per model, newest first, at their fixed addresses on the site. */
    static final Map<String, List<Release>> SUPPORTED = new HashMap<>();
    static final String FW = "/resources/japan/support/download/digital/FIRMWARE/";

    static Release pin(String name, String applies, String version, String date, String file, long size, String sha, String page) {
        Release r = new Release();
        r.name = name; r.applies = applies; r.version = version; r.date = date; r.file = file; r.url = FW + file;
        r.size = size; r.sha256 = sha; r.page = page;
        return r;
    }

    static {
        MODELS.put("GR3", "GR III"); MODELS.put("GR3_HDF", "GR III HDF"); MODELS.put("GR3X", "GR IIIx");
        MODELS.put("GR3X_HDF", "GR IIIx HDF"); MODELS.put("STANDARD", "GR IV"); MODELS.put("HDF", "GR IV HDF");
        MODELS.put("MONO", "GR IV Monochrome");
        String gr4Page = "/english/support/digital/gr4_s.html", gr4Applies = "RICOH GR IV / RICOH GR IV HDF";
        List<Release> gr4 = new ArrayList<>();
        // SHA-256 of the archives checked 2026-11-11 (the 1.20 archive holds fwdc248b.bin 7563d7e4…650d).
        gr4.add(pin("GR IV", gr4Applies, "1.20", "", "gr4_v120.zip", 34702809L,
                "dcc1b6fb004f0d855bb46b30a529da894c7b717501276fec2d198b3d7eb76a59", gr4Page));
        gr4.add(pin("GR IV", gr4Applies, "1.11", "2026/02/13", "gr4_v111.zip", 34478368L,
                "ded47aa6385886e4b1f8f41f8551866ab0f1ecd0aef89934a43ef0e456539e8f", gr4Page));
        SUPPORTED.put("STANDARD", gr4);
        SUPPORTED.put("HDF", gr4);
        List<Release> mono = new ArrayList<>();
        mono.add(pin("GR IV Monochrome", "RICOH GR IV Monochrome", "1.10", "", "gr4_mono_v110.zip", 34702809L,
                "bde05b3bf56a29c272284556d6795cb772eaccbbd0091d433fd52368d4d8af12", "/english/support/digital/gr-4-mono_s.html"));
        SUPPORTED.put("MONO", mono);
        String gr3Applies = "RICOH GR III / GR III Street Edition / GR III Diary Edition / GR III HDF", gr3Page = "/english/support/digital/gr3_s.html";
        List<Release> gr3 = new ArrayList<>();
        gr3.add(pin("GR III", gr3Applies, "2.20", "", "gr3_v220.zip", 28599247L,
                "7b19f9c03f2448c2b674fb919f6a86d22d6d83801521a9c1226a0e20cf0b5a2f", gr3Page));
        gr3.add(pin("GR III", gr3Applies, "2.10", "2025/10/23", "gr3_v210.zip", 0, null, gr3Page));
        SUPPORTED.put("GR3", gr3);
        SUPPORTED.put("GR3_HDF", gr3);
        String gr3xApplies = "RICOH GR IIIx / GR IIIx Urban Edition / GR IIIx HDF", gr3xPage = "/english/support/digital/gr3x_s.html";
        List<Release> gr3x = new ArrayList<>();
        gr3x.add(pin("GR IIIx", gr3xApplies, "1.70", "", "gr3x_v170.zip", 28599250L,
                "6a028e90b4f23c9e9af968b03bca5032b71f460be85fd2c49f4078366a71dc6d", gr3xPage));
        gr3x.add(pin("GR IIIx", gr3xApplies, "1.60", "2025/10/23", "gr3x_v160.zip", 0, null, gr3xPage));
        SUPPORTED.put("GR3X", gr3x);
        SUPPORTED.put("GR3X_HDF", gr3x);
    }

    public static final class NoRelease extends IOException { NoRelease() { super("no firmware is listed for this model"); } }
    public static final class Checksum extends IOException { Checksum() { super("the archive is not the expected file"); } }

    private final String site;
    private volatile boolean cancelled;
    private volatile HttpURLConnection active;

    public Ricoh(String site) { this.site = site == null ? SITE : site; }

    public void cancel() {
        cancelled = true;
        HttpURLConnection c = active;
        if (c != null) c.disconnect();
    }

    static String baseModel(String model) {
        if (model.equals("GR3X") || model.equals("GR3X_HDF")) return "GR IIIx";
        if (model.equals("GR3") || model.equals("GR3_HDF")) return "GR III";
        return "GR IV";
    }

    // ------------------------------------------------------------------ HTTP, on the site only

    private URI siteUri() { return URI.create(site); }

    private URI resolve(URI from, String href) throws IOException {
        URI u;
        try { u = from.resolve(href.trim().replace(" ", "%20")); } catch (IllegalArgumentException e) { throw new IOException("unusable link " + href); }
        URI base = siteUri();
        if (!base.getScheme().equalsIgnoreCase(u.getScheme()) || !base.getHost().equalsIgnoreCase(u.getHost())) throw new IOException("link leaves the site: " + u);
        try { return new URI(u.getScheme(), u.getAuthority(), u.getPath(), u.getQuery(), null); } catch (Exception e) { return u; }
    }

    private HttpURLConnection open(URI u, String method, String range) throws IOException {
        if (cancelled) throw new IOException("cancelled");
        HttpURLConnection c = (HttpURLConnection) new URL(u.toString()).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(20000);
        c.setReadTimeout(40000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "GRMod");
        if (range != null) c.setRequestProperty("Range", range);
        active = c;
        return c;
    }

    private void onSite(HttpURLConnection c) throws IOException {
        URL fin = c.getURL();
        URI base = siteUri();
        if (!base.getHost().equalsIgnoreCase(fin.getHost()) || !base.getScheme().equalsIgnoreCase(fin.getProtocol())) {
            c.disconnect();
            throw new IOException("redirected away from the site: " + fin);
        }
    }

    private String page(URI u) throws IOException {
        HttpURLConnection c = open(u, "GET", null);
        try {
            int st = c.getResponseCode();
            onSite(c);
            if (st != 200) throw new IOException(u + ": HTTP " + st);
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    b.write(buf, 0, n);
                    if (b.size() > MAX_PAGE) throw new IOException(u + ": page is too large");
                }
                return b.toString("UTF-8");
            }
        } finally { c.disconnect(); }
    }

    /** The archive's size without fetching it (HEAD, else a one-byte range); 0 when the site says neither. */
    private long size(URI u) {
        try {
            HttpURLConnection c = open(u, "HEAD", null);
            try {
                if (c.getResponseCode() == 200) { onSite(c); long n = c.getContentLengthLong(); if (n > 0) return n; }
            } finally { c.disconnect(); }
            c = open(u, "GET", "bytes=0-0");
            try {
                if (c.getResponseCode() == 206) {
                    onSite(c);
                    Matcher m = Pattern.compile("^bytes \\d+-\\d+/(\\d+)$").matcher(String.valueOf(c.getHeaderField("Content-Range")));
                    if (m.find()) return Long.parseLong(m.group(1));
                }
            } finally { c.disconnect(); }
        } catch (Exception ignored) { }
        return 0;
    }

    // ------------------------------------------------------------------ the pages

    static final Pattern ROW = Pattern.compile("(?is)<tr\\b[^>]*>(.*?)</tr>");
    static final Pattern CELL = Pattern.compile("(?is)<t[dh]\\b[^>]*>(.*?)</t[dh]>");
    static final Pattern TAG = Pattern.compile("(?s)<[^>]*>");
    static final Pattern HREF = Pattern.compile("(?is)<a\\b[^>]*?\\bhref\\s*=\\s*[\"']([^\"']+)[\"']");
    static final Pattern VERSION = Pattern.compile("^\\d{1,2}\\.\\d{1,3}$");
    static final Pattern DATE = Pattern.compile("\\d{4}/\\d{1,2}/\\d{1,2}");
    static final Pattern SPACE = Pattern.compile("[\\s\\u00a0\\u3000]+");
    static final Pattern COMMENT = Pattern.compile("(?s)<!--.*?-->");
    static final Pattern KB = Pattern.compile("(?i)([0-9][0-9,]*)\\s*KB\\b");

    static final Pattern ENTITY = Pattern.compile("&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});");

    /** HTML character references (the named ones these pages use, and numeric ones). */
    static String unescape(String s) {
        if (s.indexOf('&') < 0) return s;
        Matcher m = ENTITY.matcher(s);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            String e = m.group(1), r = null;
            try {
                if (e.startsWith("#x") || e.startsWith("#X")) r = new String(Character.toChars(Integer.parseInt(e.substring(2), 16)));
                else if (e.startsWith("#")) r = new String(Character.toChars(Integer.parseInt(e.substring(1))));
            } catch (IllegalArgumentException ignored) { }
            if (r == null) {
                switch (e) {
                    case "amp": r = "&"; break;
                    case "lt": r = "<"; break;
                    case "gt": r = ">"; break;
                    case "quot": r = "\""; break;
                    case "apos": r = "'"; break;
                    case "nbsp": r = "\u00a0"; break;
                    default: r = m.group(); break;
                }
            }
            m.appendReplacement(out, Matcher.quoteReplacement(r));
        }
        m.appendTail(out);
        return out.toString();
    }

    static String text(String fragment) {
        return SPACE.matcher(unescape(TAG.matcher(fragment).replaceAll(" "))).replaceAll(" ").trim();
    }

    static final class Row { final List<String> cells = new ArrayList<>(); String href = ""; }

    static List<Row> rows(String page) {
        page = COMMENT.matcher(page).replaceAll("");
        List<Row> out = new ArrayList<>();
        Matcher m = ROW.matcher(page);
        while (m.find()) {
            Row r = new Row();
            Matcher c = CELL.matcher(m.group(1));
            while (c.find()) r.cells.add(text(c.group(1)));
            Matcher h = HREF.matcher(m.group(1));
            if (h.find()) r.href = unescape(h.group(1));
            if (!r.cells.isEmpty()) out.add(r);
        }
        return out;
    }

    static boolean names(String cell, String name) {
        if (cell.equalsIgnoreCase(name)) return true;
        for (String part : cell.split("/")) if (part.trim().equalsIgnoreCase(name)) return true;
        return false;
    }

    static String[] indexEntry(List<Row> list, String name) {
        for (Row r : list) {
            if (!names(r.cells.get(0), name) || r.href.isEmpty()) continue;
            for (int i = r.cells.size() - 1; i >= 1; i--) if (VERSION.matcher(r.cells.get(i)).matches()) return new String[]{r.href, r.cells.get(i)};
        }
        return null;
    }

    static String field(List<Row> list, String label) {
        for (Row r : list) if (r.cells.size() >= 2 && r.cells.get(0).equalsIgnoreCase(label)) return r.cells.get(1);
        return "";
    }

    static boolean appliesTo(String applies, String name) {
        for (String part : applies.split("[/,、;]")) {
            String p = part.trim();
            if (p.length() > 6 && p.substring(0, 6).equalsIgnoreCase("RICOH ")) p = p.substring(6).trim();
            if (p.equalsIgnoreCase(name)) return true;
        }
        return false;
    }

    static String archiveLink(String page) {
        Matcher m = HREF.matcher(COMMENT.matcher(page).replaceAll(""));
        while (m.find()) {
            String h = unescape(m.group(1));
            int cut = h.length();
            for (char ch : new char[]{'?', '#'}) { int i = h.indexOf(ch); if (i >= 0 && i < cut) cut = i; }
            String path = h.substring(0, cut).toLowerCase(Locale.ROOT);
            if (path.endsWith(".zip")) return h;
        }
        return "";
    }

    static long statedSize(String registered) {
        Matcher m = KB.matcher(registered);
        if (!m.find()) return 0;
        try {
            long n = Long.parseLong(m.group(1).replace(",", ""));
            return n <= 0 || n > MAX_ARCHIVE / 1024 ? 0 : n * 1024;
        } catch (NumberFormatException e) { return 0; }
    }

    private Release current(String model, String name) throws IOException {
        URI index = siteUri().resolve(INDEX);
        List<Row> list = rows(page(index));
        String base = baseModel(model);
        List<String> candidates = new ArrayList<>();
        candidates.add(name);
        if (!name.equals(base)) candidates.add(base);
        for (String rowName : candidates) {
            String[] e = indexEntry(list, rowName);
            if (e == null) continue;
            URI pageUri = resolve(index, e[0]);
            String body = page(pageUri);
            List<Row> fields = rows(body);
            String applies = field(fields, "Applied product");
            if (!rowName.equals(name) && !appliesTo(applies, name)) continue;
            String link = archiveLink(body);
            if (link.isEmpty()) throw new IOException(pageUri + ": no download link found");
            URI file = resolve(pageUri, link);
            Release r = new Release();
            r.model = model; r.name = rowName; r.applies = applies; r.version = e[1];
            Matcher d = DATE.matcher(field(fields, "Release date"));
            r.date = d.find() ? d.group() : "";
            r.page = pageUri.toString();
            String p = file.getPath();
            r.file = p.substring(p.lastIndexOf('/') + 1);
            r.url = file.toString();
            r.size = size(file);
            if (r.size == 0) r.size = statedSize(field(fields, "Registered name"));
            return r;
        }
        return null;
    }

    private Release supported(String model, Release r) {
        Release c = r.copy();
        c.model = model;
        c.url = siteUri().resolve(r.url).toString();
        c.page = siteUri().resolve(r.page).toString();
        if (c.size == 0) c.size = size(URI.create(c.url));
        return c;
    }

    private final Map<String, List<Release>> cache = new HashMap<>();
    private final Map<String, Long> cachedAt = new HashMap<>();

    /**
     * What the site's pages offer now (first, when the site answers) and every other release GR Mod builds on,
     * newest first, as the desktop: with GR IV 1.21 on the site (Nov 2026), 1.21, 1.20 and 1.11; with GR III 2.21,
     * 2.21, 2.20 and 2.10. A release the site lists that GR Mod builds on gets its pinned SHA-256. Cached for
     * 10 minutes.
     */
    public synchronized List<Release> release(String model) throws IOException {
        Long at = cachedAt.get(model);
        if (at != null && System.currentTimeMillis() - at < 10 * 60_000) return cache.get(model);
        String name = MODELS.get(model);
        if (name == null) throw new IOException("unknown model");
        List<Release> sup = SUPPORTED.get(model);
        Release cur;
        try { cur = current(model, name); }
        catch (IOException e) { if (sup == null || sup.isEmpty()) throw e; cur = null; }
        List<Release> out = new ArrayList<>();
        if (cur != null) out.add(cur);
        if (sup != null) {
            for (Release s : sup) {
                if (cur != null && s.version.equals(cur.version)) {
                    if (cur.url.endsWith("/" + s.file)) cur.sha256 = s.sha256;
                    continue;
                }
                out.add(supported(model, s));
            }
        }
        if (out.isEmpty()) throw new NoRelease();
        cache.put(model, out);
        cachedAt.put(model, System.currentTimeMillis());
        return out;
    }

    /** The JSON of GET /api/firmware/latest: the first release, each next one under "fallback". */
    public JSONObject latestJson(String model) throws IOException {
        List<Release> r = release(model);
        JSONObject o = null;
        for (int i = r.size() - 1; i >= 0; i--) {
            JSONObject x = r.get(i).json();
            if (o != null) try { x.put("fallback", o); } catch (JSONException ignored) { }
            o = x;
        }
        return o;
    }

    /** The release of that version, or the first one when version is empty. */
    public Release chosen(String model, String version) throws IOException {
        for (Release rel : release(model)) {
            if (version == null || version.isEmpty() || rel.version.equals(version)) return rel;
        }
        throw new NoRelease();
    }

    static final Pattern FIRMWARE_NAME = Pattern.compile("(?i)^fwdc[0-9a-z]{2,8}\\.bin$");

    /** Downloads the archive to `work`, checks it, and unpacks the firmware file into `out`. Returns its name. */
    public String download(Release rel, File work, File out, Progress p) throws IOException {
        cancelled = false;
        URI u = URI.create(rel.url);
        URI base = siteUri();
        if (!base.getHost().equalsIgnoreCase(u.getHost())) throw new IOException("download address is not on the site: " + rel.url);
        HttpURLConnection c = open(u, "GET", null);
        long received = 0;
        MessageDigest md;
        try { md = MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IOException(e); }
        try {
            int st = c.getResponseCode();
            onSite(c);
            if (st != 200) throw new IOException(u + ": HTTP " + st);
            long total = Math.max(0, c.getContentLengthLong());
            if (total > MAX_ARCHIVE) throw new IOException("archive is too large");
            if (total == 0) total = rel.size;
            try (InputStream in = c.getInputStream(); OutputStream o = new FileOutputStream(work)) {
                byte[] buf = new byte[256 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancelled) throw new IOException("cancelled");
                    received += n;
                    if (received > MAX_ARCHIVE) throw new IOException("archive is too large");
                    o.write(buf, 0, n);
                    md.update(buf, 0, n);
                    p.update(received, total);
                }
            }
            long announced = c.getContentLengthLong();
            if (announced > 0 && received != announced) throw new IOException("download ended after " + received + " of " + announced + " bytes");
        } finally { c.disconnect(); active = null; }
        if (rel.sha256 != null) {
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            if (!sb.toString().equalsIgnoreCase(rel.sha256)) throw new Checksum();
        }
        return unpack(work, out);
    }

    static String unpack(File zip, File out) throws IOException {
        String found = null;
        try (ZipInputStream z = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry e;
            while ((e = z.getNextEntry()) != null) {
                String name = e.getName().replace('\\', '/');
                name = name.substring(name.lastIndexOf('/') + 1);
                if (e.isDirectory() || !FIRMWARE_NAME.matcher(name).matches()) continue;
                if (found != null) throw new IOException("the archive holds more than one firmware file");
                found = name;
                long n = 0;
                try (OutputStream o = new FileOutputStream(out)) {
                    byte[] buf = new byte[256 * 1024];
                    int r;
                    while ((r = z.read(buf)) > 0) {
                        n += r;
                        if (n > MAX_FIRMWARE) throw new IOException("firmware file has an unusable size");
                        o.write(buf, 0, r);
                    }
                }
                if (n == 0) throw new IOException("firmware file has an unusable size");
            }
        }
        if (found == null) throw new IOException("the archive holds no firmware file");
        return found;
    }
}
