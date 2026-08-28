import Foundation
import SwiftUI
import WatchConnectivity
import WidgetKit

/// Holds what the wrist knows and is the only thing that talks to the phone
/// (BASED-98).
///
/// The phone is the source of truth: it pushes a snapshot whenever the set of
/// pending gates changes, and the watch echoes answers back. Answers are sent
/// with `sendMessage` when the phone is reachable and queued with
/// `transferUserInfo` when it is not, so a tap on a wrist out of range is
/// delivered rather than dropped — the bus resolves first-wins, so a late
/// answer to a settled gate is harmless (it gets a 409 and is ignored).
@MainActor
final class GateStore: NSObject, ObservableObject {
    @Published private(set) var snapshot: DroverSnapshot = .load()
    /// Gates this watch has answered but the phone has not yet confirmed
    /// gone. They render as pending-dismissal so a double tap is impossible.
    @Published private(set) var answering: Set<String> = []
    @Published private(set) var lastError: String?

    private var session: WCSession?

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        self.session = session
    }

    var gates: [DroverGate] {
        snapshot.gates
            .filter { !answering.contains($0.id) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    func answer(_ gate: DroverGate, allow: Bool, optionId: String? = nil) {
        answering.insert(gate.id)
        let answer = DroverAnswer(id: gate.id, allow: allow, optionId: optionId)
        guard let payload = try? JSONEncoder().encode(answer),
              let dict = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            answering.remove(gate.id)
            lastError = "Could not encode the answer"
            return
        }
        guard let session, session.activationState == .activated else {
            answering.remove(gate.id)
            lastError = "Watch is not paired with the phone app"
            return
        }
        if session.isReachable {
            session.sendMessage(dict, replyHandler: nil) { [weak self] error in
                Task { @MainActor in
                    // Reachability can lapse between the check and the send;
                    // fall back to the queue rather than losing the tap.
                    session.transferUserInfo(dict)
                    self?.lastError = error.localizedDescription
                }
            }
        } else {
            session.transferUserInfo(dict)
        }
    }

    fileprivate func apply(_ context: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: context),
              let decoded = try? DroverSnapshot.decoder.decode(DroverSnapshot.self, from: data) else { return }
        snapshot = decoded
        decoded.save()
        // Anything the phone no longer lists is settled; stop holding it back.
        let live = Set(decoded.gates.map(\.id))
        answering.formIntersection(live)
        WidgetCenter.shared.reloadAllTimelines()
    }
}

extension GateStore: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith state: WCSessionActivationState,
        error: Error?
    ) {
        let context = session.receivedApplicationContext
        Task { @MainActor in
            if let error { self.lastError = error.localizedDescription }
            if !context.isEmpty { self.apply(context) }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
        Task { @MainActor in self.apply(context) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in self.apply(message) }
    }
}
