package io.github.maxwooow.grmod.push;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * "Save to device": the system's save dialog (ACTION_CREATE_DOCUMENT), where the user picks the folder (it opens in
 * Downloads) and may change the name; the file is then copied there.
 */
final class Downloads {
    private Downloads() { }

    static String safeName(String name) {
        String safe = name == null ? "" : name.replaceAll("[^A-Za-z0-9._ -]", "_");
        return safe.isEmpty() ? "fwdc248b.bin" : safe;
    }

    /** The save dialog for a file of this name. */
    static Intent saveAs(String name) {
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("application/octet-stream");
        i.putExtra(Intent.EXTRA_TITLE, name);
        // start in Downloads (where a card reader's copy usually comes from); ignored where not supported
        i.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Download"));
        return i;
    }

    /** Copies the file to the place the save dialog gave; returns the name it got there. */
    static String copy(Context ctx, File src, Uri to) throws IOException {
        ContentResolver cr = ctx.getContentResolver();
        try (InputStream in = new FileInputStream(src); OutputStream out = cr.openOutputStream(to, "wt")) {
            if (out == null) throw new IOException("cannot write there");
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } catch (IOException e) {
            try { DocumentsContract.deleteDocument(cr, to); } catch (Exception ignored) { /* left as it is */ }
            throw e;
        }
        String shown = src.getName();
        try (Cursor c = cr.query(to, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) shown = c.getString(0);
        } catch (Exception ignored) { /* the file's own name */ }
        return shown;
    }
}
