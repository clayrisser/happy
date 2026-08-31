import SwiftUI

/// What is allowed to be coloured on the wrist, and why (DROVE-228).
///
/// THE RULE IS DROVE-215's, NOT A SECOND ONE FOR THE WATCH. A glyph is the
/// FOREGROUND unless it is ACTIVE, and active means something is happening
/// right now, not a control holding a value. The phone wrote that down in
/// `composerControlColour.ts` after Clay asked twice for no coloured icons;
/// the wrist is the same product and inventing a wrist dialect is how the two
/// surfaces drift (DROVE-129).
///
/// WHAT WENT WRONG HERE. Every door on the gate wall was a `NavigationLink`
/// drawn outside a `List`, and watchOS gives that the filled accent capsule by
/// default. So the quota row and the Playground button were the same lavender
/// mass, edge to edge, and the debug screen carried exactly the weight of the
/// one fact Clay raises his wrist for. Worse, the accent capsule sat UNDER the
/// quota's own 3pt bar, so a 2% account read as a full one: the surface was
/// louder than the measure. `.buttonStyle(.plain)` is what takes the accent
/// off a door; the fill that is left belongs to the value.
///
/// THE SIGNALS. Two, and adding a third is a decision rather than a
/// formality, because a member here is a claim that something is happening at
/// the moment it is drawn.
///
///   unreachable  the wrist CANNOT make the claim on the screen: the phone is
///                not feeding it, or it asked and got nothing newer. That is a
///                fault in progress, and it is the one thing on an otherwise
///                quiet screen worth looking twice at. Orange, the colour the
///                muted-buzz banner already spends on "look twice".
///   spent        the account cannot take another turn. `critical` is the
///                phone's own band and the wrist does not re-rank it
///                (DROVE-129). Red, and it is the same red as the figure in
///                the photo Clay filed this against.
///
/// WHAT IS NOT A SIGNAL, so it is the foreground:
///   - the all-clear tick. "Nothing waiting" is true most of the day, and a
///     colour that is always on carries nothing, which is DROVE-215's whole
///     argument. The word under it says it, and the glyph shape differs in
///     every state, so green was never the carrier.
///   - the Playground door. It is a debug surface that is always available.
///   - the Tasks door, the Sessions door in the toolbar. Doors, not events.
///
/// WHAT KEEPS COLOUR BUT IS NOT A GLYPH: the quota capsule's FILL, which is
/// the measurement itself rather than a decoration of it (see
/// `WristQuotaCapsule`). A band colour there is the value being drawn, and
/// taking it away would leave the row saying nothing. It warms toward the
/// limit off the phone's own `tone`, so the loudest bar is the fullest one.
///
/// AND A TINT IS NOT A FOREGROUND. `.tint(.primary)` on a toolbar item paints
/// the DISC behind the glyph rather than the glyph, so applying this rule with
/// a tint turned the Sessions button into a white puck louder than everything
/// under it. The way to make a control quiet is to stop styling it:
/// `.buttonStyle(.plain)` on a `NavigationLink` outside a `List`, and nothing
/// at all on a toolbar item.
enum WristGlyph {
    /// Something is happening now, and this is what it is.
    enum Signal {
        /// The wrist is in no position to say what it is saying.
        case unreachable
        /// The account is out. The phone's `critical` band, never re-derived.
        case spent
    }

    /// The default, and the reason a new glyph is quiet by writing less:
    /// `WristGlyph.colour()` with no argument is the foreground.
    static func colour(_ signal: Signal? = nil) -> Color {
        switch signal {
        case .none: return .primary
        case .unreachable: return .orange
        case .spent: return .red
        }
    }

    /// The band the phone sent, as a signal. Only `critical` is one: `ample`
    /// and `low` are values a quota holds, and the capsule's fill is where a
    /// value belongs.
    static func signal(for band: DroverAccount.Tone) -> Signal? {
        band == .critical ? .spent : nil
    }
}
