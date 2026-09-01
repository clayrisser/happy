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
                        // What the wrist is hearing now, and what it has said
                        // and not yet sent, under the conversation and above
                        // the anchor, so it is the last thing on screen and
                        // the auto-scroll lands on it (DROVE-130).
                        WristHearingBar()
                        // And what the READING is doing, beside what the
                        // microphone is doing (DROVE-275). Same place for the
                        // same reason: it is state the wrist has to be able
                        // to see without opening anything.
                        WristReadingBar(session: session)
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
            // Talk to the session from the wrist. ONE PRESS OPENS THE
            // RECORDER AND HOLDS IT OPEN (DROVE-130): Clay talks, pauses,
            // thinks, keeps talking, and presses again to stop with every word
            // still there. The watch captures and the phone transcribes,
            // because `Speech.framework` does not exist on watchOS — see
            // `WristHearing` for the check and `WristRecorder` for the wire.
            //
            // The one-shot input sheet has NOT been removed. It is how
            // Scribble and the keyboard get in, and it is the only path that
            // works with the phone out of reach, so it sits in the voice bar
            // below as `SayLink`. What changed is which one is the primary
            // gesture.
            ToolbarItem(placement: .bottomBar) {
                WristMicButton(session: session)
            }
            // And pause the reading from the wrist (DROVE-275). Beside the
            // mic rather than in the scroll view because a transport control
            // has to be reachable without finding it: this is the surface he
            // reaches for with a phone in a pocket.
            ToolbarItem(placement: .bottomBar) {
                WristReadingButton(session: session)
            }
        }
        .onAppear { store.watchTranscript(of: session.id) }
        // A push on top of this screen (a gate, the session's facts) is a
        // disappear too, and the pop back is an appear, so the phone is told
        // "closed" and then "opened" around it. Cheap: an open costs one
        // round of rows, and it keeps the rule one line long.
        .onDisappear {
            // A LATCH MUST NOT OUTLIVE THE SCREEN THAT SHOWS IT (DROVE-130).
            // The listening bar lives on this view, so a push to a gate or a
            // pop back to the wall would leave the microphone open with
            // nothing on screen saying so — a hot mic, which is the one real
            // hazard a latch has. Stopping KEEPS every word: they go to the
            // draft, which survives the screen going away.
            store.stopListening()
            if store.openedSessionId == session.id { store.watchTranscript(of: nil) }
        }
        // Reachability comes back with the foreground, and the phone sends
        // every row afresh on an open, so say it again.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.watchTranscript(of: session.id) }
            // The wrist dropped, or a notification took the front. watchOS is
            // about to take the microphone away anyway; stopping here means
            // the button says so, rather than sitting on "Stop" over a
            // recorder the OS already closed.
            if phase != .active { store.stopListening() }
        }
    }
}

/// The one-shot input sheet, kept as the SECOND way in (DROVE-130).
///
/// This was the primary gesture until the wrist got a real recorder, and it is
/// still the only one that works with the phone out of reach, because the
/// phone is what does the transcribing now. It is also the only way to
/// Scribble or type, which dictation cannot replace: a word the recogniser
/// keeps getting wrong has to be spellable.
///
/// What it hands back joins the SAME draft the recorder banks into, so Send,
/// Clear and Undo do not care which way the words arrived.
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

/// The recorder, held open by one press (DROVE-130).
///
/// The whole point of the ticket, and the thing the first pass could not do.
/// Tap once and the microphone opens and STAYS open; tap again and it stops
/// with every word kept. There is no hold-to-talk because a watch offers no
/// gesture that survives the wrist dropping, and no press-and-hold on a
/// toolbar button; the latch is the ergonomic that suits a wrist anyway, and
/// it is the one the phone already has (DROVE-105).
///
/// STOPPING NEVER SENDS. It banks the words into the draft to be read and sent
/// deliberately, which is the phone's rule that only a lift sends — and the
/// wrist has no lift, so nothing here sends by itself.
struct WristMicButton: View {
    let session: DroverSession
    @EnvironmentObject private var store: GateStore

    var body: some View {
        Button {
            store.toggleMic(session)
        } label: {
            Label(
                store.listening ? "Stop" : "Listen",
                systemImage: store.listening ? "stop.circle.fill" : "mic.fill"
            )
            .font(.caption)
        }
        .tint(store.listening ? .red : .green)
    }
}

/// Pause and resume the phone's reading, from the wrist (DROVE-275).
///
/// Clay: "getting it to stream you know kind of like a live playing video or
/// something like that where I can play and pause". The lock screen and the
/// headphones have had this since DROVE-233; the wrist had no half of it at
/// all — no state on the wire, no handler in either direction — and a wrist
/// is the surface actually on him while the phone is in a pocket.
///
/// PRESENT ONLY WHILE THE READER IS ON, AND ONLY ON ITS SESSION. Read-aloud
/// off means no `reading` on the snapshot and therefore no button, which is
/// the same rule as the lock screen's card (`setReadingState`), and it is
/// what keeps this from being a control that does nothing. It never turns
/// read-aloud ON either: DROVE-189 settled that a press from a pocket must
/// not start a voice for a session he walked away from.
///
/// UNTINTED, deliberately. WristPalette keeps exactly two signal colours and
/// says a third is a decision; the glyph itself is the state, which is what a
/// transport control does everywhere else on the phone.
struct WristReadingButton: View {
    let session: DroverSession
    @EnvironmentObject private var store: GateStore

    var body: some View {
        if let reading = store.snapshot.reading, reading.applies(to: session.id) {
            Button {
                store.setReadingPaused(!reading.isPaused)
            } label: {
                Label(
                    reading.isPaused ? "Resume" : "Pause",
                    systemImage: reading.isPaused ? "play.fill" : "pause.fill"
                )
                .font(.caption)
            }
        }
    }
}

/// Whether the phone is reading this session out loud, and whether it is held
/// (DROVE-275).
///
/// The button above says which press is OFFERED, which is not the same as
/// saying what is happening — "Resume" and a reader that is off look identical
/// if the button is the only evidence. This is the evidence. It is the same
/// argument WristHearingBar makes for the microphone and it sits next to it.
struct WristReadingBar: View {
    let session: DroverSession
    @EnvironmentObject private var store: GateStore

    var body: some View {
        if let reading = store.snapshot.reading, reading.applies(to: session.id) {
            HStack(spacing: 4) {
                Image(systemName: reading.isPaused ? "pause.fill" : "waveform")
                    .font(.system(size: 9))
                Text(reading.isPaused ? "Paused" : "Reading")
                    .font(.system(size: 9, weight: .semibold))
                Spacer(minLength: 4)
            }
            .foregroundStyle(reading.isPaused ? .secondary : .primary)
            .padding(6)
            .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// What the phone is hearing while the recorder is open (DROVE-130).
///
/// A latch can be left hot, so this is deliberately unmissable: the words as
/// they arrive, a level meter that proves the microphone is live rather than
/// merely believed to be, and a Cancel. Without it the wrist would be
/// recording with nothing on screen saying so, which is the failure the
/// phone's live banner exists to prevent.
struct WristHearingBar: View {
    @EnvironmentObject private var store: GateStore

    var body: some View {
        if store.listening {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(.red)
                    Text("Listening")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.red)
                    Spacer(minLength: 4)
                    MicLevel(level: store.micLevel)
                }
                // Before the first partial there is nothing to draw, and a
                // blank box reads as a microphone that is not working. Say
                // which it is.
                Text(store.hearing.isEmpty ? "Say something…" : store.hearing.text)
                    .font(.caption2)
                    .foregroundStyle(store.hearing.isEmpty ? .secondary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(4)
                Button(role: .destructive) {
                    store.cancelListening()
                } label: {
                    Label("Discard", systemImage: "xmark")
                        .font(.system(size: 10))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.red)
            }
            .padding(6)
            .background(Color.red.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Five bars that fill with the input level. Not decoration: it is the only
/// evidence on the wrist that the microphone is open and hearing, since there
/// is no system sheet and no waveform.
private struct MicLevel: View {
    let level: Double

    var body: some View {
        HStack(spacing: 1) {
            ForEach(0..<5, id: \.self) { step in
                Capsule()
                    .fill(level * 5 > Double(step) ? Color.red : Color.secondary.opacity(0.3))
                    .frame(width: 2, height: 4 + CGFloat(step) * 2)
            }
        }
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
                // Scribble and the keyboard, for the word the recogniser keeps
                // getting wrong. Adds to this same draft.
                SayLink(session: session)
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
