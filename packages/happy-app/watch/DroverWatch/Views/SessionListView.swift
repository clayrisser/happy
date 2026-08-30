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
                Circle()
                    .fill(session.active ? .green : .secondary)
                    .frame(width: 6, height: 6)
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
                    Text("flipping…")
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

                ForEach(store.accounts.filter { $0 != session.account }, id: \.self) { account in
                    Button {
                        store.flip(session, to: account)
                        dismiss()
                    } label: {
                        Label(account, systemImage: "person.crop.circle")
                            .font(.caption)
                    }
                    .disabled(flipping)
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("Session")
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Circle()
                    .fill(session.active ? .green : .secondary)
                    .frame(width: 6, height: 6)
                Text(session.active ? "running" : "idle")
                    .font(.caption2)
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
                Text(subagents == 1 ? "1 subagent" : "\(subagents) subagents")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            // The same line the row shows, at detail size (DROVE-54).
            if let status = session.status {
                LiveStatusLine(status: status, since: session.statusSince, size: 11)
            }
            if flipping {
                Text("flipping…")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
