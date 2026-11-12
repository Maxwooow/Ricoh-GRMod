package io.github.maxwooow.grmod.push;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Saves a file into the phone's Downloads folder (Download/GR Mod/), where the Files app and a card reader see it. */
final class Downloads {
    private Downloads() { }

    /** Returns the path as the user sees it ("Download/GR Mod/fwdc248b.bin"; Android adds " (1)" when the name is taken). */
    static String save(Context ctx, File src, String name) throws IOException {
        String safe = name.replaceAll("[^A-Za-z0-9._ -]", "_");
        if (safe.isEmpty()) safe = "fwdc248b.bin";
        ContentResolver cr = ctx.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
        v.put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/GR Mod");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IOException("cannot create the file in Downloads");
        try (InputStream in = new FileInputStream(src); OutputStream out = cr.openOutputStream(uri)) {
            if (out == null) throw new IOException("cannot write to Downloads");
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } catch (IOException e) {
            cr.delete(uri, null, null);
            throw e;
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, done, null, null);
        String shown = safe;
        try (android.database.Cursor c = cr.query(uri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) shown = c.getString(0);
        }
        return Environment.DIRECTORY_DOWNLOADS + "/GR Mod/" + shown;
    }
}
