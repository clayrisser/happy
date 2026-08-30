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
///
/// It has one limit that made the wrist read "Out of date" on every open: only
/// a RUNNING phone app can call it, and iOS suspends a backgrounded app within
/// seconds. So the wrist can also ask, by sending a `{"kind":"refresh"}`
/// message — that direction wakes this app in the background — and the reply is
/// held here until JS publishes a snapshot collected after the ask (DROVE-22).

/// WCSessionDelegate requires NSObjectProtocol, which Expo's `Module` is not,
/// so the delegate is its own NSObject and the module owns it.
final class DroverWatchDelegate: NSObject, WCSessionDelegate {
    /// Set by the module; called on every answer from the wrist.
    var onAnswer: (([String: Any]) -> Void)?
    /// Called when the wrist asks for an account flip (BASED-98).
    var onFlip: (([String: Any]) -> Void)?
    /// Called when the wrist asks for a fresh snapshot (DROVE-22).
    var onRefresh: (() -> Void)?

    /// How long the wrist may be kept waiting before it is answered with
    /// whatever this phone last published.
    ///
    /// The ask arrives by `sendMessage`, which iOS answers by WAKING this app
    /// in the background — from suspended the JS resumes in well under a
    /// second, but from terminated the whole React Native bundle has to boot
    /// first. Ten seconds covers the common case and gives a cold boot a
    /// chance; past that the wrist gets the last real snapshot, unchanged, so
    /// its own staleness check still calls an old list old rather than being
    /// told a stale one is fresh.
    private static let replyDeadline: TimeInterval = 10

    private let lock = NSLock()
    private var pending: [([String: Any]) -> Void] = []
    private var lastPublished: [String: Any] = [:]

    /// Answer every wrist waiting on a snapshot, and remember what was sent.
    /// `snapshot` nil means the deadline ran out: answer with the last one.
    func settle(with snapshot: [String: Any]?) {
        lock.lock()
        let waiting = pending
        pending = []
        if let snapshot { lastPublished = snapshot }
        let payload = snapshot ?? lastPublished
        lock.unlock()
        for reply in waiting { reply(payload) }
    }

    private func hold(_ reply: @escaping ([String: Any]) -> Void) {
        lock.lock()
        pending.append(reply)
        lock.unlock()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.replyDeadline) { [weak self] in
            self?.settle(with: nil)
        }
    }

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

    /// The wrist asking for a current snapshot (DROVE-22).
    ///
    /// A `sendMessage` from watchOS wakes this app in the background when it is
    /// not running, which is the whole point: the wrist's snapshot could only
    /// ever be restamped by a phone app that happened to be on screen, so it
    /// was stale by definition every time Clay looked at his watch. The reply
    /// is held until JS publishes, so the answer carries a snapshot collected
    /// after the ask rather than whatever was lying around before it.
    func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        guard message["kind"] as? String == "refresh" else {
            // An answer or a flip that happened to be sent with a reply
            // handler. Handle it the ordinary way and close the reply, so the
            // wrist is never left waiting on a channel nothing will answer.
            forward(message)
            replyHandler([:])
            return
        }
        hold(replyHandler)
        onRefresh?()
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
        // The WHOLE selection on a multi-select question (DROVE-53). Forwarded
        // for the same reason `text` is: this function copies keys one at a
        // time, so a key it does not name is a key that travels off the wrist
        // and stops here. optionId carries the first pick either way, which is
        // why the loss would have been silent — three ticks, one word, no error.
        if let optionIds = payload["optionIds"] as? [String] { event["optionIds"] = optionIds }
        // "Allow, and stop asking this session" from the wrist. Same rule: a
        // key this function does not name is a key that dies here.
        if let scope = payload["scope"] as? String { event["scope"] = scope }
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
                // No body: there is one thing to ask for.
                self?.sendEvent("onRefresh")
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
            // A wrist that ASKED for this gets it straight back down its own
            // reply channel rather than waiting on the application context,
            // which iOS delivers when it feels like it (DROVE-22). Called on
            // every publish, not only an asked-for one, so the deadline always
            // has a real snapshot to fall back to.
            self.watchDelegate.settle(with: dict)
            return true
        }
    }
}
