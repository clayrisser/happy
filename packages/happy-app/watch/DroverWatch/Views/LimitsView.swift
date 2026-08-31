import SwiftUI

/// What is left, on the wrist (DROVE-131).
///
/// Clay: "on the watch shouldn't I be able to see my limits and stuff." Yes,
/// by DROVE-129's rule — the watch is the phone's world folded to wrist size —
/// and the wrist had a session list, a gate wall and nothing at all about
/// quotas, so the one glance that answers "can I still work" was missing from
/// the surface that exists for glances.
///
/// FOLDED, NOT SHRUNK. The phone's sheet gives every account three bars
/// (Session, Week, Fable week) with a percentage and a reset time each, and
/// DROVE-148 is widening that to all five accounts. Five accounts times three
/// bars is fifteen rows; a 45mm watch shows about four before scrolling, and
/// the whole point of a glance is that it is over before you scroll. So the
/// fold is:
///
///   FIRST GLANCE — the current account, one bar, the MOST BINDING limit. Its
///   percentage, the window's name, and when it resets. That is the whole of
///   "can I still work", and it is one number rather than three because three
///   numbers on a wrist is a table you read instead of a fact you see.
///
///   BELOW IT — every other account, one compact row each, same bar, same
///   ranking. That is "where can I flip to", which is the second question and
///   deserves the scroll rather than the glance.
///
///   NOT HERE AT ALL — the other two windows for any account. If Session is
///   the binding limit, Week being at 38% changes nothing about whether he can
///   work right now, and it is on the phone a pocket away. The wrist shows the
///   number that decides; the phone shows the numbers that explain it.
///
/// Which limit is most binding is DECIDED BY THE PHONE and sent
/// (`DroverAccount.limit`, `.tone`), never re-ranked here: the watch is Swift
/// and cannot import agentInputUsage's `droverBindingLimit`, so the phone
/// computes and sends the answer rather than the wrist recomputing from raw
/// rows it does not have (DROVE-129). `headroom` and that limit's percentage
/// are the same number by construction — the CLI writes `100 -
/// max(percent)` — so the bar here and the figure on the phone cannot drift.
struct LimitsView: View {
    @EnvironmentObject private var store: GateStore

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 60)) { context in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if let message = store.lastError {
                        BannerRow(text: message, symbol: "exclamationmark.triangle", tint: .red)
                    }
                    if let current = store.snapshot.currentAccount {
                        CurrentLimitBlock(account: current, now: context.date)
                        let others = store.snapshot.otherAccounts
                        if !others.isEmpty {
                            // No heading over the list, the same call
                            // DROVE-117 made on the phone: a label over five
                            // names tells nobody anything, and it costs a row
                            // the wrist does not have.
                            Divider()
                            ForEach(others) { account in
                                AccountLimitRow(account: account, now: context.date)
                            }
                        }
                    } else {
                        NoLimits(connected: store.snapshot.connected)
                    }
                }
                .padding(.horizontal, 4)
            }
            .onChange(of: context.date) { _, now in
                store.askIfSnapshotIsAging(at: now)
            }
        }
        .navigationTitle("Limits")
    }
}

/// The glance: the account the work is on, and the one limit stopping it.
private struct CurrentLimitBlock: View {
    let account: DroverAccount
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(account.name)
                    .font(.caption)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                // The figure, big enough to be the thing the eye lands on.
                // A dash, never a gap, when nothing was measured — the same
                // call the phone's rows make, so an unmeasured account reads
                // as unmeasured rather than as zero.
                Text(account.headroom.map { "\($0)%" } ?? "\u{2013}")
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .foregroundStyle(WristLimitBar.colour(for: account.band))
            }
            WristLimitBar(account: account)
                .frame(height: 6)
            Text(subtitle)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
    }

    /// "Session · resets 6 PM". The window's name comes first because it is
    /// what makes the percentage actionable, and the reset time is what turns
    /// "0%" from a dead end into a wait.
    private var subtitle: String {
        var parts: [String] = []
        if account.loggedIn == false {
            parts.append("not logged in")
        } else if let limit = account.limit {
            parts.append(limit)
        } else if account.headroom == nil {
            parts.append("not measured")
        }
        if let back = account.backAt, back > now {
            parts.append("back \(back.formatted(date: .omitted, time: .shortened))")
        } else if let resets = account.resets(after: now) {
            parts.append("resets \(resets.formatted(date: .omitted, time: .shortened))")
        }
        return parts.joined(separator: " · ")
    }
}

/// Every other account, one row: the second question, "where can I flip to".
private struct AccountLimitRow: View {
    let account: DroverAccount
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(account.name)
                    .font(.system(size: 11))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                Text(account.headroom.map { "\($0)%" } ?? "\u{2013}")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(.secondary)
            }
            WristLimitBar(account: account)
                .frame(height: 4)
            if let trailing {
                Text(trailing)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .opacity(account.loggedIn == false ? 0.5 : 1)
        .padding(.vertical, 1)
    }

    private var trailing: String? {
        if account.loggedIn == false { return "not logged in" }
        if let back = account.backAt, back > now {
            return "back \(back.formatted(date: .omitted, time: .shortened))"
        }
        if let limit = account.limit { return limit }
        if account.headroom == nil { return "not measured" }
        return nil
    }
}

/// The bar itself: a track filled to the headroom LEFT, coloured by the band
/// the phone sent.
///
/// Always the headroom left, never the amount used, so every bar on the screen
/// fills the same direction and the column reads down at a glance — the same
/// rule the phone's sheet follows (DROVE-107). The colour is by band and never
/// by which account it is, so two accounts at the same percentage look the
/// same.
struct WristLimitBar: View {
    let account: DroverAccount

    static func colour(for band: DroverAccount.Tone) -> Color {
        switch band {
        case .ample: return .green
        case .low: return .yellow
        case .critical: return .red
        // Nothing measured, or a band from a newer phone. Grey, which is the
        // one colour that makes no claim about how much is left.
        case .unknown: return .secondary
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.secondary.opacity(0.25))
                Capsule()
                    .fill(Self.colour(for: account.band))
                    .frame(width: max(0, geometry.size.width * account.fraction))
            }
        }
    }
}

/// No account rows at all: an older phone, or one that has never sent a
/// registry snapshot. Says which, rather than showing an empty screen.
private struct NoLimits: View {
    let connected: Bool

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: connected ? "gauge.with.dots.needle.bottom.50percent" : "wifi.slash")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(connected ? "No limits yet" : "Not connected")
                .font(.caption)
            Text(connected
                ? "Run drover on your Mac; the phone sends what it reads"
                : "Open Cattle Drover on your phone")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
    }
}

/// The glance, wherever the wrist has room for one line (DROVE-131).
///
/// The current account, its bar and its percentage, as a link into the full
/// screen. Placed where there is vertical room and a decision being made: the
/// top of the sessions list, where the next thing Clay does is open or flip
/// one, and the gate wall's empty state, which is what the wrist shows most of
/// the day. NOT on the gate wall when it has gates on it — a wall of things
/// waiting on him is not where a quota belongs.
struct HeadroomLink: View {
    let account: DroverAccount

    var body: some View {
        NavigationLink(value: DroverRoute.limits) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Image(systemName: "gauge.with.dots.needle.bottom.50percent")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                    Text(account.name)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(account.headroom.map { "\($0)%" } ?? "\u{2013}")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(WristLimitBar.colour(for: account.band))
                }
                WristLimitBar(account: account)
                    .frame(height: 3)
            }
            .padding(.vertical, 1)
        }
    }
}
