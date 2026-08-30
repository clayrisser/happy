import ExpoModulesCore
import WatchConnectivity

/// Phone side of the Cattle Drover wrist surface (BASED-98).
///
/// JS hands this module a snapshot of the gates currently waiting on a human;
/// it publishes them to the paired watch as the WatchConnectivity application
/// context, and forwards the watch's answers back to JS, which replays them
/// through the app's existing permission RPC. The watch never talks to the
/// Happy server: the phone already holds the decrypted session.
///
/// applicationContext (not sendMessage) is the transport for the snapshot
/// because it is the one WatchConnectivity channel that keeps only the LATEST
/// value and delivers it even when the watch app is not running. A queue of
/// stale gate lists is worse than no list at all.

/// WCSessionDelegate requires NSObjectProtocol, which Expo's `Module` is not,
/// so the delegate is its own NSObject and the module owns it.
final class DroverWatchDelegate: NSObject, WCSessionDelegate {
    /// Set by the module; called on every answer from the wrist.
    var onAnswer: (([String: Any]) -> Void)?
    /// Called when the wrist asks for an account flip (BASED-98).
    var onFlip: (([String: Any]) -> Void)?
    /// Called when the wrist asks for a fresh snapshot (DROVE-22).
    var onRefresh: (() -> Void)?

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {}

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate so a watch switch does not silently end the feed.
        WCSession.default.activate()
    }

    /// Live answer from the watch while the phone app is running.
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        forward(message)
    }

    /// The same, for a watch that wants an acknowledgement.
    ///
    /// The refresh (DROVE-22) is sent with a reply handler, and a watch that
    /// sends one to a counterpart implementing ONLY the no-reply variant gets
    /// its error handler called instead of its message delivered — so this
    /// overload is not optional politeness, it is what makes the refresh land
    /// at all. The reply says the message arrived and nothing more: the
    /// snapshot itself comes back the ordinary way, through JS calling publish.
    func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        forward(message)
        replyHandler(["received": true])
    }

    /// Queued answer: the watch was out of range when it was tapped. Delivered
    /// whenever the pair reconnects — the bus is first-wins, so a late answer
    /// to a settled gate is refused there rather than needing a guard here.
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        forward(userInfo)
    }

    private func forward(_ payload: [String: Any]) {
        // A flip carries `kind`, which an answer never does. Checked first so
        // the answer guard below cannot silently swallow it — that guard is a
        // `return` on a missing `allow`, and a flip has no `allow`.
        // A refresh carries only `kind`. Checked with the flip, above the
        // answer guard, for the same reason: that guard returns on a missing
        // `allow`, and neither of these has one (DROVE-22).
        if payload["kind"] as? String == "refresh" {
            onRefresh?()
            return
        }
        if payload["kind"] as? String == "flip" {
            guard let sessionId = payload["sessionId"] as? String else { return }
            var event: [String: Any] = ["sessionId": sessionId]
            if let account = payload["account"] as? String { event["account"] = account }
            onFlip?(event)
            return
        }
        guard let id = payload["id"] as? String,
              let allow = payload["allow"] as? Bool else { return }
        var event: [String: Any] = ["id": id, "allow": allow]
        if let optionId = payload["optionId"] as? String { event["optionId"] = optionId }
        // A typed or dictated answer, from the watch's own input sheet. Carried
        // separately from optionId so JS can tell which it was; dropping it
        // here would have made every free-text question on the wrist a black
        // hole again, since the tap travels and the answer does not.
        if let text = payload["text"] as? String { event["text"] = text }
        onAnswer?(event)
    }
}

/// WatchConnectivity payloads accept property-list types only, and JSON null
/// decodes to NSNull, which is not one — a single `"account": null` fails the
/// whole publish with WCErrorCodePayloadUnsupportedTypes. Optional fields
/// decode from a MISSING key just as well as from a null one, so dropping
/// nulls is lossless here.
private func plistSanitized(_ value: Any) -> Any? {
    if value is NSNull { return nil }
    if let dict = value as? [String: Any] {
        var out: [String: Any] = [:]
        for (key, child) in dict {
            if let kept = plistSanitized(child) { out[key] = kept }
        }
        return out
    }
    if let array = value as? [Any] {
        return array.compactMap { plistSanitized($0) }
    }
    return value
}

public final class DroverWatchModule: Module {
    private let watchDelegate = DroverWatchDelegate()

    public func definition() -> ModuleDefinition {
        Name("DroverWatch")

        Events("onAnswer", "onFlip", "onRefresh")

        OnCreate {
            self.watchDelegate.onAnswer = { [weak self] event in
                self?.sendEvent("onAnswer", event)
            }
            self.watchDelegate.onFlip = { [weak self] event in
                self?.sendEvent("onFlip", event)
            }
            self.watchDelegate.onRefresh = { [weak self] in
                self?.sendEvent("onRefresh", [:])
            }
            guard WCSession.isSupported() else { return }
            let session = WCSession.default
            session.delegate = self.watchDelegate
            session.activate()
        }

        /// Whether a watch is paired AND has the drover app installed. JS uses
        /// this to avoid publishing into the void, and to tell the user the
        /// truth about why the wrist is quiet.
        Function("status") { () -> [String: Any] in
            guard WCSession.isSupported() else {
                return ["supported": false, "paired": false, "installed": false, "reachable": false]
            }
            let session = WCSession.default
            return [
                "supported": true,
                "activated": session.activationState == .activated,
                "paired": session.isPaired,
                "installed": session.isWatchAppInstalled,
                "reachable": session.isReachable
            ]
        }

        /// Publish the current gate list. `json` is a serialized
        /// DroverSnapshot — the same shape the watch decodes — so the wire
        /// format lives in one Swift file on the watch side and one TS type
        /// here, with no third definition in the middle.
        AsyncFunction("publish") { (json: String) -> Bool in
            guard WCSession.isSupported() else { return false }
            let session = WCSession.default
            guard session.activationState == .activated else { return false }
            guard let data = json.data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let dict = plistSanitized(raw) as? [String: Any] else {
                throw Exception(name: "DroverWatch", description: "snapshot was not a JSON object")
            }
            do {
                try session.updateApplicationContext(dict)
            } catch {
                throw Exception(name: "DroverWatch", description: error.localizedDescription)
            }
            // A reachable watch gets it immediately as well: the application
            // context can lag by a system-chosen interval, and a gate that is
            // waiting on a human should ring now, not eventually.
            if session.isReachable {
                session.sendMessage(dict, replyHandler: nil, errorHandler: nil)
            }
            return true
        }
    }
}
