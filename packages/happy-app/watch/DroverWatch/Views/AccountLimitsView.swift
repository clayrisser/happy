import SwiftUI

/// One account, every window (DROVE-339).
///
/// Clay: "on the watch app, when I select a specific account to see the limit,
/// it should actually show the full breakdown of all the limits, just like it
/// shows in the mobile app."
///
/// WHAT THE LIMITS SCREEN IS, AND WHY THIS IS SEPARATE. DROVE-131 folded five
/// accounts times three windows down to one bar each, and that fold is still
/// right for the screen you raise your wrist to: the binding limit is the whole
/// of "can I still work", and fifteen rows is a table you read rather than a
/// fact you see. What it had no answer for is the next question — "why" — and
/// the phone answers that a pocket away. So the glance keeps its one bar, and
/// SELECTING an account opens the rest here. One account at a time, which is
/// the only way three windows and their reset times fit a 41mm screen.
///
/// THE PHONE OWNS EVERY FIGURE ON THIS SCREEN. The percentage, the band, the
/// heading sentence and the words behind each row are `usageAccountBarGroup`'s,
/// evaluated on the phone and sent (DROVE-129). Nothing here ranks, converts or
/// re-words anything: the wrist cannot import that TypeScript, and this binary
/// ships through TestFlight where a drift could not be corrected OTA. The rows
/// below are `ForEach` over what arrived.
///
/// LOOKED UP BY NAME, not pushed as a value. The route carries the account's
/// name and the block is re-read from the store on every publish, so a window
/// that turns over while the screen is open updates under Clay rather than
/// freezing at the moment he tapped. That is the whole point of opening it.
struct AccountLimitsView: View {
    let name: String
    @EnvironmentObject private var store: GateStore
    @Environment(\.dismiss) private var dismiss

    private var account: DroverAccount? {
        store.accountRows.first { $0.name == name }
    }

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 60)) { context in
            ScrollView {
                if let account {
                    VStack(alignment: .leading, spacing: 8) {
                        // The sentence the phone puts over its block, which is
                        // the one line that says WHICH nothing an account with
                        // no figure is in. Two lines of room: names run long
                        // and `promanagerdevteam · 2% left on Session` does
                        // not fit one on a 41mm.
                        Text(account.heading(at: context.date))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                        if account.limitRows.isEmpty {
                            NoWindows(account: account)
                        } else {
                            ForEach(account.limitRows) { limit in
                                LimitWindowRow(limit: limit)
                            }
                        }
                        SwitchHere(account: account, dismiss: dismiss)
                    }
                    .padding(.horizontal, 4)
                } else {
                    // The registry moved under the screen: an account removed
                    // on the Mac, or a phone that has since sent rows without
                    // it. Says so rather than drawing the last thing it saw.
                    Gone(name: name)
                }
            }
            .onChange(of: context.date) { _, now in
                store.askIfSnapshotIsAging(at: now)
            }
        }
        .navigationTitle(name)
    }
}

/// One window: its name, its percentage, its bar, and when it comes back.
///
/// The same three facts the phone's row carries and in the same order, folded
/// to one column because a wrist has no width for a name column, a track and a
/// trailing slot side by side. The bar goes under the words rather than
/// between them, which is what `WristLimitBar` already does on the Limits
/// screen — so the two screens draw one picture of a quota, not two.
private struct LimitWindowRow: View {
    let limit: DroverAccountLimit

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(limit.label)
                    .font(.system(size: 12, weight: limit.isBinding ? .semibold : .regular))
                    .lineLimit(1)
                // WHICH window is actually stopping the work (DROVE-230). The
                // phone marks it on the row because its heading names it and
                // the two would otherwise look like a contradiction; the same
                // holds here, where the heading right above says "2% left on
                // Session" over three rows that all have numbers.
                if limit.isBinding {
                    Text("binding")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                // Percent USED, like every other figure on this wrist. The
                // word is not repeated per row: the column teaches its own
                // direction, which is the same call the phone's sheet makes
                // and the reason the Limits screen spells it only once.
                Text(limit.figure)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(limit.isMeasured
                        ? WristGlyph.colour(WristGlyph.signal(for: limit.band))
                        : Color.secondary)
            }
            WindowBar(limit: limit)
                .frame(height: 5)
            if let trailing = limit.trailing, !trailing.isEmpty {
                // The phone's own words, never a second set: "Resets 6 PM",
                // "window reset", "Week spent". A row with no figure is
                // explained by this line and by nothing else on the screen.
                Text(trailing)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spoken)
    }

    private var spoken: String {
        var parts = [limit.label, limit.spokenFigure]
        if limit.isBinding { parts.append("the binding limit") }
        if let trailing = limit.trailing, !trailing.isEmpty { parts.append(trailing) }
        return parts.joined(separator: ", ")
    }
}

/// The window's own bar, drawn by the Limits screen's rules.
///
/// FILLS AS USED, and draws NOTHING when there is no reading — both inherited
/// from `WristLimitBar` rather than restated, because a second bar with its own
/// arithmetic is exactly how two screens come to run opposite ways (DROVE-230,
/// DROVE-204). A window with no figure gets the dashed outline every other
/// "no reading" on this wrist gets.
private struct WindowBar: View {
    let limit: DroverAccountLimit

    var body: some View {
        if limit.isMeasured {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(WristQuotaCapsule.track)
                    Rectangle()
                        .fill(WristLimitBar.colour(for: limit.band))
                        .frame(width: WristQuotaCapsule.fillWidth(
                            fraction: limit.fraction, in: geometry.size.width
                        ))
                }
                .clipShape(Capsule())
            }
        } else {
            WristLimitBar.unmeasured()
        }
    }
}

/// Move a session onto this account, from the screen where the decision is
/// being made (DROVE-339).
///
/// The phone's sheet switches THE session it was opened from, because it is
/// opened off a session's composer. This screen is reached from the Limits
/// wall, which belongs to no session, so the wrist has to say which one — and
/// that is the whole of the fold. A flip is a `CLAUDE_CONFIG_DIR` swap and a
/// respawn (DROVE-28); it is not undoable in one gesture, so naming the session
/// is worth the row it costs.
///
/// Offered exactly where the phone offers it: `switchable` is the phone's own
/// verdict, false on the account already in use, on one with no login, on a
/// config dir that has never been through Claude Code's first run (DROVE-246)
/// and on every cursor account, which has no directory to swap to at all
/// (DROVE-270).
private struct SwitchHere: View {
    let account: DroverAccount
    let dismiss: DismissAction
    @EnvironmentObject private var store: GateStore

    /// Sessions that are not already here. One that is has nothing to move.
    private var movable: [DroverSession] {
        store.sessions.filter { $0.account != account.name }
    }

    var body: some View {
        if account.canTakeASession {
            Divider()
            if movable.isEmpty {
                // Not a failure and not a refusal: the account can take work,
                // there is simply none to give it. Said rather than drawn as
                // an empty gap under a divider.
                Text("No session to move here")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(movable) { session in
                    Button {
                        store.flip(session, to: account.name)
                        dismiss()
                    } label: {
                        SwitchLabel(session: session)
                    }
                    .disabled(store.flipping.contains(session.id))
                }
            }
        }
    }
}

/// "Switch · <project>", with the account it is leaving underneath.
///
/// The session's name is the thing being moved and leads; where it is coming
/// from is what makes the move readable, and it is small because it is context
/// rather than the choice.
private struct SwitchLabel: View {
    let session: DroverSession

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.left.arrow.right")
                .font(.caption)
            VStack(alignment: .leading, spacing: 0) {
                Text(session.title)
                    .font(.caption)
                    .lineLimit(1)
                if let from = session.account {
                    Text("on \(from)")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Switch \(session.title) to this account")
    }
}

/// An account with no windows on the wire.
///
/// Two ways to get here and the account's own line already says which — no
/// login, nobody measured it, a window that reset, a cursor token with no quota
/// to publish — so this says only that there is nothing further to open, and
/// does not invent a fifth sentence about it (DROVE-129).
private struct NoWindows: View {
    let account: DroverAccount

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("No windows to show")
                .font(.caption2)
            Text(account.loggedIn == false
                ? "Log this account in on the Mac"
                : "drover has not read this account's quota yet")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }
}

/// The account left the registry while its screen was open.
private struct Gone: View {
    let name: String

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("\(name) is not in the registry any more")
                .font(.caption2)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
    }
}
