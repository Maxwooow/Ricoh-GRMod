import Foundation

/// The language of the native messages (push steps, failures, the log): the page's own (ui/src/i18n.ts, set through
/// GrCameraPlugin.setLanguage), Chinese or English, as L.java on Android. Each message is written in both, side by side.
enum L {
    private static let lock = NSLock()
    private static var english = !(Locale.preferredLanguages.first ?? "en").lowercased().hasPrefix("zh")

    static var en: Bool { lock.lock(); defer { lock.unlock() }; return english }

    static func set(_ lang: String?) {
        lock.lock()
        english = !(lang ?? "").lowercased().hasPrefix("zh")
        lock.unlock()
    }

    /// The message in the current language.
    static func s(_ zh: String, _ english: String) -> String { L.en ? english : zh }
}
