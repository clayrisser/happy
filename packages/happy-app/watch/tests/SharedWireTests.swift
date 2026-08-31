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

    /// The open session's rows (DROVE-91): four kinds, the streaming mark,
    /// and the gate link, all through the same ISO-8601 decoder as the rest.
    static func aTranscriptSurvivesTheWire() {
        let payload = """
        {"gates":[],"updatedAt":"2026-08-31T01:00:00Z","connected":true,
        "transcript":{"sessionId":"s1","streaming":true,"rows":[
        {"id":"u1","kind":"user","text":"fix the build","at":"2026-08-31T00:59:00Z"},
        {"id":"group-t1","kind":"tools","text":"Ran 4 shell commands","at":"2026-08-31T00:59:10Z"},
        {"id":"q1","kind":"gate","text":"Which?\\nWhich branch?","at":"2026-08-31T00:59:20Z","gateId":"s1:r1"},
        {"id":"a1","kind":"assistant","text":"On it","streaming":true,"at":"2026-08-31T00:59:30Z"},
        {"id":"x1","kind":"hologram","text":"?","at":"2026-08-31T00:59:40Z"}]}}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ), let transcript = snapshot.transcript else {
            check(false, "a snapshot with a transcript decodes")
            return
        }
        check(transcript.sessionId == "s1", "the transcript names its session")
        check(transcript.streaming, "the transcript carries the streaming flag")
        check(transcript.rows.count == 5, "every row decodes, including a kind from the future")
        check(transcript.rows[0].classification == .user, "a user row is a user row")
        check(transcript.rows[1].classification == .tools, "a folded run is a tools row")
        check(transcript.rows[2].classification == .gate && transcript.rows[2].gateId == "s1:r1", "a gate row links to its gate")
        check(transcript.rows[3].classification == .assistant && transcript.rows[3].isStreaming, "the streaming row is marked")
        check(!transcript.rows[0].isStreaming, "an absent streaming key reads as not streaming")
        check(transcript.rows[4].classification == .unknown, "a kind from the future is unknown, not a throw")
        // And back out, for the app group copy the widget and a relaunch read.
        guard let data = try? DroverSnapshot.encoder.encode(snapshot),
              let again = try? DroverSnapshot.decoder.decode(DroverSnapshot.self, from: data) else {
            check(false, "a transcript round-trips through the app group")
            return
        }
        check(again.transcript == transcript, "a transcript round-trips through the app group")
    }

    /// A phone that predates the key, and the background republish, send no
    /// transcript. That is "nothing to say", never a failed decode.
    static func aSnapshotWithoutATranscriptStillDecodes() {
        let payload = """
        {"gates":[],"updatedAt":"2026-08-31T01:00:00Z","connected":true,"sessions":[]}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ) else {
            check(false, "a snapshot with no transcript key decodes")
            return
        }
        check(snapshot.transcript == nil, "a missing transcript is absent, not a throw")
    }

    static func delta(_ payload: String) -> DroverTranscriptDelta? {
        try? DroverSnapshot.decoder.decode(DroverTranscriptDelta.self, from: Data(payload.utf8))
    }

    static func row(_ id: String, _ text: String, kind: String = "assistant") -> DroverTranscriptRow {
        DroverTranscriptRow(id: id, kind: kind, text: text, streaming: nil, at: Date(timeIntervalSince1970: 0), gateId: nil)
    }

    /// A delta carries only what changed and the whole id list; the merge
    /// keeps the rows it already had, takes the new versions, and orders by
    /// the list.
    static func aDeltaMergesIntoWhatTheWristHolds() {
        let held = DroverTranscript(sessionId: "s1", rows: [row("u1", "hi"), row("a1", "hel")], streaming: true)
        guard let delta = delta("""
        {"kind":"transcript","sessionId":"s1","streaming":false,"ids":["u1","a1","a2"],
        "rows":[{"id":"a1","kind":"assistant","text":"hello","at":"2026-08-31T00:59:30Z"},
        {"id":"a2","kind":"assistant","text":"and done","at":"2026-08-31T00:59:40Z"}],
        "updatedAt":"2026-08-31T01:00:00Z"}
        """) else {
            check(false, "a transcript delta decodes")
            return
        }
        check(delta.isTranscript, "a delta is told apart by its kind")
        let merged = DroverTranscript.applying(delta, to: held)
        check(merged.missing.isEmpty, "nothing is missing when the delta and the wrist agree")
        check(merged.transcript.rows.map(\.id) == ["u1", "a1", "a2"], "rows follow the delta's id list")
        check(merged.transcript.rows[0].text == "hi", "a row the delta did not carry is kept")
        check(merged.transcript.rows[1].text == "hello", "a row the delta carried is replaced")
        check(!merged.transcript.streaming, "the streaming flag is the delta's")
    }

    /// A delta for another session never merges with the rows of this one.
    static func aDeltaForAnotherSessionReplacesTheTranscript() {
        let held = DroverTranscript(sessionId: "s1", rows: [row("u1", "hi")], streaming: false)
        guard let delta = delta("""
        {"kind":"transcript","sessionId":"s2","streaming":false,"ids":["x1"],
        "rows":[{"id":"x1","kind":"user","text":"other","at":"2026-08-31T00:59:30Z"}],
        "updatedAt":"2026-08-31T01:00:00Z"}
        """) else {
            check(false, "a delta for another session decodes")
            return
        }
        let merged = DroverTranscript.applying(delta, to: held)
        check(merged.transcript.sessionId == "s2", "the transcript becomes the delta's session")
        check(merged.transcript.rows.map(\.id) == ["x1"], "the old session's rows do not leak in")
        check(merged.missing.isEmpty, "nothing is missing")
    }

    /// A row the phone assumes the wrist has, and it does not, is reported so
    /// the store can ask for a snapshot. The rows it does have are still drawn.
    static func aRowTheWristNeverGotIsReportedMissing() {
        guard let delta = delta("""
        {"kind":"transcript","sessionId":"s1","streaming":false,"ids":["u1","a1"],
        "rows":[{"id":"a1","kind":"assistant","text":"hello","at":"2026-08-31T00:59:30Z"}],
        "updatedAt":"2026-08-31T01:00:00Z"}
        """) else {
            check(false, "a delta with an unknown id decodes")
            return
        }
        let merged = DroverTranscript.applying(delta, to: nil)
        check(merged.missing == ["u1"], "the id the wrist has no row for is reported")
        check(merged.transcript.rows.map(\.id) == ["a1"], "the rows it does have are kept")
    }

    /// The wrist's "opened" is told apart from an answer and a flip by `kind`,
    /// and a closed transcript sends no session at all rather than null.
    static func anOpenedMessageCarriesItsKind() {
        let opened = json(DroverOpened(sessionId: "s1"))
        check(opened["kind"] as? String == "opened", "an opened message says what it is")
        check(opened["sessionId"] as? String == "s1", "an opened message names the session")
        let closed = json(DroverOpened(sessionId: nil))
        check(closed["sessionId"] == nil, "a closed transcript omits the session rather than sending null")
    }

    static func main() {
        answerOmitsWhatItDoesNotCarry()
        answerCarriesTypedText()
        answerCarriesEveryPickOnAMultiSelect()
        freeTextQuestionSurvivesTheWire()
        optionWithoutAnIdFallsBackToItsLabel()
        ageAloneIsNotOutOfDate()
        anAskThatBroughtNothingNewerIsOutOfDate()
        aFreshSnapshotIsNeverQuestioned()
        anAgingSnapshotIsWorthAsking()
        aMultiSelectQuestionSurvivesTheWire()
        aTodoIsItsOwnKindAndNotAGate()
        aSnapshotWithoutTheNewKeysStillDecodes()
        sessionCarriesWhatItIsDoing()
        sessionWithoutAStatusStillDecodes()
        theSessionStateTheWristDrawsIsThePhonesOwn()
        aStateTheWristDoesNotKnowFallsBackRatherThanThrowing()
        theWristTakesThePhonesTitleVerbatim()
        accountHeadroomSurvivesTheWire()
        aNewGateEarnsACue()
        aGateTheWristAlreadyKnowsDoesNot()
        anOldGateDoesNotBuzzOnAColdLaunch()
        aSessionThatStoppedRunningEarnsAQuieterCue()
        theLoudestCueWinsAnArrival()
        anUnknownKindStillBuzzes()
        everyCueFeelsDifferent()
        onlyABlockedSessionBreaksThroughFocus()
        aTranscriptSurvivesTheWire()
        aSnapshotWithoutATranscriptStillDecodes()
        aDeltaMergesIntoWhatTheWristHolds()
        aDeltaForAnotherSessionReplacesTheTranscript()
        aRowTheWristNeverGotIsReportedMissing()
        anOpenedMessageCarriesItsKind()
        everyDemoFixtureIsADemo()
        theDemoFixturesCoverEveryShapeTheWristDraws()
        theDemoPlaysEveryCueLoudestFirst()
        aDemoGapOutlastsThePattern()
        thePhonesBuzzGateIsADemoAndStillBuzzes()

        if failures.isEmpty {
            print("\nall wire checks passed")
            exit(0)
        }
        print("\n\(failures.count) failed")
        exit(1)
    }

    // MARK: DROVE-75, the Playground

    /// The wall the wrist owns: `GateStore.answer` refuses the `demo:` prefix
    /// before encoding anything, so every fixture has to carry it. One
    /// fixture without it would be a card whose Allow button sends.
    static func everyDemoFixtureIsADemo() {
        let gates = DroverDemo.gates()
        check(!gates.isEmpty, "the demo has fixtures")
        check(gates.allSatisfy { DroverDemo.isDemoId($0.id) }, "every demo fixture id starts with demo:")
        check(gates.allSatisfy { $0.account == "demo" }, "every demo fixture is on the demo account")
        check(Set(gates.map(\.id)).count == gates.count, "demo fixture ids are distinct")
        check(DroverDemo.idPrefix == "demo:", "the prefix is the phone's DEMO_ID_PREFIX")
        check(!DroverDemo.isDemoId("s1:r1"), "a real gate id is not a demo")
        check(!DroverDemo.isDemoId("demo"), "the bare word is not the prefix")
    }

    /// The layouts are compared side by side, so every shape GateDetailView
    /// draws has to be on the list: allow/deny, pick one, typed, pick
    /// several, done/drop, and an acknowledge.
    static func theDemoFixturesCoverEveryShapeTheWristDraws() {
        let gates = DroverDemo.gates()
        let kinds = Set(gates.map(\.classification))
        check(kinds.contains(.permission), "a permission card is on the demo")
        check(kinds.contains(.question), "a question card is on the demo")
        check(kinds.contains(.todo), "a needs-you card is on the demo")
        check(kinds.contains(.expiry), "an account-limit card is on the demo")
        check(!kinds.contains(.unknown), "no fixture has a kind the wrist does not know")
        let questions = gates.filter(\.isQuestion)
        check(questions.contains { !$0.answerableOptions.isEmpty && !$0.allowsMultipleAnswers }, "a pick-one question is on the demo")
        check(questions.contains { $0.answerableOptions.isEmpty }, "a typed question is on the demo")
        check(questions.contains { $0.allowsMultipleAnswers }, "a pick-several question is on the demo")
        // The fixtures are built with the memberwise init, which the
        // hand-written decoder in an extension has to leave standing; and
        // they round-trip, so a fixture is a gate the wire could carry. On a
        // whole second, because ISO-8601 carries none of the fraction.
        let stamped = DroverDemo.gates(now: Date(timeIntervalSince1970: 1_756_600_000))
        guard let data = try? DroverSnapshot.encoder.encode(stamped),
              let again = try? DroverSnapshot.decoder.decode([DroverGate].self, from: data) else {
            check(false, "the demo fixtures round-trip through the wire coders")
            return
        }
        check(again == stamped, "the demo fixtures round-trip through the wire coders")
    }

    /// Back to back, most urgent first, and none missing: a cue the enum
    /// grows must show up on the Playground without anyone remembering to
    /// add it.
    static func theDemoPlaysEveryCueLoudestFirst() {
        let cues = DroverDemo.cues
        check(cues.count == WristCue.allCases.count, "the demo plays every cue")
        check(Set(cues).count == cues.count, "the demo plays each cue once")
        check(cues.first == .needsYou && cues.last == .finished, "the demo plays loudest first")
        check(zip(cues, cues.dropFirst()).allSatisfy { $0.rank > $1.rank }, "the demo order is the wrist's rank")
        check(DroverDemo.describe(.needsYou) == "3 beats · tap, thud, thud", "a pattern reads as its beats")
        check(DroverDemo.describe(.permission) == "1 beat · tap", "one beat is singular")
    }

    /// The pause after each pattern has to be longer than the pattern, or
    /// the last beat of one is the first of the next and the comparison is
    /// worthless.
    static func aDemoGapOutlastsThePattern() {
        for cue in WristCue.allCases {
            let pattern = Double(max(0, cue.beats.count - 1)) * cue.beatGap
            check(DroverDemo.gapAfter(cue) > pattern + 0.5, "the gap after \(cue.rawValue) outlasts its pattern")
        }
    }

    /// What the phone's "Buzz the watch" row publishes (sources/utils/
    /// wristCues.ts demoBuzzGate): a `demo:buzz-<cue>-<stamp>` gate of the
    /// cue's wire kind, in an otherwise normal snapshot. It has to decode, be
    /// a demo, and still earn the cue, because the real pattern by the real
    /// path is the whole reason the phone sends it.
    static func thePhonesBuzzGateIsADemoAndStillBuzzes() {
        let now = Date()
        let iso = ISO8601DateFormatter().string(from: now)
        let payload = """
        {"gates":[{"id":"demo:buzz-needsYou-1756600000000","title":"Demo · Do something",
        "reason":"the phone's channel demo","preview":"3 beats: An agent asked you to do something. Three taps.",
        "kind":"todo","createdAt":"\(iso)","account":"demo"}],
        "updatedAt":"\(iso)","connected":true}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(DroverSnapshot.self, from: Data(payload.utf8)),
              let gate = snapshot.gates.first else {
            check(false, "the phone's buzz gate decodes")
            return
        }
        check(DroverDemo.isDemoId(gate.id), "the phone's buzz gate is a demo")
        check(gate.classification == .todo, "the phone's buzz gate keeps its wire kind")
        let cues = WristCueDiff.cues(from: .empty, to: snapshot, now: now)
        check(cues.map(\.cue) == [.needsYou], "the phone's buzz gate earns the cue it was sent for")
        check(cues.first.map { DroverDemo.isDemoId($0.id) } == true, "the cue it earns is a demo by id, for the log")
    }

    /// Absent, never null. WatchConnectivity payloads take property-list types
    /// only and JSON null decodes to NSNull, which is not one — a single null
    /// fails the whole send, so an unanswered field has to leave no key behind.
    static func answerOmitsWhatItDoesNotCarry() {
        let allow = json(DroverAnswer(id: "s1:r1", allow: true, optionId: nil, text: nil, optionIds: nil, scope: nil))
        check(allow["id"] as? String == "s1:r1", "a permission answer keeps its gate id")
        check(allow["allow"] as? Bool == true, "a permission answer keeps its verdict")
        check(allow["optionId"] == nil, "no optionId key on a permission answer")
        check(allow["text"] == nil, "no text key on a permission answer")
        check(allow["scope"] == nil, "no scope key on a plain allow")

        // "Allow, and stop asking this session" (DROVE-53). The wrist could
        // only ever say yes once, so a gate firing on every run of the same
        // command had to be answered every time.
        let forever = json(DroverAnswer(
            id: "s1:r1", allow: true, optionId: nil, text: nil, optionIds: nil, scope: "session"))
        check(forever["scope"] as? String == "session", "allow-for-session travels as scope")
    }

    /// The typed answer the wrist can now give. It rides beside `optionId`
    /// rather than inside it so the phone can tell a pick from a typed answer.
    static func answerCarriesTypedText() {
        let typed = json(DroverAnswer(id: "s1:r1", allow: true, optionId: nil, text: "rebase onto main", optionIds: nil, scope: nil))
        check(typed["text"] as? String == "rebase onto main", "a typed answer travels as text")
        check(typed["optionId"] == nil, "a typed answer sends no optionId")

        let picked = json(DroverAnswer(id: "s1:r1", allow: true, optionId: "Step 1 first", text: nil, optionIds: nil, scope: nil))
        check(picked["optionId"] as? String == "Step 1 first", "a picked answer travels as optionId")
        check(picked["text"] == nil, "a picked answer sends no text")
    }

    /// A multi-select answers with a LIST (DROVE-53). `optionId` still carries
    /// the first pick, so the phone and the CLI paths that only ever knew that
    /// key are unaffected — and a single pick sends no array at all, because an
    /// array where the reader expects one string is how a pick-one answer would
    /// start arriving as a list nobody asked for.
    static func answerCarriesEveryPickOnAMultiSelect() {
        let many = json(DroverAnswer(
            id: "s1:r1", allow: true, optionId: "a", text: nil, optionIds: ["a", "c"], scope: nil))
        check(many["optionIds"] as? [String] == ["a", "c"], "a multi-select answer carries every pick")
        check(many["optionId"] as? String == "a", "a multi-select answer still fills optionId")

        let one = json(DroverAnswer(
            id: "s1:r1", allow: true, optionId: "a", text: nil, optionIds: nil, scope: nil))
        check(one["optionIds"] == nil, "a single pick sends no optionIds key at all")
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

    /// The DROVE-22 defect, in one check: a snapshot that has merely AGED is
    /// not out of date. Only a phone app that happened to be on screen ever
    /// restamped `updatedAt`, and iOS suspends a backgrounded app within
    /// seconds, so three minutes after Clay put the phone down the wrist said
    /// "Out of date" whether or not anything was wrong — and he looks at the
    /// watch precisely when the phone is in his pocket.
    static func ageAloneIsNotOutOfDate() {
        let now = Date()
        let old = DroverSnapshot(
            gates: [], updatedAt: now.addingTimeInterval(-3600), connected: true
        )
        check(old.isStale(at: now), "an hour-old snapshot is still stale by age")
        check(
            old.freshness(at: now, refresh: .never) == .asking,
            "an aged snapshot with no ask yet made reads as asking, not out of date"
        )
        check(
            old.freshness(at: now, refresh: .asking) == .asking,
            "an aged snapshot with an ask in flight reads as asking"
        )
    }

    /// The other half: once the wrist HAS asked and got nothing newer, saying
    /// so is the honest answer, and the reason goes with it.
    static func anAskThatBroughtNothingNewerIsOutOfDate() {
        let now = Date()
        let old = DroverSnapshot(
            gates: [], updatedAt: now.addingTimeInterval(-3600), connected: true
        )
        check(
            old.freshness(at: now, refresh: .answered) == .stale(reason: nil),
            "a phone that answered with the same old snapshot is out of date"
        )
        check(
            old.freshness(at: now, refresh: .failed("Counterpart app not installed"))
                == .stale(reason: "Counterpart app not installed"),
            "a failed ask is out of date, and carries what WatchConnectivity said"
        )
    }

    /// A recent snapshot is fresh whatever the last ask did — including an ask
    /// that failed while a pushed context was already on its way.
    static func aFreshSnapshotIsNeverQuestioned() {
        let now = Date()
        let recent = DroverSnapshot(
            gates: [], updatedAt: now.addingTimeInterval(-5), connected: true
        )
        check(recent.freshness(at: now, refresh: .never) == .fresh, "a 5s-old snapshot is fresh")
        check(
            recent.freshness(at: now, refresh: .failed("Not reachable")) == .fresh,
            "a failed ask does not make a snapshot that is five seconds old stale"
        )
    }

    /// Asking is cheaper than being wrong, so the wrist asks a whole heartbeat
    /// before it would have called the list stale — 60s, not 180s.
    static func anAgingSnapshotIsWorthAsking() {
        let now = Date()
        func snapshot(secondsOld: TimeInterval) -> DroverSnapshot {
            DroverSnapshot(gates: [], updatedAt: now.addingTimeInterval(-secondsOld), connected: true)
        }
        check(!snapshot(secondsOld: 30).needsAsking(at: now), "a 30s-old snapshot is left alone")
        check(snapshot(secondsOld: 90).needsAsking(at: now), "a 90s-old snapshot is worth asking about")
        check(!snapshot(secondsOld: 90).isStale(at: now), "and it is asked about well before it goes stale")
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

    /// multiSelect decides whether the wrist draws one-tap buttons or toggles
    /// plus a Send. Reading it wrong is not cosmetic: with one-tap buttons on a
    /// multi-select question the first tap becomes the whole answer, which is
    /// the loss this ticket exists to close.
    static func aMultiSelectQuestionSurvivesTheWire() {
        let payload = """
        {"gates":[{"id":"s1:r1","title":"Which suites?","reason":"","preview":"Pick some",
        "kind":"question","createdAt":"2026-08-29T12:00:00Z","multiSelect":true,
        "options":[{"id":"a","label":"Alpha"},{"id":"b","label":"Beta"}]}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        guard let gate = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ).gates.first else {
            check(false, "a multi-select question decodes")
            return
        }
        check(gate.allowsMultipleAnswers, "a multi-select question asks for toggles")
        check(gate.answerableOptions.count == 2, "a multi-select question keeps its options")
    }

    /// The needs-you record (DROVE-53). It has to classify as `todo` and NOT
    /// fall into the unknown branch, which renders allow/deny — a to-do has
    /// neither, it is done or dropped.
    static func aTodoIsItsOwnKindAndNotAGate() {
        let payload = """
        {"gates":[{"id":"s1:r1","title":"push the release","reason":"the lane is blocked",
        "preview":"git push","kind":"todo","createdAt":"2026-08-29T12:00:00Z",
        "options":[{"id":"done","label":"Done"},{"id":"drop","label":"Drop it"}]}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        guard let gate = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ).gates.first else {
            check(false, "a to-do decodes")
            return
        }
        check(gate.classification == .todo, "a to-do classifies as todo, not unknown")
        check(!gate.isQuestion, "a to-do is not a question")
        check(!gate.allowsMultipleAnswers, "a to-do never asks for toggles")
    }

    /// A phone that predates multiSelect sends no such key, and the app-group
    /// blob outlives an app update — so a snapshot without it has to decode
    /// whole rather than blanking the wrist. Absent reads as single-select,
    /// which is what every gate was before the key existed.
    static func aSnapshotWithoutTheNewKeysStillDecodes() {
        let payload = """
        {"gates":[{"id":"s1:r1","title":"Which one?","reason":"","preview":"Pick",
        "kind":"question","createdAt":"2026-08-29T12:00:00Z",
        "options":[{"id":"a","label":"Alpha"}]}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        guard let gate = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ).gates.first else {
            check(false, "a snapshot with no multiSelect key decodes")
            return
        }
        check(gate.multiSelect == nil, "a missing multiSelect key is absent, not a throw")
        check(!gate.allowsMultipleAnswers, "an absent multiSelect reads as single-select")
    }

    /// The wrist's half of DROVE-54: one line saying what the session is
    /// doing, and the start of the turn it is doing it in.
    ///
    /// `statusSince` is a date, so it goes through the same ISO-8601 strategy
    /// as a gate's createdAt. Getting that wrong does not degrade — a default
    /// decoder expects seconds since 2001 and fails the WHOLE snapshot, so the
    /// wrist would stop updating entirely rather than lose one line.
    static func sessionCarriesWhatItIsDoing() {
        let payload = """
        {"gates":[],"updatedAt":"2026-08-30T19:50:00Z","connected":true,
        "sessions":[{"id":"s1","title":"cattle-drover","account":"bitspur","active":true,
        "path":"/Users/x/Projects/cattle-drover","subagents":6,
        "status":"Bash · drover-relaunch 3/5 · 6 agents",
        "statusSince":"2026-08-30T19:32:47Z"}]}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ), let session = snapshot.sessions.first else {
            check(false, "a session carrying a live status decodes")
            return
        }
        check(session.status == "Bash · drover-relaunch 3/5 · 6 agents", "the wrist gets the one-line status")
        check(session.statusSince == ISO8601DateFormatter().date(from: "2026-08-30T19:32:47Z"), "the turn start decodes as a date")
    }

    /// A phone that predates the field sends neither key. Both are Optional,
    /// which is the only way a missing key is forgiven — a property with a
    /// default still throws, which is the trap the snapshot decoder below was
    /// hand-written for.
    static func sessionWithoutAStatusStillDecodes() {
        let payload = """
        {"gates":[],"updatedAt":"2026-08-30T19:50:00Z","connected":true,
        "sessions":[{"id":"s1","title":"cattle-drover","account":null,"active":true}]}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ), let session = snapshot.sessions.first else {
            check(false, "a session with no status key decodes")
            return
        }
        check(session.status == nil, "a session with no status key decodes")
        check(session.statusSince == nil, "a session with no statusSince key decodes")
        check(session.state == nil, "a session with no state key decodes")
        check(
            session.resolvedState == .thinking,
            "a running session from a phone that predates `state` still reads as busy"
        )
    }

    /// The phone resolves the session state and SENDS it, because the wrist
    /// cannot import resolveSessionState (DROVE-129). Every word in the
    /// phone's SessionState union has to land on a case here, or the wrist
    /// silently falls back to `active` and starts answering a different
    /// question from the phone's list.
    static func theSessionStateTheWristDrawsIsThePhonesOwn() {
        let wire = ["disconnected", "waiting", "thinking", "permission_required", "input_required"]
        for raw in wire {
            check(
                SessionState(rawValue: raw) != nil,
                "the wrist knows the phone's `\(raw)` state"
            )
        }
        check(
            Set(SessionState.allCases.map(\.rawValue)) == Set(wire),
            "the wrist knows exactly the phone's five states and no sixth of its own"
        )
        check(SessionState.thinking.label == "working", "a busy turn is `working`, the phone's own word for one it cannot name")
        check(SessionState.waiting.label == "online", "an idle connected session is `online`, as the phone says")
        check(SessionState.disconnected.label == "offline", "a disconnected session is `offline`, as the phone says")
        check(
            SessionState.permissionRequired.label == "permission required"
                && SessionState.inputRequired.label == "waiting for your answer",
            "the two blocked states carry the phone's own strings"
        )
        check(
            SessionState.permissionRequired.needsYou && SessionState.inputRequired.needsYou
                && !SessionState.thinking.needsYou,
            "only the two blocked states are waiting on a human"
        )
        check(
            SessionState.disconnected.tintHex == "999999"
                && SessionState.waiting.tintHex == "34C759"
                && SessionState.thinking.tintHex == "007AFF"
                && SessionState.permissionRequired.tintHex == "FF9500"
                && SessionState.inputRequired.tintHex == "FF9500",
            "the dot on the wrist is the colour the phone's list draws for the same state"
        )
    }

    /// A state the wrist has never heard of costs the STATE, not the session.
    /// Same rule as DroverGate.Kind: a Codable enum would throw and take the
    /// whole snapshot with it.
    static func aStateTheWristDoesNotKnowFallsBackRatherThanThrowing() {
        let payload = """
        {"gates":[],"updatedAt":"2026-08-30T19:50:00Z","connected":true,
        "sessions":[{"id":"s1","title":"DROVER","account":null,"active":false,"state":"levitating"}]}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ), let session = snapshot.sessions.first else {
            check(false, "a session carrying an unknown state still decodes")
            return
        }
        check(session.state == "levitating", "the unknown state survives the wire verbatim")
        check(session.resolvedState == .disconnected, "an unknown state falls back to what `active` says")
    }

    /// The name the session was GIVEN, not its folder (DROVE-127). The phone
    /// derives it and the wrist draws it; there is nothing here for the wrist
    /// to compute, which is the whole fix.
    static func theWristTakesThePhonesTitleVerbatim() {
        let payload = """
        {"gates":[],"updatedAt":"2026-08-30T19:50:00Z","connected":true,
        "sessions":[{"id":"s1","title":"DROVER","account":"bitspur","active":true,
        "path":"/Users/x/Projects/cattle-drover","state":"thinking"}]}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ), let session = snapshot.sessions.first else {
            check(false, "a named session decodes")
            return
        }
        check(session.title == "DROVER", "the wrist shows the name the phone shows, not the directory")
        check(session.path == "/Users/x/Projects/cattle-drover", "the directory still travels, under the title")
        check(session.resolvedState == .thinking, "the phone's resolved state reaches the wrist")
    }

    /// The flip picker orders by headroom (DROVE-28's watch half), so the row
    /// has to carry the figure and not just the name.
    static func accountHeadroomSurvivesTheWire() {
        let payload = """
        {"gates":[],"updatedAt":"2026-08-29T12:00:00Z","connected":true,
        "accounts":["jamrizzi","main","spare"],
        "accountRows":[{"name":"jamrizzi","headroom":65,"loggedIn":true},
        {"name":"main","headroom":0,"loggedIn":true,"backAt":"2026-08-29T17:00:00Z"},
        {"name":"spare","loggedIn":false}]}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ) else {
            check(false, "an accountRows snapshot decodes")
            return
        }
        check(snapshot.accountRows.count == 3, "every account row decodes")
        check(snapshot.accountRows[0].headroom == 65, "an account keeps its headroom")
        check(snapshot.accountRows[1].backAt != nil, "a cooling account keeps when it is back")
        // Never measured is not the same as measured at zero: a 0 reads as
        // "out" and would hide the one account with room.
        check(snapshot.accountRows[2].headroom == nil, "an unmeasured account carries no figure")
        check(snapshot.accountRows[2].loggedIn == false, "a logged-out account says so")
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
            options: nil,
            multiSelect: nil
        )
    }

    static func session(_ id: String, active: Bool, state: String? = nil) -> DroverSession {
        DroverSession(
            id: id, title: id, account: nil, active: active,
            path: nil, subagents: nil, status: nil, statusSince: nil, state: state
        )
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
        // The wire kind is `todo` (droverGates, DroverGate.Kind). Selection is
        // by raw value, so a cue spelled differently from the wire quietly
        // becomes a permission buzz and loses its own pattern.
        check(
            WristCue.forGateKind("todo") == .needsYou,
            "the DROVE-53 needs-you kind maps to its own cue, not to permission"
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
