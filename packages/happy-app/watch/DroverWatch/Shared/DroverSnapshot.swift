import Foundation

/// The wire format between the phone, the watch app and the widget
/// (BASED-98).
///
/// One tracked copy compiled into both watch targets. The phone sends these
/// over WatchConnectivity rather than the watch talking to the Happy server
/// directly: the phone already holds the decrypted session and the RPC
/// channel, and reimplementing Happy's encryption in Swift to say "yes" to a
/// prompt would be a second copy of the thing most worth getting right.
/// Hashable because navigationDestination(for:) routes on the value itself.
struct DroverGate: Codable, Identifiable, Equatable, Hashable {
    /// The bus event id. Answers quote it back, so it must survive the trip.
    let id: String
    let title: String
    let reason: String
    /// The command or question body. Truncated by the sender for the wrist.
    let preview: String
    let kind: String
    let createdAt: Date
    /// Which drover account raised it; nil when the session is unaccounted.
    let account: String?
    /// What a question can be answered WITH. Optional, and that is load-bearing
    /// twice: a synthesized decoder forgives a missing key only for an
    /// Optional, and every gate that is not a question has none.
    let options: [DroverGateOption]?
    /// The human may pick MORE THAN ONE option (DROVE-53).
    ///
    /// Optional for the same decoder reason as `options`, and because a phone
    /// that predates the key must still yield gates rather than failing the
    /// whole snapshot. Absent reads as single-select, which is what every gate
    /// was before this existed.
    ///
    /// Without it the wrist drew one button per option and the first tap was
    /// the whole answer — Claude asked "pick as many as apply" and got one word
    /// back, with nothing on any screen saying the rest had gone.
    let multiSelect: Bool?

    /// The kinds schema/event.json defines, plus the one it cannot: a kind this
    /// build has never heard of. Decoded through `Kind(rawValue:) ?? .unknown`
    /// rather than as a Codable enum, because a Codable enum THROWS on a value
    /// outside its cases and the throw takes the whole snapshot with it — one
    /// new kind on the bus and the wrist goes blank instead of showing the
    /// gates it does understand.
    enum Kind: String {
        case permission
        case question
        case idle
        case expiry
        /// The needs-you record (DROVE-53): the session asking you to DO
        /// something — push this, run that on the box, log in — rather than to
        /// answer something. It is not a gate: nothing is blocked on a
        /// decision, something is blocked on you having done the thing.
        case todo
        case unknown
    }

    var classification: Kind { Kind(rawValue: kind) ?? .unknown }

    var isQuestion: Bool { classification == .question }

    /// The options a question offers, if any. A question with none is still
    /// answerable here — it takes free text, which watchOS enters through its
    /// own input sheet (keyboard, Scribble or dictation) rather than not at all.
    var answerableOptions: [DroverGateOption] {
        isQuestion ? (options ?? []) : []
    }

    /// Whether the wrist should draw toggles and a Send button rather than one
    /// button per option. Only ever true on a question — the bus refuses
    /// multiSelect on any other kind — but tested against the kind here as
    /// well, because a snapshot is data from another process.
    var allowsMultipleAnswers: Bool { isQuestion && multiSelect == true }
}

/// One pickable answer on a question gate (schema/event.json `options[]`).
struct DroverGateOption: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let label: String
    /// The schema calls this `description`; it is `detail` here so it cannot be
    /// mistaken for CustomStringConvertible's.
    let detail: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case label
        case detail = "description"
    }
}

extension DroverGateOption {
    /// `id` falls back to the label instead of being required. Claude's own
    /// AskUserQuestion options carry {label, description} and NO id, while the
    /// bus's carry one, and the wrist sees gates from both — requiring the key
    /// would fail the whole snapshot on a native card. Nothing is lost by the
    /// fallback: happy-cli matches an answer with `o.id === candidate ||
    /// o.label === candidate` (src/drover/droverBridge.ts), so a label sent as
    /// the id still resolves to the right option.
    ///
    /// In an extension, like DroverSnapshot's, so the memberwise init survives
    /// for the demo fixtures (DROVE-75); an init written in the body would
    /// have replaced it.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let label = try container.decode(String.self, forKey: .label)
        self.label = label
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? label
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
    }
}

/// A live session the wrist can act on (BASED-98).
///
/// Carried so the watch can FLIP a session onto another Claude account, which
/// is the other half of driving from the wrist: answering a gate unblocks the
/// session, flipping it is what you do when the account it is on has run out.
/// Decoded with defaults, so a phone that predates this still yields an empty
/// list rather than failing the whole snapshot.
struct DroverSession: Codable, Identifiable, Equatable, Hashable {
    let id: String
    /// Project name, as the phone shows it.
    let title: String
    /// The account it is on right now; nil when the session is unaccounted.
    let account: String?
    /// True while the session is actually running something.
    let active: Bool
    /// Working directory. Optional so a phone that predates it still decodes —
    /// a missing key is only forgiven for an Optional, never for a property
    /// with a default (see the snapshot's decoder below).
    let path: String?
    /// Subagents running right now. Optional for the same reason.
    let subagents: Int?
    /// One line saying what the session is DOING right now (DROVE-54): the
    /// running tool, the workflow and its progress, how many agents are out.
    /// Nil while the session is idle, which is what makes it disappear.
    let status: String?
    /// When the turn `status` describes began.
    ///
    /// Carried instead of a duration because the application context is
    /// delivered opportunistically and heartbeats only once a minute, so an
    /// elapsed time baked in by the phone would be up to a minute wrong. The
    /// wrist counts up from this itself with `Text(_:style:.timer)`.
    let statusSince: Date?
    /// The phone's own resolved session state (DROVE-129).
    ///
    /// Optional twice over: a phone that predates the key sends nothing, and a
    /// synthesized decoder forgives a missing key only for an Optional. Nil
    /// falls back to `active`, which is what this screen read before.
    ///
    /// The wrist does not RESOLVE this. `resolveSessionState` on the phone
    /// decides it — permission before question before thinking — and the wrist
    /// draws the answer, so the dot on a wrist and the dot in the phone's list
    /// cannot disagree about the same session. `SessionState` below is the only
    /// place the words and colours live; sessionStateWire.spec.ts pins it to
    /// the phone's union so a new state cannot land on one side alone.
    let state: String?
    /// THE DOT the phone is drawing right now (DROVE-257).
    ///
    /// `state` above answers "does this want a human", and the wrist reads it
    /// for the ordering and for `needsYou`. This one is only the dot, and it
    /// carries the two states that question has no words for:
    /// `recentlyDisconnected` and `compacting`.
    ///
    /// Clay caught the second of those on the phone — a terminal reading
    /// `Compacting conversation…` beside a strip drawing the idle green — and
    /// a wrist resolving its dot off `state` alone would have repeated it
    /// here. `StatusDotState` on the phone decides it; nothing is resolved on
    /// this side. Optional twice over, like `state`: a phone that predates the
    /// key sends nothing, and `dotTint` falls back to the older colour.
    let dotState: String?
    /// What the session is still working THROUGH: Claude Code's task list,
    /// unfinished lines only, in the phone's order (DROVE-167).
    ///
    /// Nothing is derived here. `utils/sessionTasks.ts` on the phone trims the
    /// text, sorts the list and picks the subset, exactly as it does for the
    /// sheet Clay opens off the composer, so a task reads the same on both
    /// (DROVE-129). Nil for a session with no list, and nil for a phone that
    /// predates the key.
    let tasks: [String]?
    /// How many of the session's tasks are finished, and how many there are.
    let tasksDone: Int?
    let tasksTotal: Int?

    var resolvedState: SessionState { SessionState(rawValue: state ?? "") ?? (active ? .thinking : .disconnected) }

    /// The dot the phone drew, or the older five-state answer when a phone too
    /// old to send one is on the other end.
    var resolvedDot: DotState? { DotState(rawValue: dotState ?? "") }

    /// The colour for the dot: the phone's own, always.
    var dotTint: String { resolvedDot?.tintHex ?? resolvedState.tintHex }

    /// Whether the dot pulses. `statusDotBlinks` on the phone, and the same
    /// rule: a blinking dot means the session is BURNING TOKENS RIGHT NOW.
    /// Blue is your turn, purple is the compaction pass; everything else is
    /// still, and a phone too old to send the field pulses nothing rather than
    /// inventing a rhythm the phone is not using.
    var dotBlinks: Bool { resolvedDot?.blinks ?? false }

    /// The unfinished lines, empty when the phone sent none.
    var openTasks: [String] { tasks ?? [] }

    var hasTasks: Bool { !openTasks.isEmpty }

    /// `2 of 7 done` — the phone's own sentence, rebuilt from the two counts
    /// rather than sent as a third string, because a wrist that can add is
    /// cheaper than a key on the wire.
    var taskHeadline: String {
        guard let total = tasksTotal, total > 0 else { return "No tasks yet" }
        return "\(tasksDone ?? 0) of \(total) done"
    }
}

/// What the phone says a session is doing, in the phone's own words
/// (DROVE-129).
///
/// The raw values are `SessionState` in sources/sync/sessionState.ts and the
/// labels are the phone's own status strings, so the wrist is the phone folded
/// smaller rather than a second vocabulary. `thinking` is "working" because
/// that is what the phone's live-status line calls a busy turn it cannot name;
/// the phone's chat header picks a random word from a list instead, and a word
/// that changes every publish is not something to put on a wire.
enum SessionState: String, CaseIterable {
    case disconnected
    case waiting
    case thinking
    case permissionRequired = "permission_required"
    case inputRequired = "input_required"

    /// The phone's own string for this state. Kept identical on purpose.
    var label: String {
        switch self {
        case .disconnected: return "offline"
        case .waiting: return "online"
        case .thinking: return "working"
        case .permissionRequired: return "permission required"
        case .inputRequired: return "waiting for your answer"
        }
    }

    /// The phone's dot colour, as a hex string so this file stays SwiftUI-free
    /// and `watch/scripts/test-shared.sh` can still compile it on the Mac.
    /// Values are useSessionStatus's, character for character.
    var tintHex: String {
        switch self {
        case .disconnected: return "999999"
        case .waiting: return "34C759"
        case .thinking: return "007AFF"
        case .permissionRequired, .inputRequired: return "FF9500"
        }
    }

    /// Whether this state means the session is waiting on a HUMAN. The wrist
    /// leads with those, the same way the phone's list does.
    var needsYou: Bool { self == .permissionRequired || self == .inputRequired }
}

/// THE DOT'S OWN STATES, which are not the session's (DROVE-231, DROVE-257).
///
/// Six, against `SessionState`'s five, and the extra two are the whole reason
/// this enum exists: `recentlyDisconnected`, which is the yellow before the
/// red, and `compacting`, which is the purple Clay asked for and never saw.
/// The raw values are `StatusDotState` in sources/components/statusDotState.ts
/// and the hexes are `statusDotColors`, digit for digit;
/// sessionStateWire.spec.ts pins both so a new state cannot land on one side
/// alone.
///
/// Nothing here is resolved on the wrist. The phone runs `statusDotState` and
/// sends the answer, exactly as it does for `SessionState`.
enum DotState: String, CaseIterable {
    case connected
    case working
    case waiting
    case recentlyDisconnected
    case disconnected
    case compacting

    /// `statusDotColors`, character for character.
    var tintHex: String {
        switch self {
        case .connected: return "34C759"
        case .working: return "007AFF"
        case .waiting: return "FF9500"
        case .recentlyDisconnected: return "FFCC00"
        case .disconnected: return "FF3B30"
        case .compacting: return "AF52DE"
        }
    }

    /// `statusDotBlinks`: exactly the two states that are burning tokens.
    var blinks: Bool { self == .working || self == .compacting }

    /// `statusDotLabels`, for the detail screen and for VoiceOver.
    var label: String {
        switch self {
        case .connected: return "Connected"
        case .working: return "Working"
        case .waiting: return "Waiting for you"
        case .recentlyDisconnected: return "Disconnected just now"
        case .disconnected: return "Disconnected"
        case .compacting: return "Compacting"
        }
    }
}

/// What the wrist's last attempt to get a current snapshot did (DROVE-22).
///
/// The wrist asks by sending the phone a `sendMessage`, which is the one
/// WatchConnectivity call that WAKES the counterpart iOS app in the background.
/// Everything else on this wire has to be called BY the phone, and a suspended
/// phone app calls nothing — which is why the wrist could only ever hold a
/// snapshot from the last time Clay had the app on screen.
enum DroverRefresh: Equatable {
    /// No ask has been made yet. A fraction of a second in practice — the
    /// store asks the moment the session activates — and permanent only where
    /// WatchConnectivity is not supported at all, which the store turns into a
    /// `failed` rather than leaving here.
    case never
    case asking
    /// A snapshot came back. Whether it is any newer is `isStale`'s business.
    case answered
    /// The ask did not land, and this is what WatchConnectivity said.
    case failed(String)
}

/// What the wall should tell Clay about the list it is showing.
enum DroverFreshness: Equatable {
    /// Recent enough to act on.
    case fresh
    /// The wrist has asked the phone and is waiting on it. NOT an accusation.
    case asking
    /// An ask was made and brought back nothing newer. `reason` is what
    /// WatchConnectivity said, where it said anything.
    case stale(reason: String?)
}

/// ONE quota window on one account, as the phone's sheet draws it (DROVE-339).
///
/// The wrist's Limits screen shows one bar per account — the binding limit,
/// which is the whole of "can I still work" (DROVE-131). SELECTING an account
/// opens these: Session, Week and every family week, the same rows the phone
/// gives every account. Clay: "when I select a specific account to see the
/// limit, it should actually show the full breakdown of all the limits, just
/// like it shows in the mobile app."
///
/// NOTHING IS DECIDED HERE. The percentage, the band and the words behind the
/// row are `usageAccountBarGroup`'s, evaluated on the phone and sent, for the
/// reason `DroverAccount.tone`, `.limit` and `.used` are sent (DROVE-129): the
/// ranking, the fill direction and the four different nothings are TypeScript
/// the watch cannot import, and this binary ships through TestFlight where a
/// drift could not be corrected OTA.
struct DroverAccountLimit: Codable, Identifiable, Equatable, Hashable {
    /// `five_hour`, `seven_day`, `seven_day_fable` — the sheet's own ids, and
    /// what a list on this side is keyed on.
    let id: String
    /// The window's name in the phone's words: "Session", "Week", "Fable week".
    let label: String
    /// Percent USED, which is what the bar FILLS to (DROVE-230). Absent where
    /// there is no reading — nobody measured it, the window had already reset,
    /// or a wider window is spent so this one cannot be spent either. Zero is a
    /// real reading, a fresh window, and never stands for "no reading".
    let used: Int?
    /// The band the phone computed, as a String for the reason every other
    /// band on this wire is one: a band from a newer phone must cost one
    /// colour, not the whole snapshot.
    let tone: String?
    /// What the phone prints behind the row: "Resets 6 PM", "window reset",
    /// "Week spent". Absent on a row with nothing to say.
    let trailing: String?
    /// The window the account's headroom was read off — the one that stops
    /// work first (DROVE-230). Absent, never false.
    let binding: Bool?

    /// The same band vocabulary the account rows use, so one screen cannot
    /// draw two colour schemes.
    var band: DroverAccount.Tone { DroverAccount.Tone(rawValue: tone ?? "") ?? .unknown }

    /// Is there a figure to print? Absent `used` is the phone withholding one,
    /// and the trailing line says which nothing it is — in the phone's words,
    /// never in a second set invented here.
    var isMeasured: Bool { used != nil }

    var isBinding: Bool { binding == true }

    /// Percent USED, clamped. The phone sends it; nothing computes it.
    var usedPercent: Int? {
        guard let used else { return nil }
        return min(100, max(0, used))
    }

    /// How much of the track the fill covers, 0...1. Unmeasured returns 0 and
    /// the views must not draw it — an empty fill is the positive claim
    /// "nothing used yet" (DROVE-230).
    var fraction: Double {
        guard let usedPercent else { return 0 }
        return Double(usedPercent) / 100
    }

    /// `79%`, or the dash the phone prints where there is no figure. The same
    /// spelling `DroverAccount.figure` uses, so a nothing looks like a nothing
    /// wherever it appears on this wrist.
    var figure: String {
        guard let usedPercent else { return "\u{2013}" }
        return "\(usedPercent)%"
    }

    /// The figure with its direction said out loud, for VoiceOver: a bar
    /// carries direction to an eye and to nothing else (DROVE-230).
    var spokenFigure: String {
        guard let usedPercent else { return "not measured" }
        return "\(usedPercent)% used"
    }
}

/// One account the wrist may flip a session onto, with the number that decides
/// which (DROVE-28's watch half).
///
/// The bare name list could only ever offer "one of the accounts something is
/// already running on", which is the opposite of what a flip wants: the account
/// worth moving to is the one with headroom, and headroom is exactly what a
/// name does not carry. The CLI stamps every registry account on
/// `metadata.droverUsage` (DROVE-47) and the phone reduces it to these.
struct DroverAccount: Codable, Identifiable, Equatable, Hashable {
    var id: String { name }
    let name: String
    /// Percent LEFT on the fullest limit. Optional, and it stays optional all
    /// the way to the label: an account never measured shows no figure rather
    /// than a 0 that reads as "out".
    ///
    /// It is no longer what the BAR draws — `used` is (DROVE-230). Headroom
    /// survives in one place on each surface, the phone's account heading and
    /// this one's current-account line, and both spell the word "left" and name
    /// the window so neither can be read backwards.
    let headroom: Int?
    /// Percent USED, which is what every bar in the product FILLS to
    /// (DROVE-228, DROVE-230).
    ///
    /// Clay, reading a verified-correct quota sheet he specified himself: "Oh
    /// so 0% means nothing left?" He could not tell which way his own bars ran,
    /// and no caption fixes that, because the mark is read first and the
    /// caption is read never. So the bars were turned round to fill toward the
    /// limit on the phone, and the wrist has to run the same way or the two
    /// surfaces say opposite things about one account.
    ///
    /// SENT, NOT COMPUTED. It is `usageBarFraction`, the single function every
    /// bar on the phone runs through, evaluated on the phone and put on the
    /// wire — for the reason `tone` and `limit` are (DROVE-129). Two
    /// implementations of one direction in two languages is two directions,
    /// and this watch binary cannot be updated OTA to correct a drift. The
    /// only arithmetic below is the fallback for a phone that predates the key.
    ///
    /// Absent when nothing was measured, and absent when the window had
    /// already reset. Zero is a real reading now — a fresh session window — so
    /// it must not share a spelling with "no reading".
    let used: Int?
    /// False when the account is not logged in, so the wrist can grey it rather
    /// than offering a flip that will bounce.
    let loggedIn: Bool?
    /// When a cooling account is back. Absent when it is not out.
    let backAt: Date?
    /// The account the work is on right now (DROVE-131). Absent on the others,
    /// and absent from every phone that predates the key — which is why the
    /// wrist falls back to the first row rather than showing nothing.
    let current: Bool?
    /// WHICH window `headroom` is about: "Session", "Week", "Fable week".
    ///
    /// The figure was always the most binding limit's — the CLI writes `100 -
    /// max(percent)` over every row — but the wrist could not say which limit
    /// that was, and "4% left" with no window named cannot be acted on. The
    /// phone decides and sends the answer rather than the watch re-ranking raw
    /// rows it does not have (DROVE-129).
    let limit: String?
    /// When THAT limit resets. Absent when the usage cache never said.
    let resetsAt: Date?
    /// The fill band for `headroom`, as the phone's own bars compute it.
    /// A String, not a Codable enum, for the reason `DroverGate.kind` is one:
    /// a band from a newer phone must cost this one label, not the snapshot.
    let tone: String?
    /// At least one of this account's windows had already RESET when the phone
    /// read the cache, so any figure it carries describes a window that was
    /// thrown away (DROVE-204).
    ///
    /// The phone decides this, the way it already decides the band and the
    /// binding limit, because `droverRowUsable` needs the clock that was in
    /// the room when the cache was read and the wrist has only its own
    /// (DROVE-129). Omitted, never false, so a phone that predates the key
    /// reads as not expired, which is what that phone meant.
    let expired: Bool?
    /// EVERY window this account has, in the phone's own order — Session,
    /// Week, then one row per model family any account scopes a limit to
    /// (DROVE-339). This is what selecting the account opens.
    ///
    /// Absent when the CLI recorded no windows for it. The phone draws bare
    /// Session and Week rows anyway so its blocks line up down a column; the
    /// wrist opens one account at a time and has no column to keep straight,
    /// so two dashes would be a table saying nothing the account's own line
    /// does not already say. Absent for a phone that predates the key too,
    /// which is why the detail still has to stand up with none.
    let limits: [DroverAccountLimit]?
    /// The sheet's own heading for this account: "jamrizzi · 51% left on
    /// Week", "main · not logged in", with the cooling time on the end when it
    /// is out (DROVE-339).
    ///
    /// Sent rather than composed here for the reason everything else is
    /// (DROVE-129): `usageAccountGroupTitle` decides between four different
    /// nothings — no login, not measured, window reset, a cursor token's
    /// deadline — and a Swift copy of that ladder is a second ladder that can
    /// disagree with the first. `heading(at:)` below is the fallback for a
    /// phone too old to send one, and it is deliberately the shorter sentence.
    let title: String?
    /// A session can be MOVED onto this account: it is not the one in use, it
    /// is logged in, its config dir has been through Claude Code's first run,
    /// and it is not a cursor account (DROVE-339).
    ///
    /// The phone's own verdict, so the wrist offers a switch exactly where the
    /// sheet offers one. Absent, never false.
    let switchable: Bool?

    /// Written out rather than synthesised so `expired` can arrive last with a
    /// default. A row this build constructs by hand (GateStore's fallback, the
    /// wire-test fixtures) is about an account it holds no expiry verdict for.
    init(
        name: String,
        headroom: Int?,
        loggedIn: Bool?,
        backAt: Date?,
        current: Bool?,
        limit: String?,
        resetsAt: Date?,
        tone: String?,
        expired: Bool? = nil,
        used: Int? = nil,
        limits: [DroverAccountLimit]? = nil,
        title: String? = nil,
        switchable: Bool? = nil
    ) {
        self.name = name
        self.headroom = headroom
        self.used = used
        self.loggedIn = loggedIn
        self.backAt = backAt
        self.current = current
        self.limit = limit
        self.resetsAt = resetsAt
        self.tone = tone
        self.expired = expired
        self.limits = limits
        self.title = title
        self.switchable = switchable
    }

    /// The four bands the phone's `usageBarTone` produces, plus the one it
    /// cannot: a band this build has never heard of.
    enum Tone: String {
        case ample
        case low
        case critical
        case unknown
    }

    /// The band the phone sent. `unknown` covers both "the phone said nothing"
    /// and "the phone said something this build does not know", which draw the
    /// same: a neutral track, never a healthy-looking one. An expired reading
    /// has no band either: whatever the phone said was about a window that no
    /// longer exists.
    var band: Tone { isExpired ? .unknown : Tone(rawValue: tone ?? "") ?? .unknown }

    /// The window this figure counted had already reset when it was read
    /// (DROVE-204).
    var isExpired: Bool { expired == true }

    /// Is there a figure to print at all?
    ///
    /// Two ways there is not, and the phone's sheet already says which: nobody
    /// ever measured this account, or somebody did and the window has since
    /// reset. NEITHER may draw as a bar, and under fill-as-used that is a
    /// sharper rule than it was: an empty bar is now the positive claim
    /// "nothing used yet", which is exactly what an unusable window must not
    /// say. So the views draw no bar at all for these, not a bar at zero
    /// (`WristQuotaCapsule`).
    ///
    /// The wrist shows ONE figure and cannot qualify it the way the phone's
    /// rows can, which is why an expired reading loses its number here rather
    /// than carrying a caveat. The line underneath is what tells the two
    /// nothings apart, in the phone's own words.
    var isMeasured: Bool { usedPercent != nil && !isExpired }

    /// Percent USED, 0...100, clamped.
    ///
    /// The phone sends it. The `100 - headroom` below is the fallback for a
    /// phone that predates the key and is the ONLY place the wrist does this
    /// arithmetic — a build 15 watch paired to a phone whose JS bundle is
    /// older than this lane. It is the same expression `usageBarFraction`
    /// evaluates, kept to one line so a future change to the direction is a
    /// one-line search rather than a hunt.
    var usedPercent: Int? {
        if let used { return min(100, max(0, used)) }
        guard let headroom else { return nil }
        return 100 - min(100, max(0, headroom))
    }

    /// How much of the track the fill covers, 0...1: percent USED, the
    /// direction every bar in the product fills (DROVE-230). Nothing measured
    /// returns 0 and the views must not draw it — see `isMeasured`.
    var fraction: Double {
        guard isMeasured, let usedPercent else { return 0 }
        return Double(usedPercent) / 100
    }

    /// `98%`, percent USED, or the dash the phone prints where there is no
    /// figure. One spelling, so the glance and the Limits screen cannot
    /// disagree about what "nothing to say" looks like.
    var figure: String {
        guard isMeasured, let usedPercent else { return "\u{2013}" }
        return "\(usedPercent)%"
    }

    /// The same figure with its direction said out loud, for VoiceOver and for
    /// the one line on this screen wide enough to spell it. A bar carries
    /// direction to an eye and to nothing else, so a reader that never sees
    /// the fill has to be told (DROVE-230).
    var spokenFigure: String {
        guard isMeasured, let usedPercent else { return "not measured" }
        return "\(usedPercent)% used"
    }

    /// `2% left`, the one thing on the wrist that counts DOWN, and the reason
    /// it is allowed to: it spells the word and the line it sits on names the
    /// window right after it. The phone keeps headroom in exactly one place
    /// for the same reason (DROVE-230). Nil when there is no reading.
    var headroomFigure: String? {
        guard isMeasured, let headroom else { return nil }
        return "\(min(100, max(0, headroom)))% left"
    }

    /// Is this limit still in force at `now`? A reset time in the past is the
    /// cache being behind, and printing "resets 6 PM" at 9 PM is worse than
    /// printing nothing.
    func resets(after now: Date) -> Date? {
        guard let resetsAt, resetsAt > now else { return nil }
        return resetsAt
    }

    /// The windows to draw on the detail, empty when the phone sent none.
    var limitRows: [DroverAccountLimit] { limits ?? [] }

    /// Whether a session may be moved here. Absent reads as no, which is the
    /// safe answer: an older phone sending nothing means the wrist offers no
    /// switch rather than one that bounces on the Mac.
    var canTakeASession: Bool { switchable == true }

    /// The heading over the breakdown: the phone's sentence, or the shortest
    /// honest one this build can write without it (DROVE-339).
    ///
    /// The fallback is deliberately NOT a reimplementation of
    /// `usageAccountGroupTitle`. That function chooses between four different
    /// nothings and the wrist must not own a second copy of that choice
    /// (DROVE-129), so a phone too old to send a title gets the name, the
    /// headroom it did send, and the window it named — and the rows below say
    /// the rest.
    func heading(at now: Date) -> String {
        if let title, !title.isEmpty { return title }
        var parts: [String] = [name]
        if let left = headroomFigure {
            parts.append(limit.map { "\(left) on \($0)" } ?? left)
        } else if loggedIn == false {
            parts.append("not logged in")
        }
        if let back = backAt, back > now {
            parts.append("back \(back.formatted(date: .omitted, time: .shortened))")
        }
        return parts.joined(separator: " · ")
    }
}

/// One row of the open session's transcript, as the phone folded it
/// (DROVE-91).
///
/// The phone does the folding: a run of tool calls is already one `tools`
/// row reading `Ran 4 shell commands`, and `text` is already cut to 500
/// characters with a "more on the phone" tail. The wrist draws, it does not
/// decide. `kind` is a String for the same reason `DroverGate.kind` is: a
/// kind this build has never heard of must cost one row, not the snapshot.
struct DroverTranscriptRow: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let kind: String
    let text: String
    /// Still being written. Optional so a phone that omits it (false) decodes.
    let streaming: Bool?
    let at: Date
    /// The gate in `DroverSnapshot.gates` this row stands for, while it is
    /// still pending. Nil once it is answered, and on every other kind.
    let gateId: String?

    enum Kind: String {
        case user
        case assistant
        case tools
        case gate
        case unknown
    }

    var classification: Kind { Kind(rawValue: kind) ?? .unknown }
    var isStreaming: Bool { streaming == true }
}

/// The last rows of the session the wrist said it was looking at (DROVE-91).
/// Oldest first, newest at the bottom.
struct DroverTranscript: Codable, Equatable {
    let sessionId: String
    var rows: [DroverTranscriptRow]
    /// The turn is running: the wrist draws a streaming row under the last one.
    var streaming: Bool
}

/// What the phone sends by `sendMessage` for a transcript change while this
/// watch is reachable, instead of the whole snapshot (DROVE-91). Told apart
/// from a snapshot by `kind`, which a snapshot never carries at the top.
struct DroverTranscriptDelta: Codable, Equatable {
    /// Always "transcript".
    let kind: String
    let sessionId: String
    let streaming: Bool
    /// The whole window, in order. Rows not in `rows` are ones the wrist was
    /// already sent; a row it turns out not to have is a reason to ask for a
    /// snapshot, which carries the full transcript.
    let ids: [String]
    /// Only the rows that changed since the last delta.
    let rows: [DroverTranscriptRow]
    let updatedAt: Date

    static let kindValue = "transcript"

    var isTranscript: Bool { kind == Self.kindValue }
}

extension DroverTranscript {
    /// Apply a delta to what the wrist holds, or to nothing.
    ///
    /// Returns the merged transcript and the ids the delta names that the
    /// wrist has no row for. The caller asks the phone for a snapshot when
    /// that list is not empty; the rows it does have are drawn meanwhile,
    /// which beats a blank screen while a delta and its predecessor race.
    static func applying(
        _ delta: DroverTranscriptDelta,
        to current: DroverTranscript?
    ) -> (transcript: DroverTranscript, missing: [String]) {
        var known: [String: DroverTranscriptRow] = [:]
        if let current, current.sessionId == delta.sessionId {
            for row in current.rows { known[row.id] = row }
        }
        for row in delta.rows { known[row.id] = row }
        var rows: [DroverTranscriptRow] = []
        var missing: [String] = []
        for id in delta.ids {
            if let row = known[id] { rows.append(row) } else { missing.append(id) }
        }
        return (
            DroverTranscript(sessionId: delta.sessionId, rows: rows, streaming: delta.streaming),
            missing
        )
    }
}

/// What read-aloud is doing on the phone (DROVE-275).
///
/// The wrist is the FOURTH surface on one state, not a second copy of it. The
/// phone resolves reading-or-paused and sends the answer, exactly as it does
/// for `SessionState` (DROVE-129): the wrist cannot import the reader, and two
/// implementations of one rule in two languages is two rules.
///
/// ABSENT MEANS READ-ALOUD IS OFF. There is no "off" case here on purpose —
/// the phone omits the whole object — so this enumeration cannot drift out of
/// step with the native `ReadingState`, which does have one.
struct DroverReading: Codable, Equatable {
    /// "reading" or "paused". Pinned against the TypeScript union by
    /// sources/sync/readingWire.spec.ts.
    let state: String
    /// The session the reader is following, when the phone knows it.
    let sessionId: String?

    static let readingState = "reading"
    static let pausedState = "paused"

    /// He is holding it. Anything that is not the paused spelling reads as
    /// reading, because a snapshot is data from another process and a state
    /// this build has never heard of is still a reader that is running.
    var isPaused: Bool { state == Self.pausedState }

    /// Whether this session's screen may show the control.
    ///
    /// A pause pressed on another session's transcript would stop a voice
    /// reading something he is not looking at. A snapshot with no `sessionId`
    /// — an older phone, or a reader following nothing in particular — offers
    /// the control nowhere rather than everywhere: silently steering the wrong
    /// session is worse than a button that is not there.
    func applies(to sessionId: String) -> Bool {
        self.sessionId == sessionId
    }
}

struct DroverSnapshot: Codable, Equatable {
    var gates: [DroverGate]
    /// Stamped by the phone at publish. The wrist's only liveness signal — see
    /// `isStale`, and `connected` below for why it cannot be the other one.
    var updatedAt: Date
    /// The wrist is being FED: the phone has an activated WatchConnectivity
    /// session, a paired watch, and this app installed on it.
    ///
    /// This used to say "false when the phone says the bridge is not connected
    /// to the bus". It never could. The flag is computed as `activated &&
    /// paired && installed` (droverWatchFeed.ts) — pure pairing state — and it
    /// is only ever written BY a publish, so the failure it was written for,
    /// the phone no longer feeding the wrist, is exactly the one it cannot
    /// report: no publish, no false. A phone that dies leaves `connected:
    /// true` on the wrist forever. `isStale` is what catches that.
    var connected: Bool
    /// Sessions the wrist may flip. Absent from snapshots written before
    /// flipping existed; see the hand-written decoder below for why the
    /// default alone is not enough.
    var sessions: [DroverSession] = []
    /// Every account the wrist can name, most headroom first. Kept as bare
    /// strings because a watch that predates `accountRows` reads only this.
    var accounts: [String] = []
    /// The same accounts with their headroom. Absent from a phone that predates
    /// DROVE-28's picker, which is why the views fall back to `accounts`.
    var accountRows: [DroverAccount] = []
    /// The open session's last rows, when the wrist has said which session
    /// (DROVE-91). Absent from a phone that predates the key, and from the
    /// background republish, which the store treats as "keep what you have".
    var transcript: DroverTranscript? = nil
    /// What read-aloud is doing (DROVE-275). Absent when it is off, and absent
    /// from a phone that predates the key; both mean "no reader here" and the
    /// wrist shows neither indicator nor control.
    var reading: DroverReading? = nil

    static let empty = DroverSnapshot(gates: [], updatedAt: .distantPast, connected: false)

    /// How long a snapshot may go unrefreshed before the wrist stops trusting
    /// it.
    ///
    /// The phone republishes every 60s whether anything changed or not
    /// (HEARTBEAT_MS in sources/sync/droverWatchFeed.ts), so a gap this wide
    /// means the phone stopped feeding us — suspended, killed, or out of range
    /// — rather than "nothing happened". Three heartbeats of slack because the
    /// application context is delivered opportunistically and one skipped
    /// delivery is normal, not a fault.
    ///
    /// Without this the wrist rendered a list from an hour ago exactly as
    /// confidently as one from a second ago, which is the failure mode that
    /// matters most here: those gates may all have been answered in tmux.
    static let staleAfter: TimeInterval = 180

    /// Takes `now` rather than reading the clock so a SwiftUI TimelineView can
    /// drive the re-render, and so it is testable.
    func age(at now: Date = Date()) -> TimeInterval { now.timeIntervalSince(updatedAt) }

    func isStale(at now: Date = Date()) -> Bool { age(at: now) > Self.staleAfter }

    /// How old the snapshot may get before the wrist asks the phone for a new
    /// one, while the wall is on screen (DROVE-22).
    ///
    /// One phone heartbeat. The feed restamps every 60s while the phone app is
    /// awake, so a snapshot older than that means it is not awake, and an ask
    /// is the only thing that will wake it.
    static let askAfter: TimeInterval = 60

    func needsAsking(at now: Date = Date()) -> Bool { age(at: now) > Self.askAfter }

    /// What the wall should SAY about the snapshot it is holding.
    ///
    /// "Out of date" used to be `age > staleAfter` and nothing else, which made
    /// it the steady state rather than a fault (DROVE-22). Only the phone app's
    /// own JS restamps `updatedAt`, iOS suspends a backgrounded app within
    /// seconds, and a suspended app runs no timers — so three minutes after Clay
    /// put the phone down the wrist said "Out of date", every time, whether or
    /// not anything was wrong. He looks at the watch precisely when he is not
    /// holding the phone, so it was the only message he ever saw.
    ///
    /// Age alone is therefore not an accusation. The wrist now asks the phone
    /// for a snapshot on activation, and a snapshot is out of date only once an
    /// ask has been made and brought back nothing newer.
    func freshness(at now: Date = Date(), refresh: DroverRefresh) -> DroverFreshness {
        if !isStale(at: now) { return .fresh }
        switch refresh {
        // Still asking, so there is nothing to accuse the phone of yet. The
        // store cannot sit here forever: it fails the ask on its own deadline,
        // and it fails it outright where no ask can ever be made.
        case .never, .asking: return .asking
        case .answered: return .stale(reason: nil)
        case let .failed(why): return .stale(reason: why)
        }
    }

    /// Shared with the widget through the app group; the widget cannot ask
    /// the phone anything itself.
    static let appGroupSuiteName = "group.com.bitspur.drover"
    static let storageKey = "drover.snapshot.v1"

    /// The phone sends dates as ISO-8601 strings (JS `toISOString`), which is
    /// NOT what JSONDecoder assumes by default — it expects seconds since
    /// 2001, so a default decoder fails the whole snapshot silently and the
    /// wrist just never updates. Both coders are shared so the app-group copy
    /// the widget reads round-trips through the same format.
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    static func load(from defaults: UserDefaults? = UserDefaults(suiteName: appGroupSuiteName)) -> DroverSnapshot {
        guard let data = defaults?.data(forKey: storageKey),
              let decoded = try? decoder.decode(DroverSnapshot.self, from: data) else {
            return .empty
        }
        return decoded
    }

    func save(to defaults: UserDefaults? = UserDefaults(suiteName: DroverSnapshot.appGroupSuiteName)) {
        guard let data = try? DroverSnapshot.encoder.encode(self) else { return }
        defaults?.set(data, forKey: DroverSnapshot.storageKey)
    }
}

extension DroverSnapshot {
    /// Hand-written because SYNTHESIZED decoding ignores a property's default:
    /// a missing key throws, it does not fall back. So `sessions = []` was
    /// never the tolerance it reads as — a snapshot from a build that predates
    /// those keys failed to decode WHOLE, and the wrist showed nothing at all.
    /// The app-group blob outlives an app update, so that is a snapshot this
    /// really does read. Written as an extension so the memberwise init the
    /// call sites use survives.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        gates = try container.decode([DroverGate].self, forKey: .gates)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        connected = try container.decode(Bool.self, forKey: .connected)
        sessions = try container.decodeIfPresent([DroverSession].self, forKey: .sessions) ?? []
        accounts = try container.decodeIfPresent([String].self, forKey: .accounts) ?? []
        accountRows = try container.decodeIfPresent([DroverAccount].self, forKey: .accountRows) ?? []
        transcript = try container.decodeIfPresent(DroverTranscript.self, forKey: .transcript)
        reading = try container.decodeIfPresent(DroverReading.self, forKey: .reading)
    }
}

extension DroverSnapshot {
    /// The account the work is on, for the one glance that answers "can I
    /// still work" (DROVE-131).
    ///
    /// The phone's `current` flag first, because the registry is what decides
    /// it. A phone that predates the key falls back to the FIRST row, which is
    /// the most headroom the picker found — not a lie about which account is
    /// live, but the account the wrist would offer next, and a bar for it beats
    /// no bar at all. Nil only when there are no rows.
    var currentAccount: DroverAccount? {
        accountRows.first { $0.current == true } ?? accountRows.first
    }

    /// Every other account, in the order the phone sent them (most headroom
    /// first). The second glance, never the first: five accounts do not fit on
    /// a wrist above the number that matters.
    var otherAccounts: [DroverAccount] {
        guard let current = currentAccount else { return [] }
        return accountRows.filter { $0.name != current.name }
    }

    /// Every session with something still to do, in the order the phone sent
    /// them (DROVE-167).
    ///
    /// The phone already dropped the finished lists and put the session
    /// actually working first, so this filters and does not sort. A session
    /// whose list is finished is not here at all: a wall of struck-through
    /// lines is how a wrist list stops being read.
    var sessionsWithTasks: [DroverSession] {
        sessions.filter { $0.hasTasks }
    }

    /// How many unfinished tasks the whole snapshot is carrying.
    var openTaskCount: Int {
        sessions.reduce(0) { $0 + $1.openTasks.count }
    }

    /// `3 tasks in 2 sessions` — the line on the door.
    var taskDoorLabel: String {
        let sessionsWith = sessionsWithTasks.count
        let count = openTaskCount
        let tasks = count == 1 ? "1 task" : "\(count) tasks"
        let across = sessionsWith == 1 ? "1 session" : "\(sessionsWith) sessions"
        return "\(tasks) in \(across)"
    }
}

/// Answers travel back the same way. `allow` is the only affirmative — a
/// deny and a timeout are deliberately different things on the bus, so the
/// watch never invents one for the other.
struct DroverAnswer: Codable {
    let id: String
    let allow: Bool
    /// For question gates: the chosen `options[].id`, which is the label when
    /// the option never carried an id. A question needs this or `text` — a
    /// question answered with a bare allow is refused by the bus (server.js: "a
    /// question needs an option or text", 409) or, on an older bus, taken with
    /// no answer at all, which dismisses every surface and leaves the waiting
    /// hook nothing to inject. Bus event "Step 1 order" (2026-08-29) was that
    /// second one: a watch tap that travelled the whole way and still lost the
    /// answer.
    let optionId: String?
    /// A typed or dictated answer, for a question whose card offered no options
    /// or offered none that fit. Trimmed and non-empty or absent entirely: the
    /// bus refuses a blank resolve with a 400, and a nil Optional is simply
    /// left out of the JSON, which is also what keeps NSNull off a
    /// WatchConnectivity payload.
    let text: String?
    /// EVERY pick on a multi-select question, in the order they were tapped
    /// (DROVE-53).
    ///
    /// `optionId` still carries the first one, so the phone and the CLI paths
    /// that only ever knew that key keep working. Absent on a single-select
    /// answer rather than a one-element array: an array where the reader
    /// expects one string is how a "pick one" answer would start arriving as a
    /// list nobody asked for.
    let optionIds: [String]?
    /// ALLOW, AND STOP ASKING for the rest of this session (DROVE-53).
    ///
    /// Only ever "session", and absent otherwise — including on a plain allow,
    /// because a default worth writing down is a default that will drift. The
    /// phone turns it into the `approved_for_session` decision the app's own
    /// card already sends, and lib/drover-gate.sh is what remembers it.
    let scope: String?
}

/// Flip a session onto another account, from the wrist (BASED-98).
///
/// Sent on the same WatchConnectivity channel as an answer and told apart by
/// `kind`, which an answer never carries. The phone turns it into the `/flip`
/// message the CLI already intercepts, so the wrist reaches the flip through
/// exactly the path the phone and a tmux key binding use — no fourth mechanism
/// to keep in step, and nothing added to the Happy server.
struct DroverFlip: Codable {
    /// Always "flip". The phone dispatches on it.
    let kind: String
    /// Which session moves.
    let sessionId: String
    /// Target account, or nil for "the next one with headroom".
    let account: String?

    init(sessionId: String, account: String?) {
        self.kind = "flip"
        self.sessionId = sessionId
        self.account = account
    }
}

/// The wrist saying which session it has open, so the phone feeds that one's
/// transcript and no other's (DROVE-91). Same channel as an answer and a flip,
/// told apart by `kind`. `sessionId` nil means it left the transcript.
struct DroverOpened: Codable {
    /// Always "opened".
    let kind: String
    let sessionId: String?

    init(sessionId: String?) {
        self.kind = "opened"
        self.sessionId = sessionId
    }
}

/// A message dictated on the wrist for a session (DROVE-92). Same channel as
/// an answer, told apart by `kind`. The phone sends it through the composer's
/// own path, so it reaches the session and both transcripts exactly like a
/// phone-typed message.
struct DroverSay: Codable {
    /// Always "say".
    let kind: String
    let sessionId: String
    let text: String

    init(sessionId: String, text: String) {
        self.kind = "say"
        self.sessionId = sessionId
        self.text = text
    }
}

/// Whether this wrist's audio route has headphones (DROVE-92). The phone
/// picks which device speaks a reply on it: Apple plays audio on the device
/// the headphones are paired to, and this is how the phone learns which.
struct DroverAudioRoute: Codable {
    /// Always "route".
    let kind: String
    let headphones: Bool

    init(headphones: Bool) {
        self.kind = "route"
        self.headphones = headphones
    }
}

/// The wrist finished, or cut, a sentence the phone sent it to speak
/// (DROVE-92). `id` is the one the phone sent; its read-aloud queue paces on
/// this the way it paces on its own synthesiser settling.
struct DroverSpoken: Codable {
    /// Always "spoken".
    let kind: String
    let id: String
    let finished: Bool

    init(id: String, finished: Bool) {
        self.kind = "spoken"
        self.id = id
        self.finished = finished
    }
}

/// Pause or resume the reading, from the wrist (DROVE-275). Same channel as an
/// answer, told apart by `kind`. The phone hands it to the one reader every
/// surface drives, so a pause taken on the wrist is the same pause the lock
/// screen and the headphones take, holding the same place.
struct DroverTransport: Codable {
    /// Always "transport".
    let kind: String
    /// "pause" or "resume".
    ///
    /// EXPLICIT, NEVER A TOGGLE. The wrist presses off the last snapshot it
    /// received, which can be a minute old or older with the phone out of
    /// range, and a toggle sent from a stale screen resumes precisely the
    /// reading he had just paused. Naming the destination makes a stale press
    /// a no-op, which is the failure worth having.
    let action: String

    static let kindValue = "transport"
    static let pauseAction = "pause"
    static let resumeAction = "resume"

    init(paused: Bool) {
        self.kind = Self.kindValue
        self.action = paused ? Self.pauseAction : Self.resumeAction
    }
}

/// A sentence the phone asks this wrist to speak, or a stop (DROVE-92).
/// Decoded off a `sendMessage` dictionary told apart by `kind == "speak"`.
struct DroverSpeak: Codable {
    static let kindValue = "speak"
    let kind: String
    /// Absent on a stop.
    let id: String?
    let text: String?
    /// Present and true on a stop: cut whatever is speaking and clear the queue.
    let stop: Bool?

    var isStop: Bool { stop == true }
}

/// The wrist opening or closing its microphone (DROVE-130).
///
/// The control half of the latched recorder: the audio itself rides its own
/// `wristaudio` messages, and this says which session it is for and when it
/// starts and stops. Separate from the audio so the phone can open its
/// recogniser BEFORE the first chunk arrives, and so a stop is a small
/// reliable message rather than something inferred from silence.
///
/// `capture` is the wrist's own id for one press-to-press recording. The phone
/// echoes it on every `DroverHeard`, which is what lets the wrist drop a
/// straggler from a capture that has already ended without guessing from the
/// words (see `WristHearing`).
struct DroverListen: Codable {
    static let kindValue = "listen"
    /// Always "listen".
    let kind: String
    let sessionId: String
    let capture: String
    /// "start", "stop" or "cancel". Stop keeps the words; cancel throws the
    /// whole capture away, which is the wrist's equivalent of the phone's
    /// slide-off-the-button.
    let state: String

    init(sessionId: String, capture: String, state: String) {
        self.kind = Self.kindValue
        self.sessionId = sessionId
        self.capture = capture
        self.state = state
    }
}

/// What the phone has heard so far on an open wrist capture (DROVE-130).
///
/// `text` is the phone's `latestTranscript`: EVERYTHING heard since the
/// recorder opened, with utterances before a pause already banked by
/// `DroverSpeechModule.absorb()`. So the wrist draws it rather than
/// accumulating it, and the DROVE-263 fix is inherited rather than copied.
///
/// `seq` is monotonic within one capture. `sendMessage` promises no ordering,
/// and the wrist cannot tell a stale duplicate from a legitimate revision by
/// reading the words — a revision is often SHORTER and correct — so ordering
/// is carried rather than guessed.
struct DroverHeard: Codable {
    static let kindValue = "heard"
    let kind: String
    let capture: String
    let seq: Int
    let text: String
    /// The last word on this capture: the recogniser settled, or gave up.
    let final: Bool?

    var isFinal: Bool { final == true }
}
