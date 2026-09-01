import ExpoModulesCore
import WatchConnectivity
// The phone half of DROVE-260. Only `WidgetCenter` is used from it, and only
// to spend a reload the JS side has already decided is worth spending.
import WidgetKit

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
    /// Called when the wrist opens a session's transcript, or leaves it
    /// (DROVE-91). The event carries `sessionId` only while one is open.
    var onOpened: (([String: Any]) -> Void)?
    /// Called when the wrist dictated a message for a session (DROVE-92).
    var onSay: (([String: Any]) -> Void)?
    /// Called when the wrist reports whether its audio route has headphones
    /// (DROVE-92), on opening a transcript and on every route change.
    var onRoute: (([String: Any]) -> Void)?
    /// Called when the wrist finished, or cut, a sentence the phone sent it
    /// to speak (DROVE-92); the phone's read-aloud queue paces on it.
    var onSpoken: (([String: Any]) -> Void)?
    /// Called when the wrist opened or closed its held-open recorder
    /// (DROVE-130). The audio does NOT come this way; only the control does.
    var onListen: (([String: Any]) -> Void)?
    /// Called when the wrist pauses or resumes the reading (DROVE-275). The
    /// action is explicit — "pause" or "resume", never a toggle — because the
    /// wrist presses off a snapshot that may be a minute old.
    var onTransport: (([String: Any]) -> Void)?

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
        // Which session the wrist is looking at (DROVE-91). No `sessionId`
        // means it left the transcript. Above the answer guard for the same
        // reason as the two before it.
        if payload["kind"] as? String == "opened" {
            var event: [String: Any] = [:]
            if let sessionId = payload["sessionId"] as? String { event["sessionId"] = sessionId }
            onOpened?(event)
            return
        }
        // A message dictated on the wrist for a session (DROVE-92). It goes
        // out through the same send path a phone-typed message takes, so the
        // phone only has to hand it over. Above the answer guard like the rest.
        if payload["kind"] as? String == "say" {
            guard let sessionId = payload["sessionId"] as? String,
                  let text = payload["text"] as? String else { return }
            onSay?(["sessionId": sessionId, "text": text])
            return
        }
        // The wrist opening or closing its microphone (DROVE-130). Only the
        // CONTROL comes through JS — which session, and start/stop/cancel —
        // so the policy around it ships OTA. The audio itself does not; see
        // below.
        if payload["kind"] as? String == "listen" {
            guard let sessionId = payload["sessionId"] as? String,
                  let capture = payload["capture"] as? String,
                  let state = payload["state"] as? String else { return }
            onListen?(["sessionId": sessionId, "capture": capture, "state": state])
            return
        }
        // A chunk of audio from the wrist's held-open recorder (DROVE-130).
        //
        // This one does NOT go to JS. It arrives about five times a second and
        // JS has no use for PCM: it would be pure bridge traffic on the way to
        // the speech module, which is the only thing that wants it. So it is
        // posted for `DroverSpeechModule` to pick up in the same process, and
        // the notification name is the contract between the two — spelled out
        // at both ends because they are separate pods and a mistyped string
        // would be a microphone that records and is never transcribed.
        if payload["kind"] as? String == "wristaudio" {
            guard let capture = payload["capture"] as? String,
                  let seq = payload["seq"] as? Int,
                  let pcm = payload["pcm"] as? Data else { return }
            NotificationCenter.default.post(
                name: Notification.Name("DroverWristAudio"),
                object: nil,
                userInfo: ["capture": capture, "seq": seq, "pcm": pcm]
            )
            return
        }
        // Whether the wrist's own audio route has headphones (DROVE-92). JS
        // arbitrates which device speaks on it.
        if payload["kind"] as? String == "route" {
            onRoute?(["headphones": payload["headphones"] as? Bool ?? false])
            return
        }
        // The wrist finished (or cut) a sentence the phone asked it to speak
        // (DROVE-92). The id is the one the phone sent with it.
        if payload["kind"] as? String == "spoken" {
            guard let id = payload["id"] as? String else { return }
            onSpoken?(["id": id, "finished": payload["finished"] as? Bool ?? false])
            return
        }
        // Pause or resume the reading, from the wrist (DROVE-275). Above the
        // answer guard like every other kind, for the same reason: that guard
        // returns on a missing `allow` and this has none.
        //
        // The action travels as it was pressed and nothing is decided here.
        // JS owns what a press means, exactly as it does for the lock screen
        // and the headphones (DROVE-233), so the four surfaces cannot come to
        // disagree about what one press did.
        if payload["kind"] as? String == "transport" {
            guard let action = payload["action"] as? String else { return }
            onTransport?(["action": action])
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

        Events(
            "onAnswer", "onFlip", "onRefresh", "onOpened", "onSay", "onRoute", "onSpoken",
            "onListen", "onTransport"
        )

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
            self.watchDelegate.onOpened = { [weak self] event in
                self?.sendEvent("onOpened", event)
            }
            self.watchDelegate.onListen = { [weak self] event in
                self?.sendEvent("onListen", event)
            }
            self.watchDelegate.onTransport = { [weak self] event in
                self?.sendEvent("onTransport", event)
            }
            self.watchDelegate.onSay = { [weak self] event in
                self?.sendEvent("onSay", event)
            }
            self.watchDelegate.onRoute = { [weak self] event in
                self?.sendEvent("onRoute", event)
            }
            self.watchDelegate.onSpoken = { [weak self] event in
                self?.sendEvent("onSpoken", event)
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
                "reachable": session.isReachable,
                // How many more times today the phone may LAUNCH the watch app
                // in the background (DROVE-62). Zero means either the budget is
                // spent or — far more likely — the Drover complication is not
                // on any watch face, which is the documented condition for this
                // count being zero. A wrist that cannot be woken is worth
                // saying out loud rather than discovering as silence.
                "wakes": session.remainingComplicationUserInfoTransfers
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

        /// Send a transcript delta to a REACHABLE watch, and nothing to one
        /// that is not (DROVE-91).
        ///
        /// `sendMessage` only: the application context is for the whole
        /// snapshot and is written by `publish` on its own cadence, and a
        /// reply streaming in as forty store updates a second must not
        /// rewrite it forty times. Unreachable means the watch app is not
        /// frontmost, so nobody is reading the transcript; the next publish
        /// carries the full one in the context for when they are. Resolves
        /// whether it was sent, so JS knows what the watch has been told.
        AsyncFunction("sendTranscript") { (json: String) -> Bool in
            guard WCSession.isSupported() else { return false }
            let session = WCSession.default
            guard session.activationState == .activated, session.isReachable else { return false }
            guard let data = json.data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let dict = plistSanitized(raw) as? [String: Any] else {
                throw Exception(name: "DroverWatch", description: "transcript was not a JSON object")
            }
            session.sendMessage(dict, replyHandler: nil, errorHandler: nil)
            return true
        }

        /// Send one small message to a REACHABLE watch and nothing to one that
        /// is not (DROVE-92): a sentence for the wrist to speak, a stop, or the
        /// reply-start cue. Same rule as sendTranscript, for the same reason:
        /// a sentence queued for a watch that is not looking is spoken into a
        /// sleeve twenty minutes later. Resolves whether it was sent, so the
        /// phone's queue knows to speak it itself instead.
        AsyncFunction("sendToWatch") { (json: String) -> Bool in
            guard WCSession.isSupported() else { return false }
            let session = WCSession.default
            guard session.activationState == .activated, session.isReachable else { return false }
            guard let data = json.data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let dict = plistSanitized(raw) as? [String: Any] else {
                throw Exception(name: "DroverWatch", description: "message was not a JSON object")
            }
            session.sendMessage(dict, replyHandler: nil, errorHandler: nil)
            return true
        }

        /// Wake the watch app in the background and hand it this snapshot
        /// (DROVE-62).
        ///
        /// `transferCurrentComplicationUserInfo` is the ONLY phone-to-watch
        /// call the WatchConnectivity headers document as launching the watch
        /// extension in the background: `sendMessage` says it launches the
        /// counterpart "iOS counterpart app only", and the application context
        /// and a plain `transferUserInfo` are both delivered "on next launch",
        /// which for a watch app means whenever the wrist next opens it. So
        /// without this the wrist learns about a question when Clay looks, and
        /// looking is the thing the buzz exists to replace.
        ///
        /// It carries the whole snapshot rather than a cue of its own so the
        /// watch runs it through exactly the apply the application context
        /// goes through, and the buzz falls out of the snapshot diff there.
        /// One cue derivation, not two that drift.
        ///
        /// BUDGETED. `remainingComplicationUserInfoTransfers` is what is left,
        /// and it is 0 whenever the complication is not enabled — in which
        /// case the system silently downgrades this to a regular userInfo and
        /// the watch is not woken at all. Returning that verdict rather than a
        /// bare true is the difference between a wrist that is quiet and a
        /// wrist nobody can tell is quiet. Spend it only on an arrival worth a
        /// buzz; the 60s heartbeat must never come through here.
        AsyncFunction("wake") { (json: String) -> Bool in
            guard WCSession.isSupported() else { return false }
            let session = WCSession.default
            guard session.activationState == .activated else { return false }
            guard let data = json.data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let dict = plistSanitized(raw) as? [String: Any] else {
                throw Exception(name: "DroverWatch", description: "snapshot was not a JSON object")
            }
            let budget = session.remainingComplicationUserInfoTransfers
            session.transferCurrentComplicationUserInfo(dict)
            return budget > 0
        }

        /// Write the PHONE widget's face into the app group, and reload its
        /// timelines when JS says the change is worth one (DROVE-260).
        ///
        /// It lives in this module rather than a second pod because this is
        /// already the phone's native surface bridge and the app group it
        /// writes to is the one the wrist half established. A separate podspec
        /// and autolink entry for one function is more build surface to get
        /// wrong than the naming is worth — and the naming is the only thing
        /// wrong with it.
        ///
        /// It writes RAW JSON rather than an encoded Swift value on purpose.
        /// The face's shape is decided in sources/sync/droverWidgetFace.ts and
        /// read back by DroverWidgetFace.swift in the extension; a third
        /// definition here, in the middle, is the drift DROVE-257 cost two
        /// fixes. The bytes pass through untouched, so this file has no
        /// opinion about any field.
        ///
        /// Silent where the app group is unreachable, which is what an
        /// entitlement that did not make it into the profile looks like: the
        /// phone app is not worth failing over a home-screen convenience, and
        /// the widget already says "Not yet synced" when nothing was ever
        /// written. It resolves false there so JS can tell the two apart.
        ///
        /// `reload` is decided in JS because the budget question needs the
        /// history of what the widget has already been told, which lives in
        /// the feed. See `shouldReloadWidget`.
        AsyncFunction("publishWidgetFace") { (json: String, reload: Bool) -> Bool in
            guard let data = json.data(using: .utf8) else {
                throw Exception(name: "DroverWatch", description: "widget face was not utf8")
            }
            // Parsed only to refuse a payload that is not an object at all. A
            // widget rendering a decode failure is a widget stuck on its last
            // face forever, and that is worth catching on this side of the
            // wire rather than in an extension nobody can attach a debugger to.
            guard (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] != nil else {
                throw Exception(name: "DroverWatch", description: "widget face was not a JSON object")
            }
            // The suite and the key are literals here and in
            // widget/DroverPhoneWidget/DroverWidgetFace.swift, which is two
            // copies of one string. droverWidgetFace.spec.ts pins both against
            // the TypeScript, the same arrangement sessionStateWire.spec.ts
            // has with DroverSnapshot.swift — a mismatch fails a test rather
            // than shipping a widget that reads an empty box.
            guard let defaults = UserDefaults(suiteName: "group.com.bitspur.drover") else {
                return false
            }
            defaults.set(data, forKey: "drover.widget.face.v1")
            if reload {
                WidgetCenter.shared.reloadAllTimelines()
            }
            return true
        }
    }
}
