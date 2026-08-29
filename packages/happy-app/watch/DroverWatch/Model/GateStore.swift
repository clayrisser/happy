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
    /// Gates this watch has answered but the phone has not yet confirmed gone.
    /// They render as sent-and-untappable, so a double tap is impossible and
    /// the card is still THERE — see `gates` for why that distinction cost a
    /// blocked session.
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

    /// Every gate the phone lists, newest first.
    ///
    /// A gate this watch has answered STAYS in here. It used to be filtered
    /// out, which made a tap delete the card from the wrist outright: the only
    /// things that ever brought it back were another surface answering it or
    /// the hold lapsing, and with the phone app dead neither happens. So a tap
    /// on a question the phone could not answer left the wrist saying "nothing
    /// waiting" while the session sat blocked — a black hole with no sign it
    /// had swallowed anything. The row is greyed and untappable instead, and it
    /// leaves only when the phone stops listing it.
    var gates: [DroverGate] {
        snapshot.gates.sorted { $0.createdAt > $1.createdAt }
    }

    /// Sent from this wrist, not yet confirmed gone by the phone.
    func isAnswering(_ gate: DroverGate) -> Bool { answering.contains(gate.id) }

    var sessions: [DroverSession] {
        snapshot.sessions.sorted { lhs, rhs in
            // Running sessions first — those are the ones worth flipping.
            if lhs.active != rhs.active { return lhs.active }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    var accounts: [String] { snapshot.accounts }

    /// Answer a gate. `optionId` is a pick, `text` is typed or dictated; a
    /// question takes exactly one of them and a permission takes neither.
    ///
    /// Returns whether the answer actually left this watch, so the caller can
    /// stay put and show `lastError` instead of dismissing on a refusal.
    @discardableResult
    func answer(_ gate: DroverGate, allow: Bool, optionId: String? = nil, text: String? = nil) -> Bool {
        // Whitespace is not an answer. The bus refuses a blank one outright
        // (server.js rejects it 400) and an older bus takes it and records
        // nothing, which dismisses every surface and leaves the waiting hook
        // nothing to inject. Caught here rather than at the button, so the
        // dictation that heard silence cannot be sent as a settled answer.
        let typed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let picked = optionId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if gate.isQuestion && (picked ?? "").isEmpty && (typed ?? "").isEmpty {
            lastError = "A question needs an answer"
            return false
        }
        answering.insert(gate.id)
        let answer = DroverAnswer(
            id: gate.id,
            allow: allow,
            optionId: optionId,
            // Absent, never empty: see DroverAnswer.text.
            text: (typed ?? "").isEmpty ? nil : typed
        )
        if !send(answer, describing: "answer") {
            answering.remove(gate.id)
            return false
        }
        // The hold has to be able to LAPSE. It is cleared otherwise only when
        // the phone stops listing the gate, so an answer that travels but never
        // lands — a question answered with no option reaches the bus as nothing
        // it will take — left the row marked "sent" forever and unanswerable
        // from this wrist until the app was relaunched. After this the row goes
        // live again and the tap can be made a second time, which is the right
        // outcome when the first one demonstrably went nowhere.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            self?.answering.remove(gate.id)
        }
        return true
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
        // Cleared per attempt: the banner is about the send in front of you,
        // and a stale one left over from a lapsed watch connection reads as a
        // failure of the tap you just made.
        lastError = nil
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
        // A snapshot arriving IS the link working, so whatever the last send
        // complained about is over. Nothing else clears the banner: it is set
        // in five places and, until GateListView, was read in none.
        lastError = nil
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
            // Apply FIRST: apply() clears lastError, so setting the activation
            // error before it would post a banner and then wipe it in the same
            // turn, which is how a real error becomes an invisible one.
            if !context.isEmpty { self.apply(context) }
            if let error { self.lastError = error.localizedDescription }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
        Task { @MainActor in self.apply(context) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in self.apply(message) }
    }
}
