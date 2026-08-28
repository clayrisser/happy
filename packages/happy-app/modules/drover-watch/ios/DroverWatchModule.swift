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
public final class DroverWatchModule: Module, WCSessionDelegate {
    private var activated = false

    public func definition() -> ModuleDefinition {
        Name("DroverWatch")

        Events("onAnswer")

        OnCreate {
            guard WCSession.isSupported() else { return }
            let session = WCSession.default
            session.delegate = self
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
                  let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
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

    // MARK: - WCSessionDelegate

    public func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        activated = activationState == .activated
    }

    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate so a watch switch does not silently end the feed.
        WCSession.default.activate()
    }

    /// Live answer from the watch while the phone app is running.
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        emitAnswer(message)
    }

    /// Queued answer: the watch was out of range when it was tapped. Delivered
    /// whenever the pair reconnects — the bus is first-wins, so a late answer
    /// to a settled gate is refused there rather than needing a guard here.
    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        emitAnswer(userInfo)
    }

    private func emitAnswer(_ payload: [String: Any]) {
        guard let id = payload["id"] as? String,
              let allow = payload["allow"] as? Bool else { return }
        var event: [String: Any] = ["id": id, "allow": allow]
        if let optionId = payload["optionId"] as? String { event["optionId"] = optionId }
        sendEvent("onAnswer", event)
    }
}
