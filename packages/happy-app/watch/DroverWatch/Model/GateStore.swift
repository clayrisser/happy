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
    /// Sessions with a flip in flight, so the row can say so and a double tap
    /// cannot queue two.
    @Published private(set) var flipping: Set<String> = []
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

    var sessions: [DroverSession] {
        snapshot.sessions.sorted { lhs, rhs in
            // Running sessions first — those are the ones worth flipping.
            if lhs.active != rhs.active { return lhs.active }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    var accounts: [String] { snapshot.accounts }

    func answer(_ gate: DroverGate, allow: Bool, optionId: String? = nil) {
        answering.insert(gate.id)
        let answer = DroverAnswer(id: gate.id, allow: allow, optionId: optionId)
        if !send(answer, describing: "answer") {
            answering.remove(gate.id)
        }
    }

    /// Move a session onto another account. `account` nil means "next one with
    /// headroom" — the CLI owns that choice, because it holds the cooldowns.
    func flip(_ session: DroverSession, to account: String? = nil) {
        flipping.insert(session.id)
        if !send(DroverFlip(sessionId: session.id, account: account), describing: "flip") {
            flipping.remove(session.id)
            return
        }
        // Nothing acknowledges a flip on this channel — the session simply
        // starts reporting the new account in the next snapshot. So the
        // in-flight mark is cleared on a timer rather than left to stick.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            self?.flipping.remove(session.id)
        }
    }

    /// One transport for both messages. Reachable gets it now; unreachable
    /// queues it, so a tap out of range is delivered rather than dropped.
    private func send<T: Encodable>(_ message: T, describing what: String) -> Bool {
        guard let payload = try? JSONEncoder().encode(message),
              let dict = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            lastError = "Could not encode the \(what)"
            return false
        }
        guard let session, session.activationState == .activated else {
            lastError = "Watch is not paired with the phone app"
            return false
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
        return true
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
