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

struct DroverSnapshot: Codable, Equatable {
    var gates: [DroverGate]
    var updatedAt: Date
    /// False when the phone says the bridge is not connected to the bus, so
    /// the watch can say "not watching" instead of implying all-clear.
    var connected: Bool

    static let empty = DroverSnapshot(gates: [], updatedAt: .distantPast, connected: false)

    /// Shared with the widget through the app group; the widget cannot ask
    /// the phone anything itself.
    static let appGroupSuiteName = "group.com.ex3ndr.happy.drover"
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
