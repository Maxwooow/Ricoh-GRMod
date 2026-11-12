import Foundation
import CryptoKit

/// What a firmware file (fwdc248b.bin) says about itself: the same reading as FirmwareInfo.java.
///
/// Container (see core/src/fw/container.ts): 0x80-byte header ("RICOH" at 0, project number at 0x30, the
/// project's version bytes at 0x38), then the LZ stream, then one 0x80-byte record per camera model, then a
/// 0x18-byte footer (proj|proj<<16, A55A5AA5, type, stream length, decoded length, checksum).
/// A model record: u32 model number, then four version bytes, two more copies, the name at 0x1C.
struct FirmwareInfo {
    static let HDR = 0x80, FOOTER = 0x18, RECORD = 0x80
    static let MAGIC: UInt32 = 0xA55A5AA5

    /// The official files we know, by SHA-256.
    static func knownOfficial(_ sha: String) -> String? {
        sha == "7563d7e462f0c53b6ab2fbab7cdfbbb57151a41192ee82f4f3a2108f9d77650d" ? "GR IV 官方 1.20" : nil
    }

    struct Model {
        let number: UInt32
        let name: String      // "GR IV", "GR IV HDF", "GR IV Monochrome"
        let version: String   // "1.20.10.11"
        /// "1.20"
        var base: String { FirmwareInfo.baseOf(version) }
    }

    let size: Int64
    let sha256: String
    let official: String?
    let container: Bool
    let error: String?
    let fileName: String?
    let version: String?
    let date: String?
    let models: [Model]

    static func baseOf(_ version: String) -> String {
        let p = version.split(separator: ".", omittingEmptySubsequences: false)
        return p.count >= 2 ? "\(p[0]).\(p[1])" : version
    }

    static func versionOf(_ b: [UInt8], _ off: Int) -> String {
        String(format: "%d.%02d.%d.%d", b[off], b[off + 1], b[off + 2], b[off + 3])
    }

    static func cstr(_ b: [UInt8], _ off: Int, _ len: Int) -> String {
        var end = off
        while end < off + len && end < b.count && b[end] != 0 { end += 1 }
        return String(decoding: b[off..<end], as: UTF8.self)
    }

    static func u32(_ b: [UInt8], _ off: Int) -> UInt32 {
        UInt32(b[off]) | UInt32(b[off + 1]) << 8 | UInt32(b[off + 2]) << 16 | UInt32(b[off + 3]) << 24
    }

    private static func bad(_ size: Int64, _ sha: String, _ why: String) -> FirmwareInfo {
        FirmwareInfo(size: size, sha256: sha, official: knownOfficial(sha), container: false, error: why,
                     fileName: nil, version: nil, date: nil, models: [])
    }

    static func read(_ url: URL) throws -> FirmwareInfo {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let sha = try sha256(url)
        if size < Int64(HDR + FOOTER + RECORD) { return bad(size, sha, "文件太小，不是固件") }
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        func at(_ off: Int64, _ n: Int) throws -> [UInt8] {
            try h.seek(toOffset: UInt64(off))
            let d = h.readData(ofLength: n)
            if d.count != n { throw NSError(domain: "grmod", code: 1, userInfo: [NSLocalizedDescriptionKey: "读文件失败"]) }
            return [UInt8](d)
        }
        let head = try at(0, HDR)
        if cstr(head, 0, 8) != "RICOH" { return bad(size, sha, "不是理光固件文件（开头不是 RICOH）") }
        let foot = try at(size - Int64(FOOTER), FOOTER)
        let proj2 = u32(foot, 0), magic = u32(foot, 4), streamLen = Int64(u32(foot, 12))
        let project = u32(head, 0x30)
        if magic != MAGIC || proj2 != (project | (project << 16)) { return bad(size, sha, "文件尾不对（不是完整的固件文件）") }
        let start = (Int64(HDR) + streamLen + 3) & ~Int64(3)
        let end = size - Int64(FOOTER)
        if start > end || (end - start) % Int64(RECORD) != 0 || end - start > Int64(16 * RECORD) { return bad(size, sha, "机型记录区不对") }
        var models: [Model] = []
        var o = start
        while o < end {
            let rec = try at(o, RECORD)
            models.append(Model(number: u32(rec, 0), name: cstr(rec, 0x1c, 0x40), version: versionOf(rec, 4)))
            o += Int64(RECORD)
        }
        return FirmwareInfo(size: size, sha256: sha, official: knownOfficial(sha), container: true, error: nil,
                            fileName: cstr(head, 8, 8), version: versionOf(head, 0x38), date: cstr(head, 0x58, 0x18), models: models)
    }

    /// The record for a camera, by the model name /v1/props reports ("RICOH GR IV HDF").
    func modelFor(_ cameraModel: String?) -> Model? {
        guard var m = cameraModel?.trimmingCharacters(in: .whitespaces) else { return nil }
        if m.hasPrefix("RICOH ") { m = String(m.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
        return models.first { $0.name.caseInsensitiveCompare(m) == .orderedSame }
    }

    static func sha256(_ url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = SHA256()
        while true {
            let d = h.readData(ofLength: 1 << 16)
            if d.isEmpty { break }
            hasher.update(data: d)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    func describe() -> String {
        if !container { return error ?? "" }
        var s = "\(fileName ?? "") \(version ?? "")，生成于 \(date ?? "")；机型："
        s += models.map { "\($0.name) \($0.version)" }.joined(separator: "、")
        if let o = official { s += "（\(o)）" }
        return s
    }

    func json() -> [String: Any] {
        [
            "size": size,
            "sha256": sha256,
            "container": container,
            "error": error ?? NSNull(),
            "official": official ?? NSNull(),
            "version": version ?? NSNull(),
            "date": date ?? NSNull(),
            "describe": describe(),
            "models": models.map { ["name": $0.name, "version": $0.version] },
        ]
    }
}
