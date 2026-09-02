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
/// WHICH ROUTE IS LIVE IS `WristReach`'s CALL, not a branch written twice
/// (DROVE-124). It used to be `applicationState == .active` inline, which is
/// only half the question: the notification route also needs alert
/// authorization, and without it `add` succeeds and UserNotifications drops
/// the alert at delivery. No error, no callback, no buzz. So this class now
/// tracks the authorization it was assuming, refreshes it on EVERY launch
/// including the background ones, and reports the silence rather than
/// pretending a buzz happened.
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

    /// Called whenever the route to this wrist changes, so a screen can say
    /// which one is live without asking UserNotifications itself.
    var onDeliveryChanged: ((WristDelivery) -> Void)?

    /// The synced `droverAnnounceHaptic` channel switch, as the phone last put
    /// it on a snapshot (DROVE-384). Never `phoneHaptics`, which is local to
    /// the handset and says nothing about this wrist (DROVE-190).
    ///
    /// True until a snapshot says otherwise, which is also what an older phone
    /// with no such key means: it was buzzing this wrist yesterday.
    var announceHaptic: Bool = true

    /// What the last `getNotificationSettings` said. `.notDetermined` until
    /// asked, which is also the honest starting value: a process that has not
    /// looked does not know.
    private(set) var permission: WristAlertPermission = .notDetermined

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

    /// Read the real authorization state, without prompting.
    ///
    /// Called from `applicationDidFinishLaunching`, which is the one point
    /// reached on EVERY launch including the background wake that a
    /// `transferCurrentComplicationUserInfo` makes (DROVE-86). Before this the
    /// only thing that ever set the state was the prompt callback on the
    /// wall's `onAppear`, so a wrist that had never had the app open, or had
    /// turned alerts off in the Watch app since, posted a notification into
    /// the void and said nothing about it.
    func refreshPermission() {
        guard let center else { return }
        center.getNotificationSettings { [weak self] settings in
            let permission = WristAlertPermission(settings.authorizationStatus)
            Task { @MainActor in self?.apply(permission) }
        }
    }

    /// Ask, from the foreground, for permission to alert — but only when it
    /// has never been asked.
    ///
    /// Without authorization the background route is silently dead: `add`
    /// accepts the request and UserNotifications drops it. Called from the
    /// wall's `onAppear`, because watchOS refuses the prompt from a background
    /// launch and the wall is the first thing a wrist sees.
    ///
    /// A second `requestAuthorization` after a denial does NOT re-prompt —
    /// watchOS returns `granted: false` immediately — so asking again would
    /// only produce the same dead callback. Once denied, the fix is in the
    /// Watch app's own settings, which is what `WristSilence.denied` says.
    func requestAuthorization() {
        guard let center else { return }
        center.getNotificationSettings { [weak self] settings in
            let current = WristAlertPermission(settings.authorizationStatus)
            Task { @MainActor in
                guard let self else { return }
                guard current == .notDetermined else {
                    self.apply(current)
                    return
                }
                self.prompt()
            }
        }
    }

    /// The one-shot system prompt. Split out of `requestAuthorization` rather
    /// than nested inside its settings callback: nesting captured both the
    /// center and `self` across two `@Sendable` closures, which Swift 6 turns
    /// from a warning into an error.
    private func prompt() {
        guard let center else { return }
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.onRefusal?(error.localizedDescription)
                    return
                }
                self.apply(granted ? .allowed : .denied)
            }
        }
    }

    /// Record a new authorization state and say what it means for the wrist.
    ///
    /// The refusal is stated for the BACKGROUND route only: with the app
    /// frontmost the pattern plays straight to the Taptic Engine whatever
    /// alerts are set to, so a banner claiming the wrist is muted while it is
    /// visibly buzzing would be its own lie.
    private func apply(_ permission: WristAlertPermission) {
        let changed = permission != self.permission
        self.permission = permission
        let background = WristReach.delivery(frontmost: false, permission: permission)
        onRefusal?(background.silence.map { WristReach.refusal(for: $0, cue: nil) })
        guard changed else { return }
        onDeliveryChanged?(delivery())
    }

    /// The route to this wrist right now.
    func delivery() -> WristDelivery {
        WristReach.delivery(
            frontmost: WKApplication.shared().applicationState == .active,
            permission: permission
        )
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
        // The channel switch rules the wrist, and until DROVE-384 it never
        // reached this process: the phone gated the background WAKE on it and
        // nothing gated the pattern played here, so a wrist with haptics
        // switched off still buzzed with the app on screen. The ids are
        // remembered FIRST, above, so turning the channel back on does not
        // replay a backlog of gates that were raised while it was off.
        guard announceHaptic else {
            droverLog.notice("wrist silent for \(loudest.cue.rawValue, privacy: .public): the haptic channel is off")
            return
        }
        // The phone's "Buzz the watch" row publishes a `demo:` gate so the
        // real pattern plays by the real path (DROVE-75). It buzzes like any
        // gate; it is only LOGGED apart, so a demo in the console is never
        // read as a missed real one.
        if DroverDemo.isDemoId(loudest.id) {
            DroverDemo.log("snapshot gate \(loudest.id) plays \(loudest.cue.rawValue) by the real path")
        }
        switch delivery() {
        case .pattern:
            play(loudest.cue)
        case .systemAlert:
            alert(loudest)
        case let .silent(silence):
            // The one case that used to be indistinguishable from nothing
            // having happened. Name the cue that was lost, so the wall says
            // "Question could not buzz" rather than leaving Clay to guess
            // whether anything was ever raised (DROVE-124).
            droverLog.error("wrist silent for \(loudest.cue.rawValue, privacy: .public): \(silence.rawValue, privacy: .public)")
            onRefusal?(WristReach.refusal(for: silence, cue: loudest.cue))
        }
    }

    /// One IN-APP moment, played now (DROVE-384).
    ///
    /// Frontmost only, which is not a limitation here but the definition: a
    /// nudge is feedback for something happening in front of him, and there is
    /// no background alert to post and none wanted. It is not a `WristCue` —
    /// those are news, ranked against each other and deduped so one arrival is
    /// one buzz, and an answer leaving the watch must never outrank, or be
    /// deduplicated against, a question.
    ///
    /// `id` is only read for the one nudge that dedupes (`needsYou`): it is
    /// checked against the same persisted ledger the gate buzz keeps, so a
    /// todo the phone already carried by push stays quiet here.
    func nudge(_ nudge: WristNudge, id: String? = nil, demo: Bool = false) {
        let decision = WristNudgePolicy.decide(
            nudge,
            announceHaptic: announceHaptic,
            frontmost: delivery().keepsPattern,
            alreadyDelivered: id.map { played.contains($0) } ?? false,
            demo: demo
        )
        switch decision {
        case let .play(beat):
            if let id { remember([id]) }
            WKInterfaceDevice.current().play(beat.hapticType)
        case let .hush(hush):
            // Said, not surfaced. A nudge is about a moment he is looking at,
            // so a banner for one that did not fire would be noise about
            // nothing; a cue that cannot buzz still gets `onRefusal`.
            droverLog.notice("wrist nudge \(nudge.rawValue, privacy: .public) hushed: \(hush.rawValue, privacy: .public)")
        }
    }

    /// A reply has started being spoken, on this wrist or on the phone
    /// (DROVE-92).
    func replyStarted() { nudge(.readingStarted) }

    /// Mark cue ids another path already carried, so the diff does not buzz
    /// for them (DROVE-384). The phone names them on the snapshot; see
    /// `DroverSnapshot.alreadyDelivered` for why only the phone can.
    func markDelivered(_ ids: [String]) {
        let fresh = ids.filter { !played.contains($0) }
        guard !fresh.isEmpty else { return }
        remember(fresh)
    }

    /// Play one pattern now, for the Playground (DROVE-75).
    ///
    /// Straight to the Taptic Engine and nowhere else: not through `buzz`, so
    /// nothing is remembered as played, nothing is ranked against anything,
    /// and no notification is posted. Frontmost only, which `play` is anyway,
    /// and the Playground is a screen, so it is. Every call is logged as a
    /// demo before it plays, so a demo buzz reads as one in the console.
    func demo(_ cue: WristCue) {
        DroverDemo.log("buzz \(cue.rawValue): \(cue.beats.map(\.rawValue).joined(separator: " "))")
        guard delivery().keepsPattern else {
            DroverDemo.log("app not frontmost, \(cue.rawValue) cannot play")
            return
        }
        play(cue)
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
        // A demo gate says so on the lock screen too, like the phone's demo
        // push does (DROVE-75).
        content.title = DroverDemo.isDemoId(event.id) ? "Demo · \(event.cue.headline)" : event.cue.headline
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
        case .start: return .start
        case .stop: return .stop
        case .click: return .click
        }
    }
}

extension WristAlertPermission {
    /// The UserNotifications status, narrowed to the four outcomes that differ
    /// on the wrist.
    ///
    /// `.ephemeral` is an App Clip state a watch app cannot reach; it is an
    /// authorization that alerts normally, so it maps onto `.allowed` rather
    /// than being a fifth case the decision has to carry. An unknown future
    /// case maps to `.allowed` too, on the same principle as
    /// `WristCue.forGateKind`: guessing that alerts work and being wrong costs
    /// one silent buzz, while guessing they do not would put a false "your
    /// wrist is muted" banner on a wrist that is buzzing fine.
    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .notDetermined: self = .notDetermined
        case .denied: self = .denied
        case .authorized, .ephemeral: self = .allowed
        case .provisional: self = .provisional
        @unknown default: self = .allowed
        }
    }
}
