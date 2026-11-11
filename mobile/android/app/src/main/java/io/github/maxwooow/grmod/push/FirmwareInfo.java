package io.github.maxwooow.grmod.push;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * What a firmware file (fwdc248b.bin) says about itself.
 *
 * Container (see core/src/fw/container.ts): 0x80-byte header ("RICOH" at 0, project number at 0x30, the
 * project's version bytes at 0x38), then the LZ stream, then one 0x80-byte record per camera model, then a
 * 0x18-byte footer (proj|proj<<16, A55A5AA5, type, stream length, decoded length, checksum).
 * A model record: u32 model number, then four version bytes (the version that model shows, e.g. the GR IV
 * Monochrome shows 1.10.10.4 for the file the GR IV shows as 1.20.10.11), two more copies, the name at 0x1C.
 */
public final class FirmwareInfo {
    public static final int HDR = 0x80, FOOTER = 0x18, RECORD = 0x80;
    public static final long MAGIC = 0xA55A5AA5L;

    /** The official files we know, by SHA-256. */
    public static String knownOfficial(String sha) {
        if ("7563d7e462f0c53b6ab2fbab7cdfbbb57151a41192ee82f4f3a2108f9d77650d".equals(sha)) return "GR IV 官方 1.20";
        return null;
    }

    public static final class Model {
        public final int number;
        public final String name;     // "GR IV", "GR IV HDF", "GR IV Monochrome"
        public final String version;  // "1.20.10.11"
        Model(int number, String name, String version) { this.number = number; this.name = name; this.version = version; }
        /** "1.20" */
        public String base() { return baseOf(version); }
    }

    public final long size;
    public final String sha256;
    public final String official;
    public final boolean container;
    public final String error;
    public final String fileName;      // header +8, e.g. "GR IV"
    public final String version;       // header version bytes
    public final String date;          // header +0x58
    public final List<Model> models;

    private FirmwareInfo(long size, String sha256, boolean container, String error, String fileName, String version,
                         String date, List<Model> models) {
        this.size = size; this.sha256 = sha256; this.official = knownOfficial(sha256); this.container = container;
        this.error = error; this.fileName = fileName; this.version = version; this.date = date; this.models = models;
    }

    public static String baseOf(String version) {
        if (version == null) return null;
        String[] p = version.split("\\.");
        return p.length >= 2 ? p[0] + "." + p[1] : version;
    }

    static String versionOf(byte[] b, int off) {
        return String.format(Locale.ROOT, "%d.%02d.%d.%d", b[off] & 0xff, b[off + 1] & 0xff, b[off + 2] & 0xff, b[off + 3] & 0xff);
    }

    static String cstr(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && end < b.length && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.US_ASCII);
    }

    public static FirmwareInfo read(File f) throws IOException {
        long size = f.length();
        String sha = sha256(f);
        byte[] head = new byte[HDR];
        byte[] foot = new byte[FOOTER];
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            if (size < HDR + FOOTER + RECORD) return bad(size, sha, "文件太小，不是固件");
            r.readFully(head);
            if (!cstr(head, 0, 8).equals("RICOH")) return bad(size, sha, "不是理光固件文件（开头不是 RICOH）");
            r.seek(size - FOOTER);
            r.readFully(foot);
            ByteBuffer fb = ByteBuffer.wrap(foot).order(ByteOrder.LITTLE_ENDIAN);
            long proj2 = fb.getInt(0) & 0xffffffffL, magic = fb.getInt(4) & 0xffffffffL, streamLen = fb.getInt(12) & 0xffffffffL;
            long project = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN).getInt(0x30) & 0xffffffffL;
            if (magic != MAGIC || proj2 != ((project | (project << 16)) & 0xffffffffL)) return bad(size, sha, "文件尾不对（不是完整的固件文件）");
            long start = (HDR + streamLen + 3) & ~3L;
            long end = size - FOOTER;
            if (start > end || (end - start) % RECORD != 0 || end - start > 16 * RECORD) return bad(size, sha, "机型记录区不对");
            List<Model> models = new ArrayList<>();
            byte[] rec = new byte[RECORD];
            for (long o = start; o < end; o += RECORD) {
                r.seek(o);
                r.readFully(rec);
                int num = ByteBuffer.wrap(rec).order(ByteOrder.LITTLE_ENDIAN).getInt(0);
                models.add(new Model(num, cstr(rec, 0x1c, 0x40), versionOf(rec, 4)));
            }
            return new FirmwareInfo(size, sha, true, null, cstr(head, 8, 8), versionOf(head, 0x38), cstr(head, 0x58, 0x18), models);
        }
    }

    private static FirmwareInfo bad(long size, String sha, String why) {
        return new FirmwareInfo(size, sha, false, why, null, null, null, new ArrayList<>());
    }

    /** The record for a camera, by the model name /v1/props reports ("RICOH GR IV HDF"). */
    public Model modelFor(String cameraModel) {
        if (cameraModel == null) return null;
        String m = cameraModel.trim();
        if (m.startsWith("RICOH ")) m = m.substring(6).trim();
        for (Model x : models) if (x.name.equalsIgnoreCase(m)) return x;
        return null;
    }

    public static String sha256(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    public String describe() {
        if (!container) return error;
        StringBuilder sb = new StringBuilder();
        sb.append(fileName).append(" ").append(version).append("，生成于 ").append(date).append("；机型：");
        for (int i = 0; i < models.size(); i++) {
            if (i > 0) sb.append("、");
            sb.append(models.get(i).name).append(" ").append(models.get(i).version);
        }
        if (official != null) sb.append("（").append(official).append("）");
        return sb.toString();
    }
}
