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

    /// `id` falls back to the label instead of being required. Claude's own
    /// AskUserQuestion options carry {label, description} and NO id, while the
    /// bus's carry one, and the wrist sees gates from both — requiring the key
    /// would fail the whole snapshot on a native card. Nothing is lost by the
    /// fallback: happy-cli matches an answer with `o.id === candidate ||
    /// o.label === candidate` (src/drover/droverBridge.ts), so a label sent as
    /// the id still resolves to the right option.
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
    /// Every account in the registry, in Clay's preference order, so the
    /// wrist can offer them by name instead of only "the next one".
    var accounts: [String] = []

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
