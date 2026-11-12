package io.github.maxwooow.grmod.push;

/**
 * The language of the native messages (push steps, failures, the log): the page's own (ui/src/i18n.ts, set
 * through GrCameraPlugin.setLanguage), Chinese or English. Each message is written in both, side by side.
 */
final class L {
    private L() { }

    static volatile boolean en = !java.util.Locale.getDefault().getLanguage().equals("zh");

    static void set(String lang) { en = lang == null || !lang.toLowerCase(java.util.Locale.ROOT).startsWith("zh"); }

    /** The message in the current language. */
    static String s(String zh, String english) { return en ? english : zh; }
}
