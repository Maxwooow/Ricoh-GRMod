import Foundation

/// Timestamped lines, kept in a file of their own per session and handed to the page as they come
/// (the same as PushLog.java).
final class PushLog {
    typealias Sink = (_ text: String, _ detail: Bool) -> Void

    let file: URL?
    private var handle: FileHandle?
    private let sink: Sink?
    private let lock = NSLock()
    private var all = ""

    init(dir: URL, sink: Sink?) {
        self.sink = sink
        let fm = FileManager.default
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        let url = dir.appendingPathComponent("push-\(f.string(from: Date())).log")
        if fm.createFile(atPath: url.path, contents: nil), let h = try? FileHandle(forWritingTo: url) {
            file = url
            handle = h
        } else {
            file = nil
            handle = nil
        }
    }

    /// A line the user sees.
    func add(_ text: String) { write(text, detail: false) }

    /// A line for the log only (requests, responses).
    func detail(_ text: String) { write(text, detail: true) }

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private func write(_ text: String, detail: Bool) {
        lock.lock()
        let line = PushLog.clock.string(from: Date()) + " " + text
        all += line + "\n"
        if let h = handle, let d = (line + "\n").data(using: .utf8) { h.write(d) }
        lock.unlock()
        sink?(line, detail)
    }

    var text: String {
        lock.lock(); defer { lock.unlock() }
        return all
    }

    func close() {
        lock.lock(); defer { lock.unlock() }
        try? handle?.close()
        handle = nil
    }
}
