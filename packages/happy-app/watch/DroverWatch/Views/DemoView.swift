import SwiftUI

/// The Playground (DROVE-75): every haptic pattern on demand, back to back,
/// and every card shape the wrist draws, from fixtures.
///
/// Nothing on this screen reaches a session. A cue plays through
/// `WristBuzzer.demo`, which never touches a snapshot, the dedupe, or the
/// notification route; a card is a `DroverDemo` fixture whose id carries the
/// `demo:` prefix, and `GateStore.answer` refuses that prefix before it
/// encodes anything, so the real `GateDetailView` can be pushed with its real
/// buttons and none of them can send. That is the constraint on the ticket,
/// held in code rather than in a note.
///
/// It is the wrist's half of the phone's Playground (longhorn menu), and it
/// exists because the patterns cannot be judged any other way: whether "three
/// thuds" and "two taps" can be told apart through a sleeve is something only
/// a wrist knows, and a real gate arrives one at a time, months apart.
struct DemoView: View {
    @EnvironmentObject private var store: GateStore
    /// Built once per visit rather than per render: the fixtures stamp
    /// `createdAt` with now, and a value that changes under a pushed
    /// NavigationLink is a value the stack cannot find again.
    @State private var gates = DroverDemo.gates()

    var body: some View {
        List {
            Section {
                Button {
                    store.demoBuzzAll()
                } label: {
                    Label("Play all", systemImage: "play.circle")
                        .font(.caption)
                }
                .tint(.green)
                ForEach(DroverDemo.cues, id: \.self) { cue in
                    Button {
                        store.demoBuzz(cue)
                    } label: {
                        CueRow(cue: cue, playing: store.demoPlaying == cue)
                    }
                }
            } header: {
                Text("Buzz")
            } footer: {
                Text("Most urgent first. Each one plays here, on this wrist, and nowhere else.")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }

            // The honest half of the Playground (DROVE-124). Every pattern
            // above plays only because this screen is up. With the app closed
            // watchOS taps once with its own haptic and none of the patterns
            // exist, and if alerts are off it does not tap at all — which used
            // to be indistinguishable from nothing having happened.
            Section {
                ClosedAppRow(delivery: store.backgroundDelivery)
            } header: {
                Text("With the app closed")
            }

            Section {
                ForEach(gates) { gate in
                    NavigationLink(value: gate) {
                        DemoGateRow(gate: gate)
                    }
                }
            } header: {
                Text("Cards")
            } footer: {
                Text("Fixtures. Every button on them is refused: nothing is sent.")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Playground")
        .navigationBarTitleDisplayMode(.inline)
        // Leaving mid play-all should not keep buzzing the wall.
        .onDisappear { store.stopDemo() }
    }
}

/// What a gate does to this wrist when the app is NOT on screen (DROVE-124).
///
/// Three outcomes, and the app has to be able to say which one is live,
/// because they are indistinguishable from the wrist: one identical system tap
/// plus a card, or nothing at all. The patterns above are never among them.
private struct ClosedAppRow: View {
    let delivery: WristDelivery

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: delivery.buzzes ? "bell.badge" : "bell.slash")
                .font(.caption2)
                .foregroundStyle(delivery.buzzes ? .green : .orange)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(delivery.buzzes ? "One tap, watchOS picks it" : "No buzz")
                    .font(.caption)
                Text(detail)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var detail: String {
        if let silence = delivery.silence { return silence.reason }
        return "A gate shows its card and taps once. The patterns above need this app on screen; watchOS chooses the haptic for a notification and no API selects it."
    }
}

/// One cue: what it means, what it feels like, and whether it is playing.
private struct CueRow: View {
    let cue: WristCue
    let playing: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: playing ? "waveform" : symbol)
                .font(.caption2)
                .foregroundStyle(playing ? .green : tint)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(cue.headline)
                    .font(.caption)
                Text(DroverDemo.describe(cue))
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The same glyphs the wall uses for the gate each cue stands for, so the
    /// row and the card it will one day announce match.
    private var symbol: String {
        switch cue {
        case .needsYou: return "checklist"
        case .question: return "questionmark.bubble"
        case .permission: return "exclamationmark.shield"
        case .expiry: return "clock.badge.exclamationmark"
        case .finished: return "checkmark.circle"
        }
    }

    private var tint: Color {
        switch cue {
        case .needsYou: return .green
        case .question: return .blue
        case .permission: return .orange
        case .expiry: return .yellow
        case .finished: return .secondary
        }
    }
}

/// A fixture card's row: the kind it exercises and what the card says.
private struct DemoGateRow: View {
    let gate: DroverGate

    private var shape: String {
        switch gate.classification {
        case .permission, .unknown: return "Permission"
        case .question:
            if gate.allowsMultipleAnswers { return "Question, pick several" }
            return gate.answerableOptions.isEmpty ? "Question, typed" : "Question, pick one"
        case .todo: return "Needs you"
        case .expiry: return "Account limit"
        case .idle: return "Waiting"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(shape)
                .font(.caption)
            Text(gate.preview)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
    }
}
