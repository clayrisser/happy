import Foundation

/// Whether the wrist can be tapped at all right now, and by which route
/// (DROVE-124).
///
/// The constraint this exists to state honestly: `WKInterfaceDevice.play` does
/// nothing unless the watch app is frontmost. That is watchOS's rule, not
/// ours, and no third-party app gets around it. Maps is not a counterexample —
/// turn-by-turn is first-party with a navigation entitlement.
///
/// So there are exactly two routes to a wrist, and they are not equal:
///
/// - **Frontmost** — our own pattern, beat by beat. Five cues that differ in
///   COUNT as well as texture, so a sleeve can still tell them apart.
/// - **Not frontmost** — a watch-local `UNNotificationRequest`, and watchOS
///   picks the haptic. One tap, always the same tap, whichever cue it was.
///   The only per-cue distinctions that survive are the headline, the body and
///   whether it breaks a Focus.
///
/// And a third state that used to be invisible: the notification route needs
/// alert authorization, and without it `UNUserNotificationCenter.add` succeeds
/// and the alert is dropped at delivery. No error, no callback, no buzz. A
/// wrist that cannot buzz looked exactly like a wrist with nothing to buzz
/// about, which is the failure push already has. `WristSilence` is that state
/// given a name so it can be said out loud.
///
/// Foundation only, like the rest of Shared, so `watch/scripts/test-shared.sh`
/// compiles it with plain `swiftc` on the Mac and the decision is under test
/// without a simulator. That matters more here than anywhere: the watch
/// simulator has no Taptic Engine, so the decision is the only part of the
/// buzz that can be checked off a real wrist.
///
/// WHAT THE BACKGROUND ROUTE COSTS THE CUE VOCABULARY, since DROVE-112 is
/// building a bigger one and the two must not drift: all five GATE cues do
/// reach a closed wrist, as one identical tap plus a card, so the thing worth
/// waking for still wakes. What cannot survive is anything ambient or
/// high-frequency — DROVE-112's heartbeat pulses and its per-event earcons (a
/// subagent spawned, a run of tool calls starting, the reader skipping ahead).
/// A notification is an interruption; one every few seconds is spam, not a
/// cue. Those need the app frontmost, or a `WKExtendedRuntimeSession`.
enum WristReach {
    /// What will actually happen if a cue is played this instant.
    static func delivery(frontmost: Bool, permission: WristAlertPermission) -> WristDelivery {
        // Frontmost wins before permission is even consulted: the pattern goes
        // straight to the Taptic Engine and no notification is involved, so a
        // wrist with alerts switched off still buzzes with the app on screen.
        // Getting this order wrong would mute the one route that always works.
        if frontmost { return .pattern }
        switch permission {
        case .allowed: return .systemAlert
        case .notDetermined: return .silent(.notAsked)
        case .denied: return .silent(.denied)
        // Provisional delivers QUIETLY by definition: the alert lands in
        // Notification Center with no sound and no haptic. It is an
        // authorization, so a naive `status != .denied` check reads it as fine
        // and the wrist stays silent anyway. Treated as silence on purpose.
        case .provisional: return .silent(.quietOnly)
        }
    }

    /// The sentence the wall shows, and the phone one day repeats, when the
    /// wrist could not be tapped. Nil when it could.
    ///
    /// Names the cue that was lost rather than describing the condition in the
    /// abstract, because "the wrist is muted" and "your permission question at
    /// 09:14 never reached you" are very different pieces of news.
    static func refusal(for silence: WristSilence, cue: WristCue?) -> String {
        guard let cue else { return silence.reason }
        return "\(cue.headline) could not buzz. \(silence.reason)"
    }
}

/// Alert authorization, as this app needs to reason about it.
///
/// Mirrors the `UNAuthorizationStatus` cases that differ in OUTCOME rather
/// than all five of them, and lives here rather than in WristBuzzer so the
/// decision compiles without UserNotifications. `.ephemeral` is an App Clip
/// state a watch app cannot be in; it maps onto `.allowed` at the boundary.
enum WristAlertPermission: String, Equatable, CaseIterable {
    /// Never asked. The prompt only appears from the foreground, so a wrist
    /// that has never had the app open sits here.
    case notDetermined
    case denied
    case allowed
    /// Authorized to deliver, but quietly: straight to Notification Center,
    /// no haptic.
    case provisional
}

/// Why the wrist stayed silent.
enum WristSilence: String, Equatable, CaseIterable {
    case notAsked
    case denied
    case quietOnly

    /// Written to be read on a 41mm screen and to say what to DO, because the
    /// whole point of surfacing this is that a silent wrist stops being a
    /// mystery.
    var reason: String {
        switch self {
        case .notAsked:
            return "The watch has never allowed alerts, so a closed app cannot buzz. Open Drover here once."
        case .denied:
            return "Alerts are off for Drover, so a closed app cannot buzz. Watch app › Notifications › Cattle Drover."
        case .quietOnly:
            return "Alerts are set to deliver quietly, so a closed app cannot buzz. Watch app › Notifications › Cattle Drover."
        }
    }
}

/// What a cue will feel like on the wrist right now.
enum WristDelivery: Equatable {
    /// Our own beats, played directly. Frontmost only.
    case pattern
    /// A watch-local notification. It taps, but watchOS chooses the haptic, so
    /// every cue feels the same and only the words differ.
    case systemAlert
    /// Nothing at all, and why.
    case silent(WristSilence)

    /// Whether the wrist is tapped at all. The wall and the Playground both
    /// need this without caring which route.
    var buzzes: Bool {
        switch self {
        case .pattern, .systemAlert: return true
        case .silent: return false
        }
    }

    /// Whether the cue keeps its own pattern. False on the notification route,
    /// which is the honest answer to "does a closed app buzz differently per
    /// kind": it does not, and nothing in the app should imply it does.
    var keepsPattern: Bool { self == .pattern }

    /// The silence, when it is one. Nil when the wrist is tapped.
    var silence: WristSilence? {
        guard case let .silent(silence) = self else { return nil }
        return silence
    }
}
