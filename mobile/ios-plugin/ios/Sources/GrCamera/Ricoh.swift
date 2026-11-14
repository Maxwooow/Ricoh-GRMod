import Foundation
import CryptoKit
import ZIPFoundation

/// The official firmware on RICOH IMAGING's site: the same as Ricoh.java (a port of the desktop shell's
/// shell/internal/ricoh/ricoh.go). The release is read from the site's pages every time; the releases GR Mod
/// also builds on that are no longer listed are fetched by their fixed addresses. Every request stays on the
/// site's host. All calls block; run them off the main thread.
final class Ricoh: NSObject, URLSessionDataDelegate {
    static let site = URL(string: "https://www.ricoh-imaging.co.jp")!
    static let indexPath = "/english/support/download_digital.html"
    static let maxPage = 4 << 20
    static let maxArchive: Int64 = 160 << 20, maxFirmware: Int64 = 160 << 20

    struct Release {
        var model = "", name = "", applies = "", version = "", date = "", page = "", file = "", url = ""
        var sha256: String?
        var size: Int64 = 0

        func json() -> [String: Any] {
            ["model": model, "name": name, "applies": applies, "version": version, "date": date, "page": page, "file": file, "size": size]
        }
    }

    struct RicohError: Error, CustomStringConvertible {
        enum Kind { case noRelease, checksum, network, cancelled }
        let kind: Kind
        let message: String
        var description: String { message }
        static let noRelease = RicohError(kind: .noRelease, message: "no firmware is listed for this model")
    }

    static let models: [String: String] = [
        "GR3": "GR III", "GR3_HDF": "GR III HDF", "GR3X": "GR IIIx", "GR3X_HDF": "GR IIIx HDF",
        "STANDARD": "GR IV", "HDF": "GR IV HDF", "MONO": "GR IV Monochrome",
    ]

    static let fw = "/resources/japan/support/download/digital/FIRMWARE/"

    static func pin(_ name: String, _ applies: String, _ version: String, _ date: String, _ file: String, _ size: Int64, _ sha: String?, _ page: String) -> Release {
        var r = Release()
        r.name = name; r.applies = applies; r.version = version; r.date = date; r.file = file; r.url = fw + file
        r.size = size; r.sha256 = sha; r.page = page
        return r
    }

    /// The releases GR Mod builds on, per model, newest first (SHA-256 of the archives as in Ricoh.java).
    static let supported: [String: [Release]] = {
        let gr4Page = "/english/support/digital/gr4_s.html", gr4Applies = "RICOH GR IV / RICOH GR IV HDF"
        let gr4 = [
            pin("GR IV", gr4Applies, "1.20", "", "gr4_v120.zip", 34702809, "dcc1b6fb004f0d855bb46b30a529da894c7b717501276fec2d198b3d7eb76a59", gr4Page),
            pin("GR IV", gr4Applies, "1.11", "2026/02/13", "gr4_v111.zip", 34478368, "ded47aa6385886e4b1f8f41f8551866ab0f1ecd0aef89934a43ef0e456539e8f", gr4Page),
        ]
        let mono = [
            pin("GR IV Monochrome", "RICOH GR IV Monochrome", "1.10", "", "gr4_mono_v110.zip", 34702809, "bde05b3bf56a29c272284556d6795cb772eaccbbd0091d433fd52368d4d8af12", "/english/support/digital/gr-4-mono_s.html"),
        ]
        let gr3Applies = "RICOH GR III / GR III Street Edition / GR III Diary Edition / GR III HDF", gr3Page = "/english/support/digital/gr3_s.html"
        let gr3 = [
            pin("GR III", gr3Applies, "2.20", "", "gr3_v220.zip", 28599247, "7b19f9c03f2448c2b674fb919f6a86d22d6d83801521a9c1226a0e20cf0b5a2f", gr3Page),
            pin("GR III", gr3Applies, "2.10", "2025/10/23", "gr3_v210.zip", 0, nil, gr3Page),
        ]
        let gr3xApplies = "RICOH GR IIIx / GR IIIx Urban Edition / GR IIIx HDF", gr3xPage = "/english/support/digital/gr3x_s.html"
        let gr3x = [
            pin("GR IIIx", gr3xApplies, "1.70", "", "gr3x_v170.zip", 28599250, "6a028e90b4f23c9e9af968b03bca5032b71f460be85fd2c49f4078366a71dc6d", gr3xPage),
            pin("GR IIIx", gr3xApplies, "1.60", "2025/10/23", "gr3x_v160.zip", 0, nil, gr3xPage),
        ]
        return ["STANDARD": gr4, "HDF": gr4, "MONO": mono, "GR3": gr3, "GR3_HDF": gr3, "GR3X": gr3x, "GR3X_HDF": gr3x]
    }()

    static func baseModel(_ model: String) -> String {
        if model == "GR3X" || model == "GR3X_HDF" { return "GR IIIx" }
        if model == "GR3" || model == "GR3_HDF" { return "GR III" }
        return "GR IV"
    }

    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 40
        c.httpAdditionalHeaders = ["User-Agent": "GRMod"]
        return URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }()

    private let lock = NSLock()
    private var cancelled = false
    private var active: URLSessionTask?

    func cancel() {
        lock.lock(); cancelled = true; let t = active; lock.unlock()
        t?.cancel()
    }

    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    // MARK: HTTP, on the site only

    private func onSite(_ u: URL?) -> Bool {
        guard let u = u else { return false }
        return u.scheme?.lowercased() == Ricoh.site.scheme && u.host?.lowercased() == Ricoh.site.host?.lowercased()
    }

    func resolve(_ from: URL, _ href: String) throws -> URL {
        let h = href.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: " ", with: "%20")
        guard let u = URL(string: h, relativeTo: from)?.absoluteURL, var c = URLComponents(url: u, resolvingAgainstBaseURL: false) else {
            throw RicohError(kind: .network, message: "unusable link \(href)")
        }
        c.fragment = nil
        guard let out = c.url, onSite(out) else { throw RicohError(kind: .network, message: "link leaves the site: \(u)") }
        return out
    }

    private final class Done {
        var data: Data?, response: URLResponse?, error: Error?
        let sem = DispatchSemaphore(value: 0)
    }

    /// One small request, waited for.
    private func fetch(_ u: URL, method: String = "GET", range: String? = nil) throws -> (Data, HTTPURLResponse) {
        if isCancelled { throw RicohError(kind: .cancelled, message: "cancelled") }
        var r = URLRequest(url: u)
        r.httpMethod = method
        if let range = range { r.setValue(range, forHTTPHeaderField: "Range") }
        let done = Done()
        let t = session.dataTask(with: r) { d, resp, e in done.data = d; done.response = resp; done.error = e; done.sem.signal() }
        lock.lock(); active = t; lock.unlock()
        t.resume()
        done.sem.wait()
        lock.lock(); active = nil; lock.unlock()
        if let e = done.error { throw RicohError(kind: isCancelled ? .cancelled : .network, message: e.localizedDescription) }
        guard let resp = done.response as? HTTPURLResponse else { throw RicohError(kind: .network, message: "\(u): no answer") }
        if !onSite(resp.url) { throw RicohError(kind: .network, message: "redirected away from the site: \(resp.url?.absoluteString ?? "")") }
        return (done.data ?? Data(), resp)
    }

    private func page(_ u: URL) throws -> String {
        let (d, resp) = try fetch(u)
        if resp.statusCode != 200 { throw RicohError(kind: .network, message: "\(u): HTTP \(resp.statusCode)") }
        if d.count > Ricoh.maxPage { throw RicohError(kind: .network, message: "\(u): page is too large") }
        return String(decoding: d, as: UTF8.self)
    }

    /// The archive's size without fetching it (HEAD, else a one-byte range); 0 when the site says neither.
    private func size(_ u: URL) -> Int64 {
        if let head = try? fetch(u, method: "HEAD"), head.1.statusCode == 200, head.1.expectedContentLength > 0 { return head.1.expectedContentLength }
        if let one = try? fetch(u, range: "bytes=0-0"), one.1.statusCode == 206,
           let cr = one.1.value(forHTTPHeaderField: "Content-Range"), let m = Ricoh.first(#"^bytes \d+-\d+/(\d+)$"#, cr), let n = Int64(m[1]) {
            return n
        }
        return 0
    }

    // MARK: the pages

    static func regex(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }
    static let rowRe = regex(#"(?is)<tr\b[^>]*>(.*?)</tr>"#)
    static let cellRe = regex(#"(?is)<t[dh]\b[^>]*>(.*?)</t[dh]>"#)
    static let tagRe = regex(#"(?s)<[^>]*>"#)
    static let hrefRe = regex(#"(?is)<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']"#)
    static let versionRe = regex(#"^\d{1,2}\.\d{1,3}$"#)
    static let dateRe = regex(#"\d{4}/\d{1,2}/\d{1,2}"#)
    static let spaceRe = regex("[\\s\\u00a0\\u3000]+")
    static let commentRe = regex(#"(?s)<!--.*?-->"#)
    static let kbRe = regex(#"(?i)([0-9][0-9,]*)\s*KB\b"#)
    static let entityRe = regex(#"&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});"#)

    /// The groups of the first match (index 0 = the whole match).
    static func first(_ pattern: String, _ s: String) -> [String]? { groups(regex(pattern), s) }

    static func groups(_ re: NSRegularExpression, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }

    static func all(_ re: NSRegularExpression, _ s: String) -> [[String]] {
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { m in
            (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
        }
    }

    static func replace(_ re: NSRegularExpression, _ s: String, _ with: String) -> String {
        re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: with)
    }

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool { groups(re, s) != nil }

    /// HTML character references (the named ones these pages use, and numeric ones).
    static func unescape(_ s: String) -> String {
        if !s.contains("&") { return s }
        let ns = s as NSString
        var out = ""
        var last = 0
        for m in entityRe.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let e = ns.substring(with: m.range(at: 1))
            var r: String?
            if e.hasPrefix("#x") || e.hasPrefix("#X") {
                if let v = UInt32(e.dropFirst(2), radix: 16), let u = Unicode.Scalar(v) { r = String(Character(u)) }
            } else if e.hasPrefix("#") {
                if let v = UInt32(e.dropFirst()), let u = Unicode.Scalar(v) { r = String(Character(u)) }
            }
            if r == nil {
                switch e {
                case "amp": r = "&"
                case "lt": r = "<"
                case "gt": r = ">"
                case "quot": r = "\""
                case "apos": r = "'"
                case "nbsp": r = "\u{00a0}"
                default: r = ns.substring(with: m.range)
                }
            }
            out += r!
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    static func text(_ fragment: String) -> String {
        replace(spaceRe, unescape(replace(tagRe, fragment, " ")), " ").trimmingCharacters(in: .whitespaces)
    }

    struct Row { var cells: [String] = []; var href = "" }

    static func rows(_ page: String) -> [Row] {
        let p = replace(commentRe, page, "")
        var out: [Row] = []
        for m in all(rowRe, p) {
            var r = Row()
            r.cells = all(cellRe, m[1]).map { text($0[1]) }
            if let h = groups(hrefRe, m[1]) { r.href = unescape(h[1]) }
            if !r.cells.isEmpty { out.append(r) }
        }
        return out
    }

    static func eq(_ a: String, _ b: String) -> Bool { a.caseInsensitiveCompare(b) == .orderedSame }

    static func names(_ cell: String, _ name: String) -> Bool {
        if eq(cell, name) { return true }
        return cell.split(separator: "/", omittingEmptySubsequences: false).contains { eq($0.trimmingCharacters(in: .whitespaces), name) }
    }

    static func indexEntry(_ list: [Row], _ name: String) -> (href: String, version: String)? {
        for r in list where names(r.cells[0], name) && !r.href.isEmpty {
            for i in stride(from: r.cells.count - 1, through: 1, by: -1) where matches(versionRe, r.cells[i]) {
                return (r.href, r.cells[i])
            }
        }
        return nil
    }

    static func field(_ list: [Row], _ label: String) -> String {
        list.first { $0.cells.count >= 2 && eq($0.cells[0], label) }?.cells[1] ?? ""
    }

    static func appliesTo(_ applies: String, _ name: String) -> Bool {
        for part in applies.components(separatedBy: CharacterSet(charactersIn: "/,、;")) {
            var p = part.trimmingCharacters(in: .whitespaces)
            if p.count > 6 && eq(String(p.prefix(6)), "RICOH ") { p = String(p.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
            if eq(p, name) { return true }
        }
        return false
    }

    static func archiveLink(_ page: String) -> String {
        for m in all(hrefRe, replace(commentRe, page, "")) {
            let h = unescape(m[1])
            let path = (h.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? h).lowercased()
            if path.hasSuffix(".zip") { return h }
        }
        return ""
    }

    static func statedSize(_ registered: String) -> Int64 {
        guard let m = groups(kbRe, registered), let n = Int64(m[1].replacingOccurrences(of: ",", with: "")) else { return 0 }
        return n <= 0 || n > maxArchive / 1024 ? 0 : n * 1024
    }

    private func current(_ model: String, _ name: String) throws -> Release? {
        let index = Ricoh.site.appendingPathComponent(String(Ricoh.indexPath.dropFirst()))
        let list = Ricoh.rows(try page(index))
        let base = Ricoh.baseModel(model)
        var candidates = [name]
        if name != base { candidates.append(base) }
        for rowName in candidates {
            guard let e = Ricoh.indexEntry(list, rowName) else { continue }
            let pageURL = try resolve(index, e.href)
            let body = try page(pageURL)
            let fields = Ricoh.rows(body)
            let applies = Ricoh.field(fields, "Applied product")
            if rowName != name && !Ricoh.appliesTo(applies, name) { continue }
            let link = Ricoh.archiveLink(body)
            if link.isEmpty { throw RicohError(kind: .network, message: "\(pageURL): no download link found") }
            let file = try resolve(pageURL, link)
            var r = Release()
            r.model = model; r.name = rowName; r.applies = applies; r.version = e.version
            r.date = Ricoh.groups(Ricoh.dateRe, Ricoh.field(fields, "Release date"))?[0] ?? ""
            r.page = pageURL.absoluteString
            r.file = file.lastPathComponent
            r.url = file.absoluteString
            r.size = size(file)
            if r.size == 0 { r.size = Ricoh.statedSize(Ricoh.field(fields, "Registered name")) }
            return r
        }
        return nil
    }

    private func supportedRelease(_ model: String, _ r: Release) -> Release {
        var c = r
        c.model = model
        c.url = URL(string: r.url, relativeTo: Ricoh.site)!.absoluteString
        c.page = URL(string: r.page, relativeTo: Ricoh.site)!.absoluteString
        if c.size == 0, let u = URL(string: c.url) { c.size = size(u) }
        return c
    }

    private var cache: [String: (at: Date, release: Release?, fallback: Release?)] = [:]
    private let cacheLock = NSLock()

    /// (release, fallback): what the site offers now and, beside it, a release GR Mod builds on (see Ricoh.java).
    /// Cached for 10 minutes.
    func release(_ model: String) throws -> (Release?, Release?) {
        cacheLock.lock()
        if let c = cache[model], Date().timeIntervalSince(c.at) < 600 { cacheLock.unlock(); return (c.release, c.fallback) }
        cacheLock.unlock()
        lock.lock(); cancelled = false; lock.unlock()
        guard let name = Ricoh.models[model] else { throw RicohError(kind: .network, message: "unknown model") }
        let sup = Ricoh.supported[model] ?? []
        var cur: Release?
        do { cur = try current(model, name) } catch { if sup.isEmpty { throw error }; cur = nil }
        var fb: Release?
        if !sup.isEmpty {
            var i = -1
            if let c = cur { for (k, s) in sup.enumerated() where s.version == c.version { i = k } }
            if i >= 0 {
                if cur!.url.hasSuffix("/" + sup[i].file) { cur!.sha256 = sup[i].sha256 }
                if i + 1 < sup.count { fb = supportedRelease(model, sup[i + 1]) }
            } else {
                fb = supportedRelease(model, sup[0])
            }
        }
        if cur == nil && fb == nil { throw RicohError.noRelease }
        cacheLock.lock(); cache[model] = (Date(), cur, fb); cacheLock.unlock()
        return (cur, fb)
    }

    /// The JSON of GET /api/firmware/latest.
    func latestJson(_ model: String) throws -> [String: Any] {
        let (rel, fb) = try release(model)
        guard let r = rel else { return fb!.json() }
        var o = r.json()
        if let f = fb { o["fallback"] = f.json() }
        return o
    }

    func chosen(_ model: String, _ version: String?) throws -> Release {
        let (rel, fb) = try release(model)
        let v = version ?? ""
        let pick: Release
        if let f = fb, rel == nil || (!v.isEmpty && v == f.version) { pick = f } else { pick = rel! }
        if !v.isEmpty && pick.version != v { throw RicohError.noRelease }
        return pick
    }

    // MARK: the download

    private var sink: FileHandle?
    private var hasher = SHA256()
    private var received: Int64 = 0
    private var total: Int64 = 0
    private var tooLarge = false
    private var progress: ((Int64, Int64) -> Void)?
    private var lastShown = Date.distantPast

    static let firmwareName = regex(#"(?i)^fwdc[0-9a-z]{2,8}\.bin$"#)

    /// Downloads the archive to `work`, checks it, and unpacks the firmware file into `out`. Returns its name.
    func download(_ rel: Release, work: URL, out: URL, progress: @escaping (Int64, Int64) -> Void) throws -> String {
        lock.lock(); cancelled = false; lock.unlock()
        guard let u = URL(string: rel.url), onSite(u) else { throw RicohError(kind: .network, message: "download address is not on the site: \(rel.url)") }
        FileManager.default.createFile(atPath: work.path, contents: nil)
        let h = try FileHandle(forWritingTo: work)
        sink = h
        hasher = SHA256()
        received = 0
        total = rel.size
        tooLarge = false
        self.progress = progress
        lastShown = .distantPast
        let done = Done()
        var r = URLRequest(url: u)
        r.httpMethod = "GET"
        let t = session.dataTask(with: r)
        lock.lock(); active = t; lock.unlock()
        lock.lock(); doneFor[t.taskIdentifier] = done; lock.unlock()
        t.resume()
        done.sem.wait()
        lock.lock(); active = nil; lock.unlock()
        try? h.close()
        sink = nil
        self.progress = nil
        if isCancelled { throw RicohError(kind: .cancelled, message: "cancelled") }
        if tooLarge { throw RicohError(kind: .network, message: "archive is too large") }
        if let e = done.error { throw RicohError(kind: .network, message: e.localizedDescription) }
        guard let resp = done.response as? HTTPURLResponse else { throw RicohError(kind: .network, message: "no answer") }
        if !onSite(resp.url) { throw RicohError(kind: .network, message: "redirected away from the site") }
        if resp.statusCode != 200 { throw RicohError(kind: .network, message: "\(u): HTTP \(resp.statusCode)") }
        if resp.expectedContentLength > 0 && received != resp.expectedContentLength {
            throw RicohError(kind: .network, message: "download ended after \(received) of \(resp.expectedContentLength) bytes")
        }
        if let want = rel.sha256 {
            let got = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            if got.lowercased() != want.lowercased() { throw RicohError(kind: .checksum, message: "the archive is not the expected file") }
        }
        return try Ricoh.unpack(work, out)
    }

    private var doneFor: [Int: Done] = [:]

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let n = response.expectedContentLength
        if n > Ricoh.maxArchive { tooLarge = true; completionHandler(.cancel); return }
        if n > 0 { total = n }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if isCancelled { dataTask.cancel(); return }
        received += Int64(data.count)
        if received > Ricoh.maxArchive { tooLarge = true; dataTask.cancel(); return }
        sink?.write(data)
        hasher.update(data: data)
        let now = Date()
        if now.timeIntervalSince(lastShown) >= 0.15 { lastShown = now; progress?(received, total) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let found = doneFor.removeValue(forKey: task.taskIdentifier); lock.unlock()
        guard let done = found else { return }
        done.response = task.response
        done.error = error
        done.sem.signal()
    }

    /// Redirects stay on the site.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(onSite(request.url) ? request : nil)
    }

    static func unpack(_ zip: URL, _ out: URL) throws -> String {
        let archive: Archive
        do { archive = try Archive(url: zip, accessMode: .read, pathEncoding: nil) } catch {
            throw RicohError(kind: .network, message: "the archive cannot be read: \(error.localizedDescription)")
        }
        var found: String?
        for entry in archive where entry.type == .file {
            let path = entry.path.replacingOccurrences(of: "\\", with: "/")
            let name = String(path.split(separator: "/").last ?? "")
            if !matches(firmwareName, name) { continue }
            if found != nil { throw RicohError(kind: .network, message: "the archive holds more than one firmware file") }
            found = name
            FileManager.default.createFile(atPath: out.path, contents: nil)
            let h = try FileHandle(forWritingTo: out)
            defer { try? h.close() }
            var n: Int64 = 0
            _ = try archive.extract(entry) { data in
                n += Int64(data.count)
                if n > maxFirmware { throw RicohError(kind: .network, message: "firmware file has an unusable size") }
                h.write(data)
            }
            if n == 0 { throw RicohError(kind: .network, message: "firmware file has an unusable size") }
        }
        guard let f = found else { throw RicohError(kind: .network, message: "the archive holds no firmware file") }
        return f
    }
}
