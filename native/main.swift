import AppKit
import WebKit
import Foundation
import Darwin
import CoreFoundation

private let controlLimit = 65_536
private let jsonLimit = 2 * 1024 * 1024
private let archiveLimit = 64 * 1024 * 1024
private let chunkLimit = 32 * 1024
private let requestSeconds = 30
private let productID = "com.cdbentley.scribe-reader.capture"
private let storeID = UUID(uuidString: "D91D21E0-FE72-47D2-83BC-7C96D12576C8")!

#if SYNTHETIC_FIXTURE
private let origin = "https://localhost:18443"
private let sessionID = UUID(uuidString: "91B37029-632B-46F0-80A9-7B95D61AE04B")!
#else
private let origin = "https://read.amazon.com"
private let sessionID = storeID
#endif

private enum Failure: String, Error {
    case protocolUnsupported = "protocol-unsupported"
    case authenticationRequired = "authentication-required"
    case networkError = "network-error"
    case serviceError = "service-error"
    case tooLarge = "response-too-large"
    case timeout = "request-timeout"
    case interrupted
    case busy
    case loginCancelled = "login-cancelled"
    case localError = "local-error"
}

private func strictInt(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= 2_147_483_647,
          number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
    return number.intValue
}
private func strictBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}

private struct Request: Sendable {
    enum Kind: String { case connect, notes, open, render, close }
    let id: Int
    let kind: Kind
    let login: Bool
    let notebookID: String?
    let page: Int?
    let token: String?

    init(_ data: Data) throws {
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              strictInt(raw["version"]) == 1, let id = strictInt(raw["id"]), id > 0, id <= 2_147_483_647,
              let name = raw["kind"] as? String, let kind = Kind(rawValue: name) else { throw Failure.protocolUnsupported }
        var keys = Set(["version", "id", "kind"])
        var login = false
        var notebookID: String?
        var page: Int?
        var token: String?
        switch kind {
        case .connect:
            keys.insert("login")
            guard let value = strictBool(raw["login"]) else { throw Failure.protocolUnsupported }
            login = value
        case .open:
            keys.insert("notebookId")
            guard let value = raw["notebookId"] as? String, !value.isEmpty, value.utf8.count <= 4096 else { throw Failure.protocolUnsupported }
            notebookID = value
        case .render:
            keys.formUnion(["page", "token"])
            guard let number = strictInt(raw["page"]), number >= 0, number < 1000,
                  let value = raw["token"] as? String, !value.isEmpty, value.utf8.count <= 16_384,
                  !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw Failure.protocolUnsupported }
            page = number
            token = value
        case .notes, .close: break
        }
        guard Set(raw.keys) == keys else { throw Failure.protocolUnsupported }
        self.id = id; self.kind = kind; self.login = login
        self.notebookID = notebookID; self.page = page; self.token = token
    }

    var bridge: [String: Any] {
        var result: [String: Any] = ["id": id, "kind": kind.rawValue]
        if let notebookID { result["notebookId"] = notebookID }
        if let page { result["page"] = page }
        if let token { result["token"] = token }
        return result
    }
}

private func readExactly(_ count: Int) throws -> Data? {
    var result = Data()
    while result.count < count {
        guard let bytes = try FileHandle.standardInput.read(upToCount: count - result.count), !bytes.isEmpty else {
            if result.isEmpty { return nil }
            throw Failure.protocolUnsupported
        }
        result.append(bytes)
    }
    return result
}

private func encoded(_ value: [String: Any]) throws -> Data {
    let json = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard json.count <= controlLimit else { throw Failure.protocolUnsupported }
    var length = UInt32(json.count).bigEndian
    var bytes = Data(bytes: &length, count: 4)
    bytes.append(json)
    return bytes
}

private func writeResponse(id: Int, body: Data?, failure: Failure?) async throws {
    let header: [String: Any]
    if let failure { header = ["version": 1, "id": id, "kind": "error", "error": failure.rawValue] }
    else { header = ["version": 1, "id": id, "kind": "body", "length": body?.count ?? 0] }
    let control = try encoded(header)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        DispatchQueue.global(qos: .utility).async {
            do {
                try FileHandle.standardOutput.write(contentsOf: control)
                if let body { try FileHandle.standardOutput.write(contentsOf: body) }
                continuation.resume()
            } catch { continuation.resume(throwing: Failure.interrupted) }
        }
    }
}

@MainActor
private final class Capture: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, NSWindowDelegate {
    private var view: WKWebView?
    private var window: NSWindow?
    private let world = WKContentWorld.world(name: "ScribeReaderTransport")
    private var lockFD: Int32 = -1
    private var task: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var operationDeadline: Task<Void, Never>?
    private var navigation: CheckedContinuation<Void, Error>?
    private var active: Request?
    private var queued: Request?
    private var writing = false
    private var expired = false
    private var lastID = 0
    private var bytes = Data()
    private var sequence = 0
    private var stopped = false
    private var signalSources: [DispatchSourceSignal] = []
    #if SYNTHETIC_FIXTURE
    private var pendingChunks = 0
    private var peakPendingChunks = 0
    private var acceptedChunks = 0
    private var peakBodyBytes = 0
    #endif

    func start() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.stop(0) }
            source.resume()
            signalSources.append(source)
        }
        signal(SIGPIPE, SIG_IGN)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            do {
                while let prefix = try readExactly(4) {
                    let count = prefix.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                    guard count > 0, count <= controlLimit, let data = try readExactly(Int(count)) else { throw Failure.protocolUnsupported }
                    let request = try Request(data)
                    Task { @MainActor [weak self] in self?.accept(request) }
                }
                Task { @MainActor [weak self] in self?.stop(0) }
            } catch {
                Task { @MainActor [weak self] in self?.stop(1) }
            }
        }
    }

    private func stop(_ code: Int32) {
        guard !stopped else { return }
        stopped = true
        task?.cancel(); deadline?.cancel(); operationDeadline?.cancel()
        navigation?.resume(throwing: Failure.interrupted); navigation = nil
        view?.stopLoading(); window?.delegate = nil; window?.close()
        if lockFD >= 0 { flock(lockFD, LOCK_UN); Darwin.close(lockFD); lockFD = -1 }
        #if SYNTHETIC_FIXTURE
        let metrics: [String: Any] = ["kind": "fixture-closed", "pid": getpid(), "peakPendingChunks": peakPendingChunks, "acceptedChunks": acceptedChunks, "peakBodyBytes": peakBodyBytes]
        if let encoded = try? JSONSerialization.data(withJSONObject: metrics, options: [.sortedKeys]) {
            try? FileHandle.standardError.write(contentsOf: encoded + Data([10]))
        }
        #endif
        exit(code)
    }

    private func accept(_ request: Request) {
        if request.kind == .close { stop(0); return }
        guard request.id > lastID else { stop(1); return }
        if active != nil {
            guard writing, queued == nil else { stop(1); return }
            queued = request; return
        }
        lastID = request.id; active = request; bytes = Data(); sequence = 0; expired = false
        deadline = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(requestSeconds))
            if !Task.isCancelled { self?.expire(request.id) }
        }
        task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                if request.kind == .connect { try await connect(login: request.login) }
                else { try await perform(request) }
                try Task.checkCancellation()
                writing = true
                try await writeResponse(id: request.id, body: bytes, failure: nil)
            } catch {
                if writing { stop(1); return }
                let failure = expired ? Failure.timeout : error as? Failure ?? (Task.isCancelled ? .interrupted : .networkError)
                writing = true
                do { try await writeResponse(id: request.id, body: nil, failure: failure) }
                catch { stop(1) }
            }
            deadline?.cancel()
            bytes = Data(); active = nil; task = nil; writing = false
            if let next = queued { queued = nil; accept(next) }
        }
    }

    private func expire(_ id: Int) {
        guard active?.id == id else { return }
        expired = true
        navigation?.resume(throwing: Failure.timeout); navigation = nil
        task?.cancel()
        if let view {
            Task { @MainActor in
                _ = try? await view.callAsyncJavaScript("globalThis.scribeBridge?.abort(id)", arguments: ["id": id], in: nil, contentWorld: world)
            }
            view.stopLoading()
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            if self?.active?.id == id { self?.stop(1) }
        }
    }

    private func connect(login: Bool) async throws {
        guard view == nil else { throw Failure.protocolUnsupported }
        #if SYNTHETIC_FIXTURE
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("scribe-reader-native-fixture")
        #else
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Scribe Reader")
        #endif
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        lockFD = Darwin.open(directory.appendingPathComponent("native-session.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lockFD >= 0 else { throw Failure.localError }
        guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(lockFD); lockFD = -1; throw Failure.busy }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: sessionID)
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        guard let path = Bundle.main.url(forResource: "bridge", withExtension: "js"),
              let script = try? String(contentsOf: path, encoding: .utf8), script.utf8.count <= controlLimit else { throw Failure.localError }
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: world, name: "scribeChunk")
        configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1050, height: 850), configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self; view = web
        if login {
            NSApplication.shared.setActivationPolicy(.accessory)
            let menu = NSMenu()
            let edit = NSMenu(title: "Edit")
            for (title, action, key) in [
                ("Cut", #selector(NSText.cut(_:)), "x"),
                ("Copy", #selector(NSText.copy(_:)), "c"),
                ("Paste", #selector(NSText.paste(_:)), "v"),
                ("Select All", #selector(NSText.selectAll(_:)), "a")
            ] {
                let item = edit.addItem(withTitle: title, action: action, keyEquivalent: key)
                item.keyEquivalentModifierMask = .command
            }
            let editItem = menu.addItem(withTitle: "Edit", action: nil, keyEquivalent: "")
            editItem.submenu = edit
            NSApplication.shared.mainMenu = menu
            let panel = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            panel.title = "Scribe Reader sign in"; panel.contentView = web; panel.delegate = self
            panel.center(); panel.makeKeyAndOrderFront(nil); window = panel
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        operationDeadline = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(login ? 900 : 600))
            if !Task.isCancelled { self?.stop(1) }
        }
        try await withCheckedThrowingContinuation { continuation in
            navigation = continuation
            web.load(URLRequest(url: URL(string: origin + "/")!))
        }
    }

    private func perform(_ request: Request) async throws {
        guard let view else { throw Failure.protocolUnsupported }
        guard trusted(view.url) else { throw Failure.authenticationRequired }
        let result: Any?
        do {
            result = try await view.callAsyncJavaScript("return await globalThis.scribeBridge.perform(request)", arguments: ["request": request.bridge], in: nil, contentWorld: world)
        } catch { throw Failure.networkError }
        guard let object = result as? [String: Any] else { throw Failure.protocolUnsupported }
        if let error = object["error"] as? String { throw Failure(rawValue: error) ?? .protocolUnsupported }
        guard strictInt(object["bytes"]) == bytes.count, strictInt(object["chunks"]) == sequence else { throw Failure.protocolUnsupported }
    }

    private func trusted(_ url: URL?) -> Bool {
        guard let url, let expected = URL(string: origin) else { return false }
        return url.scheme == expected.scheme && url.host == expected.host && url.port == expected.port && url.user == nil && url.password == nil
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let request = active, request.kind != .connect,
              message.name == "scribeChunk", message.frameInfo.isMainFrame,
              trusted(message.frameInfo.request.url),
              message.frameInfo.securityOrigin.protocol == "https",
              message.frameInfo.securityOrigin.host == URL(string: origin)!.host,
              message.frameInfo.securityOrigin.port == (URL(string: origin)!.port ?? 0),
              let raw = message.body as? [String: Any], Set(raw.keys) == Set(["id", "sequence", "base64"]),
              strictInt(raw["id"]) == request.id, strictInt(raw["sequence"]) == sequence,
              let base64 = raw["base64"] as? String, base64.utf8.count <= 43_692,
              let chunk = Data(base64Encoded: base64), !chunk.isEmpty, chunk.count <= chunkLimit,
              chunk.base64EncodedString() == base64 else { return (nil, "protocol-unsupported") }
        let limit = request.kind == .render ? archiveLimit : jsonLimit
        guard bytes.count + chunk.count <= limit else { return (nil, "response-too-large") }
        #if SYNTHETIC_FIXTURE
        pendingChunks += 1; peakPendingChunks = max(peakPendingChunks, pendingChunks)
        defer { pendingChunks -= 1 }
        try? await Task.sleep(for: .milliseconds(1))
        guard pendingChunks == 1, active?.id == request.id else { return (nil, "protocol-unsupported") }
        acceptedChunks += 1
        #endif
        bytes.append(chunk); sequence += 1
        #if SYNTHETIC_FIXTURE
        peakBodyBytes = max(peakBodyBytes, bytes.count)
        #endif
        return (true, nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, url.scheme == "https", url.user == nil, url.password == nil else { decisionHandler(.cancel); return }
        #if SYNTHETIC_FIXTURE
        let allowed = trusted(url)
        #else
        let allowed = url.port == nil && ["read.amazon.com", "www.amazon.com", "amazon.com"].contains(url.host ?? "")
        #endif
        decisionHandler(allowed && navigationAction.targetFrame != nil ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        self.navigation?.resume(); self.navigation = nil
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.navigation?.resume(throwing: Failure.networkError); self.navigation = nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.navigation?.resume(throwing: Failure.networkError); self.navigation = nil
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { stop(1) }
    func windowShouldClose(_ sender: NSWindow) -> Bool { stop(0); return true }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) { completionHandler() }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) { completionHandler(false) }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) { completionHandler(nil) }

    #if SYNTHETIC_FIXTURE
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.host == "localhost", challenge.protectionSpace.port == 18443,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let first = chain.first,
              let fixture = Bundle.main.url(forResource: "fixture", withExtension: "der"),
              let expected = try? Data(contentsOf: fixture), (SecCertificateCopyData(first) as Data) == expected else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    #endif
}

let args = Array(CommandLine.arguments.dropFirst())
if args.isEmpty || args == ["--help"] {
    print("Scribe Reader Capture\n\n  --help\n  --version\n\nPrivate WebKit transport; use the Scribe Reader reader command.")
} else if args == ["--version"] {
    print("{\"id\":\"\(productID)\",\"transport\":\"native-webkit-v1\",\"protocolVersion\":1}")
} else if args == ["--pipe"] {
    umask(0o077)
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let capture = Capture()
    capture.start()
    app.run()
} else {
    FileHandle.standardError.write(Data("{\"kind\":\"invalid-arguments\"}\n".utf8))
    exit(1)
}
