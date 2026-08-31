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

    var resolvedState: SessionState { SessionState(rawValue: state ?? "") ?? (active ? .thinking : .disconnected) }
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
    let headroom: Int?
    /// False when the account is not logged in, so the wrist can grey it rather
    /// than offering a flip that will bounce.
    let loggedIn: Bool?
    /// When a cooling account is back. Absent when it is not out.
    let backAt: Date?
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
