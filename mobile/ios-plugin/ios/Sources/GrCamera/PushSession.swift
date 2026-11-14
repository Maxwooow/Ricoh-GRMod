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
        /// Shown with the message but kept out of the log (the camera's Wi-Fi password).
        var shownOnly: String = ""
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
            log.add("FirmwareUpdateResult: \(h)" + (v == 1 ? L.s("（成功）", " (success)") : v == 2 ? L.s("（失败）", " (failure)") : v == 0 ? L.s("（invalid：照相机未接受）", " (invalid: the camera did not take it)") : ""))
            lock.lock()
            if v == 1 || v == 2 { fwResultValue = Int(v) } else if v == 0 && startSentFlag { fwInvalidFlag = true }
            lock.unlock()
        } else {
            log.detail(L.s("Bluetooth® 通知 ", "Bluetooth notification ") + "\(Ble.short8(uuid)): \(h)")
        }
    }

    func onDisconnected(_ reason: String) { log.detail(L.s("Bluetooth® 断开：", "Bluetooth dropped: ") + reason) }

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
            result["uploaded"] = uploaded   // the page offers to try again only when nothing was sent
            log.close()
            ev?.finished(result)
        }
        do {
            var info: FirmwareInfo?
            var fileSize: Int64 = 0
            if mode != .INFO {
                guard let f = file else { throw Fail(code: "file", message: L.s("尚未选择固件文件", "No firmware file chosen yet")) }
                let i = try FirmwareInfo.read(f)
                info = i
                fileSize = i.size
                log.add(L.s("固件：", "Firmware: ") + i.describe() + L.s("，", ", ") + "\(i.size)" + L.s(" 字节，SHA-256 ", " bytes, SHA-256 ") + i.sha256)
                if !i.container { throw Fail(code: "file", message: i.error ?? L.s("不是固件文件", "Not a firmware file")) }
            }

            // 1. Bluetooth
            ev?.stage("ble", L.s("正在通过 Bluetooth® 连接照相机…", "Connecting to the camera over Bluetooth…"))
            try connect(ble, tries: 3)
            try check()
            // iOS pairs by itself on the first protected read and shows its dialog meanwhile.
            ev?.stage("pair", L.s("配对：如出现 Bluetooth® 配对请求，请确认设备与照相机显示的验证码一致，并在两端确认（已配对时不会出现）。", "Pairing: if a Bluetooth pairing request comes up, check that the device and the camera show the same number, and confirm on both (it does not come up once paired)"))
            let nt: Data
            do {
                nt = try ble.read(GrUUID.wlan, GrUUID.networkType, timeout: 120)
            } catch let e as BleError {
                log.add(L.s("读取照相机无线局域网状态失败：", "Reading the camera's Wi-Fi state failed: ") + e.message)
                throw Fail(code: "ble-auth", message: L.s("照相机不接受此设备的 Bluetooth® 连接。若已在照相机中删除此设备，请在[设置] › [蓝牙]中轻触 \(name) 旁的 ⓘ，选择[忽略此设备]，再将照相机设为配对状态并重新推送。",
                    "The camera does not accept this device over Bluetooth. If the device was removed in the camera: in Settings › Bluetooth tap ⓘ next to \(name), choose Forget This Device, put the camera in pairing mode and send again"))
            }
            PushSession.remember(peripheral)
            ev?.stage("ble", L.s("已通过 Bluetooth® 连接照相机", "Connected to the camera over Bluetooth"))
            var wifiJustOn = false
            if nt.isEmpty || nt[nt.startIndex] != 1 {
                try ble.write(GrUUID.wlan, GrUUID.networkType, Data([1]))
                log.add(L.s("已通过 Bluetooth® 开启照相机无线局域网", "Camera Wi-Fi turned on over Bluetooth"))
                wifiJustOn = true
                try sleep(1.5)
            }
            let ssid = PushSession.text(try ble.read(GrUUID.wlan, GrUUID.ssid))
            let pass = PushSession.text(try ble.read(GrUUID.wlan, GrUUID.passphrase))
            log.add(L.s("照相机热点：", "Camera network: ") + ssid)
            try check()

            // 2. Wi-Fi + checks
            let vpn = CameraNet.vpnActive()
            if vpn { log.add(L.s("注意：设备正在使用 VPN。若 VPN 接管全部流量，则无法连接照相机无线局域网中的 192.168.0.1", "Note: a VPN is on. If it takes all traffic, 192.168.0.1 on the camera's Wi-Fi cannot be reached")) }
            ev?.stage("wifi", L.s("正在连接照相机的无线局域网[\(ssid)]。请在系统提示中轻触[加入]。", "Connecting to the camera's Wi-Fi “\(ssid)”: tap Join when the system asks"))
            // iOS does not wait for a network to appear: a camera that has only just turned its Wi-Fi on is given a
            // few seconds first (joining too early fails with "Unable to join the network").
            if wifiJustOn { try sleep(4) }
            let manual = Fail(code: "wifi-join",
                              message: L.s("无法自动加入照相机的无线局域网[\(ssid)]。请在[设置] › [无线局域网]中手动加入，再轻触[重试]。",
                                           "Could not join the camera's Wi-Fi “\(ssid)” by itself. Join it under Settings › Wi-Fi, then tap Retry."),
                              shownOnly: L.s("（密码：\(pass)）", " (password: \(pass))"))
            do {
                try net.join(ssid: ssid, passphrase: pass, timeout: 120, cancelled: { [weak self] in self?.cancelled ?? true })
            } catch let e as CameraNet.NetError {
                if e.notJoined { throw manual }
                throw Fail(code: "wifi", message: e.message)
            }
            try check()
            var props: CameraNet.Reply?
            let until = Date().addingTimeInterval(30)
            var lastError = ""
            var otherNetwork = false
            while props == nil {
                try check()
                do {
                    let r = try net.get("/v1/props", timeout: 10)
                    // something else answers at 192.168.0.1 (the router of the network the device stayed on)
                    if r.json?["model"] == nil {
                        otherNetwork = true
                        if Date() > until { throw manual }
                        try sleep(1)
                        continue
                    }
                    props = r
                } catch let e as CameraNet.NetError {
                    lastError = e.message
                    if Date() > until {
                        if otherNetwork { throw manual }
                        throw Fail(code: "wifi", message: L.s("已连接照相机的无线局域网，但无法访问 192.168.0.1：\(lastError)。"
                            + "请在[设置] › [隐私与安全性] › [本地网络]中开启 GR Mod" + (vpn ? "，并关闭 VPN" : "") + "，再重新推送。",
                            "On the camera's Wi-Fi, but 192.168.0.1 cannot be reached: \(lastError). "
                            + "Turn GR Mod on under Settings › Privacy & Security › Local Network" + (vpn ? " and switch the VPN off" : "") + ", then send again"))
                    }
                    try sleep(1)
                }
            }
            guard let p = props!.json else { throw Fail(code: "camera", message: L.s("无法读取照相机信息：", "Cannot read the camera's details: ") + props!.describe()) }
            let model = p["model"] as? String ?? ""
            let fwVersion = p["firmwareVersion"] as? String ?? ""
            let battery = (p["battery"] as? NSNumber)?.intValue ?? -1
            let hot = (p["hot"] as? NSNumber)?.boolValue ?? false
            result["camera"] = ["model": model, "firmwareVersion": fwVersion, "battery": battery, "hot": hot, "serialNo": p["serialNo"] as? String ?? ""] as [String: Any]
            log.add(L.s("照相机：", "Camera: ") + model + L.s("，固件 ", ", firmware ") + fwVersion + L.s("，电池电量 ", ", battery ") + "\(battery)%")
            if mode == .INFO {
                result["ok"] = true
                ev?.stage("done", L.s("已读取照相机信息", "Camera details read"))
                return
            }

            guard let info = info, let f = file else { throw Fail(code: "file", message: L.s("尚未选择固件文件", "No firmware file chosen yet")) }
            guard let rec = info.modelFor(model) else {
                throw Fail(code: "model", message: L.s("此固件不适用于 \(model)（文件中的机型：\(info.describe())）", "This firmware is not for the \(model) (models in the file: \(info.describe()))"))
            }
            let camBase = FirmwareInfo.baseOf(fwVersion)
            if rec.base != camBase {
                throw Fail(code: "version", message: L.s("照相机当前版本为 \(fwVersion)，此固件对应版本为 \(rec.version)。目前仅支持推送同一基础版本的固件；跨版本时，请使用存储卡更新。",
                    "The camera runs \(fwVersion); for it this firmware is \(rec.version). Only a firmware of the same base version can be sent (across versions, update from a memory card)"))
            }
            if battery >= 0 && battery < PushSession.minBattery {
                throw Fail(code: "battery", message: L.s("照相机电池电量为 \(battery)%。请充电至 \(PushSession.minBattery)% 以上后再推送。", "The camera's battery is at \(battery)%: charge it above \(PushSession.minBattery)% first"))
            }
            if hot { throw Fail(code: "hot", message: L.s("照相机过热，请等待其冷却。", "The camera is too hot: let it cool down")) }
            try check()

            // 3. prepare + upload
            do { try net.openChanges() } catch let e as CameraNet.NetError { throw Fail(code: "wifi", message: e.message) }
            wsOpen = true
            ev?.stage("prepare", L.s("正在准备上传…", "Preparing the upload…"))
            var r: CameraNet.Reply
            do { r = try net.post("/v1/configs/firmware/prepare", form: "filesize=\(fileSize)", timeout: 60) } catch let e as CameraNet.NetError {
                throw Fail(code: "prepare", message: L.s("prepare 无回应：", "No answer to prepare: ") + e.message)
            }
            log.add(L.s("prepare：", "prepare: ") + r.describe())
            if !r.ok { throw Fail(code: "prepare", message: L.s("照相机未接受：", "The camera did not accept it: ") + r.describe()) }
            prepared = true
            if mode == .PREPARE_TEST {
                cancelUpdate(net)
                prepared = false
                result["ok"] = true
                ev?.stage("done", L.s("prepare 已接受（已取消，未传输文件）", "prepare accepted (cancelled, no file sent)"))
                return
            }
            try check()
            ev?.stage("upload", L.s("正在上传固件…", "Uploading the firmware…"))
            var lastShown = Date.distantPast
            let t0 = Date()
            uploaded = true   // from here on: no cancel, no retry
            r = try net.putFile("/v1/configs/firmware?storage=in&reboot=true", file: f, timeout: 180) { done, total in
                let now = Date()
                if now.timeIntervalSince(lastShown) > 0.2 || done == total { lastShown = now; self.ev?.progress(done, total) }
            }
            let putDone = Date()
            log.add(L.s("上传：", "Upload: ") + r.describe() + L.s("，耗时 ", ", ") + "\(Int(putDone.timeIntervalSince(t0)))" + L.s(" 秒", " s"))
            if !r.ok {
                cancelUpdate(net)
                throw Fail(code: "upload", message: L.s("照相机未接受此固件：", "The camera did not accept this firmware: ") + r.describe())
            }

            // 4. the camera drops Wi-Fi and Bluetooth, then waits for FirmwareUpdateStart
            ev?.stage("waiting", L.s("照相机已接收固件，正在准备更新…", "The camera has the firmware and is getting ready to update…"))
            let dropBy = Date().addingTimeInterval(40)
            while ble.isConnected && Date() < dropBy { Thread.sleep(forTimeInterval: 0.5) }
            let wsBy = Date().addingTimeInterval(15)
            while net.changesAlive && Date() < wsBy { Thread.sleep(forTimeInterval: 0.5) }
            net.closeChanges()
            wsOpen = false
            net.release()
            Thread.sleep(forTimeInterval: 2)

            ev?.stage("start", L.s("正在开始更新…", "Starting the update…"))
            let deadline = Date().addingTimeInterval(PushSession.startAfterUpload + PushSession.resultWindow)
            var started = false, reconnected = false
            var linkSince = Date.distantPast
            while fwResult == nil && Date() < deadline {
                if cancelled { throw Cancelled() }
                if !ble.isConnected {
                    do {
                        try ble.connect(timeout: 15)
                        log.add(L.s("Bluetooth® 已重新连接", "Bluetooth reconnected"))
                        reconnected = true
                        linkSince = Date()
                    } catch let e as BleError {
                        log.detail(L.s("重新连接失败：", "Reconnecting failed: ") + e.message)
                        Thread.sleep(forTimeInterval: 3)
                        continue
                    }
                    do { try ble.subscribe(GrUUID.camera, GrUUID.fwResult) } catch let e as BleError { log.detail(L.s("订阅结果失败：", "Subscribing to the result failed: ") + e.message) }
                    if started {
                        do {
                            let v = try ble.read(GrUUID.camera, GrUUID.fwResult)
                            log.detail(L.s("FirmwareUpdateResult 当前值 ", "FirmwareUpdateResult now ") + PushSession.hex(v))
                            if let b = v.first, b == 1 || b == 2 { lock.lock(); fwResultValue = Int(b); lock.unlock() }
                        } catch let e as BleError { log.detail(L.s("读取结果失败：", "Reading the result failed: ") + e.message) }
                    }
                }
                if !started && ble.isConnected {
                    if !reconnected {
                        // Bluetooth never dropped after the upload: subscribe on this link before starting.
                        do { try ble.subscribe(GrUUID.camera, GrUUID.fwResult) } catch let e as BleError { log.detail(L.s("订阅结果失败：", "Subscribing to the result failed: ") + e.message) }
                        reconnected = true
                        linkSince = Date()
                    }
                    // Give the camera time to settle into "waiting for update": at least startAfterUpload after the
                    // upload and startAfterLink on the new link. It waits minutes for the start, so this costs nothing.
                    let ready = max(putDone.addingTimeInterval(PushSession.startAfterUpload), linkSince.addingTimeInterval(PushSession.startAfterLink))
                    let now = Date()
                    if now < ready {
                        log.detail(L.s("等待照相机准备就绪，\(Int(ceil(ready.timeIntervalSince(now)))) 秒后发送[开始更新]", "Waiting for the camera: \"start update\" in \(Int(ceil(ready.timeIntervalSince(now)))) s"))
                        Thread.sleep(forTimeInterval: min(1, ready.timeIntervalSince(now)))
                        continue
                    }
                    do {
                        lock.lock(); startSentFlag = true; lock.unlock()
                        try ble.write(GrUUID.camera, GrUUID.fwStart, Data([1]))
                        started = true
                        result["started"] = true
                        log.add(L.s("已发送[开始更新]", "\"Start update\" sent"))
                        ev?.stage("updating", L.s("正在更新固件。请勿关闭照相机电源或取出电池，并等待照相机自动重启。", "Updating the firmware: do not switch the camera off or take the battery out; it restarts by itself"))
                    } catch let e as BleError {
                        log.detail(L.s("发送[开始更新]失败：", "Sending \"start update\" failed: ") + e.message)
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
                ev?.stage("failed", L.s("照相机返回[开始更新]无效（invalid）。若显示处理失败或返回正常画面，固件未发生变更，可重新推送；"
                    + "若停留在[正在更新]且进度条长时间不动，请勿取出电池。请等待数分钟，再长按电源按钮关闭照相机后重试。",
                    "The camera answered \"start update\" with invalid. If it shows that processing failed, or goes back to its normal screen, "
                    + "the firmware has not changed and you can send again; if it stays on \"updating\" with the bar not moving for a long time, "
                    + "do not take the battery out: wait a few minutes, then hold the power button to switch it off and try again"))
            } else if fwResult == 1 {
                result["ok"] = true
                ev?.stage("done", L.s("照相机固件更新成功。", "The camera updated successfully."))
            } else if fwResult != nil {
                result["ok"] = false
                result["reason"] = "update-failed"
                ev?.stage("failed", L.s("照相机报告更新失败。固件可能未发生变更。请重新推送，或使用存储卡更新。", "The camera reports that the update failed. Its firmware should be unchanged; send again, or update from a memory card"))
            } else {
                result["ok"] = false
                result["reason"] = started ? "no-result" : "not-started"
                ev?.stage("failed", started
                    ? L.s("已发送[开始更新]，但未收到结果。照相机可能仍在更新。", "\"Start update\" was sent, but no result came back. The camera may still be updating")
                    : L.s("未能发送[开始更新]。照相机将在数分钟后显示处理失败，固件不会发生变更；可重新推送。", "\"Start update\" could not be sent. In a few minutes the camera shows that processing failed, with its firmware unchanged; you can send again"))
            }
        } catch let f as Fail {
            result["ok"] = false
            result["reason"] = f.code
            result["message"] = f.message
            log.add(L.s("停止：", "Stopped: ") + f.message)
            if prepared && !uploaded { cancelUpdate(net) }
            ev?.stage("failed", f.message + f.shownOnly)
        } catch is Cancelled {
            result["ok"] = false
            result["reason"] = "cancelled"
            log.add(L.s("已取消", "Cancelled"))
            if prepared && !uploaded { cancelUpdate(net) }
            ev?.stage("failed", uploaded ? L.s("已停止等待。照相机可能仍在处理，请查看照相机显示屏", "Stopped waiting; the camera may still be at work: look at its screen") : L.s("已取消", "Cancelled"))
        } catch {
            let m = "\(error)"
            result["ok"] = false
            result["reason"] = "error"
            result["message"] = m
            log.add(L.s("错误：", "Error: ") + m)
            if prepared && !uploaded { cancelUpdate(net) }
            ev?.stage("failed", uploaded ? L.s("上传期间发生错误（\(m)）。请勿立即重试，请先查看照相机显示屏", "Error during the upload (\(m)). Do not try again at once: look at the camera's screen first") : L.s("错误：", "Error: ") + m)
        }
    }

    private func connect(_ ble: Ble, tries: Int) throws {
        var last: BleError?
        for i in 0..<tries {
            try check()
            do { try ble.connect(timeout: 15); return } catch let e as BleError {
                last = e
                log.detail(L.s("第 \(i + 1) 次 Bluetooth® 连接失败：", "Bluetooth connection attempt \(i + 1) failed: ") + e.message)
                try sleep(2)
            }
        }
        throw Fail(code: "ble", message: L.s("无法通过 Bluetooth® 连接照相机。请确认照相机已开启，并已退出此设备上的 GR WORLD。（", "Cannot connect to the camera over Bluetooth: is it on? Is GR WORLD closed on this device? (") + (last?.message ?? "") + L.s("）", ")"))
    }

    private func cancelUpdate(_ net: CameraNet) {
        do {
            let r = try net.post("/v1/configs/firmware/cancel", form: "", timeout: 30)
            log.add(L.s("cancel：", "cancel: ") + r.describe())
        } catch {
            log.add(L.s("cancel 失败：", "cancel failed: ") + "\(error)")
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
