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
}
