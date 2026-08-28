import SwiftUI

/// The wall: every gate waiting on a human, newest first (BASED-98).
struct GateListView: View {
    @EnvironmentObject private var store: GateStore

    var body: some View {
        NavigationStack {
            Group {
                if store.gates.isEmpty {
                    EmptyStateView(connected: store.snapshot.connected)
                } else {
                    List {
                        ForEach(store.gates) { gate in
                            NavigationLink(value: gate) {
                                GateRow(gate: gate)
                            }
                        }
                    }
                    .listStyle(.carousel)
                }
            }
            .navigationTitle("Drover")
            .navigationDestination(for: DroverGate.self) { gate in
                GateDetailView(gate: gate)
            }
            .navigationDestination(for: DroverSession.self) { session in
                SessionFlipView(session: session)
            }
            .toolbar {
                // The flip surface hangs off the gate wall rather than being a
                // second tab: gates are what the wrist is FOR, and a tab bar
                // costs a row of pixels on every screen to reach something
                // used far less often.
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SessionListView()
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                }
            }
        }
    }
}

private struct EmptyStateView: View {
    let connected: Bool

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: connected ? "checkmark.circle" : "wifi.slash")
                .font(.title2)
                .foregroundStyle(connected ? .green : .secondary)
            // Never imply all-clear when the phone is not actually watching:
            // an empty list and a disconnected bridge look identical
            // otherwise, and only one of them means "nothing is waiting".
            Text(connected ? "Nothing waiting" : "Not connected")
                .font(.headline)
            if !connected {
                Text("Open Cattle Drover on your phone")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
    }
}

private struct GateRow: View {
    let gate: DroverGate

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: gate.isQuestion ? "questionmark.bubble" : "exclamationmark.shield")
                    .font(.caption2)
                    .foregroundStyle(gate.isQuestion ? .blue : .orange)
                Text(gate.title)
                    .font(.caption)
                    .lineLimit(1)
            }
            Text(gate.preview)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            if let account = gate.account {
                Text(account)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}
