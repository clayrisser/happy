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

    var isQuestion: Bool { kind == "question" }
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
}

struct DroverSnapshot: Codable, Equatable {
    var gates: [DroverGate]
    var updatedAt: Date
    /// False when the phone says the bridge is not connected to the bus, so
    /// the watch can say "not watching" instead of implying all-clear.
    var connected: Bool
    /// Sessions the wrist may flip. Defaulted for snapshots written before
    /// flipping existed.
    var sessions: [DroverSession] = []
    /// Every account in the registry, in Clay's preference order, so the
    /// wrist can offer them by name instead of only "the next one".
    var accounts: [String] = []

    static let empty = DroverSnapshot(gates: [], updatedAt: .distantPast, connected: false)

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

/// Answers travel back the same way. `allow` is the only affirmative — a
/// deny and a timeout are deliberately different things on the bus, so the
/// watch never invents one for the other.
struct DroverAnswer: Codable {
    let id: String
    let allow: Bool
    /// For question gates: the chosen option label.
    let optionId: String?
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
