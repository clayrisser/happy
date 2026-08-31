import Foundation

/// The wrist's half of the channel demo (DROVE-75): what the Playground
/// offers, and the namespace that keeps it a demo.
///
/// Foundation only, like the rest of Shared, so `watch/scripts/test-shared.sh`
/// compiles it on the Mac and the checks in tests/SharedWireTests.swift run
/// without a simulator. The SwiftUI that draws it is Views/DemoView.swift; the
/// buzz it plays is WristBuzzer's, called directly.
///
/// THE RULE: a demo gate must never become an answer on the wire. Every
/// fixture id below starts with `idPrefix`, GateStore.answer refuses that
/// prefix before encoding anything, and the phone refuses the same prefix
/// again on its side (sources/sync/droverWatchFeed.ts drops a `demo:` answer;
/// happy-cli's droverBridge refuses one a third time). The fixtures are never
/// in a snapshot, so the buzz diff never sees them either.
///
/// The phone's own demo DOES put one gate into a snapshot: "Buzz the watch"
/// publishes a `demo:buzz-<cue>-<stamp>` gate of the cue's wire kind for four
/// seconds so WristCueDiff plays the real pattern by the real path
/// (sources/sync/droverDemoBuzz.ts). That gate decodes like any other, shows
/// on the wall until the phone withdraws it, and is refused by the same
/// `answer` if it is tapped.
enum DroverDemo {
    /// The namespace, shared with the phone's `DEMO_ID_PREFIX`
    /// (sources/sync/droverDemo.ts).
    static let idPrefix = "demo:"

    static func isDemoId(_ id: String) -> Bool {
        id.hasPrefix(idPrefix)
    }

    /// Every demo line is prefixed so a demo buzz in the console is never read
    /// as a missed real one. NSLog rather than print: it reaches the device
    /// console with a timestamp, which is what "identifiable in the logs"
    /// needs, and it does not pull `os` into a Foundation-only file.
    static func log(_ line: String) {
        NSLog("[drover-demo] %@", line)
    }

    /// The card shapes the wrist draws, one per kind it knows, so the layouts
    /// can be judged side by side on the watch itself. `createdAt` is now,
    /// not baked in, because the row shows an age.
    static func gates(now: Date = Date()) -> [DroverGate] {
        [
            DroverGate(
                id: "demo:permission",
                title: "Run Bash",
                reason: "Destructive Bash command: rm -rf on a checkout",
                preview: "rm -rf build && git clean -fdx",
                kind: "permission",
                createdAt: now,
                account: "demo",
                options: nil,
                multiSelect: nil
            ),
            DroverGate(
                id: "demo:question",
                title: "Branch",
                reason: "AskUserQuestion",
                preview: "Which branch should this land on?",
                kind: "question",
                createdAt: now,
                account: "demo",
                options: [
                    DroverGateOption(id: "main", label: "main", detail: "The default branch"),
                    DroverGateOption(id: "develop", label: "develop", detail: "Merges into main on Friday"),
                    DroverGateOption(id: "lane", label: "lane/BASED-113", detail: nil),
                ],
                multiSelect: nil
            ),
            DroverGate(
                id: "demo:question-freeform",
                title: "Release name",
                reason: "AskUserQuestion",
                preview: "What should this release be called?",
                kind: "question",
                createdAt: now,
                account: "demo",
                options: nil,
                multiSelect: nil
            ),
            DroverGate(
                id: "demo:question-multi",
                title: "Suites",
                reason: "AskUserQuestion",
                preview: "Which test suites should run before the merge?",
                kind: "question",
                createdAt: now,
                account: "demo",
                options: [
                    DroverGateOption(id: "vitest", label: "vitest", detail: "Unit, about a minute"),
                    DroverGateOption(id: "bats", label: "bats", detail: "The shell suite"),
                    DroverGateOption(id: "watch", label: "watch:test", detail: "The wrist wire checks"),
                ],
                multiSelect: true
            ),
            DroverGate(
                id: "demo:todo",
                title: "Push the release",
                reason: "the lane is blocked on it (by 10:00)",
                preview: "git push origin lane/DROVE-53-needs-you",
                kind: "todo",
                createdAt: now,
                account: "demo",
                options: [
                    DroverGateOption(id: "done", label: "Done", detail: nil),
                    DroverGateOption(id: "drop", label: "Drop it", detail: nil),
                ],
                multiSelect: nil
            ),
            DroverGate(
                id: "demo:expiry",
                title: "Account limit",
                reason: "jamrizzi is at 95% of its five-hour window",
                preview: "flip to spare, or wait 40 minutes",
                kind: "expiry",
                createdAt: now,
                account: "demo",
                options: nil,
                multiSelect: nil
            ),
        ]
    }

    /// The cues in the order the demo plays them: most urgent first, which is
    /// the order the wrist itself ranks an arrival.
    static var cues: [WristCue] {
        WristCue.allCases.sorted { $0.rank > $1.rank }
    }

    /// How the pattern reads on the row: "3 beats · tap, thud, thud".
    static func describe(_ cue: WristCue) -> String {
        let count = cue.beats.count
        let words = cue.beats.map(word).joined(separator: ", ")
        return "\(count) \(count == 1 ? "beat" : "beats") · \(words)"
    }

    private static func word(_ beat: WristBeat) -> String {
        switch beat {
        case .notification: return "tap"
        case .directionUp: return "tick"
        case .retry: return "thud"
        case .success: return "soft"
        case .failure: return "rough"
        }
    }

    /// The pause between two patterns when they play back to back: the whole
    /// of the previous one, plus enough silence that its last beat is not
    /// heard as the first of the next.
    static func gapAfter(_ cue: WristCue) -> TimeInterval {
        Double(max(0, cue.beats.count - 1)) * cue.beatGap + 0.9
    }
}
