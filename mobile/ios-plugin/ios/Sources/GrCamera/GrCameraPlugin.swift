import Foundation
import UIKit
import CoreBluetooth
import Capacitor

/// The page's way to the camera on iOS: the same methods and events as GrCameraPlugin.java, so ui/src
/// (host-android.ts, camera.tsx) runs unchanged. Events: "found", "stage", "progress", "log", "finished",
/// "firmwareProgress". A camera's "address" here is the identifier iOS gives it (a UUID, not its MAC address).
@objc(GrCameraPlugin)
public class GrCameraPlugin: CAPPlugin, CAPBridgedPlugin, PushEvents, UIDocumentPickerDelegate {
    public let identifier = "GrCameraPlugin"
    public let jsName = "GrCamera"
    public let pluginMethods: [CAPPluginMethod] = [
        "ensurePermissions", "getStatus", "bondedCameras", "scan",
        "uploadBegin", "uploadAppend", "uploadEnd", "storeRead", "storeDelete",
        "firmwareLatest", "firmwareDownload", "firmwareCancel", "firmwarePage",
        "openUrl", "leave", "haptic", "appInfo", "start", "cancel", "shareLog", "setLanguage",
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private let hub = BleCentral.shared
    private let work = DispatchQueue(label: "grmod.plugin", qos: .userInitiated, attributes: .concurrent)
    private var firmware: URL?
    private var session: PushSession?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    // MARK: files

    private func dir(_ name: String) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("grmod", isDirectory: true)
        let d = base.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        var v = URLResourceValues()
        v.isExcludedFromBackup = true
        var b = base
        try? b.setResourceValues(v)
        return d
    }

    private static let keyPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9._-]{1,128}$")
    private static func goodKey(_ k: String) -> Bool {
        keyPattern.firstMatch(in: k, range: NSRange(location: 0, length: (k as NSString).length)) != nil
    }

    private static func move(_ from: URL, _ to: URL) throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: to.path) { try fm.removeItem(at: to) }
        try fm.moveItem(at: from, to: to)
    }

    // MARK: permissions

    private func status(_ state: CBManagerState? = nil) -> [String: Any] {
        let s = state ?? hub.settledState(timeout: 2)
        return [
            "bluetooth": s == .poweredOn,
            "permissions": hub.authorized,
            "sdk": UIDevice.current.systemVersion,
            "vpn": CameraNet.vpnActive(),
        ]
    }

    @objc func ensurePermissions(_ call: CAPPluginCall) {
        work.async {
            // Creating the manager makes iOS ask, the first time; wait for the answer.
            let s = self.hub.settledState(timeout: 90)
            if s == .unauthorized || (!self.hub.authorized && !self.hub.undetermined) {
                call.reject(L.s("未获得 Bluetooth® 权限。请在[设置] › [GR Mod]中开启蓝牙。", "Bluetooth permission was not given: turn Bluetooth on under Settings › GR Mod"), "permission")
                return
            }
            call.resolve(self.status(s))
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) { work.async { call.resolve(self.status()) } }

    /// The app's language ("zh" or "en"): the native messages (L.swift) follow it.
    static var language = "zh"
    @objc func setLanguage(_ call: CAPPluginCall) {
        GrCameraPlugin.language = call.getString("lang") == "en" ? "en" : "zh"
        L.set(GrCameraPlugin.language)
        call.resolve()
    }

    // MARK: scan

    private static func looksLikeCamera(_ name: String?, _ adv: [String: Any]?) -> Bool {
        if let n = name, n.hasPrefix("GR_") || n.uppercased().contains("RICOH") { return true }
        var ids: [CBUUID] = []
        if let a = adv?[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] { ids += a }
        if let a = adv?[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] { ids += a }
        return ids.contains(GrUUID.advInfo) || ids.contains(GrUUID.advPairing)
    }

    private static func deviceJson(_ p: CBPeripheral, _ name: String?, _ rssi: Int) -> [String: Any] {
        let remembered = PushSession.remembered()
        return [
            "address": p.identifier.uuidString,
            "name": name ?? p.name ?? remembered[p.identifier.uuidString] ?? NSNull(),
            "rssi": rssi,
            "bonded": remembered[p.identifier.uuidString] != nil,
        ]
    }

    /// Cameras this phone has paired with before, and cameras iOS is connected to now (they may not advertise
    /// while another app is connected).
    @objc func bondedCameras(_ call: CAPPluginCall) {
        work.async {
            guard self.hub.authorized else { call.reject(L.s("请先授权。", "Allow the permissions first"), "permission"); return }
            var list: [[String: Any]] = []
            var ids = Set<UUID>()
            let remembered = PushSession.remembered()
            for p in self.hub.known(remembered.keys.compactMap { UUID(uuidString: $0) }) where ids.insert(p.identifier).inserted {
                list.append(GrCameraPlugin.deviceJson(p, p.name, 0))
            }
            for p in self.hub.connected(services: [GrUUID.camera, GrUUID.wlan]) where GrCameraPlugin.looksLikeCamera(p.name, nil) && ids.insert(p.identifier).inserted {
                list.append(GrCameraPlugin.deviceJson(p, p.name, 0))
            }
            call.resolve(["devices": list])
        }
    }

    private var found: [UUID: [String: Any]] = [:]
    private let foundLock = NSLock()

    @objc func scan(_ call: CAPPluginCall) {
        work.async {
            guard self.hub.authorized else { call.reject(L.s("请先授权。", "Allow the permissions first"), "permission"); return }
            guard self.hub.settledState(timeout: 5) == .poweredOn else { call.reject(L.s("Bluetooth® 未开启", "Bluetooth is off"), "bluetooth-off"); return }
            self.foundLock.lock(); self.found = [:]; self.foundLock.unlock()
            self.hub.onDiscover = { [weak self] p, adv, rssi in
                guard let self = self else { return }
                let name = adv[CBAdvertisementDataLocalNameKey] as? String ?? p.name
                guard GrCameraPlugin.looksLikeCamera(name, adv) else { return }
                let o = GrCameraPlugin.deviceJson(p, name, rssi.intValue)
                self.foundLock.lock()
                let fresh = self.found[p.identifier] == nil
                self.found[p.identifier] = o
                self.foundLock.unlock()
                if fresh { self.notifyListeners("found", data: o) }
            }
            self.hub.startScan()
            let ms = call.getInt("ms") ?? 8000
            self.work.asyncAfter(deadline: .now() + .milliseconds(ms)) {
                self.stopScan()
                self.foundLock.lock(); let list = Array(self.found.values); self.foundLock.unlock()
                call.resolve(["devices": list])
            }
        }
    }

    private func stopScan() {
        hub.onDiscover = nil
        hub.stopScan()
    }

    // MARK: files from the page (sent in base64 chunks)

    private final class Upload {
        let file: URL
        let out: FileHandle
        init(file: URL, out: FileHandle) { self.file = file; self.out = out }
    }
    private var uploads: [String: Upload] = [:]
    private var uploadSeq = 0
    private let uploadLock = NSLock()

    @objc func uploadBegin(_ call: CAPPluginCall) {
        uploadLock.lock(); uploadSeq += 1; let id = "u\(uploadSeq)"; uploadLock.unlock()
        let f = dir("incoming").appendingPathComponent("\(id).part")
        guard FileManager.default.createFile(atPath: f.path, contents: nil), let h = try? FileHandle(forWritingTo: f) else {
            call.reject("cannot create \(f.lastPathComponent)")
            return
        }
        uploadLock.lock(); uploads[id] = Upload(file: f, out: h); uploadLock.unlock()
        call.resolve(["id": id])
    }

    @objc func uploadAppend(_ call: CAPPluginCall) {
        uploadLock.lock(); let u = uploads[call.getString("id") ?? ""]; uploadLock.unlock()
        guard let u = u else { call.reject("no such upload"); return }
        guard let d = Data(base64Encoded: call.getString("data") ?? "", options: .ignoreUnknownCharacters) else { call.reject("bad base64"); return }
        u.out.write(d)
        call.resolve()
    }

    /// Ends an upload and puts the file where `to` says: "store" (key), "push" (the file to push next),
    /// "download" (exported where the user picks, in the Files app), "jpeg" (a picture decoded into a JPEG).
    @objc func uploadEnd(_ call: CAPPluginCall) {
        uploadLock.lock(); let u = uploads.removeValue(forKey: call.getString("id") ?? ""); uploadLock.unlock()
        guard let u = u else { call.reject("no such upload"); return }
        try? u.out.close()
        let to = call.getString("to") ?? ""
        work.async {
            do {
                switch to {
                case "store":
                    let key = call.getString("key") ?? ""
                    guard GrCameraPlugin.goodKey(key) else { throw NSError(domain: "grmod", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad key"]) }
                    try GrCameraPlugin.move(u.file, self.dir("store").appendingPathComponent(key))
                    call.resolve()
                case "push":
                    let target = self.dir("firmware").appendingPathComponent("push.bin")
                    try GrCameraPlugin.move(u.file, target)
                    self.firmware = target
                    call.resolve(try FirmwareInfo.read(target).json())
                case "download":
                    self.export(u.file, name: call.getString("name") ?? "fwdc248b.bin", call: call)
                case "jpeg":
                    let outDir = self.dir("pictures")
                    for f in (try? FileManager.default.contentsOfDirectory(at: outDir, includingPropertiesForKeys: nil)) ?? [] { try? FileManager.default.removeItem(at: f) }
                    let target = outDir.appendingPathComponent("picture-\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
                    try GrCameraPlugin.toJpeg(u.file, target)
                    try? FileManager.default.removeItem(at: u.file)
                    call.resolve(["path": target.path])
                default:
                    throw NSError(domain: "grmod", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad target"])
                }
            } catch {
                try? FileManager.default.removeItem(at: u.file)
                call.reject(error.localizedDescription)
            }
        }
    }

    /// Any picture iOS can decode (HEIC / HEIF included), upright, into an sRGB JPEG of at most 4096 px.
    private static func toJpeg(_ src: URL, _ out: URL) throws {
        guard let img = UIImage(contentsOfFile: src.path), img.size.width > 0, img.size.height > 0 else {
            throw NSError(domain: "grmod", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot decode the picture"])
        }
        let w = img.size.width * img.scale, h = img.size.height * img.scale
        let k = min(1, 4096 / max(w, h))
        let size = CGSize(width: max(1, (w * k).rounded()), height: max(1, (h * k).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        format.opaque = true
        let data = UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.95) { _ in
            img.draw(in: CGRect(origin: .zero, size: size))
        }
        try data.write(to: out)
    }

    // "Save to phone": iOS has no shared Downloads folder; the user picks where the copy goes (Files app,
    // iCloud Drive, a card reader on the iPad…).
    private var exportCall: CAPPluginCall?
    private var exportTemp: URL?

    private func export(_ file: URL, name: String, call: CAPPluginCall) {
        var safe = name.replacingOccurrences(of: "[^A-Za-z0-9._ -]", with: "_", options: .regularExpression)
        if safe.isEmpty { safe = "fwdc248b.bin" }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("export-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
            let target = tmp.appendingPathComponent(safe)
            try FileManager.default.moveItem(at: file, to: target)
            DispatchQueue.main.async {
                guard let vc = self.bridge?.viewController else { call.reject("no window"); return }
                self.exportCall = call
                self.exportTemp = tmp
                let picker = UIDocumentPickerViewController(forExporting: [target], asCopy: true)
                picker.delegate = self
                picker.modalPresentationStyle = .formSheet
                vc.present(picker, animated: true)
            }
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            call.reject(error.localizedDescription)
        }
    }

    private func exportDone() {
        if let t = exportTemp { try? FileManager.default.removeItem(at: t) }
        exportTemp = nil
        exportCall = nil
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let shown = urls.first.map { "\($0.deletingLastPathComponent().lastPathComponent)/\($0.lastPathComponent)" } ?? ""
        exportCall?.resolve(["path": shown])
        exportDone()
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        exportCall?.resolve(["cancelled": true])
        exportDone()
    }

    /// A stored value: its path (the page reads it through the web view's file server), or exists = false.
    @objc func storeRead(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        guard GrCameraPlugin.goodKey(key) else { call.reject("bad key"); return }
        let f = dir("store").appendingPathComponent(key)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: f.path, isDirectory: &isDir), !isDir.boolValue else {
            call.resolve(["exists": false])
            return
        }
        let size = ((try? FileManager.default.attributesOfItem(atPath: f.path))?[.size] as? NSNumber)?.int64Value ?? 0
        call.resolve(["exists": true, "path": f.path, "size": size])
    }

    @objc func storeDelete(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        guard GrCameraPlugin.goodKey(key) else { call.reject("bad key"); return }
        try? FileManager.default.removeItem(at: dir("store").appendingPathComponent(key))
        call.resolve()
    }

    // MARK: the official firmware from Ricoh's site

    private let ricoh = Ricoh()
    private var downloading = false
    private let downloadLock = NSLock()

    private static func code(_ e: Error) -> String {
        guard let r = e as? Ricoh.RicohError else { return "network" }
        switch r.kind {
        case .noRelease: return "not-found"
        case .checksum: return "checksum"
        case .cancelled: return "cancelled"
        case .network: return "network"
        }
    }

    @objc func firmwareLatest(_ call: CAPPluginCall) {
        let model = call.getString("model") ?? ""
        work.async {
            do { call.resolve(try self.ricoh.latestJson(model)) } catch { call.reject("\(error)", GrCameraPlugin.code(error)) }
        }
    }

    /// Downloads and unpacks; resolves with the firmware file's path (read by the page through the file server).
    @objc func firmwareDownload(_ call: CAPPluginCall) {
        downloadLock.lock()
        if downloading { downloadLock.unlock(); call.reject("a download is already running", "busy"); return }
        downloading = true
        downloadLock.unlock()
        let model = call.getString("model") ?? "", version = call.getString("version")
        work.async {
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            let zip = caches.appendingPathComponent("firmware.zip"), out = caches.appendingPathComponent("firmware.bin")
            defer {
                try? FileManager.default.removeItem(at: zip)
                self.downloadLock.lock(); self.downloading = false; self.downloadLock.unlock()
            }
            do {
                let rel = try self.ricoh.chosen(model, version)
                let name = try self.ricoh.download(rel, work: zip, out: out) { received, total in
                    self.notifyListeners("firmwareProgress", data: ["received": received, "total": total])
                }
                call.resolve(["name": name, "version": rel.version, "path": out.path])
            } catch {
                call.reject("\(error)", GrCameraPlugin.code(error))
            }
        }
    }

    @objc func firmwareCancel(_ call: CAPPluginCall) { ricoh.cancel(); call.resolve() }

    /// The model's download page, for the licence terms.
    @objc func firmwarePage(_ call: CAPPluginCall) {
        let model = call.getString("model") ?? "", version = call.getString("version")
        work.async {
            do { self.open(try self.ricoh.chosen(model, version).page); call.resolve() } catch { call.reject("\(error)") }
        }
    }

    private func open(_ url: String?) {
        guard let s = url, s.hasPrefix("https://") || s.hasPrefix("http://"), let u = URL(string: s) else { return }
        DispatchQueue.main.async { UIApplication.shared.open(u) }
    }

    @objc func openUrl(_ call: CAPPluginCall) { open(call.getString("url")); call.resolve() }

    /// Android's back button leaves the app; iOS has no such thing, and apps do not close themselves.
    @objc func leave(_ call: CAPPluginCall) { call.resolve() }

    @objc func haptic(_ call: CAPPluginCall) {
        let kind = call.getString("kind")
        DispatchQueue.main.async {
            if kind == "confirm" { UIImpactFeedbackGenerator(style: .medium).impactOccurred() } else { UISelectionFeedbackGenerator().selectionChanged() }
            call.resolve()
        }
    }

    private static func machine() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { b in String(decoding: b.prefix { $0 != 0 }, as: UTF8.self) }
    }

    @objc func appInfo(_ call: CAPPluginCall) {
        call.resolve([
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "sdk": UIDevice.current.systemVersion,
            "device": "Apple \(GrCameraPlugin.machine())",
        ])
    }

    // MARK: the session

    private func line(_ text: String, _ detail: Bool) -> [String: Any] { ["text": text, "detail": detail] }

    @objc func start(_ call: CAPPluginCall) {
        work.async {
            guard self.hub.authorized else { call.reject(L.s("请先授权。", "Allow the permissions first"), "permission"); return }
            if self.session != nil { call.reject(L.s("已有推送正在进行", "A push is already running"), "busy"); return }
            guard let mode = PushSession.Mode(rawValue: (call.getString("mode") ?? "INFO").uppercased().replacingOccurrences(of: "-", with: "_")) else {
                call.reject("mode?")
                return
            }
            if mode != .INFO && self.firmware == nil { call.reject(L.s("尚未选择固件文件", "No firmware file chosen yet"), "no-file"); return }
            guard self.hub.settledState(timeout: 5) == .poweredOn else { call.reject(L.s("Bluetooth® 未开启", "Bluetooth is off"), "bluetooth-off"); return }
            guard let id = UUID(uuidString: call.getString("address") ?? ""), let p = self.hub.peripheral(id) else {
                call.reject(L.s("照相机地址不正确", "Not a camera address"), "address")
                return
            }
            self.stopScan()
            let log = PushLog(dir: self.dir("logs")) { [weak self] text, detail in self?.notifyListeners("log", data: self?.line(text, detail)) }
            log.add(L.s("GR Mod iOS，模式 ", "GR Mod iOS, mode ") + mode.rawValue + L.s("，照相机 ", ", camera ") + (p.name ?? "?") + " (\(id.uuidString)), iOS \(UIDevice.current.systemVersion) (\(GrCameraPlugin.machine()))")
            self.keepAwake(true)
            let s = PushSession(peripheral: p, file: self.firmware, mode: mode, log: log, events: self)
            self.session = s
            s.start()
            call.resolve()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) { session?.cancel(); call.resolve() }

    func stage(_ id: String, _ text: String) { notifyListeners("stage", data: ["id": id, "text": text]) }
    func progress(_ sent: Int64, _ total: Int64) { notifyListeners("progress", data: ["sent": sent, "total": total]) }
    func finished(_ result: [String: Any]) {
        session = nil
        keepAwake(false)
        notifyListeners("finished", data: result)
    }

    /// The screen stays on during a push, and iOS gives the app some extra time if it is sent to the background
    /// (joinOnce: the camera's Wi-Fi is left as soon as GR Mod is not in front).
    private func keepAwake(_ on: Bool) {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            if on && self.backgroundTask == .invalid {
                self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "grmod-push") { [weak self] in
                    guard let self = self else { return }
                    UIApplication.shared.endBackgroundTask(self.backgroundTask)
                    self.backgroundTask = .invalid
                }
            } else if !on && self.backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(self.backgroundTask)
                self.backgroundTask = .invalid
            }
        }
    }

    /// The share sheet with a log as text (to send it by mail, chat, AirDrop…).
    @objc func shareLog(_ call: CAPPluginCall) {
        let logs = dir("logs").standardizedFileURL.path
        let f = URL(fileURLWithPath: call.getString("path") ?? "").standardizedFileURL
        guard f.path.hasPrefix(logs + "/") else { call.reject("not a log"); return }
        guard let text = try? String(contentsOf: f, encoding: .utf8) else { call.reject("cannot read the log"); return }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { call.reject("no window"); return }
            let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
            if let pop = sheet.popoverPresentationController {
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            vc.present(sheet, animated: true)
            call.resolve()
        }
    }
}
