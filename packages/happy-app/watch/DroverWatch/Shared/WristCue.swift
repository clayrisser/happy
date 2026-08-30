import Foundation

/// Why the wrist should buzz, and what it should feel like (DROVE-62).
///
/// Push is not a path to Clay's wrist and has not been one for a while: of the
/// 888 `sendSessionNotification` verdicts in `~/.happy/logs` on 2026-08-30,
/// 798 died `InvalidCredentials` and 58 were dropped `active-ui-client`, so 21
/// were delivered. This is the second path, and it never touches APNs — the
/// phone hands the watch a snapshot over WatchConnectivity and the watch
/// decides, here, whether that arrival is worth a tap on the wrist.
///
/// Foundation only, and deliberately: `watch/scripts/test-shared.sh` compiles
/// this file with plain `swiftc` on the Mac, so the DECISION is testable
/// without a simulator. WatchKit lives one file over in WristBuzzer, which
/// only plays what this decides.
enum WristCue: String, Codable, CaseIterable {
    /// Claude wants Clay to DO something (DROVE-53). Not on the bus yet; the
    /// kind string is honoured now so that lane needs no Swift change.
    case needsYou = "needs-you"
    /// AskUserQuestion — the session is blocked on an answer.
    case question
    /// A yes/no gate on an action.
    case permission
    /// An account is running out of usage or auth.
    case expiry
    /// A session stopped running. Worth knowing, never worth a jolt.
    case finished

    /// Which cue wins when several land in the same delivery. One arrival is
    /// one buzz — three gates published together must not tap three times,
    /// because a wrist cannot tell three taps from one long pattern anyway.
    var rank: Int {
        switch self {
        case .needsYou: return 4
        case .question: return 3
        case .permission: return 2
        case .expiry: return 1
        case .finished: return 0
        }
    }

    /// The taptic pattern, one beat per element, played `beatGap` apart.
    ///
    /// Named without WatchKit so this file still compiles on the Mac;
    /// `WristBuzzer` maps each beat onto its `WKHapticType`. The patterns
    /// differ in COUNT as well as texture, because texture alone is not
    /// something a wrist reliably tells apart through a sleeve.
    var beats: [WristBeat] {
        switch self {
        case .needsYou: return [.notification, .retry, .retry]
        case .question: return [.notification, .directionUp]
        case .permission: return [.notification]
        case .expiry: return [.failure]
        case .finished: return [.success]
        }
    }

    /// Long enough that two beats are two taps rather than one blur.
    var beatGap: TimeInterval { 0.35 }

    /// Whether the alert should break through a Focus.
    ///
    /// Everything that BLOCKS a session does; a session merely finishing does
    /// not, because the whole point of Focus is that finished work waits.
    var breaksThroughFocus: Bool { self != .finished }

    /// What the notification says when the watch app is not frontmost. This is
    /// the only per-kind distinction available in that case: watchOS picks the
    /// haptic for a notification itself, and no API selects it.
    var headline: String {
        switch self {
        case .needsYou: return "Do something"
        case .question: return "Question"
        case .permission: return "Permission"
        case .expiry: return "Account limit"
        case .finished: return "Session finished"
        }
    }

    /// The cue a bus `kind` deserves. Unknown kinds are treated as a
    /// permission rather than dropped: a kind this build has never heard of is
    /// still something waiting on a human, and silence is the worse failure.
    static func forGateKind(_ kind: String) -> WristCue {
        WristCue(rawValue: kind) ?? .permission
    }
}

/// One beat of a taptic pattern. Mirrors the `WKHapticType` cases this app
/// uses; kept out of WatchKit so the decision compiles on the Mac.
enum WristBeat: String, Equatable {
    case notification
    case directionUp
    case retry
    case success
    case failure
}

/// One thing worth buzzing about, already deduped and ready to play.
struct WristCueEvent: Equatable {
    let cue: WristCue
    /// Dedupe key. A gate's bus id, or `finished:<sessionId>`. Stable on
    /// purpose: the same arrival reaches the watch twice by design — once as
    /// the background wake that launched the app, once as the application
    /// context — and that must be one buzz, not two.
    let id: String
    /// The notification body. The gate's own preview, trimmed for a wrist.
    let detail: String
}

/// What changed between two snapshots, in cue terms (DROVE-62).
///
/// Pure, and diffed on the WATCH rather than announced by the phone, for one
/// reason: the watch is woken by a WatchConnectivity delivery that can arrive
/// through three different channels, and deriving the cue from the snapshot
/// itself means every channel produces the same answer with no fourth thing to
/// keep in step.
enum WristCueDiff {
    /// How new a gate has to be to be worth waking a wrist for.
    ///
    /// The watch's own persisted snapshot is the `previous` on a cold launch,
    /// and after a night on the charger that is arbitrarily old — every gate
    /// in the new snapshot would read as new. The window is what stops a
    /// launch from buzzing about work that was answered in tmux hours ago. It
    /// is deliberately wider than the 60s heartbeat so a gate raised while the
    /// watch was out of range still lands.
    static let freshWindow: TimeInterval = 150

    /// Cues for everything `next` gained that `previous` did not have, most
    /// urgent first.
    ///
    /// `previous` is nil only on the very first run, before anything has been
    /// persisted. Gates still have to pass `freshWindow`, so that case does not
    /// buzz for a wall of history either.
    static func cues(
        from previous: DroverSnapshot?,
        to next: DroverSnapshot,
        now: Date = Date()
    ) -> [WristCueEvent] {
        var events: [WristCueEvent] = []

        let known = Set((previous?.gates ?? []).map(\.id))
        for gate in next.gates {
            if known.contains(gate.id) { continue }
            if now.timeIntervalSince(gate.createdAt) > freshWindow { continue }
            // A gate stamped in the future is a clock skew, not a reason to
            // stay silent — the phone and the watch do drift.
            events.append(
                WristCueEvent(
                    cue: WristCue.forGateKind(gate.kind),
                    id: gate.id,
                    detail: gate.preview.isEmpty ? gate.title : gate.preview
                )
            )
        }

        // A session finishing needs a BEFORE to be a change at all, so there
        // is no freshness window to apply and no cold-launch storm to guard
        // against: with no previous snapshot there is nothing to compare.
        if let previous {
            let wasRunning = Set(previous.sessions.filter(\.active).map(\.id))
            for session in next.sessions where !session.active && wasRunning.contains(session.id) {
                events.append(
                    WristCueEvent(cue: .finished, id: "finished:\(session.id)", detail: session.title)
                )
            }
        }

        return events.sorted { $0.cue.rank > $1.cue.rank }
    }
}
