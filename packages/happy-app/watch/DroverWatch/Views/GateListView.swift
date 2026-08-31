import SwiftUI

/// Where the wall can go that is not a gate or a session.
///
/// A VALUE, not a `NavigationLink { SessionListView() }`, and that distinction
/// is the whole of BASED-98's tap bug. A view-based link pushes outside the
/// stack's value-driven navigation, and once the sessions screen had arrived
/// that way, the value link on each session row was dropped in silence:
/// SwiftUI built `SessionDetailView` — its strings show up in the log — and
/// then never presented it, so tapping a session did nothing at all. No
/// warning, no crash, no destination missing. Every push in this stack is
/// value-based now, so there is one mechanism rather than two that disagree.
enum DroverRoute: Hashable {
    case sessions
    /// The session's facts and its flip buttons, off the transcript's
    /// toolbar (DROVE-91). A tap on a session row opens the conversation;
    /// this is the rest of what the row used to open.
    case detail(DroverSession)
}

/// The wall: every gate waiting on a human, newest first (BASED-98).
struct GateListView: View {
    @EnvironmentObject private var store: GateStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            // The clock has to keep moving for staleness to mean anything: a
            // plain `snapshot.isStale()` is evaluated once at render and then
            // never again, so a wrist left on the wall would go on saying the
            // list was fresh however long the phone had been gone. A 30s tick
            // is well inside the 180s threshold.
            TimelineView(.periodic(from: Date(), by: 30)) { context in
                let freshness = store.freshness(at: context.date)
                Group {
                    if store.gates.isEmpty {
                        EmptyStateView(
                            connected: store.snapshot.connected,
                            freshness: freshness,
                            updatedAt: store.snapshot.updatedAt,
                            lastError: store.lastError
                        )
                    } else {
                        List {
                            if let message = store.lastError {
                                BannerRow(text: message, symbol: "exclamationmark.triangle", tint: .red)
                            }
                            // A wrist that cannot buzz looks exactly like a
                            // wrist with nothing to buzz about, which is the
                            // failure push already has (DROVE-62). So say it.
                            if let muted = store.buzzRefusal {
                                BannerRow(text: muted, symbol: "bell.slash", tint: .orange)
                            }
                            // A stale list is the dangerous one: every gate on
                            // it may already have been answered in tmux or on
                            // the phone, and the wrist has no way to know.
                            // Only shown once the phone has been ASKED and
                            // brought back nothing newer (DROVE-22) — age alone
                            // used to be enough, and age alone is the steady
                            // state of a phone in a pocket.
                            if case let .stale(reason) = freshness {
                                StaleRow(updatedAt: store.snapshot.updatedAt, reason: reason)
                            }
                            ForEach(store.gates) { gate in
                                NavigationLink(value: gate) {
                                    GateRow(gate: gate, sent: store.isAnswering(gate))
                                }
                                // Sent from here already. Left tappable it
                                // would queue a second answer for a gate that
                                // is merely slow.
                                .disabled(store.isAnswering(gate))
                            }
                        }
                        .listStyle(.carousel)
                    }
                }
                // The tick is also when the wrist asks again. A wall left open
                // while the phone sleeps would otherwise age out and stay aged
                // out: nothing else on this screen ever reaches the phone.
                .onChange(of: context.date) { _, now in
                    store.askIfSnapshotIsAging(at: now)
                }
            }
            .navigationTitle("Drover")
            // Authorization for the watch-local alert has to be asked from the
            // foreground — watchOS will not prompt from a background launch,
            // and without it the background buzz is accepted and dropped
            // (DROVE-62). The wall is the first thing a wrist sees.
            .onAppear { store.prepareBuzzer() }
            .navigationDestination(for: DroverGate.self) { gate in
                GateDetailView(gate: gate)
            }
            .navigationDestination(for: DroverRoute.self) { route in
                switch route {
                case .sessions: SessionListView()
                case let .detail(session): SessionDetailView(session: session)
                }
            }
            // A session row opens the CONVERSATION (DROVE-91): the transcript
            // is what Clay raises his wrist for, and the flip and the facts
            // are one more tap from there.
            .navigationDestination(for: DroverSession.self) { session in
                TranscriptView(session: session)
            }
            // Raising a wrist is the moment the answer has to be current, and
            // activation only fires on the first launch — a watch app resumed
            // from the dock is already activated and would have shown whatever
            // it was holding when it was put away (DROVE-22). The floor stops
            // a flick in and out of the app waking the phone repeatedly.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { store.askPhoneForSnapshot(notMoreOftenThan: 5) }
            }
            .toolbar {
                // The flip surface hangs off the gate wall rather than being a
                // second tab: gates are what the wrist is FOR, and a tab bar
                // costs a row of pixels on every screen to reach something
                // used far less often.
                //
                // A Label, not a bare Image: the toolbar elides the text, but
                // the title is what VoiceOver reads, and a bare symbol left it
                // announcing the SF Symbol name (DROVE-7). The glyph is the
                // same `terminal` the Sessions empty state shows, so the door
                // and the room match. It used to be the circlepath arrows,
                // which read as sync, and the watch has nothing to sync: no
                // refresh message exists on the wire, snapshots are pushed.
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: DroverRoute.sessions) {
                        Label("Sessions", systemImage: "terminal")
                    }
                }
            }
        }
    }
}

/// "Nothing waiting" is a claim about RIGHT NOW, and there are three ways the
/// wrist can be in no position to make it: the phone was never feeding this
/// watch, the wrist is still asking it, and the ask came back with nothing
/// newer. Only the fourth case is all-clear.
private struct EmptyStateView: View {
    let connected: Bool
    let freshness: DroverFreshness
    let updatedAt: Date
    let lastError: String?

    private var clear: Bool { connected && freshness == .fresh }

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(clear ? .green : .secondary)
            Text(headline)
                .font(.headline)
                .multilineTextAlignment(.center)
            if !connected {
                Text("Open Cattle Drover on your phone")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            } else if case let .stale(reason) = freshness {
                // The age, not a vague "maybe out of date": how long the phone
                // has been quiet is the whole of what the wrist knows, and 40
                // seconds and 40 minutes mean very different things.
                UpdatedAgo(updatedAt: updatedAt)
                // And WHY, when WatchConnectivity said. "Out of date" with no
                // reason is what Clay was reading every morning; it now only
                // appears after the phone was asked, so what the ask hit
                // belongs on screen next to it.
                if let reason {
                    Text(reason)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            if let lastError {
                Text(lastError)
                    .font(.system(size: 9))
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
    }

    private var symbol: String {
        if !connected { return "wifi.slash" }
        switch freshness {
        case .fresh: return "checkmark.circle"
        case .asking: return "arrow.clockwise"
        case .stale: return "clock.badge.exclamationmark"
        }
    }

    /// "Out of date" is now a verdict, not a stopwatch reading.
    ///
    /// It used to be `connected && 180s elapsed`, and the phone is suspended
    /// within seconds of going in a pocket, so that was the steady state rather
    /// than a fault — Clay looks at the wrist precisely when he is not holding
    /// the phone, so the failure message was the only one he ever saw. The
    /// wrist now ASKS (GateStore.refresh) and says out of date when the ask
    /// came back empty.
    private var headline: String {
        if !connected { return "Not connected" }
        switch freshness {
        case .fresh: return "Nothing waiting"
        // Not "Out of date". The wrist has woken the phone and is waiting on
        // it, which takes about a second — saying the list is stale during
        // that second is the accusation this whole ticket is about.
        case .asking: return "Asking your phone"
        case .stale: return "Out of date"
        }
    }
}

/// The phone was asked and brought back nothing newer. Shown above the gates
/// rather than instead of them: the list is probably still right, it just
/// cannot be relied on.
struct StaleRow: View {
    let updatedAt: Date
    /// What WatchConnectivity said, where it said anything.
    let reason: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Label("May be out of date", systemImage: "clock.badge.exclamationmark")
                .font(.caption2)
                .foregroundStyle(.yellow)
            UpdatedAgo(updatedAt: updatedAt)
            if let reason {
                Text(reason)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// `Text(_:style: .relative)` counts up on its own, so the age stays honest
/// between snapshots without anything having to re-render the row.
private struct UpdatedAgo: View {
    let updatedAt: Date

    var body: some View {
        HStack(spacing: 3) {
            Text("phone last spoke")
            Text(updatedAt, style: .relative)
            Text("ago")
        }
        .font(.system(size: 9))
        .foregroundStyle(.secondary)
    }
}

/// One line of trouble at the top of a list. `lastError` is written in five
/// places in GateStore and was, until this, rendered in none — a failed answer
/// looked exactly like a successful one, and a failed flip like a flip.
///
/// Not private: the sessions screen shows the same banner, because two of those
/// five writes happen on the flip path and that screen is where you are
/// standing when they do.
struct BannerRow: View {
    let text: String
    let symbol: String
    let tint: Color

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.caption2)
            .foregroundStyle(tint)
            .padding(.vertical, 2)
    }
}

private struct GateRow: View {
    let gate: DroverGate
    /// Answered from this wrist, still listed by the phone.
    let sent: Bool

    /// One glyph per kind the bus emits. A question and a permission need
    /// telling apart at a glance because they take different answers, idle and
    /// expiry are not gates on an action at all, and a to-do is a job for you
    /// rather than a decision — green, because nothing is being held up by a
    /// choice you have not made yet.
    private var symbol: (name: String, tint: Color) {
        switch gate.classification {
        case .question: return ("questionmark.bubble", .blue)
        case .permission, .unknown: return ("exclamationmark.shield", .orange)
        case .idle: return ("hourglass", .secondary)
        case .expiry: return ("clock.badge.exclamationmark", .yellow)
        case .todo: return ("checklist", .green)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: sent ? "paperplane" : symbol.name)
                    .font(.caption2)
                    .foregroundStyle(sent ? Color.secondary : symbol.tint)
                Text(gate.title)
                    .font(.caption)
                    .lineLimit(1)
            }
            Text(gate.preview)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 4) {
                if let account = gate.account {
                    Text(account)
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
                // The card does not vanish on a tap any more, so it has to say
                // what happened to it. "sent" is the honest word: the answer
                // left this watch, and the phone has not yet retired the gate.
                if sent {
                    Text("sent")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .opacity(sent ? 0.5 : 1)
    }
}
