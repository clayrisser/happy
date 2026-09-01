import SwiftUI
import WidgetKit

/// The iPhone home-screen widget, `.systemSmall` and nothing else (DROVE-260).
///
/// ONE SIZE ON PURPOSE. The proposal in docs/plans/drover-widgets.md argues the
/// case at length; the short version is that `.systemSmall` is the smallest
/// phone surface that can carry the one question worth a glance — is anything
/// waiting on me — AND, when the answer is no, say whether the work is still
/// alive in the hue vocabulary that already exists. `.systemMedium` invites a
/// list and the app is the list. The Lock Screen accessory families are the
/// better SURFACE and the worse CANVAS: they render in `.vibrant`, which
/// desaturates, and `statusDotColors` is a hue vocabulary end to end. Shipping
/// there means designing a monochrome one first, which is a decision, not a
/// size.
///
/// It cannot ask the phone anything. Everything below is read out of the app
/// group and rendered; the freshness ladder is what stops that from becoming a
/// lie between writes.
struct DroverPhoneEntry: TimelineEntry {
    let date: Date
    let face: DroverWidgetFace
    /// No face has ever been written: the app has not run since install.
    let unwritten: Bool

    var updatedAt: Date { face.updatedAt }
}

struct DroverPhoneProvider: TimelineProvider {
    func placeholder(in context: Context) -> DroverPhoneEntry {
        DroverPhoneEntry(date: Date(), face: .empty, unwritten: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (DroverPhoneEntry) -> Void) {
        completion(read(at: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DroverPhoneEntry>) -> Void) {
        let now = Date()
        let entry = read(at: now)
        var entries = [entry]
        // A second entry at the exact moment this face stops being a fact, so
        // the widget stops stating it the instant it stops knowing rather than
        // waiting for a reload it does not control. Same move the watch
        // complication makes at `staleAfter`, with the asymmetric budget.
        if !entry.unwritten {
            let budget = entry.face.count > 0 ? widgetCountTrusted : widgetClearTrusted
            let turns = entry.updatedAt.addingTimeInterval(budget)
            if turns > now {
                entries.append(DroverPhoneEntry(date: turns, face: entry.face, unwritten: false))
            }
        }
        // The REAL refresh is the silent content-available push the CLI already
        // sends on every gate change (droverBackgroundNotification.ts), which
        // reloads timelines from the app itself. This policy is only the
        // backstop for a widget whose app has not been woken: WidgetKit's own
        // budget is roughly 40-70 reloads a day, so asking for less than about
        // 15 minutes buys nothing and spends the budget the push wants.
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(900))))
    }

    private func read(at now: Date) -> DroverPhoneEntry {
        guard let face = DroverSnapshot.loadWidgetFace() else {
            return DroverPhoneEntry(date: now, face: .empty, unwritten: true)
        }
        return DroverPhoneEntry(date: now, face: face, unwritten: false)
    }
}

struct DroverPhoneWidgetView: View {
    var entry: DroverPhoneEntry

    /// Measured against the ENTRY's date, which is the moment WidgetKit is
    /// drawing for, not the clock at the time this struct was built.
    private var trusted: Bool {
        !entry.unwritten && widgetTrusted(
            count: entry.face.count,
            updatedAt: entry.updatedAt,
            now: entry.date
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle()
                    .fill(tint)
                    .frame(width: 10, height: 10)
                Spacer(minLength: 0)
                if !trusted && !entry.unwritten {
                    // The age, not a warning glyph. "as of 3h ago" is a fact
                    // about the widget; a yellow triangle is a claim about the
                    // machine, and the widget is in no position to make one.
                    Text(entry.updatedAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Text(headline)
                .font(entry.face.count > 0 && trusted ? .system(size: 44, weight: .semibold) : .headline)
                .foregroundStyle(trusted ? .primary : .secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if !detail.isEmpty {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
        .widgetURL(URL(string: "happy://gates"))
    }

    /// The phone's hex, parsed, never a table of this widget's own. A hex that
    /// will not parse falls back to `.secondary` rather than to a guessed
    /// colour, so the failure reads as "no claim" instead of as a state.
    private var tint: Color {
        guard trusted, let parsed = Color(hex: entry.face.tintHex) else { return .secondary }
        return parsed
    }

    /// WHAT A DATED WIDGET SAYS. Not the count as a figure.
    ///
    /// A stale count keeps its shape — the number is still the best thing known
    /// and hiding it would be its own lie — but it stops being the 44pt figure
    /// that reads as live, and the relative age goes in the corner. A stale
    /// ZERO does not survive at all: "clear" off a snapshot nobody refreshed is
    /// exactly DROVE-255's fresh-looking row over a spent week, and the widget
    /// says it has not heard instead.
    private var headline: String {
        if entry.unwritten { return "Not yet synced" }
        if trusted { return entry.face.headline }
        return entry.face.count > 0 ? "\(entry.face.count) waiting" : "Not heard from"
    }

    private var detail: String {
        if entry.unwritten { return "Open Happy once" }
        if trusted { return entry.face.detail }
        return entry.face.count > 0 ? entry.face.detail : ""
    }
}

@main
struct DroverPhoneWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DroverPhoneWidget", provider: DroverPhoneProvider()) { entry in
            DroverPhoneWidgetView(entry: entry)
        }
        .configurationDisplayName("Drover")
        .description("Whether anything is waiting on you.")
        .supportedFamilies([.systemSmall])
    }
}

extension Color {
    /// `#RRGGBB` as the phone writes it. Nil on anything else, which the caller
    /// turns into "no claim" rather than into a colour.
    init?(hex: String) {
        var value = hex
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6, let rgb = UInt32(value, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}
