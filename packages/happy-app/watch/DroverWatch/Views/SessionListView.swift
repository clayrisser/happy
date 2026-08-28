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
        }
        .padding(.vertical, 2)
    }
}

/// Pick where the session goes. "Next with headroom" is first because it is
/// the answer that does not need Clay to remember which account is cooling —
/// the CLI holds the ledger and decides.
struct SessionFlipView: View {
    let session: DroverSession
    @EnvironmentObject private var store: GateStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(session.title)
                    .font(.headline)
                    .lineLimit(2)
                if let account = session.account {
                    Text("on \(account)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Button {
                    store.flip(session)
                    dismiss()
                } label: {
                    Label("Next with headroom", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption)
                }
                .tint(.orange)

                ForEach(store.accounts.filter { $0 != session.account }, id: \.self) { account in
                    Button {
                        store.flip(session, to: account)
                        dismiss()
                    } label: {
                        Label(account, systemImage: "person.crop.circle")
                            .font(.caption)
                    }
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("Flip")
    }
}
