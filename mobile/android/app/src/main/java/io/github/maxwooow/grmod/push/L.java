package io.github.maxwooow.grmod.push;

/**
 * The language of the native messages (push steps, failures, the log): the page's own (ui/src/i18n.ts, set
 * through GrCameraPlugin.setLanguage). Each message is written in Chinese and English side by side; the other
 * languages come from Tr (generated from mobile/native-texts.json by mobile/tools/native-texts.mjs), keyed by
 * the English text. A message missing there falls back to Chinese for zh-TW and to English for the rest.
 */
final class L {
    private L() { }

    /** "zh", "en", or one of Tr.LANGS. */
    static volatile String lang = norm(java.util.Locale.getDefault().toLanguageTag());

    static void set(String l) { lang = norm(l); }

    static String norm(String l) {
        String s = l == null ? "" : l.toLowerCase(java.util.Locale.ROOT).replace('_', '-');
        if (s.startsWith("zh")) {
            return s.equals("zh-tw") || s.contains("hant") || s.endsWith("-tw") || s.endsWith("-hk") || s.endsWith("-mo")
                ? "zh-TW" : "zh";
        }
        for (String t : Tr.LANGS) if (s.equals(t.toLowerCase(java.util.Locale.ROOT)) || s.startsWith(t + "-")) return t;
        return "en";
    }

    /** The message in the current language. */
    static String s(String zh, String english) {
        String l = lang;
        if (l.equals("zh")) return zh;
        if (l.equals("en")) return english;
        String[] t = Tr.MAP.get(english);
        if (t != null) for (int i = 0; i < Tr.LANGS.length; i++) if (Tr.LANGS[i].equals(l)) return t[i];
        return l.equals("zh-TW") ? zh : english;
    }

    /** A message with {0}, {1}… filled in. */
    static String f(String zh, String english, Object... args) {
        String m = s(zh, english);
        for (int i = 0; i < args.length; i++) m = m.replace("{" + i + "}", String.valueOf(args[i]));
        return m;
    }
}
