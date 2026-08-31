import SwiftUI

/// The conversation of one session, newest at the bottom, replies arriving as
/// they are written (DROVE-91).
///
/// Everything drawn here was folded by the phone: a run of tool calls is
/// already one `tools` row reading the way the phone's own list reads it
/// (DROVE-84), and every row is already cut to wrist size with a "more on
/// the phone" tail. This screen tells the phone which session it is looking
/// at, draws what comes back, and follows the bottom while a reply streams.
///
/// The gates that are waiting on this session sit at the top as their own
/// section, and a gate row inside the conversation opens the same
/// GateDetailView the wall opens, so a question is answerable where it was
/// asked. The session's facts and its flip buttons are behind the toolbar
/// button, which is what a session row used to open outright.
struct TranscriptView: View {
    let session: DroverSession
    @EnvironmentObject private var store: GateStore
    @Environment(\.scenePhase) private var scenePhase

    /// The id the view scrolls to: the streaming row while there is one, else
    /// the last row.
    private static let bottomAnchor = "transcript-bottom"

    private var transcript: DroverTranscript? { store.transcript(for: session.id) }

    /// Gates the phone lists for THIS session. Gate ids are
    /// `${sessionId}:${requestId}` (droverWatchFeed.ts), and a session id
    /// never contains a colon, so the prefix is the session.
    private var waiting: [DroverGate] {
        store.gates.filter { $0.id.hasPrefix("\(session.id):") }
    }

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 30)) { context in
            let freshness = store.freshness(at: context.date)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        if let message = store.lastError {
                            BannerRow(text: message, symbol: "exclamationmark.triangle", tint: .red)
                        }
                        if case let .stale(reason) = freshness {
                            StaleRow(updatedAt: store.snapshot.updatedAt, reason: reason)
                        }
                        // The gate wall for this session, first: a question
                        // waiting on you outranks reading how it got there.
                        if !waiting.isEmpty {
                            Text("Waiting on you")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.secondary)
                            ForEach(waiting) { gate in
                                NavigationLink(value: gate) {
                                    GateLine(gate: gate, sent: store.isAnswering(gate))
                                }
                                .disabled(store.isAnswering(gate))
                            }
                            Divider()
                        }
                        if let transcript, !transcript.rows.isEmpty {
                            ForEach(transcript.rows) { row in
                                TranscriptRowView(row: row, gate: store.gate(withId: row.gateId))
                                    .id(row.id)
                            }
                            if transcript.streaming {
                                StreamingRow()
                            }
                        } else {
                            WaitingForRows(connected: store.snapshot.connected, freshness: freshness)
                        }
                        // What the wrist has said and not yet sent, under the
                        // conversation and above the anchor, so it is the last
                        // thing on screen and the auto-scroll lands on it
                        // (DROVE-130).
                        WristDraftBar(session: session)
                        // A zero-height anchor under everything, so scrolling
                        // "to the bottom" is one id whatever the last row is.
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomAnchor)
                    }
                    .padding(.horizontal, 4)
                }
                .onAppear {
                    proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                }
                // Follow the bottom while a reply is being written, and jump
                // there when a row lands. A wrist reading history is not
                // dragged down by a heartbeat: the rows have to have changed.
                .onChange(of: transcript?.rows) { _, _ in
                    withAnimation { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
                }
                .onChange(of: transcript?.streaming) { _, streaming in
                    if streaming == true {
                        withAnimation { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
                    }
                }
            }
            .onChange(of: context.date) { _, now in
                store.askIfSnapshotIsAging(at: now)
            }
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: DroverRoute.detail(session)) {
                    Label("Session", systemImage: "info.circle")
                }
            }
            // Talk to the session from the wrist (DROVE-92). Tap to dictate:
            // `TextFieldLink` opens watchOS's own input sheet, where
            // dictation is one tap away beside the keyboard and Scribble, the
            // same path GateDetailView answers a question by (DROVE-55).
            // watchOS gives no hold gesture on that control and no in-app
            // recogniser to hold open, so there is no push-to-talk here. What
            // there IS, since DROVE-130, is a LATCH: the sheet closes on Done
            // and the phrase joins a draft that stays open, so the next thing
            // said is added rather than replacing what came before.
            ToolbarItem(placement: .bottomBar) {
                SayLink(session: session)
            }
        }
        .onAppear { store.watchTranscript(of: session.id) }
        // A push on top of this screen (a gate, the session's facts) is a
        // disappear too, and the pop back is an appear, so the phone is told
        // "closed" and then "opened" around it. Cheap: an open costs one
        // round of rows, and it keeps the rule one line long.
        .onDisappear {
            if store.openedSessionId == session.id { store.watchTranscript(of: nil) }
        }
        // Reachability comes back with the foreground, and the phone sends
        // every row afresh on an open, so say it again.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.watchTranscript(of: session.id) }
        }
    }
}

/// The mic, latched (DROVE-130).
///
/// A tap opens watchOS's input sheet and what comes back is KEPT rather than
/// sent: the draft stays on the wrist with the mic still armed, another tap
/// appends the next phrase, Send sends the lot, Clear throws it away. That is
/// the phone's gesture table (DROVE-105, DROVE-140) as far as watchOS allows
/// it — see WristDraft for why the recorder itself cannot be held open, which
/// comes down to Speech.framework not existing in the watchOS SDK at all.
///
/// The important half is the append. DROVE-140's second fault was that
/// speaking again after a silence OVERWROTE what came before, and that is
/// exactly what the wrist did: every sheet started from empty and the last
/// phrase was the whole message. Every sheet return is its own recognition, so
/// every return appends — the same rule, keyed on the task rather than on
/// comparing strings, with the sheet standing in for the task.
///
/// One control, used from the transcript's bottom bar and from the session's
/// facts screen, so both places accumulate into the one draft on the store
/// rather than each holding their own.
struct SayLink: View {
    let session: DroverSession
    @EnvironmentObject private var store: GateStore

    private var draft: WristDraft { store.draft(for: session.id) }

    var body: some View {
        TextFieldLink(prompt: Text("Say to \(session.title)")) {
            // The label says what the tap DOES, and after the first phrase
            // that is "add", not "dictate": the draft is already open and the
            // sheet is how you keep talking into it.
            Label(draft.isEmpty ? "Dictate" : "Add", systemImage: "mic.fill")
                .font(.caption)
        } onSubmit: { said in
            store.addToDraft(session, heard: said)
        }
        .tint(draft.isEmpty ? .green : .orange)
    }
}

/// What has been said so far and has not gone anywhere (DROVE-130).
///
/// The visible half of the latch. Without it the wrist would be holding a
/// message with nothing on screen saying so, which is the failure the phone's
/// live banner exists to prevent. It shows the words, how many times the sheet
/// has been opened for them, and the two ways out: Send, and Clear.
///
/// Clear is the wrist's cancel. The phone cancels by sliding the finger off
/// the button, which a watch cannot express, so the discard is a visible
/// button — the one thing DROVE-130 asked for explicitly on top of the latch.
struct WristDraftBar: View {
    let session: DroverSession
    @EnvironmentObject private var store: GateStore

    private var draft: WristDraft { store.draft(for: session.id) }

    var body: some View {
        if !draft.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(.orange)
                    Text(draft.count == 1 ? "1 phrase" : "\(draft.count) phrases")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
                Text(draft.text)
                    .font(.caption2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(4)
                HStack(spacing: 6) {
                    Button {
                        store.sendDraft(session)
                    } label: {
                        Label("Send", systemImage: "paperplane.fill")
                            .font(.system(size: 11))
                    }
                    .tint(.green)
                    Button {
                        store.clearDraft()
                    } label: {
                        Label("Clear", systemImage: "trash")
                            .font(.system(size: 11))
                    }
                    .tint(.red)
                }
                // The undo, one level deep and no more: dictation mishears the
                // last thing said far more often than the first, and re-saying
                // one phrase should not mean re-saying the paragraph.
                Button {
                    store.undoLastPhrase()
                } label: {
                    Label("Undo last", systemImage: "arrow.uturn.backward")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(6)
            .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// One row of the conversation, styled by who it is from (DROVE-91).
///
/// User on the right in the accent, assistant on the left plain, tool runs
/// small and monospaced with the terminal glyph, and a gate as the same card
/// the wall draws, tappable into GateDetailView while it is still pending.
private struct TranscriptRowView: View {
    let row: DroverTranscriptRow
    /// The pending gate this row stands for, when the phone still lists it.
    let gate: DroverGate?

    var body: some View {
        switch row.classification {
        case .user:
            HStack {
                Spacer(minLength: 24)
                Text(row.text)
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    .background(Color.accentColor.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
                    .multilineTextAlignment(.trailing)
            }
        case .assistant, .unknown:
            HStack(alignment: .top, spacing: 3) {
                Text(row.text)
                    .font(.caption2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if row.isStreaming {
                    StreamingDots()
                }
            }
        case .tools:
            HStack(alignment: .top, spacing: 4) {
                Image(systemName: "terminal")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                Text(row.text)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                if row.isStreaming {
                    ProgressView()
                        .controlSize(.mini)
                }
            }
        case .gate:
            if let gate {
                NavigationLink(value: gate) {
                    GateLine(gate: gate, sent: false)
                }
            } else {
                // Answered already, on some surface. The line stays so the
                // conversation still reads, greyed so it does not look live.
                HStack(alignment: .top, spacing: 4) {
                    Image(systemName: "checkmark.shield")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                    Text(row.text)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
        }
    }
}

/// A gate as one line, inside the conversation or in the section above it.
private struct GateLine: View {
    let gate: DroverGate
    let sent: Bool

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
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: sent ? "paperplane" : symbol.name)
                    .font(.caption2)
                    .foregroundStyle(sent ? Color.secondary : symbol.tint)
                Text(gate.title)
                    .font(.caption2)
                    .lineLimit(1)
            }
            if !gate.preview.isEmpty {
                Text(gate.preview)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(symbol.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        .opacity(sent ? 0.5 : 1)
    }
}

/// The row under the last one while the turn is running: the reply is on its
/// way, whatever the last row was.
private struct StreamingRow: View {
    var body: some View {
        HStack(spacing: 4) {
            StreamingDots()
            Text("writing")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
        }
    }
}

/// Three dots that breathe. The streaming indicator, on the row being written
/// and on the trailing row.
private struct StreamingDots: View {
    @State private var on = false

    var body: some View {
        Text("…")
            .font(.caption)
            .foregroundStyle(.secondary)
            .opacity(on ? 1 : 0.3)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                    on = true
                }
            }
    }
}

/// Nothing to draw yet. Which of the three reasons is what the line says.
private struct WaitingForRows: View {
    let connected: Bool
    let freshness: DroverFreshness

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: connected ? "text.bubble" : "wifi.slash")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(headline)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
    }

    private var headline: String {
        if !connected { return "Open Cattle Drover on your phone" }
        switch freshness {
        case .fresh, .asking: return "Waiting for the phone"
        case .stale: return "Out of date; the phone has not sent this session"
        }
    }
}
