import SwiftUI

/// The other half of driving from the wrist (BASED-98): moving a session onto
/// a different Claude account without going near a keyboard.
///
/// Answering a gate unblocks a session that is waiting on a human. This is
/// what you reach for when the session is not waiting on you at all — the
/// account it is running on has run out, and the work should carry on
/// somewhere with headroom. Same `/flip` the phone and a tmux key binding
/// send; the wrist is just the fastest way to say it.
struct SessionListView: View {
    @EnvironmentObject private var store: GateStore

    var body: some View {
        Group {
            if store.sessions.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "terminal")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("No sessions")
                        .font(.headline)
                    Text("Start one with `drover` on your Mac")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            } else {
                List {
                    // A flip that could not be sent clears its own "flipping…"
                    // mark and otherwise leaves no trace, so without this the
                    // tap simply looked ignored.
                    if let message = store.lastError {
                        BannerRow(text: message, symbol: "exclamationmark.triangle", tint: .red)
                    }
                    // What is left, above the list of what is running
                    // (DROVE-131). This screen is where a flip is decided, and
                    // "which account has room" is the question the flip is an
                    // answer to, so the glance belongs at the top of it rather
                    // than behind a menu somewhere else.
                    if let headroom = store.snapshot.currentAccount {
                        HeadroomLink(account: headroom)
                    }
                    ForEach(store.sessions) { session in
                        NavigationLink(value: session) {
                            SessionRow(session: session, flipping: store.flipping.contains(session.id))
                        }
                    }
                }
                .listStyle(.carousel)
            }
        }
        .navigationTitle("Sessions")
    }
}

private struct SessionRow: View {
    let session: DroverSession
    let flipping: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                StateDot(session: session)
                // The name the PHONE shows, verbatim (DROVE-127). The wrist
                // used to be handed the working directory basename instead, so
                // the same session read `cattle-drover` here and `DROVER` on
                // the phone. Nothing is derived on this side any more.
                Text(session.title)
                    .font(.caption)
                    .lineLimit(1)
            }
            HStack(spacing: 4) {
                if let account = session.account {
                    Text(account)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.orange)
                }
                if flipping {
                    Text("switching…")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
            }
            // What it is DOING, not just that it is on (DROVE-54). One line,
            // and only while there IS something — an idle session looks
            // exactly as it did before this row existed.
            if let status = session.status {
                LiveStatusLine(status: status, since: session.statusSince, size: 9)
            }
        }
        .padding(.vertical, 2)
    }
}

/// The dot beside a session, in the phone's colour for the phone's state
/// (DROVE-129).
///
/// It used to be green-or-grey off `active`, which is whether the process is
/// alive. The phone's list draws five colours off `resolveSessionState`, and
/// the wrist now draws the same five off the answer the phone sends, so one
/// glance means the same thing on both.
private struct StateDot: View {
    let session: DroverSession

    /// The pulse, driven by the view rather than by a timer, so it costs
    /// nothing while nothing is running (DROVE-257).
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(Color(hex: session.dotTint))
            .frame(width: 6, height: 6)
            // THE SAME TWO SECONDS AS THE PHONE. `STATUS_DOT_BLINK_MS` is
            // 2000 and the fade reaches 0.3, never 0: a dot that vanishes
            // reads as gone. The blink says the session is BURNING TOKENS
            // RIGHT NOW — blue is its turn, purple is the compaction pass —
            // so a wrist that pulsed on a different rhythm would be a second
            // dialect of a vocabulary Clay wrote once.
            .opacity(session.dotBlinks && dim ? 0.3 : 1)
            .animation(
                session.dotBlinks
                    ? .easeInOut(duration: 1).repeatForever(autoreverses: true)
                    : .default,
                value: dim
            )
            .onAppear { dim = session.dotBlinks }
            .onChange(of: session.dotBlinks) { _, blinks in dim = blinks }
            .accessibilityLabel(session.resolvedDot?.label ?? session.resolvedState.label)
    }
}

extension Color {
    /// `RRGGBB`. Only ever fed SessionState.tintHex, which is why a malformed
    /// string falls back to secondary rather than throwing: a colour is not
    /// worth blanking a row for.
    init(hex: String) {
        var value: UInt64 = 0
        guard hex.count == 6, Scanner(string: hex).scanHexInt64(&value) else {
            self = .secondary
            return
        }
        self = Color(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

/// The one live line, with a clock the wrist runs itself.
///
/// `Text(_:style:.timer)` counts up on-device from the date the phone sent, so
/// the number is right between deliveries. The alternative — the phone baking
/// in "17m 13s" — is wrong by however long the application context took to
/// arrive, and that is delivered opportunistically with a once-a-minute
/// heartbeat behind it.
private struct LiveStatusLine: View {
    let status: String
    let since: Date?
    let size: CGFloat

    var body: some View {
        HStack(spacing: 4) {
            Text(status)
                .font(.system(size: size))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            if let since {
                Text(since, style: .timer)
                    .font(.system(size: size, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

/// One session: what it is, and where it can go next (BASED-98).
///
/// The facts come first because the wrist is what you look at when you cannot
/// see the terminal — which project, where it is checked out, is it moving,
/// whose account, how many subagents are out. Then the flip, and "next with
/// headroom" leads it because that is the answer that does not need Clay to
/// remember which account is cooling: the CLI holds the ledger and decides.
///
/// Flipping goes through `GateStore.flip`, the same call the row list and the
/// phone reach, so there is one flip path and not a second one to keep in step.
struct SessionDetailView: View {
    let session: DroverSession
    @EnvironmentObject private var store: GateStore
    @Environment(\.dismiss) private var dismiss

    private var flipping: Bool { store.flipping.contains(session.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(session.title)
                    .font(.headline)
                    .lineLimit(2)
                if let path = session.path {
                    // Truncated at the HEAD: the tail of a working directory is
                    // the half that says which checkout, and it is the half a
                    // 40mm screen would otherwise drop.
                    Text(path)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }

                facts

                // Dictate a message to this session from its facts screen
                // too (DROVE-92): the same control the transcript's bottom
                // bar carries, so the mic is wherever the session is. And
                // since DROVE-130 the draft comes with it — the phrases
                // accumulate on the store, not in either screen, so walking
                // from the transcript to here mid-sentence does not lose it.
                SayLink(session: session)
                WristDraftBar(session: session)

                // What this session is working through (DROVE-167). A link
                // rather than the list itself: the facts screen is already a
                // scroll, and a seven-line task list under the flip buttons
                // would push them off the bottom of a 40mm screen.
                if session.hasTasks {
                    NavigationLink(value: DroverRoute.sessionTasks(session)) {
                        Label(session.taskHeadline, systemImage: "checklist")
                            .font(.caption)
                    }
                }

                Button {
                    store.flip(session)
                    dismiss()
                } label: {
                    // Left-right arrows, not the circlepath pair: that glyph
                    // also opened the Sessions list, so one symbol meant two
                    // things two screens apart (DROVE-7). A flip moves the
                    // session sideways onto another account, which is what
                    // this one draws.
                    Label("Next with headroom", systemImage: "arrow.left.arrow.right")
                        .font(.caption)
                }
                .tint(.orange)
                .disabled(flipping)

                // Most headroom first, with the figure on the button (DROVE-28's
                // watch half). A bare list of names could only ever offer an
                // account something is already running on, which is the
                // opposite of what a flip wants — the one worth moving to is
                // the one with room, and a name does not carry that.
                ForEach(store.accountRows.filter { $0.name != session.account }) { account in
                    Button {
                        store.flip(session, to: account.name)
                        dismiss()
                    } label: {
                        AccountLabel(account: account)
                    }
                    // An account that is not logged in cannot take the session,
                    // so the tap is refused here rather than by a flip that
                    // bounces a minute later on the Mac.
                    .disabled(flipping || account.loggedIn == false)
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("Session")
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                StateDot(session: session)
                // The phone's own word, not "running"/"idle" (DROVE-129).
                // `active` says whether the PROCESS is up; the phone's list
                // answers a different question with its dot, and a session
                // sitting on a permission prompt is the case where the two
                // used to disagree most loudly.
                //
                // The DOT's word when the phone sent one (DROVE-257), because
                // otherwise a compacting session reads `working` beside a
                // purple dot and the line contradicts the thing next to it.
                Text(session.resolvedDot?.label ?? session.resolvedState.label)
                    .font(.caption2)
                    .foregroundStyle(session.resolvedState.needsYou ? Color.orange : .primary)
            }
            if let account = session.account {
                Text("on \(account)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
            // Shown only when there ARE some: "0 subagents" is a line of noise
            // on a wrist, and a phone that predates the field sends no count
            // rather than a zero, which would read as a fact it never checked.
            if let subagents = session.subagents, subagents > 0 {
                // "agents", which is what the phone calls them everywhere it
                // counts them — the live-status line, the rig activity bar
                // (DROVE-129). "subagents" was a word only the wrist used.
                Text(subagents == 1 ? "1 agent" : "\(subagents) agents")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            // The same line the row shows, at detail size (DROVE-54).
            if let status = session.status {
                LiveStatusLine(status: status, since: session.statusSince, size: 11)
            }
            // Only when the session kept a list. "0 of 0 done" is noise, and a
            // phone that predates the key sends no counts rather than zeros.
            if session.hasTasks {
                Text(session.taskHeadline)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if flipping {
                Text("switching…")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}


/// An account on the flip list: its name, and the number that decides whether
/// it is worth flipping to.
///
/// Headroom stays optional all the way here. An account the CLI never measured
/// shows no figure rather than a 0, which would read as "out" and hide the one
/// account with room.
private struct AccountLabel: View {
    let account: DroverAccount

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: account.loggedIn == false ? "person.crop.circle.badge.xmark" : "person.crop.circle")
                .font(.caption)
            VStack(alignment: .leading, spacing: 0) {
                Text(account.name)
                    .font(.caption)
                    .lineLimit(1)
                if let detail {
                    Text(detail)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The phone's own words, character for character (DROVE-129), naming the
    /// window the figure is about (DROVE-131).
    ///
    /// `no login`, `Back 3:26 PM`, `51% left` and `not measured` are what
    /// agentInputUsage.ts prints in the composer popup and on the session info
    /// screen. The wrist said "not logged in", lower-cased the "back", and
    /// showed nothing at all for an account nobody had measured: three
    /// different sentences for three states the phone already had names for.
    ///
    /// The window rides on the end of the percentage, because a flip decided on
    /// a bare figure cannot tell an account that is out for the next five hours
    /// from one that is out for the rest of the week. An unmeasured account
    /// still says so rather than going blank, which is DROVE-129's rule.
    private var detail: String? {
        if account.loggedIn == false { return "no login" }
        if let backAt = account.backAt, backAt > Date() {
            return "Back \(backAt.formatted(date: .omitted, time: .shortened))"
        }
        // "window reset" and "not measured" are two different nothings and the
        // picker must not print a dead percentage as if it were a live one
        // (DROVE-204). `headroomFigure` is nil for both.
        if account.isExpired { return "window reset" }
        guard let left = account.headroomFigure else { return "not measured" }
        // Spelled and with its window named, which is what lets this one line
        // count DOWN while every bar counts up (DROVE-230). A flip decided on
        // a bare figure cannot tell an account out for five hours from one out
        // for the week.
        if let limit = account.limit { return "\(left) · \(limit)" }
        return left
    }
}
