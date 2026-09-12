@MainActor
private extension Capture {
    func verifyEditingShortcuts() async throws -> [String: Any] {
        try await connect(login: true)
        guard let view, let window else { throw Failure.localError }
        let pasteboard = NSPasteboard.general
        let previous: [NSPasteboardItem] = pasteboard.pasteboardItems?.map { original in
            let item = NSPasteboardItem()
            for type in original.types {
                if let data = original.data(forType: type) { item.setData(data, forType: type) }
            }
            return item
        } ?? []
        defer {
            pasteboard.clearContents()
            if !previous.isEmpty { _ = pasteboard.writeObjects(previous) }
        }
        _ = try await view.callAsyncJavaScript("document.body.innerHTML = '<label>Source<textarea id=source>alpha beta</textarea></label><label>Destination<textarea id=destination></textarea></label>'; return true", arguments: [:], in: nil, contentWorld: .defaultClient)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
        NSApplication.shared.activate(ignoringOtherApps: true)

        func evaluate(_ source: String) async throws -> Any? {
            try await view.callAsyncJavaScript(source, arguments: [:], in: nil, contentWorld: .defaultClient)
        }
        func waitFor(_ predicate: @MainActor () async throws -> Bool) async throws -> Bool {
            for _ in 0..<30 {
                if try await predicate() { return true }
                try await Task.sleep(for: .milliseconds(50))
            }
            return false
        }
        func key(_ character: String, _ keyCode: UInt16) throws {
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: character, charactersIgnoringModifiers: character, isARepeat: false, keyCode: keyCode) else { throw Failure.localError }
            NSApplication.shared.sendEvent(event)
        }
        let keyWindow = try await waitFor { NSApplication.shared.keyWindow === window }
        guard keyWindow else { throw Failure.localError }
        _ = try await evaluate("source.focus(); source.setSelectionRange(0, 5); return true")
        pasteboard.clearContents(); pasteboard.setString("copy-sentinel", forType: .string)
        try key("c", 8)
        let copied = try await waitFor { pasteboard.string(forType: .string) == "alpha" }

        _ = try await evaluate("destination.focus(); return true")
        pasteboard.clearContents(); pasteboard.setString("pasted-beta", forType: .string)
        try key("v", 9)
        let pasted = try await waitFor { try await evaluate("return destination.value") as? String == "pasted-beta" }

        _ = try await evaluate("source.value = 'cut-sample'; source.focus(); source.setSelectionRange(3, 3); return true")
        try key("a", 0)
        let selected = try await waitFor { try await evaluate("return source.selectionStart === 0 && source.selectionEnd === source.value.length") as? Bool == true }
        try key("x", 7)
        let cut = try await waitFor { try await evaluate("return source.value") as? String == "" && pasteboard.string(forType: .string) == "cut-sample" }

        _ = try await evaluate("destination.value = ''; destination.focus(); return true")
        try key("v", 9)
        let roundTrip = try await waitFor { try await evaluate("return destination.value") as? String == "cut-sample" }
        return ["kind": "native-editing-shortcuts", "activation": "accessory", "nativeKeyWindow": keyWindow, "copy": copied, "paste": pasted, "selectAll": selected, "cut": cut, "cutPasteRoundTrip": roundTrip, "passed": copied && pasted && selected && cut && roundTrip]
    }
}

let shortcutApplication = NSApplication.shared
shortcutApplication.setActivationPolicy(.prohibited)
private let shortcutCapture = Capture()
Task { @MainActor in
    do {
        let result = try await shortcutCapture.verifyEditingShortcuts()
        let bytes = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(bytes + Data([10]))
        exit(result["passed"] as? Bool == true ? 0 : 1)
    } catch {
        print("{\"kind\":\"native-editing-shortcut-test-failed\"}")
        exit(1)
    }
}
Task { @MainActor in
    try? await Task.sleep(for: .seconds(20))
    print("{\"kind\":\"native-editing-shortcut-test-timeout\"}")
    exit(1)
}
shortcutApplication.run()
