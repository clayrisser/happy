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
        let entry = DroverEntry(date: Date(), snapshot: .load())
        // Refreshes are driven by the watch app calling reloadAllTimelines
        // when the phone pushes; the interval is only a backstop so a widget
        // whose app never ran does not sit on placeholder data forever.
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(900))))
    }
}

struct DroverWidgetView: View {
    var entry: DroverEntry

    private var count: Int { entry.snapshot.gates.count }

    var body: some View {
        VStack(spacing: 2) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(tint)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private var symbol: String {
        if !entry.snapshot.connected { return "wifi.slash" }
        return count > 0 ? "exclamationmark.shield.fill" : "checkmark.circle"
    }

    private var tint: Color {
        if !entry.snapshot.connected { return .secondary }
        return count > 0 ? .orange : .green
    }

    private var label: String {
        if !entry.snapshot.connected { return "offline" }
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
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryCorner])
    }
}
