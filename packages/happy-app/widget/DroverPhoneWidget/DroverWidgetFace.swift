import Foundation

/// The face the PHONE resolved, as the widget reads it back (DROVE-260).
///
/// Every field here was decided in sources/sync/droverWidgetFace.ts and written
/// into the app group. Nothing is derived on this side, for the reason
/// DROVE-129 gave the wrist and DROVE-257 had to give it twice: a widget that
/// picks its own colour for `disconnected` is a fifth copy of a table that
/// already has four, and it drifts silently because nobody looks at a home
/// screen and a session list side by side.
///
/// `droverWidgetFace.spec.ts` reads this file and checks the hexes and the two
/// timeouts against the phone's own, the same arrangement sessionStateWire.spec.ts
/// has with DroverSnapshot.swift.
struct DroverWidgetFace: Codable, Equatable {
    /// Gates waiting on him.
    let count: Int
    /// A `StatusDotState` raw value. Unknown values fall back to disconnected
    /// rather than to a colour, because a widget from an older build meeting a
    /// state it has never heard of should look like a fault, not like calm.
    let dot: String
    /// `statusDotColors[dot]`, with the `#`. Sent rather than looked up.
    let tintHex: String
    /// The big line: a count, or the dot's own label.
    let headline: String
    /// The small line. Empty string when there is nothing worth the row.
    let detail: String
    /// When the phone resolved this, ISO-8601 through the shared coders.
    ///
    /// Carried INSIDE the face rather than read off `DroverSnapshot.updatedAt`
    /// beside it. The two blobs are written by different paths — the wrist
    /// publish writes the snapshot, and a push that only needs to move the
    /// widget writes just this — so a face paired with someone else's
    /// timestamp would be dated by an unrelated write, or worse, freshened by
    /// one. One blob, one age.
    let updatedAt: Date

    static let empty = DroverWidgetFace(
        count: 0,
        dot: "disconnected",
        tintHex: "#FF3B30",
        headline: "Disconnected",
        detail: "",
        updatedAt: .distantPast
    )
}

/// How long "clear" may be shown as a fact. `WIDGET_CLEAR_TRUSTED_MS`.
let widgetClearTrusted: TimeInterval = 3600

/// How long a count may be shown as a fact. `WIDGET_COUNT_TRUSTED_MS`.
let widgetCountTrusted: TimeInterval = 21600

/// Whether the face may be stated flatly. `widgetTrust` in the TS, evaluated
/// here because "still true" is a time the phone did not know when it wrote.
///
/// The asymmetry is the whole point and it is stated at the TS constants: a
/// count survives silence because the push that would have corrected it fires
/// on a CHANGE, and a zero does not, because the missing push and the quiet
/// machine look identical from here.
func widgetTrusted(count: Int, updatedAt: Date, now: Date) -> Bool {
    let age = now.timeIntervalSince(updatedAt)
    if age < 0 { return false }
    return age <= (count > 0 ? widgetCountTrusted : widgetClearTrusted)
}

extension DroverSnapshot {
    /// The app-group key the phone writes the face under, beside the snapshot.
    ///
    /// A separate key rather than a field on `DroverSnapshot`, so a watch
    /// binary that has never heard of the widget keeps decoding the snapshot
    /// exactly as it does today — the hand-written `init(from:)` would ignore
    /// the extra key anyway, but a separate blob means the widget can be
    /// written on a push that does not touch the wrist at all.
    static let widgetFaceKey = "drover.widget.face.v1"

    static func loadWidgetFace(
        from defaults: UserDefaults? = UserDefaults(suiteName: appGroupSuiteName)
    ) -> DroverWidgetFace? {
        guard let data = defaults?.data(forKey: widgetFaceKey),
              let decoded = try? decoder.decode(DroverWidgetFace.self, from: data) else {
            return nil
        }
        return decoded
    }
}
