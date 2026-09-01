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
    /// Whether a CLOSED app can be tapped on this wrist (DROVE-124). The
    /// frontmost route always works and is not in question; this is the one
    /// that silently was not, and the Playground says so out loud.
    @Published private(set) var backgroundDelivery: WristDelivery = .silent(.notAsked)

    /// The session whose transcript is on screen, told to the phone so it
    /// feeds that one (DROVE-91). Nil between transcript screens.
    @Published private(set) var openedSessionId: String?
    /// The Playground cue playing right now, so its row can say so (DROVE-75).
    /// Nil between patterns.
    @Published private(set) var demoPlaying: WristCue?
    /// The play-all run in flight, cancelled by any other demo tap.
    private var demoTask: Task<Void, Never>?

    private var session: WCSession?
    /// When the ask in flight was made. Used to drop the reply of an ask that
    /// has already been superseded, so a slow first answer cannot overwrite the
    /// state of a later one.
    private var askedAt: Date?
    private let buzzer = WristBuzzer()
    /// Voices the sentences the phone sends when this wrist is the speaker
    /// (DROVE-92), and reports its audio route so the phone can decide.
    private let speaker = WatchSpeaker()
    /// The wrist's microphone, held open across pauses (DROVE-130).
    private let recorder = WristRecorder()

    override init() {
        super.init()
        buzzer.onRefusal = { [weak self] reason in
            Task { @MainActor in self?.buzzRefusal = reason }
        }
        buzzer.onDeliveryChanged = { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.backgroundDelivery = WristReach.delivery(
                    frontmost: false, permission: self.buzzer.permission
                )
            }
        }
        speaker.onUtteranceEnded = { [weak self] id, finished in
            self?.reportSpoken(id: id, finished: finished)
        }
        speaker.onRouteChanged = { [weak self] _ in
            self?.sendRoute()
        }
        recorder.onLevel = { [weak self] value in
            self?.micLevel = value
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
    /// which is the only place watchOS will show the prompt (DROVE-62). A
    /// wrist that has already answered is not asked again, only re-read.
    func prepareBuzzer() {
        buzzer.requestAuthorization()
    }

    /// Re-read whether a closed app can buzz, without prompting (DROVE-124).
    ///
    /// Called from `applicationDidFinishLaunching`, the one point every launch
    /// reaches — including the background wake, where the answer matters most
    /// and where nothing used to look. Alerts turned off in the Watch app
    /// months after the prompt was granted are found here rather than never.
    func refreshBuzzPermission() {
        buzzer.refreshPermission()
    }

    /// Play one cue's pattern from the Playground (DROVE-75). Local to this
    /// wrist: nothing is sent, nothing is remembered as played, and no
    /// snapshot is involved. `demoPlaying` holds the cue for as long as the
    /// pattern takes plus the gap, so the row lights while it can be felt.
    func demoBuzz(_ cue: WristCue) {
        demoTask?.cancel()
        demoPlaying = cue
        buzzer.demo(cue)
        demoTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(DroverDemo.gapAfter(cue) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.demoPlaying = nil
        }
    }

    /// Every cue back to back, most urgent first, with a pause after each so
    /// the last beat of one is not felt as the first of the next (DROVE-75).
    /// This is the comparison AC 1 asks for: the patterns have to be told
    /// apart without looking, and that can only be judged side by side.
    func demoBuzzAll() {
        demoTask?.cancel()
        let cues = DroverDemo.cues
        DroverDemo.log("play all: \(cues.map(\.rawValue).joined(separator: ", "))")
        demoTask = Task { @MainActor [weak self] in
            for cue in cues {
                guard let self, !Task.isCancelled else { return }
                self.demoPlaying = cue
                self.buzzer.demo(cue)
                try? await Task.sleep(nanoseconds: UInt64(DroverDemo.gapAfter(cue) * 1_000_000_000))
            }
            guard !Task.isCancelled else { return }
            self?.demoPlaying = nil
        }
    }

    /// Stop a play-all, when the Playground is left mid-run.
    func stopDemo() {
        demoTask?.cancel()
        demoTask = nil
        demoPlaying = nil
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
        return snapshot.accounts.map {
            DroverAccount(
                name: $0,
                headroom: nil,
                loggedIn: nil,
                backAt: nil,
                current: nil,
                limit: nil,
                resetsAt: nil,
                tone: nil
            )
        }
    }

    /// The rows the phone last sent for `sessionId`, or nil when what it last
    /// sent was another session's (DROVE-91). The wrist never draws one
    /// session's conversation under another's title.
    func transcript(for sessionId: String) -> DroverTranscript? {
        guard let transcript = snapshot.transcript, transcript.sessionId == sessionId else { return nil }
        return transcript
    }

    /// The gate a transcript row stands for, while the phone still lists it.
    func gate(withId id: String?) -> DroverGate? {
        guard let id else { return nil }
        return snapshot.gates.first { $0.id == id }
    }

    /// Tell the phone which session's transcript is on screen, or that none
    /// is (DROVE-91). The phone builds rows for that session alone and sends
    /// them by `sendMessage` while this watch is reachable.
    ///
    /// `sendMessage` only, never queued: an "opened" delivered twenty minutes
    /// late names a screen that closed nineteen minutes ago. Sent again on
    /// every foreground, because reachability comes and goes with it and the
    /// phone sends every row afresh on an open.
    func watchTranscript(of sessionId: String?) {
        openedSessionId = sessionId
        guard let session, session.activationState == .activated else { return }
        guard let payload = try? JSONEncoder().encode(DroverOpened(sessionId: sessionId)),
              let dict = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return }
        droverLog.notice("transcript opened session=\(sessionId ?? "none", privacy: .public) reachable=\(session.isReachable, privacy: .public)")
        session.sendMessage(dict, replyHandler: nil, errorHandler: nil)
        // The route rides along with every open: the phone picks the speaker
        // per sentence off the last route it heard, and a wrist that has just
        // come to the front is the wrist that is about to be spoken to.
        if sessionId != nil { sendRoute() }
    }

    /// Say something to a session, from the wrist (DROVE-92). The text is
    /// what watchOS dictation (or the keyboard, or Scribble) handed back; the
    /// phone sends it through the composer's own path, so it lands in the
    /// session and in both transcripts like a typed message. Queued when the
    /// phone is out of reach, like an answer: a sentence spoken to a session
    /// is worth delivering late rather than dropping.
    ///
    /// Returns whether it left this watch, so the caller can show
    /// `lastError` instead of pretending it was sent.
    @discardableResult
    func say(_ session: DroverSession, text: String) -> Bool {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty {
            lastError = "Nothing was heard"
            return false
        }
        return send(DroverSay(sessionId: session.id, text: typed), describing: "message")
    }

    // MARK: The latched composer (DROVE-130)

    /// What the wrist has said to `draftSessionId` so far and not yet sent.
    ///
    /// The LATCH, at the only level watchOS allows one: the input sheet cannot
    /// be held open and there is no in-app recogniser to hold (see
    /// WristDraft), so a tap opens the sheet, what comes back stays here, and
    /// the mic stays armed for the next phrase. Nothing leaves the wrist until
    /// Send. Held on the store rather than in a view's `@State` so a push to a
    /// gate and back, or the transcript screen going away under a
    /// notification, does not throw away a half-dictated message.
    @Published private(set) var draft: WristDraft = .empty
    /// Which session the draft belongs to. A draft is never carried across
    /// sessions: the words were meant for the one that was on screen.
    @Published private(set) var draftSessionId: String?

    /// The draft for this session, or an empty one. A draft left over from
    /// another session reads as empty here and is cleared on the next append.
    func draft(for sessionId: String) -> WristDraft {
        draftSessionId == sessionId ? draft : .empty
    }

    /// A phrase came back from the input sheet: keep it, do not send it
    /// (DROVE-130).
    ///
    /// Every sheet return is its own recognition, so every return APPENDS —
    /// DROVE-140's rule, keyed on the task rather than on comparing strings,
    /// and on the wrist the sheet IS the task. This is what stops the second
    /// thing Clay says from replacing the first, which is the same complaint
    /// on both devices.
    func addToDraft(_ session: DroverSession, heard: String) {
        if draftSessionId != session.id {
            draftSessionId = session.id
            draft = .empty
        }
        let next = draft.appending(heard)
        if next == draft {
            // The sheet was dismissed with nothing in it. Not an error worth a
            // banner, but the wrist must not look as though it took something.
            lastError = "Nothing was heard"
            return
        }
        lastError = nil
        draft = next
    }

    /// Send the whole draft and clear it. The wrist's answer to the phone's
    /// second tap: everything said across every sheet goes as ONE message, in
    /// the order it was said.
    @discardableResult
    func sendDraft(_ session: DroverSession) -> Bool {
        let pending = draft(for: session.id)
        guard !pending.isEmpty else {
            lastError = "Nothing to send"
            return false
        }
        guard say(session, text: pending.text) else { return false }
        clearDraft()
        return true
    }

    /// Throw the draft away. The wrist's slide-off: the words were wrong and
    /// nothing should reach the session.
    func clearDraft() {
        draft = .empty
        draftSessionId = nil
    }

    /// Drop the last phrase. Dictation misheard one thing; re-saying it should
    /// not mean re-saying the paragraph.
    func undoLastPhrase() {
        draft = draft.droppingLast()
        if draft.isEmpty { draftSessionId = nil }
    }


    // MARK: The latched recorder (DROVE-130)

    /// Whether the wrist's microphone is open right now.
    ///
    /// THE ASK, and what shipped instead the first time. Clay asked why a
    /// single press of the microphone could not hold the recorder open so he
    /// could talk, pause, think and keep talking. The first pass at DROVE-130
    /// answered that watchOS cannot do it and moved the latch up a level: the
    /// one-shot `TextFieldLink` sheet stayed, and what it handed back
    /// accumulated in a draft (see `WristDraft`). That is a real improvement
    /// and it is still here — the sheet is how Scribble and the keyboard get
    /// in, and it is the fallback when the phone is out of reach — but it is
    /// not what was asked for. The sheet still ends the recording every time
    /// he stops for breath.
    ///
    /// What that pass got RIGHT is that the watch cannot recognise speech:
    /// `Speech.framework` is genuinely absent from the watchOS SDK. What it
    /// set aside, in its own words as "a different and much larger job", is
    /// that recognition does not have to happen ON the watch. The phone
    /// already owns a recogniser that survives a pause correctly, so the wrist
    /// captures and the phone transcribes. That is this.
    @Published private(set) var listening = false
    /// Input loudness while listening, 0...1, for the meter.
    @Published private(set) var micLevel: Double = 0
    /// What the phone has heard on the open capture. Drawn, never accumulated
    /// here: the phone sends the whole transcript each time (see
    /// `WristHearing`).
    @Published private(set) var hearing: WristHearing = .idle
    /// The session the open capture belongs to.
    private var listeningSessionId: String?
    /// When a latch with nothing new said stops itself.
    private var idleStopAt: Date?
    /// Ticks the idle clock while the microphone is open.
    private var idleWatchdog: Task<Void, Never>?

    /// The single press (DROVE-130).
    ///
    /// One control, two meanings, exactly as the phone's mic button works: a
    /// press with the microphone shut OPENS it and leaves it open; a press
    /// with it open STOPS it and KEEPS the words. Stopping never sends — the
    /// words land in the draft to be read and sent deliberately, which is the
    /// phone's rule that only a lift sends (DROVE-105), and the wrist has no
    /// lift.
    func toggleMic(_ session: DroverSession) {
        if listening {
            stopListening()
        } else {
            startListening(session)
        }
    }

    /// Open the microphone and tell the phone to start recognising.
    func startListening(_ session: DroverSession) {
        guard !listening else { return }
        // A capture id that cannot collide with the last one, so a straggling
        // partial from a capture that has ended is dropped structurally.
        let capture = UUID().uuidString
        recorder.start(captureId: capture) { [weak self] live in
            guard let self else { return }
            guard live else {
                self.lastError = self.recorder.failure ?? "The microphone would not open"
                return
            }
            self.lastError = nil
            self.listening = true
            self.listeningSessionId = session.id
            self.hearing = .opening(capture)
            self.tellPhone(session.id, capture, "start")
            self.armIdleStop()
        }
    }

    /// Close the microphone, keeping every word. The words go into the draft,
    /// which is where Send, Clear and Undo already live.
    func stopListening() {
        guard listening else { return }
        let sessionId = listeningSessionId
        let capture = hearing.captureId
        recorder.stop()
        listening = false
        micLevel = 0
        idleWatchdog?.cancel()
        idleWatchdog = nil
        idleStopAt = nil
        if let sessionId { tellPhone(sessionId, capture, "stop") }
        bankWhatWasHeard(into: sessionId)
        listeningSessionId = nil
    }

    /// Throw the whole capture away. The wrist's cancel, which the phone
    /// spells as sliding the finger off the button before lifting.
    func cancelListening() {
        guard listening else { return }
        let sessionId = listeningSessionId
        let capture = hearing.captureId
        recorder.stop()
        listening = false
        micLevel = 0
        idleWatchdog?.cancel()
        idleWatchdog = nil
        idleStopAt = nil
        hearing = .idle
        listeningSessionId = nil
        if let sessionId { tellPhone(sessionId, capture, "cancel") }
    }

    /// Move what was heard into the draft as one phrase, so a capture behaves
    /// exactly like a sheet return and everything already built on the draft
    /// keeps working.
    private func bankWhatWasHeard(into sessionId: String?) {
        let words = hearing.text.trimmingCharacters(in: .whitespacesAndNewlines)
        hearing = .idle
        guard !words.isEmpty, let sessionId,
              let session = snapshot.sessions.first(where: { $0.id == sessionId }) else { return }
        addToDraft(session, heard: words)
    }

    private func tellPhone(_ sessionId: String, _ capture: String, _ state: String) {
        guard let session, session.activationState == .activated, session.isReachable else { return }
        guard let payload = try? JSONEncoder().encode(
            DroverListen(sessionId: sessionId, capture: capture, state: state)
        ), let dict = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return }
        // Never queued. A "start listening" delivered when the pair reconnects
        // would open a recogniser for audio that was never sent.
        session.sendMessage(dict, replyHandler: nil, errorHandler: nil)
    }

    /// A partial from the phone (DROVE-130).
    ///
    /// The guards that keep this from becoming DROVE-263 again live in
    /// `WristHearing.absorbing`, not here, so they are unit-tested on the Mac
    /// rather than only on a wrist.
    fileprivate func applyHeard(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let heard = try? JSONDecoder().decode(DroverHeard.self, from: data) else { return }
        let next = hearing.absorbing(
            captureId: heard.capture, seq: heard.seq, text: heard.text, final: heard.isFinal
        )
        guard next != hearing else { return }
        // Him talking is the only thing that pushes the idle deadline out. A
        // partial that says the same thing is the recogniser thinking, not
        // Clay speaking.
        if next.text != hearing.text { armIdleStop() }
        hearing = next
        // The recogniser gave up or settled on its own. Close the microphone
        // rather than leaving a latch looking live over a dead task.
        if next.settled, listening { stopListening() }
    }

    /// A latched microphone with nothing new said stops itself, and keeps the
    /// words. The phone's own `DICTATION_LATCH_IDLE_MS`, which `WristAudio`
    /// holds so the two cannot drift apart.
    private func armIdleStop() {
        idleStopAt = Date().addingTimeInterval(WristAudio.idleStopSeconds)
        guard idleWatchdog == nil else { return }
        idleWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self else { return }
                let done = await MainActor.run { () -> Bool in
                    guard self.listening, let deadline = self.idleStopAt else { return true }
                    guard Date() >= deadline else { return false }
                    self.stopListening()
                    return true
                }
                if done { return }
            }
        }
    }

    /// Tell the phone whether this wrist has headphones on its route
    /// (DROVE-92). Reachable only, never queued: a route reported twenty
    /// minutes late describes headphones that have since come off.
    func sendRoute() {
        guard let session, session.activationState == .activated, session.isReachable else { return }
        guard let payload = try? JSONEncoder().encode(DroverAudioRoute(headphones: speaker.headphonesConnected)),
              let dict = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return }
        session.sendMessage(dict, replyHandler: nil, errorHandler: nil)
    }

    /// A sentence the phone sent is over; the phone's queue is waiting to
    /// hear so before it sends the next (DROVE-92).
    private func reportSpoken(id: String, finished: Bool) {
        guard let session, session.activationState == .activated, session.isReachable else { return }
        guard let payload = try? JSONEncoder().encode(DroverSpoken(id: id, finished: finished)),
              let dict = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return }
        session.sendMessage(dict, replyHandler: nil, errorHandler: nil)
    }

    /// The phone asking this wrist to speak a sentence, or to stop
    /// (DROVE-92). Only ever arrives when the phone picked the watch as the
    /// speaker, so nothing here second-guesses the choice.
    fileprivate func applySpeak(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let speak = try? JSONDecoder().decode(DroverSpeak.self, from: data) else { return }
        if speak.isStop {
            speaker.stop()
            return
        }
        guard let id = speak.id, let text = speak.text, !text.isEmpty else { return }
        speaker.speak(id: id, text: text)
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
        // A demo card is never answered on the wire (DROVE-75). Refused
        // before anything is encoded, so no button on GateDetailView can put
        // a `demo:` id on the channel: the fixtures in DroverDemo and the
        // phone's own "Buzz the watch" gate both carry the prefix. The phone
        // and the Mac refuse the same prefix again, but this is the wall the
        // wrist owns. Logged as a demo, and said on screen, because a button
        // that does nothing with no word is the failure the banner exists for.
        if DroverDemo.isDemoId(gate.id) {
            DroverDemo.log(
                "answer refused for \(gate.id): \(allow ? "allow" : "deny")"
                    + " option=\(optionId ?? optionIds?.joined(separator: "+") ?? "none")"
                    + " text=\(text == nil ? "none" : "typed"); nothing sent"
            )
            lastError = "Demo card, nothing was sent"
            return false
        }
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
        // A snapshot with no transcript is a phone that has none to send (an
        // older JS, or the background republish, which builds no rows), not
        // a phone saying the conversation is gone. Keep what the deltas built
        // (DROVE-91).
        var next = decoded
        if next.transcript == nil { next.transcript = snapshot.transcript }
        snapshot = next
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

    /// A transcript delta by `sendMessage` (DROVE-91): the rows that changed
    /// and the id list of the whole window. Merged into what the wrist holds
    /// and persisted with the snapshot, so a watch relaunched with the phone
    /// out of reach still shows the last conversation it saw.
    ///
    /// The phone spoke, so the snapshot's stamp moves with the delta's: a
    /// wrist reading a live reply is not looking at an out-of-date list.
    @discardableResult
    fileprivate func applyTranscriptDelta(_ message: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let delta = try? DroverSnapshot.decoder.decode(DroverTranscriptDelta.self, from: data),
              delta.isTranscript else { return false }
        let merged = DroverTranscript.applying(delta, to: snapshot.transcript)
        snapshot.transcript = merged.transcript
        snapshot.updatedAt = max(snapshot.updatedAt, delta.updatedAt)
        refresh = .answered
        snapshot.save()
        if !merged.missing.isEmpty {
            // Rows the phone thinks this wrist has and it does not: a delta
            // sent before this screen opened, or one that was lost. The
            // snapshot carries the full transcript, so ask for one, with a
            // floor so a run of such deltas is one ask.
            droverLog.notice("transcript delta missing \(merged.missing.count, privacy: .public) rows, asking for a snapshot")
            askPhoneForSnapshot(notMoreOftenThan: 5)
        }
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
            // A transcript delta rides the same channel as a snapshot and is
            // told apart by `kind`, which a snapshot never carries at the top
            // (DROVE-91). Buffered and replayed by the bridge exactly as a
            // snapshot is.
            let kind = message["kind"] as? String
            if kind == DroverTranscriptDelta.kindValue {
                applyTranscriptDelta(message)
            } else if kind == DroverSpeak.kindValue {
                // A sentence to voice on this wrist, or a stop (DROVE-92).
                applySpeak(message)
            } else if kind == DroverHeard.kindValue {
                // What the phone has heard on the open capture (DROVE-130).
                applyHeard(message)
            } else if kind == "cue" {
                // A reply has started being spoken, here or on the phone;
                // the wrist buzzes either way (DROVE-92).
                buzzer.replyStarted()
            } else {
                apply(message)
            }
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
