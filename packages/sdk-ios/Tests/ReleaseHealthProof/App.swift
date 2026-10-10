// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import UIKit
import EverframeKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    static var mode = ""
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let args = ProcessInfo.processInfo.arguments
        func argument(_ name: String) -> String? { guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else { return nil }; return args[index + 1] }
        guard let mode = argument("--mode"), let key = argument("--key"), let nonce = argument("--nonce"),
              let endpoint = argument("--endpoint").flatMap(URL.init(string:)), endpoint.scheme == "http", endpoint.host == "127.0.0.1" else {
            fatalError("Qualification requires an explicit loopback endpoint and synthetic key")
        }
        LoopbackTransport.endpoint = endpoint
        LoopbackTransport.logURL = Self.markers.appendingPathComponent("transport-" + nonce + ".jsonl")
        URLProtocol.registerClass(LoopbackTransport.self)
        NativeProofInstallTransport(LoopbackTransport.self)
        Self.mode = mode
        let documents = Self.markers
        func ready(_ state: [String: Any]) {
            try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]).write(
                to: documents.appendingPathComponent("ready-" + nonce + ".json"), options: .atomic)
        }
        // Refuse to run any capture or drain if the SDK's actual upload session
        // does not contain our interceptor. No fallthrough to live services.
        guard [ReportSubmitter.makeIsolatedSession().configuration, URLSessionConfiguration.ephemeral].allSatisfy({ configuration in
            configuration.protocolClasses?.contains(where: { NSStringFromClass($0) == NSStringFromClass(LoopbackTransport.self) }) == true
        }) else { ready(["error": "SDK upload session is not loopback isolated"]); return true }
        let original = mode == "fatal"
        do {
            try Everframe.shared.start(config: .init(sdkKey: key, release: original ? "release-A" : "release-B",
                capture: .init(logs: false, crash: mode != "off" && mode != "health-only"), companionBadgeEnabled: false,
                shakeToReportEnabled: false, installIdentifierEnabled: false, vitals: .init(enabled: false)))
            Everframe.shared.setUser(.init(id: original ? "user-A" : "user-B"))
        } catch { ready(["error": String(describing: error)]); return true }
        Task { @MainActor in
            let configuration = try! ReleaseHealthConfiguration(nativeBuildId: original ? "native-A" : "native-B",
                loadedBuildId: nil, loadedBundleStatus: .notApplicable)
            var healthReady = false
            if mode == "off" {
                healthReady = await Everframe.shared.setReleaseHealth(nil)
            } else {
                for _ in 0..<300 {
                    healthReady = await Everframe.shared.setReleaseHealth(configuration)
                    if healthReady { break }
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
            }
            if mode == "off" || mode == "health-only" {
                ready(["enabled": NativeProofRecorderEnabled(), "healthReady": healthReady, "mode": mode]); return
            }
            for _ in 0..<300 {
                if NativeProofRecorderEnabled() {
                    ready(["enabled": true, "healthReady": healthReady, "mode": mode])
                    if original { try? await Task.sleep(nanoseconds: 300_000_000); Self.crash("swift") }
                    if mode == "recover" {
                        Task { @MainActor in
                            let trigger = documents.appendingPathComponent("submit-" + nonce)
                            for _ in 0..<600 {
                                if FileManager.default.fileExists(atPath: trigger.path) {
                                    Everframe.shared.captureException(NSError(domain: "ReleaseHealthProgress", code: 812,
                                        userInfo: [NSLocalizedDescriptionKey: "synthetic report while health is held"]))
                                    return
                                }
                                try? await Task.sleep(nanoseconds: 100_000_000)
                            }
                        }
                    }
                    return
                }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            ready(["error": "Native capture did not become ready"])
        }
        return true
    }
    static let faults = ["swift", "objc", "memory"]
    // The installed-delivery harness reads iOS markers from Documents. tvOS apps cannot write
    // Documents, so on tvOS they live in Caches.
    #if os(tvOS)
    static let markers = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    #else
    static let markers = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    #endif
    static func crash(_ fault: String) {
        switch fault {
        case "swift": fatalError("synthetic startup Swift trap")
        case "objc": NativeProofObjCException()
        case "memory": NativeProofMemoryFault()
        default: fatalError("Unknown fault")
        }
    }
}

/// Apps built with the iOS/tvOS 27 SDKs must use the scene life cycle or the
/// 27 runtimes refuse to launch them. The SDK still starts in the app delegate.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let controller = UIViewController() // systemBackground is unavailable on tvOS.
        controller.view.backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? .black : .white }
        let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 20
        let label = UILabel(); label.text = "Release health proof: " + AppDelegate.mode; label.numberOfLines = 0
        stack.addArrangedSubview(label)
        for fault in AppDelegate.faults {
            // Primary action covers a tap on iOS and a remote select on tvOS.
            let button = UIButton(type: .system); button.setTitle("Trigger " + fault, for: .normal)
            button.addAction(UIAction { _ in AppDelegate.crash(fault) }, for: .primaryActionTriggered); stack.addArrangedSubview(button)
        }
        stack.translatesAutoresizingMaskIntoConstraints = false; controller.view.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor), stack.widthAnchor.constraint(equalToConstant: 300)])
        let window = UIWindow(windowScene: scene); window.rootViewController = controller; window.makeKeyAndVisible(); self.window = window
    }
}

/// Test-host-only transport: every non-loopback HTTP request is intercepted.
/// Only ingest bytes are forwarded to the explicit loopback API. This preserves
/// Release SDK routing/serialization without contacting any production service.
final class LoopbackTransport: URLProtocol, @unchecked Sendable {
    static var endpoint: URL!
    static var logURL: URL!
    private static let logLock = NSLock()
    static func record(_ value: [String: Any]) {
        logLock.lock(); defer { logLock.unlock() }
        guard let url = logURL, let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        var data = (try? Data(contentsOf: url)) ?? Data(); data.append(bytes); data.append(10)
        try? data.write(to: url, options: .atomic)
    }
    private var uploadTask: URLSessionDataTask?
    private var session: URLSession?
    override class func canInit(with request: URLRequest) -> Bool {
        ["http", "https"].contains(request.url?.scheme ?? "") && request.url?.host != "127.0.0.1"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.record(["phase": "request", "url": request.url?.absoluteString ?? "", "method": request.httpMethod ?? ""])
        guard ["/api/ingest", "/api/ingest/release-health"].contains(request.url?.path ?? "") else {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8)); client?.urlProtocolDidFinishLoading(self); return
        }
        var forwarded = request
        forwarded.url = Self.endpoint.appendingPathComponent(String(request.url!.path.dropFirst()))
        if forwarded.httpBody == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = Data(), buffer = [UInt8](repeating: 0, count: 16_384)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count < 0 { client?.urlProtocol(self, didFailWithError: stream.streamError ?? URLError(.cannotDecodeRawData)); return }
                if count == 0 { break }
                bytes.append(buffer, count: count)
            }
            forwarded.httpBodyStream = nil; forwarded.httpBody = bytes
        }
        Self.record(["phase": "forward", "url": forwarded.url?.absoluteString ?? "", "bytes": forwarded.httpBody?.count ?? -1])
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = []
        let session = URLSession(configuration: config); self.session = session
        uploadTask = session.dataTask(with: forwarded) { [weak self] data, response, error in
            guard let self else { return }
            if let error {
                Self.record(["phase": "error", "code": (error as NSError).code])
                self.client?.urlProtocol(self, didFailWithError: error)
            }
            else if let response = response as? HTTPURLResponse {
                Self.record(["phase": "response", "status": response.statusCode])
                let mapped = HTTPURLResponse(url: self.request.url!, statusCode: response.statusCode, httpVersion: nil,
                    headerFields: response.allHeaderFields as? [String: String])!
                self.client?.urlProtocol(self, didReceive: mapped, cacheStoragePolicy: .notAllowed)
                self.client?.urlProtocol(self, didLoad: data ?? Data()); self.client?.urlProtocolDidFinishLoading(self)
            }
            session.finishTasksAndInvalidate()
        }
        uploadTask?.resume()
    }
    override func stopLoading() { uploadTask?.cancel(); session?.invalidateAndCancel() }
}
