import Foundation

/// What the phone and the wrist have to agree on, checked without a simulator
/// (BASED-98).
///
/// DroverSnapshot.swift imports Foundation and nothing else, so these run on
/// the Mac in about a second. `xcodebuild` proves the watch app compiles; this
/// proves the FORMAT, which is where the failures have actually been: a null
/// where a key should have been absent fails a WatchConnectivity publish whole,
/// and a decoder that throws on one unexpected value blanks the wrist rather
/// than dropping a row.
@main
struct SharedWireTests {
    static var failures: [String] = []

    static func check(_ condition: Bool, _ what: String) {
        if condition {
            print("ok   \(what)")
        } else {
            failures.append(what)
            print("FAIL \(what)")
        }
    }

    static func json<T: Encodable>(_ value: T) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(value),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return dict
    }

    static func main() {
        answerOmitsWhatItDoesNotCarry()
        answerCarriesTypedText()
        freeTextQuestionSurvivesTheWire()
        optionWithoutAnIdFallsBackToItsLabel()
        aNewGateEarnsACue()
        aGateTheWristAlreadyKnowsDoesNot()
        anOldGateDoesNotBuzzOnAColdLaunch()
        aSessionThatStoppedRunningEarnsAQuieterCue()
        theLoudestCueWinsAnArrival()
        anUnknownKindStillBuzzes()
        everyCueFeelsDifferent()
        onlyABlockedSessionBreaksThroughFocus()

        if failures.isEmpty {
            print("\nall wire checks passed")
            exit(0)
        }
        print("\n\(failures.count) failed")
        exit(1)
    }

    /// Absent, never null. WatchConnectivity payloads take property-list types
    /// only and JSON null decodes to NSNull, which is not one — a single null
    /// fails the whole send, so an unanswered field has to leave no key behind.
    static func answerOmitsWhatItDoesNotCarry() {
        let allow = json(DroverAnswer(id: "s1:r1", allow: true, optionId: nil, text: nil))
        check(allow["id"] as? String == "s1:r1", "a permission answer keeps its gate id")
        check(allow["allow"] as? Bool == true, "a permission answer keeps its verdict")
        check(allow["optionId"] == nil, "no optionId key on a permission answer")
        check(allow["text"] == nil, "no text key on a permission answer")
    }

    /// The typed answer the wrist can now give. It rides beside `optionId`
    /// rather than inside it so the phone can tell a pick from a typed answer.
    static func answerCarriesTypedText() {
        let typed = json(DroverAnswer(id: "s1:r1", allow: true, optionId: nil, text: "rebase onto main"))
        check(typed["text"] as? String == "rebase onto main", "a typed answer travels as text")
        check(typed["optionId"] == nil, "a typed answer sends no optionId")

        let picked = json(DroverAnswer(id: "s1:r1", allow: true, optionId: "Step 1 first", text: nil))
        check(picked["optionId"] as? String == "Step 1 first", "a picked answer travels as optionId")
        check(picked["text"] == nil, "a picked answer sends no text")
    }

    /// The gate the wrist used to punt to the phone: a question whose card
    /// carried no options at all. It has to decode with the `options` key
    /// missing entirely, because the phone omits an empty list rather than
    /// sending one, and it is still a question the wrist can answer by typing.
    static func freeTextQuestionSurvivesTheWire() {
        let payload = """
        {"gates":[{"id":"s1:r1","title":"Which branch?","reason":"/a/work",
        "preview":"Which branch should this land on?","kind":"question",
        "createdAt":"2026-08-29T12:00:00Z"}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ) else {
            check(false, "a snapshot with an optionless question decodes")
            return
        }
        check(snapshot.gates.count == 1, "a snapshot with an optionless question decodes")
        let gate = snapshot.gates[0]
        check(gate.isQuestion, "an optionless gate is still classified a question")
        check(gate.answerableOptions.isEmpty, "an optionless question offers no options to pick")
        // Absent keys, not nulls: this is the same snapshot shape the feed
        // publishes, and it must not need account or sessions to be present.
        check(gate.account == nil, "a gate with no account decodes rather than throwing")
        check(snapshot.sessions.isEmpty, "a snapshot with no sessions key decodes")
    }

    /// Claude's own AskUserQuestion options carry {label, description} and no
    /// id. Requiring the key would fail the whole snapshot on a native card.
    static func optionWithoutAnIdFallsBackToItsLabel() {
        let payload = """
        {"gates":[{"id":"s1:r1","title":"Order?","reason":"","preview":"Which order?",
        "kind":"question","createdAt":"2026-08-29T12:00:00Z",
        "options":[{"label":"Step 1 first","description":"the safe one"}]}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ), let option = snapshot.gates.first?.answerableOptions.first else {
            check(false, "an id-less option decodes")
            return
        }
        check(option.id == "Step 1 first", "an id-less option answers by its label")
        check(option.detail == "the safe one", "an option's description lands on detail")
    }

    // ---- the wrist buzz, DROVE-62 -----------------------------------------
    //
    // Push has not been a path to the wrist: of the 888 sendSessionNotification
    // verdicts in ~/.happy/logs on 2026-08-30, 798 died InvalidCredentials and
    // 58 were dropped active-ui-client, leaving 21 delivered. WristCueDiff is
    // the second path's decision — what the watch buzzes about, from the
    // snapshot alone — and it is checked here because the SIMULATOR HAS NO
    // TAPTIC ENGINE, so this is the only part of the buzz that can be proven
    // anywhere but on a wrist.

    static func gate(
        _ id: String,
        kind: String = "question",
        secondsAgo: TimeInterval = 1,
        preview: String = "pick one"
    ) -> DroverGate {
        DroverGate(
            id: id,
            title: "Question",
            reason: "cattle-drover",
            preview: preview,
            kind: kind,
            createdAt: Date().addingTimeInterval(-secondsAgo),
            account: nil,
            options: nil
        )
    }

    static func session(_ id: String, active: Bool) -> DroverSession {
        DroverSession(id: id, title: id, account: nil, active: active, path: nil, subagents: nil)
    }

    static func snapshot(gates: [DroverGate] = [], sessions: [DroverSession] = []) -> DroverSnapshot {
        DroverSnapshot(gates: gates, updatedAt: Date(), connected: true, sessions: sessions, accounts: [])
    }

    static func aNewGateEarnsACue() {
        let cues = WristCueDiff.cues(from: snapshot(), to: snapshot(gates: [gate("s1:r1")]))
        check(cues.count == 1, "a gate the wrist has not seen earns exactly one cue")
        check(cues.first?.cue == .question, "an AskUserQuestion gate buzzes as a question")
        check(cues.first?.id == "s1:r1", "the cue is keyed on the gate id, so a redelivery buzzes once")
        check(cues.first?.detail == "pick one", "the cue carries the gate's own preview")
    }

    static func aGateTheWristAlreadyKnowsDoesNot() {
        let waiting = snapshot(gates: [gate("s1:r1")])
        check(
            WristCueDiff.cues(from: waiting, to: waiting).isEmpty,
            "a gate that was already on the wall does not buzz again"
        )
    }

    /// The cold-launch guard. The watch's `previous` is whatever it persisted
    /// in the app group, which after a night on the charger is arbitrarily
    /// old — without the freshness window every gate in the first snapshot
    /// reads as new and the wrist buzzes about work answered in tmux hours ago.
    static func anOldGateDoesNotBuzzOnAColdLaunch() {
        let stale = gate("s1:old", secondsAgo: WristCueDiff.freshWindow + 30)
        let fresh = gate("s1:new", secondsAgo: 5)
        let cues = WristCueDiff.cues(from: snapshot(), to: snapshot(gates: [stale, fresh]))
        check(cues.count == 1, "a gate older than the freshness window is not worth a wrist")
        check(cues.first?.id == "s1:new", "the gate raised seconds ago still buzzes")
    }

    static func aSessionThatStoppedRunningEarnsAQuieterCue() {
        let before = snapshot(sessions: [session("a", active: true), session("b", active: false)])
        let after = snapshot(sessions: [session("a", active: false), session("b", active: false)])
        let cues = WristCueDiff.cues(from: before, to: after)
        check(cues.count == 1, "only the session that actually stopped earns a cue")
        check(cues.first?.cue == .finished, "a finished session buzzes as finished")
        check(cues.first?.id == "finished:a", "a finished cue is keyed on the session")
        check(
            WristCueDiff.cues(from: nil, to: after).isEmpty,
            "with nothing to compare against, no session has finished"
        )
    }

    /// Three gates published together is ONE arrival. The list is ordered so
    /// the buzzer plays the most urgent and marks the rest seen — a wrist
    /// cannot tell three patterns played back to back from one long one.
    static func theLoudestCueWinsAnArrival() {
        let before = snapshot(sessions: [session("a", active: true)])
        let after = snapshot(
            gates: [gate("s1:p", kind: "permission"), gate("s1:q", kind: "question")],
            sessions: [session("a", active: false)]
        )
        let cues = WristCueDiff.cues(from: before, to: after)
        check(cues.count == 3, "every change is reported, so none is silently forgotten")
        check(cues.first?.cue == .question, "the question outranks the permission and the finish")
        check(cues.last?.cue == .finished, "a finished session is the quietest thing here")
    }

    /// A kind this build has never heard of is still something waiting on a
    /// human. Silence is the worse failure, so it buzzes as a permission
    /// rather than being dropped.
    static func anUnknownKindStillBuzzes() {
        let cues = WristCueDiff.cues(from: snapshot(), to: snapshot(gates: [gate("s1:x", kind: "handshake")]))
        check(cues.first?.cue == .permission, "an unknown kind buzzes rather than being dropped")
        check(
            WristCue.forGateKind("needs-you") == .needsYou,
            "the DROVE-53 needs-you kind already maps to its own cue"
        )
    }

    /// The distinguishability the wrist is judged on: no two cues may feel the
    /// same. Count as well as texture, because a sleeve blurs texture.
    static func everyCueFeelsDifferent() {
        var seen: [[WristBeat]] = []
        for cue in WristCue.allCases {
            check(!cue.beats.isEmpty, "\(cue.rawValue) has a pattern at all")
            check(!seen.contains(cue.beats), "\(cue.rawValue) feels different from every other cue")
            seen.append(cue.beats)
        }
        var ranks: Set<Int> = []
        for cue in WristCue.allCases { ranks.insert(cue.rank) }
        check(ranks.count == WristCue.allCases.count, "no two cues tie for urgency")
    }

    /// Time-sensitive is what gets a blocked session past a Focus. A session
    /// merely finishing is exactly what Focus is for.
    static func onlyABlockedSessionBreaksThroughFocus() {
        check(WristCue.question.breaksThroughFocus, "a question interrupts a Focus")
        check(WristCue.needsYou.breaksThroughFocus, "a needs-you request interrupts a Focus")
        check(WristCue.permission.breaksThroughFocus, "a permission gate interrupts a Focus")
        check(!WristCue.finished.breaksThroughFocus, "a finished session waits for you")
    }
}
