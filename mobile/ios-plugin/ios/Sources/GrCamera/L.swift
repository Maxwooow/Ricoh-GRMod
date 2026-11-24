import Foundation

/// The language of the native messages (push steps, failures, the log): the page's own (ui/src/i18n.ts, set through
/// GrCameraPlugin.setLanguage), as L.java on Android. Each message is written in Chinese and English side by side;
/// the other languages come from Tr (generated from mobile/native-texts.json by mobile/tools/native-texts.mjs),
/// keyed by the English text. A message missing there falls back to Chinese for zh-TW and to English for the rest.
enum L {
    private static let lock = NSLock()
    private static var current = norm(Locale.preferredLanguages.first)

    /// "zh", "en", or one of Tr.langs.
    static var lang: String { lock.lock(); defer { lock.unlock() }; return current }

    static func set(_ l: String?) {
        let n = norm(l)
        lock.lock()
        current = n
        lock.unlock()
    }

    static func norm(_ l: String?) -> String {
        let s = (l ?? "").lowercased().replacingOccurrences(of: "_", with: "-")
        if s.hasPrefix("zh") {
            return s == "zh-tw" || s.contains("hant") || s.hasSuffix("-tw") || s.hasSuffix("-hk") || s.hasSuffix("-mo")
                ? "zh-TW" : "zh"
        }
        for t in Tr.langs where s == t.lowercased() || s.hasPrefix(t + "-") { return t }
        return "en"
    }

    /// The message in the current language.
    static func s(_ zh: String, _ english: String) -> String {
        let l = lang
        if l == "zh" { return zh }
        if l == "en" { return english }
        if let t = Tr.map[english], let i = Tr.langs.firstIndex(of: l) { return t[i] }
        return l == "zh-TW" ? zh : english
    }

    /// A message with {0}, {1}… filled in.
    static func f(_ zh: String, _ english: String, _ args: Any...) -> String {
        var m = s(zh, english)
        for (i, a) in args.enumerated() { m = m.replacingOccurrences(of: "{\(i)}", with: "\(a)") }
        return m
    }
}
