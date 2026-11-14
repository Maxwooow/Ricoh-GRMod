package io.github.maxwooow.grmod.push;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Timestamped lines, kept in a file of their own per session and handed to the page as they come. */
public final class PushLog {
    public interface Sink { void line(String text, boolean detail); }

    private final Writer out;
    private final Sink sink;
    private final StringBuilder all = new StringBuilder();
    public final File file;

    public PushLog(File dir, Sink sink) {
        this.sink = sink;
        File f = null;
        Writer w = null;
        try {
            if (dir.isDirectory() || dir.mkdirs()) {
                f = new File(dir, "push-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date()) + ".log");
                w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8);
            }
        } catch (IOException ignored) { }
        this.file = f;
        this.out = w;
    }

    /** A line the user sees. */
    public void add(String text) { write(text, false); }

    /** A line for the log only (requests, responses). */
    public void detail(String text) { write(text, true); }

    private synchronized void write(String text, boolean detail) {
        String line = new SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date()) + " " + text;
        all.append(line).append('\n');
        if (out != null) {
            try { out.write(line); out.write('\n'); out.flush(); } catch (IOException ignored) { }
        }
        if (sink != null) sink.line(line, detail);
    }

    public synchronized String text() { return all.toString(); }

    public synchronized void close() {
        if (out != null) {
            try { out.close(); } catch (IOException ignored) { }
        }
    }
}
