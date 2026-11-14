import Foundation
import NetworkExtension

/// The camera's Wi-Fi (as CameraNet.java): joins its access point for as long as the app is in front
/// (NEHotspotConfiguration, joinOnce), and talks HTTP and WebSocket to 192.168.0.1. The access point has no
/// internet; requests here never use the cellular network, so they go to the camera or nowhere.
///
/// Two system dialogs may come up the first time: joining the camera's network, and "find devices on your local
/// network" (the first request to 192.168.0.1). Until the second one is answered, requests fail; PushSession
/// keeps trying for 30 seconds.
final class CameraNet: NSObject, URLSessionWebSocketDelegate {
    static let host = "192.168.0.1"

    struct Reply {
        let status: Int
        let body: String
        let json: [String: Any]?

        init(status: Int, body: String) {
            self.status = status
            self.body = body
            json = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any]
        }

        var ok: Bool { (json?["errCode"] as? NSNumber)?.intValue == 200 }

        func describe() -> String {
            guard let j = json else { return "HTTP \(status) \(String(body.prefix(200)))" }
            var s = "HTTP \(status)" + L.s("，errCode=", ", errCode=") + "\((j["errCode"] as? NSNumber)?.intValue ?? 0) \(j["errMsg"] as? String ?? "")"
            var d: Any? = j["detail"]
            if let o = d as? [String: Any] { d = o["reason"] }
            if let d = d, !(d is NSNull) { s += " reason=\(d)" }
            if let h = Reply.hint((d as? String) ?? (j["errMsg"] as? String)) { s += L.s("（", " (") + h + L.s("）", ")") }
            return s
        }

        static func hint(_ errMsg: String?) -> String? {
            switch errMsg ?? "" {
            case "err_fw_same": return L.s("照相机判定版本相同，已拒绝", "the camera has this version already and refused it")
            case "err_fw_old": return L.s("照相机判定版本较旧，已拒绝。若照相机显示的版本与此文件相同（例如上次更新中途停止或曾关闭电源），请使用存储卡安装一次相同文件以恢复，之后可再次无线推送。",
                "the camera takes this for an older version and refused it. If the camera shows the same version as this file (say an update got stuck and the camera was switched off), flashing the same file once from a memory card sets it right; after that, sending works again")
            case "err_fw_broken": return L.s("照相机判定文件已损坏", "the camera takes the file for damaged")
            case "battery_too_low": return L.s("照相机电池电量不足", "the camera's battery is too low")
            default: return nil
            }
        }
    }

    struct NetError: Error, CustomStringConvertible {
        let message: String
        /// iOS did not join the network (rather than: the user said no, or a request failed).
        var notJoined = false
        var description: String { message }
    }

    private let log: PushLog
    private var session: URLSession!
    private var joined: String?

    init(log: PushLog) {
        self.log = log
        super.init()
        let c = URLSessionConfiguration.ephemeral
        c.allowsCellularAccess = false          // the camera is on Wi-Fi; never send its traffic anywhere else
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpMaximumConnectionsPerHost = 2
        session = URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }

    /// True when a VPN is up (a VPN that takes all traffic can keep requests away from 192.168.0.1).
    static func vpnActive() -> Bool {
        guard let settings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any],
              let scoped = settings["__SCOPED__"] as? [String: Any] else { return false }
        return scoped.keys.contains { k in ["tap", "tun", "ppp", "ipsec", "utun"].contains { k.hasPrefix($0) } }
    }

    /// The network the device is on, if iOS tells (with the Wi-Fi information entitlement, for networks the app
    /// joined; nil otherwise).
    func currentSSID(timeout: TimeInterval = 3) -> String? {
        let sem = DispatchSemaphore(value: 0)
        var ssid: String?
        NEHotspotNetwork.fetchCurrent { n in ssid = n?.ssid; sem.signal() }
        _ = sem.wait(timeout: .now() + timeout)
        return ssid
    }

    /// Joins the camera's access point (iOS asks the user, the first time for each network). iOS reports success
    /// even when the network was not found (and shows "Unable to join the network"): where it can, the network the
    /// device is on is checked, and the join is tried again, three times in all, a few seconds apart.
    func join(ssid: String, passphrase: String, timeout: TimeInterval, cancelled: () -> Bool) throws {
        if currentSSID() == ssid {
            log.detail(L.s("已在照相机的无线局域网中", "Already on the camera's Wi-Fi"))
            return   // joined in Settings: nothing to do, and nothing of ours to remove afterwards
        }
        for attempt in 1...3 {
            if cancelled() { return }
            let conf = NEHotspotConfiguration(ssid: ssid, passphrase: passphrase, isWEP: false)
            conf.joinOnce = true
            let sem = DispatchSemaphore(value: 0)
            var failure: Error?
            NEHotspotConfigurationManager.shared.apply(conf) { e in failure = e; sem.signal() }
            if sem.wait(timeout: .now() + timeout) == .timedOut { throw NetError(message: L.s("连接照相机的无线局域网超时", "Joining the camera's Wi-Fi timed out")) }
            var refused = false
            if let e = failure as NSError? {
                if e.domain == NEHotspotConfigurationErrorDomain {
                    switch NEHotspotConfigurationError(rawValue: e.code) {
                    case .alreadyAssociated?: break
                    case .userDenied?: throw NetError(message: L.s("未连接照相机的无线局域网（已在系统提示中取消）", "Not connected to the camera's Wi-Fi (cancelled in the system prompt)"))
                    default:
                        refused = true
                        log.detail(L.s("加入无线局域网失败：", "Joining the Wi-Fi failed: ") + e.localizedDescription + " (\(e.code))")
                    }
                } else {
                    refused = true
                    log.detail(L.s("加入无线局域网失败：", "Joining the Wi-Fi failed: ") + e.localizedDescription)
                }
            }
            if !refused {
                joined = ssid
                // where iOS tells which network the device is on: wait for the camera's to come up
                var known = false
                let until = Date().addingTimeInterval(8)
                while Date() < until {
                    if cancelled() { return }
                    if let now = currentSSID(timeout: 2) {
                        known = true
                        if now == ssid {
                            log.detail(L.s("当前无线局域网：", "Current Wi-Fi: ") + now)
                            return
                        }
                    }
                    Thread.sleep(forTimeInterval: 1)
                }
                if !known { return }   // iOS does not say: the first request to the camera tells
            }
            log.add(L.s("第 \(attempt) 次加入照相机的无线局域网未成功", "Joining the camera's Wi-Fi did not work (attempt \(attempt))"))
            NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
            joined = nil
            if attempt < 3 { Thread.sleep(forTimeInterval: 3) }
        }
        throw NetError(message: L.s("未能加入照相机的无线局域网", "Could not join the camera's Wi-Fi"), notJoined: true)
    }

    /// Leaves the camera's network (the phone goes back to its own Wi-Fi).
    func release() {
        if let s = joined {
            joined = nil
            NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: s)
        }
    }

    private func request(_ method: String, _ path: String, timeout: TimeInterval) -> URLRequest {
        var r = URLRequest(url: URL(string: "http://\(CameraNet.host)\(path)")!)
        r.httpMethod = method
        r.timeoutInterval = timeout
        r.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        return r
    }

    /// What a task gave back (filled in by its completion handler).
    private final class Done {
        var data: Data?
        var response: URLResponse?
        var error: Error?
        let sem = DispatchSemaphore(value: 0)
        func set(_ d: Data?, _ r: URLResponse?, _ e: Error?) { data = d; response = r; error = e; sem.signal() }
    }

    /// Runs a task and waits for it; `tick` is called a few times a second while it runs.
    private func wait(_ task: URLSessionTask, _ done: Done, timeout: TimeInterval, tick: ((URLSessionTask) -> Void)? = nil) throws -> Reply {
        task.resume()
        let until = Date().addingTimeInterval(timeout + 15)
        while done.sem.wait(timeout: .now() + 0.2) == .timedOut {
            tick?(task)
            if Date() > until {
                task.cancel()
                _ = done.sem.wait(timeout: .now() + 5)
                throw NetError(message: L.s("照相机无回应（超时）", "The camera did not answer (timed out)"))
            }
        }
        tick?(task)
        if let e = done.error { throw NetError(message: e.localizedDescription) }
        return Reply(status: (done.response as? HTTPURLResponse)?.statusCode ?? 0, body: String(decoding: done.data ?? Data(), as: UTF8.self))
    }

    func get(_ path: String, timeout: TimeInterval) throws -> Reply {
        let done = Done()
        let t = session.dataTask(with: request("GET", path, timeout: timeout)) { d, r, e in done.set(d, r, e) }
        let r = try wait(t, done, timeout: timeout)
        log.detail("GET \(path) -> \(r.status) \(CameraNet.clip(r.body))")
        return r
    }

    func post(_ path: String, form: String, timeout: TimeInterval) throws -> Reply {
        var req = request("POST", path, timeout: timeout)
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let body = Data(form.utf8)
        let done = Done()
        let t = session.uploadTask(with: req, from: body) { d, r, e in done.set(d, r, e) }
        let r = try wait(t, done, timeout: timeout)
        log.detail("POST \(path) [\(form)] -> \(r.status) \(CameraNet.clip(r.body))")
        return r
    }

    /// One PUT of the whole file, as GR WORLD does it.
    func putFile(_ path: String, file: URL, timeout: TimeInterval, progress: @escaping (Int64, Int64) -> Void) throws -> Reply {
        var req = request("PUT", path, timeout: timeout)
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let total = ((try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? NSNumber)?.int64Value ?? 0
        let done = Done()
        let t = session.uploadTask(with: req, fromFile: file) { d, r, e in done.set(d, r, e) }
        let r = try wait(t, done, timeout: timeout, tick: { task in progress(task.countOfBytesSent, total) })
        log.detail("PUT \(path) (\(total)" + L.s(" 字节) -> ", " bytes) -> ") + "\(r.status) \(CameraNet.clip(r.body))")
        return r
    }

    static func clip(_ s: String) -> String { s.count > 1500 ? String(s.prefix(1500)) + "…" : s }

    // MARK: ws://192.168.0.1/v1/changes
    //
    // The camera cancels a firmware update when this closes while the file is still coming in, so it stays
    // open for the whole push. A ping every 10 seconds; the camera's pings are answered by URLSession.

    private var ws: URLSessionWebSocketTask?
    private var wsOpen: DispatchSemaphore?
    private var pinger: DispatchSourceTimer?
    private let wsLock = NSLock()
    private var wsAlive = false

    var changesAlive: Bool { wsLock.lock(); defer { wsLock.unlock() }; return wsAlive }

    func openChanges() throws {
        let sem = DispatchSemaphore(value: 0)
        let t = session.webSocketTask(with: URL(string: "ws://\(CameraNet.host)/v1/changes")!)
        wsLock.lock(); ws = t; wsOpen = sem; wsLock.unlock()
        t.resume()
        if sem.wait(timeout: .now() + 10) == .timedOut || t.state != .running {
            t.cancel()
            throw NetError(message: L.s("WebSocket 握手失败", "WebSocket handshake failed"))
        }
        wsLock.lock(); wsAlive = true; wsLock.unlock()
        log.detail(L.s("WebSocket 已连接 /v1/changes", "WebSocket open: /v1/changes"))
        receive(t)
        let p = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        p.schedule(deadline: .now() + 10, repeating: 10)
        p.setEventHandler { [weak self, weak t] in
            t?.sendPing { e in if let e = e { self?.log.detail(L.s("WebSocket ping 失败：", "WebSocket ping failed: ") + e.localizedDescription) } }
        }
        p.resume()
        pinger = p
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let m):
                switch m {
                case .string(let s): self.log.detail("[changes] \(CameraNet.clip(s))")
                case .data(let d): self.log.detail("[changes] \(CameraNet.clip(String(decoding: d, as: UTF8.self)))")
                @unknown default: break
                }
                self.receive(t)
            case .failure(let e):
                self.log.detail(L.s("WebSocket 断开：", "WebSocket closed: ") + e.localizedDescription)
                self.wsLock.lock(); self.wsAlive = false; self.wsLock.unlock()
            }
        }
    }

    func closeChanges() {
        pinger?.cancel()
        pinger = nil
        wsLock.lock()
        let t = ws
        ws = nil
        wsAlive = false
        wsLock.unlock()
        t?.cancel(with: .normalClosure, reason: nil)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        wsLock.lock(); let s = wsOpen; wsOpen = nil; wsLock.unlock()
        s?.signal()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        log.detail(L.s("照相机已关闭 WebSocket（", "The camera closed the WebSocket (") + "\(closeCode.rawValue)" + L.s("）", ")"))
        wsLock.lock(); wsAlive = false; wsLock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task is URLSessionWebSocketTask else { return }
        wsLock.lock(); let s = wsOpen; wsOpen = nil; wsAlive = false; wsLock.unlock()
        s?.signal()   // a failed handshake ends the wait at once (t.state then is not .running)
    }

    func invalidate() {
        closeChanges()
        session.invalidateAndCancel()
    }
}
