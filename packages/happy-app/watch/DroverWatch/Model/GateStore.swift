import Foundation
import SwiftUI
import WatchConnectivity
import WatchKit
import WidgetKit

/// Holds what the wrist knows and is the only thing that talks to the phone
/// (BASED-98). The session itself is activated and delegated by
/// `WatchSessionBridge`, on launch, so a background launch with no scene
/// still receives what it was launched for (DROVE-86); this store subscribes.
///
/// The phone is the source of truth: it pushes a snapshot whenever the set of
/// pending gates changes, and the watch echoes answers back. The wrist also
/// ASKS for one — see `askPhoneForSnapshot` — because a push is something only
/// a running phone app can do, and the phone app is suspended in exactly the
/// moment Clay raises his wrist (DROVE-22). Answers are sent
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
    /// What the last ask-the-phone-for-a-snapshot attempt did (DROVE-22).
    @Published private(set) var refresh: DroverRefresh = .never
    /// Why the wrist did not buzz, when it did not. Nil is the normal case.
    @Published private(set) var buzzRefusal: String?

    private var session: WCSession?
    /// When the ask in flight was made. Used to drop the reply of an ask that
    /// has already been superseded, so a slow first answer cannot overwrite the
    /// state of a later one.
    private var askedAt: Date?
    private let buzzer = WristBuzzer()

    override init() {
        super.init()
        buzzer.onRefusal = { [weak self] reason in
            Task { @MainActor in self?.buzzRefusal = reason }
        }
        // Activation belongs to the bridge, which the app delegate has
        // normally already run on launch; calling it again is a no-op. It is
        // still called here so a store built by anything else (a preview, a
        // test) talks to a live session too (DROVE-86).
        let bridge = WatchSessionBridge.shared
        bridge.activate()
        guard let session = bridge.session else {
            // No ask can ever be made here, so `refresh` must not sit on
            // `never`: freshness reads that as "still asking" and suppresses
            // the out-of-date warning it exists to give.
            refresh = .failed("This watch cannot talk to the phone")
            return
        }
        self.session = session
        // Anything the bridge received before this store existed, which on a
        // background launch is the very transfer that launched the process,
        // is replayed through here first.
        bridge.attach { [weak self] arrival in self?.receive(arrival) }
    }

    /// What the wall should say about the snapshot it is holding.
    func freshness(at now: Date = Date()) -> DroverFreshness {
        snapshot.freshness(at: now, refresh: refresh)
    }

    /// Ask the phone for a snapshot, now (DROVE-22).
    ///
    /// This is the only thing on the wrist that can restamp `updatedAt` without
    /// Clay holding the phone. `updateApplicationContext` has to be CALLED by
    /// the phone app's JS, iOS suspends a backgrounded app within seconds, and
    /// a suspended app runs no timers — so the snapshot went stale three
    /// minutes after he put the phone down and the wall said "Out of date"
    /// every time he raised his wrist. A `sendMessage` in THIS direction is the
    /// one WatchConnectivity call that wakes the counterpart iOS app in the
    /// background, so the phone can be locked in a pocket with the Drover app
    /// off screen and still answer.
    ///
    /// Never queued with `transferUserInfo` when the phone is out of range,
    /// unlike an answer: a request for a snapshot delivered twenty minutes late
    /// is answered into a watch app that closed nineteen minutes ago.
    func askPhoneForSnapshot(notMoreOftenThan interval: TimeInterval = 0) {
        if refresh == .asking { return }
        if let askedAt, Date().timeIntervalSince(askedAt) < interval { return }
        guard let session, session.activationState == .activated else {
            refresh = .failed("Watch is not paired with the phone app")
            return
        }
        let asked = Date()
        askedAt = asked
        refresh = .asking
        session.sendMessage(
            ["kind": "refresh"],
            replyHandler: { [weak self] reply in
                Task { @MainActor in
                    guard let self, self.askedAt == asked else { return }
                    // apply() sets `.answered` itself when the reply decodes.
                    // A reply that does not is the phone waking, finding it had
                    // nothing to send, and answering with an empty payload
                    // rather than leaving the wrist on a spinner.
                    if !self.apply(reply) {
                        self.refresh = .failed("Your phone had no snapshot to send")
                    }
                }
            },
            errorHandler: { [weak self] error in
                Task { @MainActor in
                    guard let self, self.askedAt == asked else { return }
                    self.refresh = .failed(error.localizedDescription)
                }
            }
        )
        // WatchConnectivity does call the error handler on its own timeout, but
        // nothing here should be able to sit on `asking` forever if it ever
        // does not: that state suppresses the out-of-date warning, so a silent
        // hang would put the wrist straight back to trusting an old list as
        // confidently as a live one.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard let self, self.askedAt == asked, self.refresh == .asking else { return }
            self.refresh = .failed("Your phone did not answer")
        }
    }

    /// Ask again while the wall is on screen, if the snapshot has aged past one
    /// phone heartbeat. Driven by the list's 30s tick; the interval floor is
    /// what stops a tick storm waking the phone more often than that.
    func askIfSnapshotIsAging(at now: Date = Date()) {
        guard snapshot.needsAsking(at: now) else { return }
        askPhoneForSnapshot(notMoreOftenThan: 30)
    }

    /// Ask for the permission the background buzz needs, from the foreground,
    /// which is the only place watchOS will show the prompt (DROVE-62).
    func prepareBuzzer() {
        buzzer.requestAuthorization()
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

    /// Accounts with their headroom, most first. Falls back to the bare names a
    /// phone that predates DROVE-28's picker sends, so the flip list is never
    /// empty just because the figures are missing.
    var accountRows: [DroverAccount] {
        if !snapshot.accountRows.isEmpty { return snapshot.accountRows }
        return snapshot.accounts.map { DroverAccount(name: $0, headroom: nil, loggedIn: nil, backAt: nil) }
    }

    /// Answer a gate. `optionId` is a pick, `text` is typed or dictated; a
    /// question takes exactly one of them and a permission takes neither.
    ///
    /// Returns whether the answer actually left this watch, so the caller can
    /// stay put and show `lastError` instead of dismissing on a refusal.
    @discardableResult
    func answer(
        _ gate: DroverGate,
        allow: Bool,
        optionId: String? = nil,
        text: String? = nil,
        optionIds: [String]? = nil,
        forSession: Bool = false
    ) -> Bool {
        // Whitespace is not an answer. The bus refuses a blank one outright
        // (server.js rejects it 400) and an older bus takes it and records
        // nothing, which dismisses every surface and leaves the waiting hook
        // nothing to inject. Caught here rather than at the button, so the
        // dictation that heard silence cannot be sent as a settled answer.
        let typed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        // A multi-select answers with a LIST, and the first of that list is
        // also what goes out as optionId — so a reader that never learned the
        // new key still gets an answer instead of nothing (DROVE-53).
        let many = (optionIds ?? []).filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let picked = (optionId ?? many.first)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if gate.isQuestion && (picked ?? "").isEmpty && (typed ?? "").isEmpty {
            lastError = "A question needs an answer"
            return false
        }
        answering.insert(gate.id)
        let answer = DroverAnswer(
            id: gate.id,
            allow: allow,
            optionId: picked,
            // Absent, never empty: see DroverAnswer.text.
            text: (typed ?? "").isEmpty ? nil : typed,
            // Absent for a single pick, never a one-element array: see
            // DroverAnswer.optionIds.
            optionIds: many.count > 1 ? many : nil,
            // Absent unless it was actually asked for. Only a permission can
            // carry it — nothing else here has a "and stop asking" to remember.
            scope: forSession && gate.classification == .permission ? "session" : nil
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

    /// Returns whether the payload was a snapshot. The ask needs to know: a
    /// reply that carries nothing is the phone failing to answer, not the
    /// phone saying the wrist is up to date (DROVE-22).
    @discardableResult
    fileprivate func apply(_ context: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: context),
              let decoded = try? DroverSnapshot.decoder.decode(DroverSnapshot.self, from: data) else { return false }
        // Diffed BEFORE the assignment, because the snapshot being replaced is
        // the only record of what this wrist already knew — on a background
        // wake it is the copy loaded from the app group, which is exactly the
        // case the buzz exists for (DROVE-62). Deduped inside the buzzer, so
        // the same arrival reaching us twice (once as the wake that launched
        // this process, once as the application context) is one tap.
        buzzer.buzz(WristCueDiff.cues(from: snapshot, to: decoded))
        snapshot = decoded
        // The phone spoke, however it reached us. Whether the snapshot it sent
        // is any newer is `isStale`'s question, not this one.
        refresh = .answered
        decoded.save()
        // A snapshot arriving IS the link working, so whatever the last send
        // complained about is over. Nothing else clears the banner: it is set
        // in five places and, until GateListView, was read in none.
        lastError = nil
        // Anything the phone no longer lists is settled; stop holding it back.
        let live = Set(decoded.gates.map(\.id))
        answering.formIntersection(live)
        WidgetCenter.shared.reloadAllTimelines()
        return true
    }
}

extension GateStore {
    /// Every WatchConnectivity callback, live or replayed, lands here on the
    /// main actor (DROVE-86). The bridge owns the delegate; this store owns
    /// what the arrival means.
    private func receive(_ arrival: WatchSessionBridge.Arrival) {
        droverLog.notice("wcsession handling \(arrival.name, privacy: .public) appState=\(WKApplication.shared().applicationState.rawValue, privacy: .public)")
        switch arrival {
        case let .activated(_, error):
            let context = session?.receivedApplicationContext ?? [:]
            // Apply FIRST: apply() clears lastError, so setting the activation
            // error before it would post a banner and then wipe it in the same
            // turn, which is how a real error becomes an invisible one.
            if !context.isEmpty { apply(context) }
            if let error { lastError = error.localizedDescription }
            // The context above is the LAST one iOS delivered, which on a
            // phone that has been asleep is exactly the stale snapshot Clay
            // keeps seeing. Ask for a current one (DROVE-22).
            askPhoneForSnapshot()
        case let .applicationContext(context):
            apply(context)
        case let .message(message):
            apply(message)
        // A snapshot the phone sent as a background transfer, in practice the
        // one it sent with `transferCurrentComplicationUserInfo`, which is the
        // only documented phone-to-watch call that LAUNCHES this app in the
        // background (DROVE-62). It is the same dictionary the application
        // context carries, so it goes through the same apply and the buzz falls
        // out of the diff rather than needing a second cue format on the wire.
        case let .userInfo(userInfo):
            apply(userInfo)
        }
    }
}
