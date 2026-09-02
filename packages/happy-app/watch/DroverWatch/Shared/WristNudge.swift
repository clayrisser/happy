import Foundation

/// The wrist's IN-APP haptics: everything that happens while the watch app is
/// on screen and had no buzz at all until now (DROVE-384).
///
/// Clay: "Why does my watch never get any haptic feedback other than push
/// notifications?" He was right, and the code said so. Before this file the
/// only two things that ever reached `WKInterfaceDevice.play` were a gate
/// arriving off a snapshot diff (`WristBuzzer.buzz`, DROVE-62) and a reply
/// starting to be spoken (DROVE-92). Answering a gate from the wrist, a write
/// the phone refused, the reader pausing or skipping, an account flip
/// landing — all silent. So the only thing he ever felt was watchOS's own
/// notification tap, which is exactly the complaint.
///
/// A NUDGE IS NOT A CUE, and the two must not be merged. A `WristCue` is
/// NEWS: it is ranked against other news, deduped so one arrival is one buzz,
/// and it survives a closed app as a notification. A nudge is FEEDBACK for
/// something that just happened in front of him — it is never ranked, never
/// posted as an alert, and it is worth nothing at all when the app is not on
/// screen. `WKInterfaceDevice.play` is frontmost-only (WristReach), which for
/// a cue is a limitation to work around and for a nudge is simply the
/// definition.
///
/// WHERE EACH ONE COMES FROM, because it is not one place:
///
///   the WRIST itself   `answerSent`, `answerRefused`, `flipLanded`,
///                      `gateArrived`, `needsYou`. The watch knows the moment
///                      it happens; asking the phone would put a round trip
///                      between his tap and the tap back.
///   the PHONE          `readingStarted`, `readingPaused`, `readingSkipped`.
///                      Read-aloud runs on the phone even when the wrist is
///                      the speaker, so the phone is the only thing that knows
///                      the reader moved. They arrive as a `cue` message
///                      (DroverWatchVoiceMessage), which is DROVE-92's wire
///                      widened by two values rather than a second channel.
///
/// Foundation only, like the rest of Shared, so `watch/scripts/test-shared.sh`
/// compiles it with plain `swiftc` on the Mac. That matters more here than
/// anywhere: the watch simulator has no Taptic Engine, so the DECISION is the
/// only part of a buzz anyone can check off a real wrist.
enum WristNudge: String, CaseIterable {
    /// A gate landed while he was looking at the watch.
    case gateArrived
    /// The one gate kind that is a standing request rather than a block
    /// (DROVE-70). Deduped against the push; see `dedupes`.
    case needsYou
    /// He answered from the wrist and the answer left the watch.
    case answerSent
    /// He answered, or flipped, or pressed, and the write was refused.
    case answerRefused
    /// Read-aloud began speaking a reply, here or on the phone (DROVE-92).
    case readingStarted
    /// The reader paused (DROVE-275).
    case readingPaused
    /// The reader skipped ahead. Clay asked for "a ding or a beep" rather
    /// than the words "skipping ahead"; on the wrist it is a tap.
    case readingSkipped
    /// A flip he asked for from the wrist has landed: the phone now reports
    /// the session on the other account.
    case flipLanded

    /// The single beat this moment plays.
    ///
    /// ONE beat each, and that is the whole difference in weight between this
    /// table and `WristCue.beats`. A cue is allowed a pattern because it has
    /// to be told apart through a sleeve minutes later; a nudge answers a
    /// thing he did a quarter-second ago and he is looking at the screen.
    var beat: WristBeat {
        switch self {
        case .gateArrived: return .notification
        case .needsYou: return .notification
        case .answerSent: return .success
        case .answerRefused: return .failure
        case .readingStarted: return .start
        case .readingPaused: return .stop
        case .readingSkipped: return .directionUp
        case .flipLanded: return .click
        }
    }

    /// What the Playground row says this is for.
    var meaning: String {
        switch self {
        case .gateArrived: return "A gate landed while you were looking at the watch."
        case .needsYou: return "An agent asked you to do something, and no push got there first."
        case .answerSent: return "Your answer left the watch."
        case .answerRefused: return "The phone would not take it."
        case .readingStarted: return "A reply started being read aloud."
        case .readingPaused: return "The reading paused."
        case .readingSkipped: return "The reader skipped ahead."
        case .flipLanded: return "The session is on the other account now."
        }
    }

    /// Whether an id has to be checked before this one plays.
    ///
    /// Only `needsYou`. A todo can reach the wrist twice — once as the phone's
    /// push, which iOS mirrors onto the watch, and once as the snapshot the
    /// phone publishes over WatchConnectivity — and the two are different
    /// wires that cannot see each other. The phone is the only thing that sees
    /// both, so it names the ids it already carried on the snapshot and the
    /// wrist marks them delivered before it diffs (DroverSnapshot
    /// `alreadyDelivered`). Everything else here is caused by a finger or by a
    /// reader that moved once, and cannot arrive twice.
    var dedupes: Bool { self == .needsYou }

    /// The cue name on the wire, tolerating DROVE-92's original spelling.
    ///
    /// `reply` is what `cueWatchReplyStart` has been sending since DROVE-92
    /// and what a watch build already on Clay's wrist answers to. A phone that
    /// updates before the watch does would otherwise send `readingStarted` to
    /// a binary that has never heard of it, and TestFlight is not OTA — the
    /// watch app can be a build behind for days.
    static func named(_ wire: String) -> WristNudge? {
        if wire == "reply" { return .readingStarted }
        return WristNudge(rawValue: wire)
    }
}

/// Why a nudge did not play. Named rather than left as a bare `false`, for
/// the reason `WristSilence` exists: a haptic that never fires is
/// indistinguishable from nothing having happened.
enum WristHush: String, Equatable, CaseIterable {
    /// The app is not on screen, so `WKInterfaceDevice.play` does nothing.
    /// Not a fault and never surfaced: a nudge off screen has no audience.
    case notFrontmost
    /// `droverAnnounceHaptic` is off. Clay has said the wrist should not
    /// buzz, so it does not.
    case channelOff
    /// Some other path already carried this id to the wrist.
    case alreadyDelivered
}

enum WristNudgeDecision: Equatable {
    case play(WristBeat)
    case hush(WristHush)

    var beat: WristBeat? {
        guard case let .play(beat) = self else { return nil }
        return beat
    }
}

/// Whether a nudge plays, and why not when it does not.
///
/// Pure and one place, so the watch and the phone cannot end up with two
/// answers. `sources/utils/wristNudges.ts` mirrors it and its spec parses this
/// file, exactly as wristCues.spec.ts does for the gate patterns.
enum WristNudgePolicy {
    /// - Parameters:
    ///   - announceHaptic: the SYNCED drover channel switch, as the phone put
    ///     it on the snapshot. Never `phoneHaptics`, which is device-local to
    ///     the handset and has nothing to say about this wrist (DROVE-190).
    ///   - demo: a finger pressed a Playground row asking to feel this. A demo
    ///     that plays nothing is a broken screen, not a quiet one, so it
    ///     bypasses the channel and the ledger — but not the frontmost rule,
    ///     which is physics rather than policy.
    static func decide(
        _ nudge: WristNudge,
        announceHaptic: Bool,
        frontmost: Bool,
        alreadyDelivered: Bool = false,
        demo: Bool = false
    ) -> WristNudgeDecision {
        // First, because it is not a decision anyone gets to make: watchOS
        // refuses `play` outright unless this app is on screen.
        if !frontmost { return .hush(.notFrontmost) }
        if demo { return .play(nudge.beat) }
        if !announceHaptic { return .hush(.channelOff) }
        if nudge.dedupes && alreadyDelivered { return .hush(.alreadyDelivered) }
        return .play(nudge.beat)
    }
}
