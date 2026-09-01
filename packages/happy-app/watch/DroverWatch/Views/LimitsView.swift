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
///   ONE TAP DOWN — the other two windows for any account (DROVE-339). If
///   Session is the binding limit, Week being at 38% changes nothing about
///   whether he can work right now, so it stays off this screen; but "why"
///   is the very next question and it used to be answerable only on the phone.
///   Selecting a row opens `AccountLimitsView`, which is the phone's whole
///   block — Session, Week, Fable week, each with its bar, its percentage and
///   its reset — for that one account. The glance decides; the screen behind
///   it explains.
///
/// Which limit is most binding is DECIDED BY THE PHONE and sent
/// (`DroverAccount.limit`, `.tone`), never re-ranked here: the watch is Swift
/// and cannot import agentInputUsage's `droverBindingLimit`, so the phone
/// computes and sends the answer rather than the wrist recomputing from raw
/// rows it does not have (DROVE-129).
///
/// SO IS THE FILL, as of DROVE-230, and for the same reason. Every bar in the
/// product fills as usage is CONSUMED, and that direction is one TypeScript
/// function, `usageBarFraction`; the phone evaluates it and puts the answer on
/// the wire as `DroverAccount.used`. Nothing here computes a fraction, so
/// nothing here can end up running the other way — which matters more on this
/// surface than on the phone's, because this binary ships through TestFlight
/// and a drift could not be corrected OTA.
///
/// The one thing that still counts DOWN is the current account's subtitle,
/// `2% left · Session · resets 6 PM`, and it is allowed to because it spells
/// the word and names the window. The phone keeps headroom in exactly one
/// place, its account heading, for the same reason.
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
                        // EVERY row opens its own breakdown (DROVE-339). The
                        // current account's too: it is the one whose windows
                        // Clay is most often asking about, and a block that
                        // led the screen and alone did nothing when tapped
                        // would read as broken rather than as final.
                        //
                        // `.buttonStyle(.plain)` is load-bearing here for the
                        // reason it is on `HeadroomLink` (DROVE-228): without
                        // it watchOS paints an accent capsule under the whole
                        // row, and that capsule gets read as the bar.
                        AccountDoor(name: current.name) {
                            CurrentLimitBlock(account: current, now: context.date)
                        }
                        let others = store.snapshot.otherAccounts
                        if !others.isEmpty {
                            // No heading over the list, the same call
                            // DROVE-117 made on the phone: a label over five
                            // names tells nobody anything, and it costs a row
                            // the wrist does not have.
                            Divider()
                            ForEach(others) { account in
                                AccountDoor(name: account.name) {
                                    AccountLimitRow(account: account, now: context.date)
                                }
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

/// A row that opens that account's every window (DROVE-339).
///
/// One spelling for both rows on this screen, so the glance block and the list
/// underneath cannot end up with two different ideas of what a tap does — and
/// so `.buttonStyle(.plain)` is applied in exactly one place rather than being
/// remembered twice (DROVE-228).
private struct AccountDoor<Content: View>: View {
    let name: String
    @ViewBuilder var content: Content

    var body: some View {
        NavigationLink(value: DroverRoute.account(name)) {
            content
        }
        .buttonStyle(.plain)
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
                // The figure, big enough to be the thing the eye lands on, and
                // percent USED so it says the same thing the bar under it does
                // (DROVE-230). A dash, never a gap, when there is nothing to
                // print: the same call the phone's rows make, and `figure` is
                // the one spelling of it, so an unmeasured account and one
                // whose window has reset both read as "no number" rather than
                // as zero (DROVE-204).
                Text(account.figure)
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    // The band lives in the bar under this. Red here is the
                    // account being OUT, which is a fact about right now
                    // (DROVE-215, WristGlyph).
                    .foregroundStyle(account.isMeasured
                        ? WristGlyph.colour(WristGlyph.signal(for: account.band))
                        : Color.secondary)
                if account.isMeasured {
                    Text("used")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            }
            WristLimitBar(account: account)
                .frame(height: 6)
            Text(subtitle)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(account.name), \(account.spokenFigure). \(subtitle)")
    }

    /// "2% left · Session · resets 6 PM".
    ///
    /// The headroom leads, and this is the ONE place on the wrist that counts
    /// down (DROVE-230). It is allowed to because it spells the word "left"
    /// and the window's name follows it immediately, so it cannot be read as
    /// the bar's number; the phone keeps headroom in exactly one place, its
    /// account heading, for the same reason. Everything else here is percent
    /// used.
    ///
    /// The window's name is what makes either figure actionable, and the reset
    /// time is what turns a full bar from a dead end into a wait.
    private var subtitle: String {
        var parts: [String] = []
        if account.loggedIn == false {
            parts.append("not logged in")
        // Two different nothings, and saying the wrong one is the bug
        // (DROVE-204). "not measured" means nobody ever asked. "window reset"
        // means somebody asked and the answer has since expired, so the
        // account may be wide open or entirely spent. Same words as the
        // phone's sheet.
        } else if account.isExpired {
            parts.append("window reset")
        } else if account.headroom == nil {
            parts.append("not measured")
        }
        if let left = account.headroomFigure { parts.append(left) }
        if let limit = account.limit, account.isMeasured, account.loggedIn != false {
            parts.append(limit)
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
                // Percent USED, bare. This is a COLUMN, and a column of bars
                // teaches its own direction; the block above it spells the
                // word once for the whole screen (DROVE-230).
                Text(account.figure)
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
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(account.name), \(account.spokenFigure)")
    }

    private var trailing: String? {
        if account.loggedIn == false { return "not logged in" }
        if let back = account.backAt, back > now {
            return "back \(back.formatted(date: .omitted, time: .shortened))"
        }
        // Why there is no figure, when there is none (DROVE-204).
        if account.isExpired { return "window reset" }
        if let limit = account.limit { return limit }
        if account.headroom == nil { return "not measured" }
        return nil
    }
}

/// The bar itself: a track that FILLS as the window is consumed, coloured by
/// the band the phone sent.
///
/// FILLS AS USED, never as left (DROVE-230). Clay read a correct sheet and
/// asked "Oh so 0% means nothing left?" about bars he specified himself, so
/// the direction moved into the mark: a bar that grows means the thing it
/// measures is accumulating, and what accumulates here is usage. The wrist
/// runs the phone's direction because it draws the phone's number
/// (`DroverAccount.used`) rather than computing one.
///
/// The colour comes off the same `tone` the phone's own bars use, so it WARMS
/// toward the limit as the bar fills, and an exhausted window is a full red
/// bar needing no number read. It is by band and never by which account it is,
/// so two accounts at the same percentage look the same.
///
/// NO READING DRAWS NO BAR. Under fill-as-used an empty track is the positive
/// claim "nothing used yet", which is exactly the claim an unmeasured account
/// or a window that has already reset must not make (DROVE-204). Those get a
/// dashed outline instead: a shape that is plainly not a measurement.
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

    /// The dashed outline every "no reading" draws, at whatever height it is
    /// given. One spelling, so the glance and the Limits rows cannot invent
    /// two pictures of the same nothing.
    static func unmeasured() -> some View {
        Capsule()
            .strokeBorder(
                Color.secondary,
                style: StrokeStyle(lineWidth: 1, dash: [2.5, 2.5])
            )
    }

    var body: some View {
        if account.isMeasured {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(WristQuotaCapsule.track)
                    Rectangle()
                        .fill(Self.colour(for: account.band))
                        .frame(width: WristQuotaCapsule.fillWidth(
                            fraction: account.fraction, in: geometry.size.width
                        ))
                }
                // A RECTANGLE CLIPPED TO THE TRACK, not a second capsule. A
                // capsule 7pt wide in a 30pt row is a vertical pill whose ends
                // stick out past the track's own rounded corners, so the
                // minimum sliver read as a pip floating beside the bar rather
                // than the start of it.
                .clipShape(Capsule())
            }
        } else {
            Self.unmeasured()
        }
    }
}

/// One capsule, and its FILL is the value (DROVE-228).
///
/// THE BUG THIS REPLACES. The glance was a `NavigationLink` outside a `List`,
/// so watchOS drew it as a filled accent capsule edge to edge, and the real
/// measure was a 3pt track inside that capsule carrying a 3pt red segment at
/// the far left. Clay photographed a 2% account: the eye lands on the purple
/// mass and reads a full tank, the figure says 2% in red, and the picture wins.
/// A bar that says the opposite of its own number is worse than no bar.
///
/// WHY THE CAPSULE BECAME THE TRACK, rather than keeping the capsule as the
/// row's surface and growing the bar inside it. Two capsules on one row is
/// what caused this: whatever height the inner bar is given, it is still a
/// shape sitting inside a larger, fuller-looking shape, and the eye reads the
/// big one first. One shape cannot disagree with itself. It is also the
/// biggest bar the screen can hold, the full width and height of the row,
/// which is what "readable at arm's length on a 41mm" actually costs. And it
/// takes the accent off the row for free (DROVE-215): the only colour left on
/// it is the band, which is the measurement.
///
/// THE FILL IS WHAT IS USED, and it fills toward the limit (DROVE-230). Clay
/// could not tell which way his own bars ran — "Oh so 0% means nothing left?"
/// — so the phone's bars were turned round and the wrist follows, because the
/// wrist draws the number the phone sends (`DroverAccount.used`, which is
/// `usageBarFraction`) instead of computing one of its own. The two cannot
/// drift: there is one function, on one surface, and this binary ships in
/// TestFlight where a drift could not be corrected OTA.
///
/// The 2% account in Clay's photo is therefore a nearly FULL red capsule, and
/// a fresh session window is a nearly empty one. The colour warms as it fills,
/// off the same `tone` the phone's bars use, so the fullest bar is also the
/// loudest and the row needs no number read.
///
/// A WINDOW WITH NO READING DRAWS NO CAPSULE. An empty fill now CLAIMS
/// something — "nothing used yet" — so an account nobody measured, and one
/// whose window had already reset when the phone read it (DROVE-204), cannot
/// be drawn at zero: that is a fresh window's picture. They get a dashed
/// outline and a dash for a figure, and the line underneath says which nothing
/// it is, in the phone's own words.
///
/// THE TEXT RIDES ON TOP, which is only safe because the fill is a wash rather
/// than a solid: at `fillOpacity` over the black watch face the band colours
/// land dark enough that white stays well clear of 4.5:1 on all three, and
/// yellow, which is the one that would fail solid, is no worse than the others.
/// The FIGURE is the foreground unless the band is `critical`, where the
/// account cannot take another turn and the red is a live signal rather than a
/// decoration of a value (DROVE-215, WristGlyph).
struct WristQuotaCapsule: View {
    let account: DroverAccount
    /// The row's whole height. This IS the bar, so it is sized like a row.
    var height: CGFloat = 30

    /// The empty part of every quota track on the wrist. Bright enough to be
    /// a shape on the black face, dim enough that a fill of any band reads as
    /// clearly more than it.
    static let track = Color.primary.opacity(0.16)
    /// A wash, not a slab, so the name and the figure can sit on it.
    static let fillOpacity: Double = 0.45
    /// The narrowest a MEASURED fill may be drawn.
    ///
    /// A window measured at 0% used is a fresh one, and it is a reading. 0pt of
    /// capsule would make it identical to a row nobody measured, which is the
    /// distinction the phone spends its `measured` flag on (DROVE-230). A
    /// measured sliver gets a visible pip; an unmeasured row gets no capsule at
    /// all.
    static let minimumFill: CGFloat = 7

    /// Shared with `WristLimitBar` so the thin bars and this one round a
    /// sliver the same way.
    static func fillWidth(fraction: Double, in width: CGFloat) -> CGFloat {
        min(width, max(minimumFill, width * fraction))
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                if account.isMeasured {
                    ZStack(alignment: .leading) {
                        Capsule().fill(Self.track)
                        // Clipped to the track rather than drawn as its own
                        // capsule, so the minimum sliver starts INSIDE the
                        // rounded end instead of poking out beside it.
                        Rectangle()
                            .fill(WristLimitBar.colour(for: account.band).opacity(Self.fillOpacity))
                            .frame(width: Self.fillWidth(
                                fraction: account.fraction, in: geometry.size.width
                            ))
                    }
                    .clipShape(Capsule())
                } else {
                    WristLimitBar.unmeasured()
                }
                HStack(spacing: 4) {
                    Text(account.name)
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(account.figure)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(figureColour)
                    // The word, on the one row that has width for it
                    // (DROVE-230). The phone spells "used" only to VoiceOver
                    // because it prints a COLUMN of bars that teach the
                    // direction between them; this is a single bar on an
                    // otherwise empty screen and has no column to teach with,
                    // so it says it out loud. The rows in the scrolled list
                    // below do not repeat it.
                    if account.isMeasured {
                        Text("used")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 9)
                .frame(maxHeight: .infinity)
            }
        }
        .frame(height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(account.name), \(account.spokenFigure)")
    }

    private var figureColour: Color {
        guard account.isMeasured else { return .secondary }
        return WristGlyph.colour(WristGlyph.signal(for: account.band))
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
/// The current account, its capsule and its percentage, as a link into the
/// full screen. Placed where there is vertical room and a decision being made:
/// the top of the sessions list, where the next thing Clay does is open or
/// flip one, and the gate wall's empty state, which is what the wrist shows
/// most of the day. NOT on the gate wall when it has gates on it: a wall of
/// things waiting on him is not where a quota belongs.
///
/// `.buttonStyle(.plain)` is load-bearing (DROVE-228). Without it watchOS
/// paints the accent capsule under everything here, and that capsule was being
/// read as the bar.
struct HeadroomLink: View {
    let account: DroverAccount

    var body: some View {
        NavigationLink(value: DroverRoute.limits) {
            WristQuotaCapsule(account: account)
        }
        .buttonStyle(.plain)
    }
}
