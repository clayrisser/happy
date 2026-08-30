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
        multiSelectSurvivesTheWire()
        needsYouIsAKindThisBuildKnows()
        aSnapshotFromAnOlderPhoneStillDecodes()
        accountHeadroomSurvivesTheWire()
        sessionStatusSurvivesTheWire()
        refreshIsToldApartByItsKind()

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

    /// The kind of question the wrist could not answer at all (DROVE-53 Part
    /// A): one that wants SEVERAL of its options. One tick was the whole of
    /// what could be sent, so the harness got a single label back for a
    /// question that asked for a set.
    static func multiSelectSurvivesTheWire() {
        let payload = """
        {"gates":[{"id":"s1:r1","title":"Which lanes?","reason":"","preview":"Pick the lanes to merge",
        "kind":"question","createdAt":"2026-08-29T12:00:00Z","multiSelect":true,
        "options":[{"label":"DROVE-10"},{"label":"DROVE-22"}]}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        guard let gate = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ).gates.first else {
            check(false, "a multi-select question decodes")
            return
        }
        check(gate.multiSelect == true, "a multi-select question decodes as one")
        check(gate.takesManyAnswers, "a multi-select question with options takes many answers")

        // A question with the flag and NO options is still one string: there is
        // nothing to tick, so the wrist offers typing and not a checkbox list.
        let optionless = """
        {"gates":[{"id":"s1:r2","title":"Which?","reason":"","preview":"?","kind":"question",
        "createdAt":"2026-08-29T12:00:00Z","multiSelect":true}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        let bare = try? DroverSnapshot.decoder.decode(DroverSnapshot.self, from: Data(optionless.utf8))
        check(bare?.gates.first?.takesManyAnswers == false, "a multi-select with no options takes one answer")

        // Absent means single-select, which is what every question was before.
        let single = """
        {"gates":[{"id":"s1:r3","title":"?","reason":"","preview":"?","kind":"question",
        "createdAt":"2026-08-29T12:00:00Z","options":[{"label":"Yes"}]}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        let one = try? DroverSnapshot.decoder.decode(DroverSnapshot.self, from: Data(single.utf8))
        check(one?.gates.first?.takesManyAnswers == false, "a question with no multiSelect key is single-select")
    }

    /// Swift cannot ship OTA, so a kind the wrist learns about after this
    /// archive needs another one. `needs-you` (DROVE-53 Part B) is decoded here
    /// before the bus emits it, so the producer can land OTA and the wrist
    /// already draws it as a thing to DO rather than falling into the
    /// allow/deny pair, which would offer a Deny button for a to-do.
    static func needsYouIsAKindThisBuildKnows() {
        let payload = """
        {"gates":[{"id":"s1:r1","title":"Push the branch","reason":"blocks the merge",
        "preview":"git push fork lane/DROVE-55-watch-finish","kind":"needs-you",
        "createdAt":"2026-08-29T12:00:00Z"}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        guard let gate = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ).gates.first else {
            check(false, "a needs-you gate decodes")
            return
        }
        check(gate.classification == .needsYou, "a needs-you gate is classified as one")
        check(!gate.isQuestion, "a needs-you gate is not a question")
        check(gate.answerableOptions.isEmpty, "a needs-you gate offers nothing to pick")

        // And the guarantee that made the enum non-Codable in the first place:
        // a kind THIS build has still never heard of drops to unknown rather
        // than taking the whole snapshot down with it.
        let future = """
        {"gates":[{"id":"s1:r2","title":"?","reason":"","preview":"","kind":"telepathy",
        "createdAt":"2026-08-29T12:00:00Z"}],
        "updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        let unknown = try? DroverSnapshot.decoder.decode(DroverSnapshot.self, from: Data(future.utf8))
        check(unknown?.gates.first?.classification == .unknown, "a kind from the future decodes as unknown")
    }

    /// The whole reason the snapshot decoder is hand written: a synthesized one
    /// IGNORES a property's default and throws on the missing key, so a build
    /// that adds a field blanks a wrist holding the app-group blob written by
    /// the build before it. Every key added for DROVE-55 has to be forgiven.
    static func aSnapshotFromAnOlderPhoneStillDecodes() {
        let payload = """
        {"gates":[],"updatedAt":"2026-08-29T12:00:00Z","connected":true}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ) else {
            check(false, "a snapshot with none of the new keys decodes")
            return
        }
        check(snapshot.accountRows.isEmpty, "a snapshot with no accountRows key decodes")
        check(snapshot.accounts.isEmpty, "a snapshot with no accounts key decodes")
        check(snapshot.connected, "the keys it does carry survive")
    }

    /// The flip picker's numbers (DROVE-28's watch half). A name alone could
    /// only ever offer an account something was already running on.
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

    /// The one line the wrist shows about what a session is DOING (DROVE-54).
    /// The elapsed time is NOT in the string: `statusSince` is a date the wrist
    /// counts up from, so the phone does not have to republish every second to
    /// keep a timer honest.
    static func sessionStatusSurvivesTheWire() {
        let payload = """
        {"gates":[],"updatedAt":"2026-08-29T12:00:00Z","connected":true,
        "sessions":[{"id":"s1","title":"drover","active":true,
        "status":"thinking","statusSince":"2026-08-29T11:58:00Z"},
        {"id":"s2","title":"happy","active":false}]}
        """
        guard let snapshot = try? DroverSnapshot.decoder.decode(
            DroverSnapshot.self, from: Data(payload.utf8)
        ) else {
            check(false, "a snapshot with a session status decodes")
            return
        }
        check(snapshot.sessions[0].status == "thinking", "a session keeps its status line")
        check(snapshot.sessions[0].statusSince != nil, "a session keeps when the status began")
        // A session that said nothing is silent, not "idle" invented here.
        check(snapshot.sessions[1].status == nil, "a session with no status carries none")
    }

    /// The refresh the wrist can now ask for (DROVE-22). It rides the answer
    /// channel and is told apart by `kind`, the way a flip already is — so it
    /// must carry that key and nothing an answer would be mistaken for.
    static func refreshIsToldApartByItsKind() {
        let refresh = json(DroverRefresh())
        check(refresh["kind"] as? String == "refresh", "a refresh says what it is")
        check(refresh["id"] == nil, "a refresh carries no gate id to be mistaken for an answer")
        check(refresh["allow"] == nil, "a refresh carries no verdict")

        // And a flip still says flip, since the phone dispatches on the one key.
        let flip = json(DroverFlip(sessionId: "s1", account: nil))
        check(flip["kind"] as? String == "flip", "a flip is still told apart from a refresh")
        check(flip["account"] == nil, "a flip with no account sends no account key")
    }
}
