import SwiftUI
import WidgetKit

/// Smart Stack complication: how many gates are waiting (BASED-98).
///
/// The widget reads the app-group snapshot the watch app writes. It cannot
/// talk to the phone itself, so a stale snapshot is always possible — it
/// shows the count it has and the watch app is what refreshes it.
struct DroverEntry: TimelineEntry {
    let date: Date
    let snapshot: DroverSnapshot
}

struct DroverProvider: TimelineProvider {
    func placeholder(in context: Context) -> DroverEntry {
        DroverEntry(date: Date(), snapshot: .empty)
    }

    func getSnapshot(in context: Context, completion: @escaping (DroverEntry) -> Void) {
        completion(DroverEntry(date: Date(), snapshot: .load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DroverEntry>) -> Void) {
        let now = Date()
        let snapshot = DroverSnapshot.load()
        var entries = [DroverEntry(date: now, snapshot: snapshot)]
        // A second entry at the exact moment this snapshot goes stale, so the
        // complication stops saying "clear" the instant it stops knowing. The
        // widget cannot ask the phone anything, so without this it would sit on
        // a green checkmark until the next reload — up to the 900s backstop
        // below — with the phone long since dead.
        let goesStale = snapshot.updatedAt.addingTimeInterval(DroverSnapshot.staleAfter)
        if goesStale > now { entries.append(DroverEntry(date: goesStale, snapshot: snapshot)) }
        // Refreshes are driven by the watch app calling reloadAllTimelines
        // when the phone pushes; the interval is only a backstop so a widget
        // whose app never ran does not sit on placeholder data forever.
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(900))))
    }
}

struct DroverWidgetView: View {
    var entry: DroverEntry
    /// Which slot on the face this is drawing into. Inline is the one family
    /// that is a line rather than a shape, so it is the one that lays the
    /// same two things out differently (DROVE-260).
    @Environment(\.widgetFamily) private var family

    private var count: Int { entry.snapshot.gates.count }

    /// Measured against the ENTRY's date, not the clock: that is the moment
    /// WidgetKit rendered for, and the provider schedules an entry exactly when
    /// the snapshot turns.
    private var stale: Bool { entry.snapshot.isStale(at: entry.date) }

    var body: some View {
        Group {
            if family == .accessoryInline {
                // ONE LINE BESIDE THE TIME (DROVE-260). The same glyph and the
                // same word the circular draws, laid flat instead of stacked:
                // inline is the settled signal on one more face slot, not a
                // second vocabulary. Untinted on purpose, because the inline
                // slot renders monochrome and a colour here would be a claim
                // the face cannot show.
                Label(label, systemImage: symbol)
            } else {
                VStack(spacing: 2) {
                    Image(systemName: symbol)
                        .font(.title3)
                        .foregroundStyle(tint)
                    Text(label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private var symbol: String {
        if !entry.snapshot.connected { return "wifi.slash" }
        if stale { return "clock.badge.exclamationmark" }
        return count > 0 ? "exclamationmark.shield.fill" : "checkmark.circle"
    }

    private var tint: Color {
        if !entry.snapshot.connected { return .secondary }
        if stale { return .yellow }
        return count > 0 ? .orange : .green
    }

    /// A count is only worth showing while it is current. "clear" off a
    /// snapshot the phone stopped refreshing is the same lie the watch app used
    /// to tell, on the face Clay actually glances at.
    private var label: String {
        if !entry.snapshot.connected { return "offline" }
        if stale { return count > 0 ? "\(count)?" : "stale" }
        switch count {
        case 0: return "clear"
        case 1: return "1 gate"
        default: return "\(count) gates"
        }
    }
}

@main
struct DroverWatchWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DroverWatchWidget", provider: DroverProvider()) { entry in
            DroverWidgetView(entry: entry)
        }
        .configurationDisplayName("Drover")
        .description("Gates waiting on you.")
        // Every accessory slot a watch face offers, carrying the one signal
        // (DROVE-260). Inline was the slot Drover did not fill, and it needed
        // no new decision: the same count, one more place to read it.
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryCorner, .accessoryInline])
    }
}
