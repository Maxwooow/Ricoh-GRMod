import Foundation
import CoreBluetooth

struct BleError: Error, CustomStringConvertible {
    let message: String
    /// CoreBluetooth's own error, when there is one (e.g. CBError.peerRemovedPairingInformation).
    var underlying: NSError? = nil
    var description: String { message }
}

/// The app's one CBCentralManager. Its callbacks run on `queue`; scans and connections are handed to it from
/// any thread. Creating it is what makes iOS ask for Bluetooth the first time.
final class BleCentral: NSObject, CBCentralManagerDelegate {
    static let shared = BleCentral()

    let queue = DispatchQueue(label: "grmod.ble")
    private var manager: CBCentralManager?
    private var links: [UUID: Ble] = [:]
    /// Peripherals seen while scanning, kept so they can be connected to by identifier.
    private(set) var seen: [UUID: CBPeripheral] = [:]
    var onDiscover: ((CBPeripheral, [String: Any], NSNumber) -> Void)?

    /// The manager, created on first use.
    var central: CBCentralManager {
        if let m = manager { return m }
        let m = CBCentralManager(delegate: self, queue: queue, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        manager = m
        return m
    }

    var authorized: Bool { CBManager.authorization == .allowedAlways }
    var undetermined: Bool { CBManager.authorization == .notDetermined }

    /// Waits until iOS knows whether Bluetooth is usable (the first time, until the user answered the prompt).
    func settledState(timeout: TimeInterval) -> CBManagerState {
        let c = central
        let until = Date().addingTimeInterval(timeout)
        while true {
            let s = queue.sync { c.state }
            if s != .unknown && s != .resetting { return s }
            if Date() > until { return s }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }

    func register(_ link: Ble) { queue.async { self.links[link.peripheral.identifier] = link } }
    func unregister(_ link: Ble) {
        queue.async { if self.links[link.peripheral.identifier] === link { self.links[link.peripheral.identifier] = nil } }
    }

    /// The peripheral for a camera's identifier (from a scan, or one iOS still knows).
    func peripheral(_ id: UUID) -> CBPeripheral? {
        queue.sync {
            if let p = seen[id] { return p }
            return central.retrievePeripherals(withIdentifiers: [id]).first
        }
    }

    func known(_ ids: [UUID]) -> [CBPeripheral] { queue.sync { central.retrievePeripherals(withIdentifiers: ids) } }
    func connected(services: [CBUUID]) -> [CBPeripheral] { queue.sync { central.retrieveConnectedPeripherals(withServices: services) } }

    func startScan() {
        queue.async {
            let c = self.central
            if c.isScanning { c.stopScan() }
            c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        }
    }

    func stopScan() { queue.async { if self.manager?.isScanning == true { self.manager?.stopScan() } } }

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) { }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        seen[peripheral.identifier] = peripheral
        onDiscover?(peripheral, advertisementData, RSSI)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        links[peripheral.identifier]?.didConnect()
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        links[peripheral.identifier]?.didFailToConnect(error)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        links[peripheral.identifier]?.didDisconnect(error)
    }
}

protocol BleListener: AnyObject {
    func onNotify(_ uuid: CBUUID, _ value: Data)
    func onDisconnected(_ reason: String)
}

/// One GATT connection to the camera, used from a single worker thread: every call blocks until the camera
/// answered (as Ble.java). Pairing is iOS's own: the first read of a protected characteristic makes iOS show
/// its pairing dialog, and the read finishes once the user confirmed.
final class Ble: NSObject, CBPeripheralDelegate {
    let peripheral: CBPeripheral
    private weak var listener: BleListener?
    private let log: PushLog
    private let hub = BleCentral.shared

    // State below is touched on hub.queue only.
    private var connectedFlag = false
    private var connectSem: DispatchSemaphore?
    private var connectError: Error?
    private var discoverSem: DispatchSemaphore?
    private var discoverPending = 0
    private var discoverError: Error?
    private var opSem: DispatchSemaphore?
    private var opChar: CBUUID?
    private var opKind = ""
    private var opValue: Data?
    private var opError: Error?

    init(peripheral: CBPeripheral, listener: BleListener, log: PushLog) {
        self.peripheral = peripheral
        self.listener = listener
        self.log = log
    }

    var isConnected: Bool { hub.queue.sync { connectedFlag && peripheral.state == .connected } }

    // MARK: called by BleCentral on its queue

    func didConnect() {
        connectedFlag = true
        connectSem?.signal()
    }

    func didFailToConnect(_ error: Error?) {
        connectedFlag = false
        connectError = error
        connectSem?.signal()
        log.add("蓝牙连接失败：\(error?.localizedDescription ?? "?")")
    }

    func didDisconnect(_ error: Error?) {
        let was = connectedFlag
        connectedFlag = false
        connectSem?.signal()
        if discoverSem != nil { discoverError = error ?? BleError(message: "蓝牙断开"); discoverSem?.signal() }
        if opSem != nil { opError = error ?? BleError(message: "蓝牙断开"); opSem?.signal() }
        if was { listener?.onDisconnected(error?.localizedDescription ?? "-") }
    }

    // MARK: operations (worker thread)

    /// Connects and discovers the services and their characteristics.
    func connect(timeout: TimeInterval) throws {
        close()
        let sem = DispatchSemaphore(value: 0)
        hub.register(self)
        hub.queue.sync {
            connectSem = sem
            connectError = nil
            connectedFlag = false
            peripheral.delegate = self
            hub.central.connect(peripheral, options: nil)
        }
        let waited = sem.wait(timeout: .now() + timeout)
        let ok = hub.queue.sync { () -> Bool in connectSem = nil; return connectedFlag }
        if waited == .timedOut || !ok {
            close()
            throw BleError(message: "蓝牙连不上相机" + (connectError.map { "（\($0.localizedDescription)）" } ?? ""))
        }
        let dsem = DispatchSemaphore(value: 0)
        hub.queue.sync {
            discoverSem = dsem
            discoverError = nil
            discoverPending = 0
            peripheral.discoverServices([GrUUID.wlan, GrUUID.camera])
        }
        let dw = dsem.wait(timeout: .now() + 15)
        let err = hub.queue.sync { () -> Error? in discoverSem = nil; return discoverError }
        if dw == .timedOut { throw BleError(message: "读不到相机的蓝牙服务（超时）") }
        if let e = err { throw BleError(message: "读不到相机的蓝牙服务（\(e.localizedDescription)）", underlying: e as NSError) }
    }

    private func find(_ svc: CBUUID, _ ch: CBUUID) throws -> CBCharacteristic {
        try hub.queue.sync {
            guard connectedFlag else { throw BleError(message: "没有蓝牙连接") }
            guard let s = peripheral.services?.first(where: { $0.uuid == svc }),
                  let c = s.characteristics?.first(where: { $0.uuid == ch }) else {
                throw BleError(message: "相机没有特征值 \(ch.uuidString)")
            }
            return c
        }
    }

    /// Runs one GATT operation and waits for its answer.
    private func run(_ what: String, _ ch: CBUUID, timeout: TimeInterval, _ start: @escaping () -> Void) throws -> Data? {
        let sem = DispatchSemaphore(value: 0)
        hub.queue.sync {
            opSem = sem
            opChar = ch
            opKind = what
            opValue = nil
            opError = nil
            start()
        }
        let w = sem.wait(timeout: .now() + timeout)
        let (value, error, alive) = hub.queue.sync { () -> (Data?, Error?, Bool) in
            opSem = nil
            opChar = nil
            return (opValue, opError, connectedFlag)
        }
        if w == .timedOut { throw BleError(message: "\(what) 超时") }
        if let e = error { throw BleError(message: "\(what) 失败（\(e.localizedDescription)）", underlying: e as NSError) }
        if !alive { throw BleError(message: "\(what) 时蓝牙断开") }
        return value
    }

    /// `timeout` is long for the first read of a protected value: iOS shows its pairing dialog meanwhile.
    func read(_ svc: CBUUID, _ ch: CBUUID, timeout: TimeInterval = 10) throws -> Data {
        let c = try find(svc, ch)
        return try run("读 \(Ble.short8(ch))", ch, timeout: timeout) { self.peripheral.readValue(for: c) } ?? Data()
    }

    func write(_ svc: CBUUID, _ ch: CBUUID, _ value: Data) throws {
        let c = try find(svc, ch)
        _ = try run("写 \(Ble.short8(ch))", ch, timeout: 10) { self.peripheral.writeValue(value, for: c, type: .withResponse) }
    }

    func subscribe(_ svc: CBUUID, _ ch: CBUUID) throws {
        let c = try find(svc, ch)
        _ = try run("订阅 \(Ble.short8(ch))", ch, timeout: 10) { self.peripheral.setNotifyValue(true, for: c) }
    }

    func close() {
        hub.queue.sync {
            connectedFlag = false
            if peripheral.state == .connected || peripheral.state == .connecting {
                hub.central.cancelPeripheralConnection(peripheral)
            }
        }
        hub.unregister(self)
    }

    static func short8(_ u: CBUUID) -> String { String(u.uuidString.prefix(8)).uppercased() }

    // MARK: CBPeripheralDelegate (hub.queue)

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let e = error { discoverError = e; discoverSem?.signal(); return }
        let services = peripheral.services ?? []
        if services.isEmpty { discoverError = BleError(message: "相机没有提供服务"); discoverSem?.signal(); return }
        discoverPending = services.count
        for s in services { peripheral.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let e = error, discoverError == nil { discoverError = e }
        discoverPending -= 1
        if discoverPending <= 0 { discoverSem?.signal() }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if opSem != nil, opChar == characteristic.uuid, opKind.hasPrefix("读") {
            opValue = characteristic.value
            opError = error
            opSem?.signal()
            return
        }
        if error == nil, let v = characteristic.value { listener?.onNotify(characteristic.uuid, v) }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if opSem != nil, opChar == characteristic.uuid { opError = error; opSem?.signal() }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if opSem != nil, opChar == characteristic.uuid { opError = error; opSem?.signal() }
    }
}

/// The camera's Bluetooth UUIDs (see PushSession.java and GrCameraPlugin.java).
enum GrUUID {
    static let advInfo = CBUUID(string: "9a5ed1c5-74cc-4c50-b5b6-66a48e7ccff1")
    static let advPairing = CBUUID(string: "0f291746-0c80-4726-87a7-3c501fd3b4b6")
    static let wlan = CBUUID(string: "f37f568f-9071-445d-a938-5441f2e82399")
    static let networkType = CBUUID(string: "9111cdd0-9f01-45c4-a2d4-e09e8fb0424d")
    static let ssid = CBUUID(string: "90638e5a-e77d-409d-b550-78f7e1ca5ab4")
    static let passphrase = CBUUID(string: "0f38279c-fe9e-461b-8596-81287e8c9a81")
    static let camera = CBUUID(string: "4b445988-caa0-4dd3-941d-37b4f52aca86")
    static let fwStart = CBUUID(string: "5f0a7ba9-ae46-4645-abac-58ab2a1f4fe4")
    static let fwResult = CBUUID(string: "39879aac-0af6-44b5-afbb-ca50053fa575")
}
