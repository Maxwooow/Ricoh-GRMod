import Foundation
import CoreBluetooth

/// One wireless firmware update, the way GR WORLD does it: a line-by-line port of PushSession.java (the
/// Android version, verified on a GR IV HDF, 2026-11-11). Keep the two in step.
///
///  1. Bluetooth: connect (iOS pairs on the first protected read: the camera must be in pairing mode),
///     WLAN NetworkType = 1 (camera Wi-Fi on), read SSID and passphrase.
///  2. Join the camera's access point; GET /v1/props, check model / version / battery against the file.
///  3. Keep ws://192.168.0.1/v1/changes open; POST /v1/configs/firmware/prepare (filesize=N);
///     PUT /v1/configs/firmware?storage=in&reboot=true with the whole file.
///  4. The camera turns Wi-Fi and Bluetooth off and shows "waiting for update". Reconnect Bluetooth and
///     write 01 to CameraService FirmwareUpdateStart (5F0A7BA9); the result comes in FirmwareUpdateResult
///     (39879AAC): 1 success, 2 failure. Without the 01 the camera gives up after a few minutes and
///     shows "processing failed", unchanged.
///
/// Nothing is retried once the PUT has started; before that every failure ends with a cancel.
protocol PushEvents: AnyObject {
    func stage(_ id: String, _ text: String)
    func progress(_ sent: Int64, _ total: Int64)
    func finished(_ result: [String: Any])
}

final class PushSession: BleListener {
    enum Mode: String { case INFO, PREPARE_TEST, PUSH }

    /// Refuse below this battery level (percent).
    static let minBattery = 50
    static let resultWindow: TimeInterval = 200       // GR WORLD waits 200 s for FirmwareUpdateResult
    static let startAfterUpload: TimeInterval = 30
    static let startAfterLink: TimeInterval = 6

    private let peripheral: CBPeripheral
    private let file: URL?
    private let mode: Mode
    private weak var ev: PushEvents?
    let log: PushLog

    private let lock = NSLock()
    private var cancelledFlag = false
    private var fwResultValue: Int?
    private var startSentFlag = false
    private var fwInvalidFlag = false

    private var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelledFlag }
    private var fwResult: Int? { lock.lock(); defer { lock.unlock() }; return fwResultValue }
    private var fwInvalid: Bool { lock.lock(); defer { lock.unlock() }; return fwInvalidFlag }

    init(peripheral: CBPeripheral, file: URL?, mode: Mode, log: PushLog, events: PushEvents) {
        self.peripheral = peripheral
        self.file = file
        self.mode = mode
        self.log = log
        self.ev = events
    }

    func start() {
        let t = Thread { [self] in run() }
        t.name = "grmod-push"
        t.start()
    }

    /// Stops before the upload; once the camera has the file there is nothing to stop.
    func cancel() { lock.lock(); cancelledFlag = true; lock.unlock() }

    private struct Cancelled: Error { }

    private struct Fail: Error {
        let code: String
        let message: String
    }

    private func check() throws { if cancelled { throw Cancelled() } }

    /// Sleeps, but wakes up for a cancel (as Thread.interrupt in the Java version).
    private func sleep(_ seconds: TimeInterval) throws {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            try check()
            Thread.sleep(forTimeInterval: min(0.1, max(0, until.timeIntervalSinceNow)))
        }
    }

    private static func text(_ d: Data) -> String {
        let b = [UInt8](d)
        let n = b.firstIndex(of: 0) ?? b.count
        return String(decoding: b[0..<n], as: UTF8.self)
    }

    static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    // MARK: BleListener (Bluetooth queue)

    func onNotify(_ uuid: CBUUID, _ value: Data) {
        let h = PushSession.hex(value)
        if uuid == GrUUID.fwResult, let v = value.first {
            log.add("FirmwareUpdateResult: \(h)" + (v == 1 ? "（成功）" : v == 2 ? "（失败）" : v == 0 ? "（invalid：相机不接受）" : ""))
            lock.lock()
            if v == 1 || v == 2 { fwResultValue = Int(v) } else if v == 0 && startSentFlag { fwInvalidFlag = true }
            lock.unlock()
        } else {
            log.detail("蓝牙通知 \(Ble.short8(uuid)): \(h)")
        }
    }

    func onDisconnected(_ reason: String) { log.detail("蓝牙断开：\(reason)") }

    // MARK: the session

    private func run() {
        var result: [String: Any] = ["mode": mode.rawValue]
        let ble = Ble(peripheral: peripheral, listener: self, log: log)
        let net = CameraNet(log: log)
        var wsOpen = false
        var prepared = false, uploaded = false
        let name = peripheral.name ?? "GR"
        defer {
            if wsOpen { net.closeChanges() }
            net.release()
            net.invalidate()
            ble.close()
            result["log"] = log.file?.path ?? NSNull()
            log.close()
            ev?.finished(result)
        }
        do {
            var info: FirmwareInfo?
            var fileSize: Int64 = 0
            if mode != .INFO {
                guard let f = file else { throw Fail(code: "file", message: "还没有选固件文件") }
                let i = try FirmwareInfo.read(f)
                info = i
                fileSize = i.size
                log.add("固件：\(i.describe())，\(i.size) 字节，SHA-256 \(i.sha256)")
                if !i.container { throw Fail(code: "file", message: i.error ?? "不是固件文件") }
            }

            // 1. Bluetooth
            ev?.stage("ble", "连接相机蓝牙…")
            try connect(ble, tries: 3)
            try check()
            // iOS pairs by itself on the first protected read and shows its dialog meanwhile.
            ev?.stage("pair", "如果手机弹出蓝牙配对请求：确认手机和相机上的数字一致，两边都按确定（已经配对过就不会弹出）")
            let nt: Data
            do {
                nt = try ble.read(GrUUID.wlan, GrUUID.networkType, timeout: 120)
            } catch let e as BleError {
                log.add("读相机 Wi-Fi 状态失败：\(e.message)")
                throw Fail(code: "ble-auth", message: "相机不接受这台手机的蓝牙连接。如果相机里已经删掉了这台手机：在 iPhone 的「设置 › 蓝牙」里点 \(name) 旁边的 ⓘ，选「忽略此设备」，再让相机进入配对状态，重新推送")
            }
            PushSession.remember(peripheral)
            ev?.stage("ble", "已连接相机蓝牙")
            if nt.isEmpty || nt[nt.startIndex] != 1 {
                try ble.write(GrUUID.wlan, GrUUID.networkType, Data([1]))
                log.add("已通过蓝牙打开相机 Wi-Fi")
                try sleep(1.5)
            }
            let ssid = PushSession.text(try ble.read(GrUUID.wlan, GrUUID.ssid))
            let pass = PushSession.text(try ble.read(GrUUID.wlan, GrUUID.passphrase))
            log.add("相机热点：\(ssid)")
            try check()

            // 2. Wi-Fi + checks
            let vpn = CameraNet.vpnActive()
            if vpn { log.add("注意：手机正在用 VPN。如果 VPN 接管了所有流量，就连不上相机 Wi-Fi 里的 192.168.0.1") }
            ev?.stage("wifi", "连接相机 Wi-Fi「\(ssid)」：请在系统弹窗里选「加入」")
            do { try net.join(ssid: ssid, passphrase: pass, timeout: 120) } catch let e as CameraNet.NetError {
                throw Fail(code: "wifi", message: e.message)
            }
            var props: CameraNet.Reply?
            let until = Date().addingTimeInterval(30)
            var lastError = ""
            while props == nil {
                try check()
                do {
                    props = try net.get("/v1/props", timeout: 10)
                } catch let e as CameraNet.NetError {
                    lastError = e.message
                    if Date() > until {
                        throw Fail(code: "wifi", message: "连上了相机 Wi-Fi，但访问不到 192.168.0.1：\(lastError)。"
                            + "请在「设置 › 隐私与安全性 › 本地网络」里打开 GR Mod" + (vpn ? "，并关掉 VPN" : "") + "，再重新推送")
                    }
                    try sleep(1)
                }
            }
            guard let p = props!.json else { throw Fail(code: "camera", message: "读不到相机信息：\(props!.describe())") }
            let model = p["model"] as? String ?? ""
            let fwVersion = p["firmwareVersion"] as? String ?? ""
            let battery = (p["battery"] as? NSNumber)?.intValue ?? -1
            let hot = (p["hot"] as? NSNumber)?.boolValue ?? false
            result["camera"] = ["model": model, "firmwareVersion": fwVersion, "battery": battery, "hot": hot, "serialNo": p["serialNo"] as? String ?? ""]
            log.add("相机：\(model)，固件 \(fwVersion)，电量 \(battery)%")
            if mode == .INFO {
                result["ok"] = true
                ev?.stage("done", "已读到相机信息")
                return
            }

            guard let info = info, let f = file else { throw Fail(code: "file", message: "还没有选固件文件") }
            guard let rec = info.modelFor(model) else {
                throw Fail(code: "model", message: "这个固件不是给 \(model) 的（文件里的机型：\(info.describe())）")
            }
            let camBase = FirmwareInfo.baseOf(fwVersion)
            if rec.base != camBase {
                throw Fail(code: "version", message: "相机是 \(fwVersion)，这个固件对它来说是 \(rec.version)。目前只支持推送同一基础版本的固件（跨版本请用存储卡更新）")
            }
            if battery >= 0 && battery < PushSession.minBattery {
                throw Fail(code: "battery", message: "相机电量 \(battery)%，请充到 \(PushSession.minBattery)% 以上再推送")
            }
            if hot { throw Fail(code: "hot", message: "相机过热，请等它凉下来") }
            try check()

            // 3. prepare + upload
            do { try net.openChanges() } catch let e as CameraNet.NetError { throw Fail(code: "wifi", message: e.message) }
            wsOpen = true
            ev?.stage("prepare", "准备上传…")
            var r: CameraNet.Reply
            do { r = try net.post("/v1/configs/firmware/prepare", form: "filesize=\(fileSize)", timeout: 60) } catch let e as CameraNet.NetError {
                throw Fail(code: "prepare", message: "prepare 没有回应：\(e.message)")
            }
            log.add("prepare：\(r.describe())")
            if !r.ok { throw Fail(code: "prepare", message: "相机没有接受：\(r.describe())") }
            prepared = true
            if mode == .PREPARE_TEST {
                cancelUpdate(net)
                prepared = false
                result["ok"] = true
                ev?.stage("done", "prepare 被接受（已取消，没有传文件）")
                return
            }
            try check()
            ev?.stage("upload", "上传固件…")
            var lastShown = Date.distantPast
            let t0 = Date()
            uploaded = true   // from here on: no cancel, no retry
            r = try net.putFile("/v1/configs/firmware?storage=in&reboot=true", file: f, timeout: 180) { done, total in
                let now = Date()
                if now.timeIntervalSince(lastShown) > 0.2 || done == total { lastShown = now; self.ev?.progress(done, total) }
            }
            let putDone = Date()
            log.add("上传：\(r.describe())，用时 \(Int(putDone.timeIntervalSince(t0))) 秒")
            if !r.ok {
                cancelUpdate(net)
                throw Fail(code: "upload", message: "相机没有接受这个固件：\(r.describe())")
            }

            // 4. the camera drops Wi-Fi and Bluetooth, then waits for FirmwareUpdateStart
            ev?.stage("waiting", "相机收到固件，正在进入「等待更新」…")
            let dropBy = Date().addingTimeInterval(40)
            while ble.isConnected && Date() < dropBy { Thread.sleep(forTimeInterval: 0.5) }
            let wsBy = Date().addingTimeInterval(15)
            while net.changesAlive && Date() < wsBy { Thread.sleep(forTimeInterval: 0.5) }
            net.closeChanges()
            wsOpen = false
            net.release()
            Thread.sleep(forTimeInterval: 2)

            ev?.stage("start", "重连蓝牙，发送「开始更新」…")
            let deadline = Date().addingTimeInterval(PushSession.startAfterUpload + PushSession.resultWindow)
            var started = false, reconnected = false
            var linkSince = Date.distantPast
            while fwResult == nil && Date() < deadline {
                if cancelled { throw Cancelled() }
                if !ble.isConnected {
                    do {
                        try ble.connect(timeout: 15)
                        log.add("蓝牙已重连")
                        reconnected = true
                        linkSince = Date()
                    } catch let e as BleError {
                        log.detail("重连失败：\(e.message)")
                        Thread.sleep(forTimeInterval: 3)
                        continue
                    }
                    do { try ble.subscribe(GrUUID.camera, GrUUID.fwResult) } catch let e as BleError { log.detail("订阅结果失败：\(e.message)") }
                    if started {
                        do {
                            let v = try ble.read(GrUUID.camera, GrUUID.fwResult)
                            log.detail("FirmwareUpdateResult 当前值 \(PushSession.hex(v))")
                            if let b = v.first, b == 1 || b == 2 { lock.lock(); fwResultValue = Int(b); lock.unlock() }
                        } catch let e as BleError { log.detail("读结果失败：\(e.message)") }
                    }
                }
                if !started && ble.isConnected {
                    if !reconnected {
                        // Bluetooth never dropped after the upload: subscribe on this link before starting.
                        do { try ble.subscribe(GrUUID.camera, GrUUID.fwResult) } catch let e as BleError { log.detail("订阅结果失败：\(e.message)") }
                        reconnected = true
                        linkSince = Date()
                    }
                    // Give the camera time to settle into "waiting for update": at least startAfterUpload after the
                    // upload and startAfterLink on the new link. It waits minutes for the start, so this costs nothing.
                    let ready = max(putDone.addingTimeInterval(PushSession.startAfterUpload), linkSince.addingTimeInterval(PushSession.startAfterLink))
                    let now = Date()
                    if now < ready {
                        log.detail("等相机准备好，\(Int(ceil(ready.timeIntervalSince(now)))) 秒后发送「开始更新」")
                        Thread.sleep(forTimeInterval: min(1, ready.timeIntervalSince(now)))
                        continue
                    }
                    do {
                        lock.lock(); startSentFlag = true; lock.unlock()
                        try ble.write(GrUUID.camera, GrUUID.fwStart, Data([1]))
                        started = true
                        result["started"] = true
                        log.add("已发送「开始更新」")
                        ev?.stage("updating", "相机正在更新固件：不要关机、不要拔电池，等它自己重启")
                    } catch let e as BleError {
                        log.detail("发送「开始更新」失败：\(e.message)")
                        Thread.sleep(forTimeInterval: 3)
                        continue
                    }
                }
                Thread.sleep(forTimeInterval: 1)
            }
            ble.close()
            if fwInvalid && fwResult == nil {
                result["ok"] = false
                result["reason"] = "start-invalid"
                ev?.stage("failed", "相机回应「开始更新」无效（invalid）。看相机屏幕：如果显示处理失败或回到正常画面，固件没有变化，可以重新推送；"
                    + "如果停在「正在更新」且进度条长时间完全不动，不要拔电池，先等几分钟再长按电源键关机重开")
            } else if fwResult == 1 {
                result["ok"] = true
                ev?.stage("done", "相机报告更新成功。等相机重启后，在设置里确认固件版本")
            } else if fwResult != nil {
                result["ok"] = false
                result["reason"] = "update-failed"
                ev?.stage("failed", "相机报告更新失败。相机的固件应该没有变化；可以重新推送，或用存储卡更新")
            } else {
                result["ok"] = false
                result["reason"] = started ? "no-result" : "not-started"
                ev?.stage("failed", started
                    ? "已发送「开始更新」，但没收到结果。相机可能还在更新：不要关机，看相机屏幕，更新完成后它会自己重启"
                    : "没能发送「开始更新」。相机会在几分钟后显示处理失败，固件不变；可以重新推送")
            }
        } catch let f as Fail {
            result["ok"] = false
            result["reason"] = f.code
            result["message"] = f.message
            log.add("停止：\(f.message)")
            if prepared && !uploaded { cancelUpdate(net) }
            ev?.stage("failed", f.message)
        } catch is Cancelled {
            result["ok"] = false
            result["reason"] = "cancelled"
            log.add("已取消")
            if prepared && !uploaded { cancelUpdate(net) }
            ev?.stage("failed", uploaded ? "已停止等待；相机可能还在处理，看相机屏幕" : "已取消")
        } catch {
            let m = "\(error)"
            result["ok"] = false
            result["reason"] = "error"
            result["message"] = m
            log.add("出错：\(m)")
            if prepared && !uploaded { cancelUpdate(net) }
            ev?.stage("failed", uploaded ? "上传期间出错（\(m)）。不要马上重试：先看相机屏幕" : "出错：\(m)")
        }
    }

    private func connect(_ ble: Ble, tries: Int) throws {
        var last: BleError?
        for i in 0..<tries {
            try check()
            do { try ble.connect(timeout: 15); return } catch let e as BleError {
                last = e
                log.detail("蓝牙连接第 \(i + 1) 次失败：\(e.message)")
                try sleep(2)
            }
        }
        throw Fail(code: "ble", message: "蓝牙连不上相机：相机开着吗？手机上的 GR WORLD 关掉了吗？（\(last?.message ?? "")）")
    }

    private func cancelUpdate(_ net: CameraNet) {
        do {
            let r = try net.post("/v1/configs/firmware/cancel", form: "", timeout: 30)
            log.add("cancel：\(r.describe())")
        } catch {
            log.add("cancel 失败：\(error)")
        }
    }

    // MARK: cameras this phone has paired with (iOS does not list them: the app remembers them)

    private static let rememberedKey = "grmod.cameras"

    static func remember(_ p: CBPeripheral) {
        var m = remembered()
        m[p.identifier.uuidString] = p.name ?? m[p.identifier.uuidString] ?? "GR"
        UserDefaults.standard.set(m, forKey: rememberedKey)
    }

    static func remembered() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: rememberedKey) as? [String: String] ?? [:]
    }
}
