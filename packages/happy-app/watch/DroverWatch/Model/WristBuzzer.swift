import Foundation
import UserNotifications
import WatchKit

/// Plays what `WristCueDiff` decided, by whichever route the watch is
/// currently allowed to use (DROVE-62).
///
/// TWO ROUTES, because one of them is only available half the time:
///
/// - **Frontmost** — `WKInterfaceDevice.play` runs the per-kind pattern
///   directly. This is the only route that can express a pattern at all, and
///   it is the only route whose behaviour is fully under this app's control.
/// - **Not frontmost** — a watch-LOCAL `UNNotificationRequest` with a nil
///   trigger, which UserNotifications delivers immediately and watchOS alerts
///   with its own haptic. No server, no APNs, no Expo credentials.
///
/// The background case does not call `play` and never has. The WatchKit SDK
/// says why by omission: `WKExtendedRuntimeSession` carries a whole
/// `notifyUser(hapticType:repeatHandler:)` API "to alert the user … if the app
/// is not active", and it is refused outright unless the session was scheduled
/// from the foreground (`WKExtendedRuntimeSessionErrorMustBeActiveToStartOrSchedule`).
/// An API that exists solely to play a haptic from the background, gated
/// behind a foreground start, is Apple saying `play` will not do it. So the
/// notification is the load-bearing path and the pattern is a bonus, rather
/// than the other way round.
///
/// NOT PROVEN ON HARDWARE. The watch simulator has no Taptic Engine and no
/// paired phone, so everything above is the documented contract plus the
/// decision logic under test — not a buzz anyone has felt. See DROVE-62.
@MainActor
final class WristBuzzer {
    /// Cue ids already played. Persisted, because the arrival that matters is
    /// usually the one that LAUNCHED this process — a set held only in memory
    /// starts empty on every background wake and would buzz again for the same
    /// gate every time the phone published.
    private var played: [String]
    private let defaults: UserDefaults?
    private let center: UNUserNotificationCenter?

    /// Called whenever the reason the wrist is silent changes, nil when it
    /// stops being silent. Surfaced on the wall rather than logged: a haptic
    /// that never fires is indistinguishable from nothing having happened,
    /// which is the exact failure push already has.
    var onRefusal: ((String?) -> Void)?

    private static let playedKey = "drover.buzzed.v1"
    /// Enough to cover a long stretch of gates without growing forever. The
    /// oldest ids are dropped first; a gate that old cannot arrive again.
    private static let playedLimit = 200

    init(
        defaults: UserDefaults? = UserDefaults(suiteName: DroverSnapshot.appGroupSuiteName),
        center: UNUserNotificationCenter? = .current()
    ) {
        self.defaults = defaults
        self.center = center
        played = defaults?.stringArray(forKey: Self.playedKey) ?? []
    }

    /// Ask once, from the foreground, for permission to alert.
    ///
    /// Without this the background route is silently dead: `add` accepts the
    /// request and UserNotifications drops it. Called from the wall's
    /// `onAppear`, because watchOS refuses the prompt from a background launch
    /// and the wall is the first thing a wrist sees.
    func requestAuthorization() {
        guard let center else { return }
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
            Task { @MainActor in
                guard let self else { return }
                if granted {
                    self.onRefusal?(nil)
                } else {
                    self.onRefusal?(error?.localizedDescription ?? "Notifications are off — the wrist cannot buzz")
                }
            }
        }
    }

    /// Play the most urgent of `events`, and remember all of them as played.
    ///
    /// ALL of them, not just the one played: three gates arriving together is
    /// one arrival, so the two that lost the rank must not each buzz on the
    /// next delivery that mentions them.
    func buzz(_ events: [WristCueEvent]) {
        let fresh = events.filter { !played.contains($0.id) }
        guard let loudest = fresh.max(by: { $0.cue.rank < $1.cue.rank }) else { return }
        remember(fresh.map(\.id))
        if WKApplication.shared().applicationState == .active {
            play(loudest.cue)
        } else {
            alert(loudest)
        }
    }

    /// A reply has started being spoken, on this wrist or on the phone
    /// (DROVE-92). One beat, frontmost only: the cue arrives by `sendMessage`,
    /// which only ever reaches a watch app that is on screen, so there is no
    /// background alert to post and none wanted. It is not a WristCue: those
    /// are gates and ranked against each other, and a reply starting must
    /// never outrank, or be deduplicated against, a question.
    func replyStarted() {
        guard WKApplication.shared().applicationState == .active else { return }
        WKInterfaceDevice.current().play(.start)
    }

    /// The per-kind pattern, beat by beat.
    private func play(_ cue: WristCue) {
        let device = WKInterfaceDevice.current()
        for (index, beat) in cue.beats.enumerated() {
            let delay = cue.beatGap * Double(index)
            if delay == 0 {
                device.play(beat.hapticType)
                continue
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                device.play(beat.hapticType)
            }
        }
    }

    /// A watch-local notification. Nil trigger, so UserNotifications delivers
    /// it right away rather than scheduling it.
    private func alert(_ event: WristCueEvent) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = event.cue.headline
        content.body = event.detail
        content.sound = .default
        // Time-sensitive is what gets a blocked session through a Focus. A
        // finished session is not worth interrupting for, which is the whole
        // reason the level is per-cue rather than set once.
        //
        // It is set unconditionally even though it is not yet honoured:
        // breaking through a Focus needs the Time Sensitive Notifications
        // capability on the watch app's App ID, which is a one-time step in
        // the developer portal plus a profile regeneration, and neither is
        // this lane's to make. Without it watchOS clamps the level back to
        // .active — the alert still fires, it just waits out a Focus. Setting
        // it now means turning the capability on is the whole of the change.
        content.interruptionLevel = event.cue.breaksThroughFocus ? .timeSensitive : .active
        // The cue is on the category so a future notification action ("Allow",
        // "Deny") can hang off it without another wire change.
        content.categoryIdentifier = "drover.\(event.cue.rawValue)"
        // What a tap needs to land on the gate (DROVE-94): the gate id, and
        // the session the phone filed it under. WatchNotificationRouter reads
        // these back and pushes the gate's detail.
        content.userInfo = Self.userInfo(for: event)
        let request = UNNotificationRequest(identifier: event.id, content: content, trigger: nil)
        center.add(request) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in self?.onRefusal?(error.localizedDescription) }
        }
    }

    /// The gate id and session id a tap on the alert routes by.
    ///
    /// A cue id is the phone's gate id, `${sessionId}:${requestId}` (the
    /// session is the one HOLDING the card, which for a bus gate is the
    /// bridge session), or `finished:<sessionId>` for a session that stopped.
    /// Session ids never contain a colon; request ids can, so the split is on
    /// the first one. Absent rather than empty when nothing can be read, so a
    /// reader can tell "no session" from "".
    static func userInfo(for event: WristCueEvent) -> [String: String] {
        var info = [WatchNotificationRouter.gateIdKey: event.id]
        let sessionId: Substring?
        if event.cue == .finished, let colon = event.id.firstIndex(of: ":") {
            sessionId = event.id[event.id.index(after: colon)...]
        } else if let colon = event.id.firstIndex(of: ":") {
            sessionId = event.id[..<colon]
        } else {
            sessionId = nil
        }
        if let sessionId, !sessionId.isEmpty {
            info[WatchNotificationRouter.sessionIdKey] = String(sessionId)
        }
        return info
    }

    private func remember(_ ids: [String]) {
        played.append(contentsOf: ids)
        if played.count > Self.playedLimit {
            played.removeFirst(played.count - Self.playedLimit)
        }
        defaults?.set(played, forKey: Self.playedKey)
    }
}

extension WristBeat {
    /// The WatchKit type each beat plays. Kept here rather than in WristCue so
    /// that file stays Foundation-only and testable on the Mac.
    var hapticType: WKHapticType {
        switch self {
        case .notification: return .notification
        case .directionUp: return .directionUp
        case .retry: return .retry
        case .success: return .success
        case .failure: return .failure
        }
    }
}
