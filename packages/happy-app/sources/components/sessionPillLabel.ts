/**
 * What the composer says about the session's mode, model and effort, and the
 * room the model's name has on the button row (DROVE-83, DROVE-111,
 * DROVE-138, DROVE-178).
 *
 * DROVE-83 read the three as one pill, `Yolo · Opus 5 1M · High`, on a row of
 * its own. DROVE-111 folded them into the button row: the mode a glyph, the
 * effort a glyph, the model the only one still spelled out. DROVE-138 then
 * moved the model down to the status line, because a name sharing a row with
 * six buttons was showing `Opus 5 1M` as `Opus 5...`.
 *
 * AND DROVE-178 BRINGS IT BACK UP, so the history is written here to stop it
 * flipping a third time. Clay asked for the move DOWN when six 63pt buttons
 * were cutting the name. DROVE-153 then collapsed the row to three objects
 * and freed about 121pt at 393, and he circled "Fable 5" on the status row
 * and drew an arrow up into exactly that gap. With that room the whole name
 * fits, and the status row, which by then carried the main thread's clock,
 * the agent count, the model and the account, needed to lose something. So
 * the model is the third segment of the session capsule, after mode and
 * effort, in full, and the status row no longer shows it. The name is the one
 * thing on the row with priority: the spacer gives way first, then the name's
 * own padding, and only then its type size. Nothing else on the row shrinks and
 * nothing is dropped (DROVE-264).
 *
 * The glyph controls read `mode` and `effort` to know they have something to
 * draw, the capsule's third segment reads `model`, and `text` is the whole
 * sentence for a screen reader.
 *
 * Pure, so the names and the budget can be tested without a renderer.
 * ComposerSessionControls.tsx draws them.
 */

import {
    MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
    MOBILE_COMPOSER_METRICS,
} from './agentInputLayout';

export const SESSION_PILL_SEPARATOR = ' · ';

/**
 * The mode and effort segments inside the session capsule, on HOME's row.
 *
 * 44, up from 38 (DROVE-153). They were half a step under the row's buttons
 * because seven separate discs had to fit across 357pt. They no longer have
 * to: the mode and the effort are one capsule now, the primary has moved into
 * the input, so the glyph segments are 44pt with nothing to squeeze. The
 * model segment (DROVE-178) is as tall, and as wide as its name needs.
 *
 * IT IS NOT WHAT THE CHAT DRAWS ANY MORE (DROVE-236). The chat's capsule is
 * inside the bubble's own button row, so it is as tall as that row
 * (`MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE`) and its glyph segments are as wide as
 * `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH` rather than square (DROVE-284). This
 * stays the default because the component still takes a size and 44 is what a
 * capsule on a row of its own should be.
 */
export const COMPOSER_SESSION_CONTROL_SIZE = 44;

/**
 * The model's name inside the capsule (DROVE-178).
 *
 * 13pt, AND CLAY HAS ASKED FOR THIS ONE TWICE (DROVE-320). With the shipped
 * 12pt row on his phone: "I told you to make this bigger."
 *
 * THIS IS A REVERSAL AND NOT A CONTRADICTION, which is worth naming because
 * the same person asked for the opposite four tickets ago. DROVE-111's row
 * squeezed the name to 12 by necessity; DROVE-178 stepped it up to 13 because
 * the name had DROVE-153's gap to itself; DROVE-284's air refinement took the
 * point BACK — "you can make the model text smaller" — and spent it on the
 * glyph segments, 26 -> 28. So 12 was never a size anybody wanted. It was a
 * currency, and this ticket is Clay buying the type back.
 *
 * WHAT PAYS FOR IT, BECAUSE A ROW THAT WAS FULL DOES NOT GET A FREE POINT.
 * Nothing has changed on this row since DROVE-284, so the 4pt a 13pt name
 * needs at 375 comes out of the two gives the ledger already names, one point
 * each, and the third lever — the type — is what receives them:
 *
 *   paddingHorizontal   6 -> 5   argued below, and it is a re-derivation
 *                                rather than a shave
 *   the glyph segments 28 -> 27  `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`,
 *                                still what the 375 floor affords, still over
 *                                the padlock's ink rule, and Clay keeps half
 *                                the air he granted
 *
 * AND EVERY WIDTH DRAWS THE NAME BIGGER, which is the only claim that matters
 * to the person who filed it. 375 goes 9.89pt -> 10.74pt on the longest name
 * either picker offers; 390 goes 11.87 -> 12.73; 393 — the phone Clay reads —
 * goes 12.00 -> 13.00, every name whole at full size as before.
 *
 * THE FLOOR IS A SCALE, SO A BIGGER BASE SIZE STRESSES IT, and this one does
 * not. The worst scale on any supported width goes 0.824 -> 0.827: the name
 * needs 8% more ink at 13pt and the budget it draws in grew by more, so the
 * type floor is LESS pressed than it was at 12pt while the type itself is a
 * point larger. Bigger-when-it-fits has not been bought with
 * tinier-when-it-does-not; there is no width where it is.
 *
 * AND SINCE DROVE-331 NO SUPPORTED WIDTH SCALES AT ALL. The auto-accept bolt
 * left the capsule and its 27pt went to this segment's budget, so 375 has 118
 * against the 108 the longest name needs whole, and the 0.827 and 0.980 above
 * are history: every name either picker offers draws at 13pt on every phone
 * the app supports. The floor below is still the last line before a name is
 * cut, and it is now only ever reached under 346.
 *
 * `glyphWidth` is a generous average advance for the system font at 13pt, and
 * it steps with the size it estimates: 7 is DROVE-178's own value at this
 * size, coming back with it, and it is the least the estimate may be
 * (`glyphWidth >= 7 * fontSize / 13`, asserted) so the model still only ever
 * errs toward "does not fit".
 * `paddingHorizontal` is the inset each side of the text.
 */
export const COMPOSER_MODEL_SEGMENT = {
    fontSize: 13,
    glyphWidth: 7,
    /**
     * The inset each side of the text, and the one thing this segment gives up
     * twice: once to pay for DROVE-264's second voice control, and once to pay
     * for its own type (DROVE-320).
     *
     * 5, DOWN FROM 6, DOWN FROM 10. Each step is a re-derivation rather than a
     * shave, and the history is here because the number has now been wrong in
     * both directions.
     *
     * 10 WAS "the same air the 44pt glyph segments give their 20pt glyphs",
     * which was true of a 44pt segment and stopped being true when DROVE-236
     * made the segments 36; at 36 that air is 8, so 10 was already a number
     * nothing was measuring.
     *
     * 6 WAS `controlGap`, on the argument that "every other segment on this row
     * is bounded by a circle's rim or a disc's edge and needs a rim's
     * clearance, and this one is bounded by two hairlines, which need a gap's."
     * The premise holds. The MEASUREMENT does not: `controlGap` is the air
     * BETWEEN two objects on the row, and this is the clearance INSIDE one, so
     * it was a rule borrowed from the wrong family.
     *
     * 5 IS THE FAMILY THIS SEGMENT ACTUALLY BELONGS TO — the other glyph
     * segments of the same capsule, which are bounded by the same hairlines and
     * hold ink of their own. What they give it, at
     * `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`'s 27 and off the same Ionicons
     * ink ratios the constant measures:
     *
     *   lock-closed   0.6875 of the em   13.75pt   6.625 a side
     *   volume-high   0.8750             17.50     4.750
     *   eye           0.9355             18.71     4.145   <- the widest mark
     *
     * So the capsule already draws its widest glyph with 4.145 of clearance,
     * and the name was being held to 6. The rule is the tightest of that
     * family, rounded UP to a whole point — `ceil((segment - 20 * 0.9355) / 2)`
     * — which is 5. It is derived, it is not the smallest thing that fits, and
     * it moves with the segments if they ever move again. Asserted in
     * sessionPillLabel.spec.ts rather than restated.
     *
     * WHAT THE 2pt BUYS, which is the reason it is spent rather than admired.
     * With 10 and DROVE-264's extra control, `Gemini 3.1 Pro` lands at scale
     * 0.765 on a 375 phone, under the floor, which is DROVE-138's cut name
     * arriving on a shipping model. With 5 it is 0.827 at 13pt — a HIGHER scale
     * than the 0.824 the smaller 12pt name managed on 6 — and `Opus 4.8 1M`,
     * the longest the Claude picker offers, still draws WHOLE at 375.
     */
    paddingHorizontal: 5,
    /**
     * Never an ellipsis. A name that will not fit at 13pt is drawn smaller
     * before it is ever cut, down to this scale, because `Opus 5...` is the
     * exact failure DROVE-138 was filed about.
     *
     * 0.80 since DROVE-236, and DROVE-264, DROVE-266 and DROVE-284 have each
     * declined to move it again.
     *
     * The floor exists so the longest name the picker offers still draws WHOLE
     * on the narrowest phone it can. DROVE-236 moved it 0.85 -> 0.80 to keep
     * `Opus 4.8 1M` whole at 320; DROVE-264 put a second voice control on the
     * row and no floor above zero rescues 320 any more, so lowering it again
     * would buy nothing and cost type everywhere. The 8pt came out of the
     * segment's padding instead, which is a give with a bottom.
     *
     * DROVE-284 IS WHERE IT WOULD HAVE BEEN EASIEST TO SPEND AND IT IS NOT
     * SPENT. That ticket takes the capsule's own row away on Clay's
     * instruction, so the give with no bottom is gone and this floor is the
     * last line before a name is cut. It buys the width out of the capsule's
     * SEGMENTS instead (`MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`), which is a
     * give with a bottom and a measurement. Lowering the floor would not even
     * buy the width that fails: 320 leaves the name 32pt and the SHORTEST name
     * in any picker needs 44 at 0.8, so the floor would have to go well under
     * 0.6 to rescue a phone nobody holds, at the cost of type on every phone
     * somebody does.
     *
     * AND THE 13PT STEP DOES NOT MOVE IT EITHER, IN THE DIRECTION THAT WOULD
     * HAVE BEEN EASY TO MISS (DROVE-320). The floor is a SCALE, so a BIGGER
     * base size raises the smallest type it permits — 0.8 of 13 is 10.4 where
     * 0.8 of 12 was 9.6 — and the trap is the other side of that: a longer
     * name needs more ink at 13pt, so the same budget yields a SMALLER scale,
     * and a base size raised without buying width walks the longest names
     * straight through this floor and into DROVE-138's cut.
     *
     * IT WAS CHECKED RATHER THAN ASSUMED, and the width was bought first. The
     * padding and one point off each glyph segment hand the name 4pt at 375,
     * which is more than the extra ink costs: the worst scale on any supported
     * width goes 0.824 -> 0.827, so the floor is LESS pressed at 13pt than it
     * was at 12, and the smallest type anything actually draws goes 9.89pt ->
     * 10.74pt. Raising the floor is still refused for the reason DROVE-284
     * gave: it is the last line before a name is CUT, and 0.8 is where a name
     * that will not fit stops shrinking and starts being wrong.
     *
     * What it was FOR was the widths that scaled, and there were two: the
     * three 14-glyph Gemini names landed at 0.827 on a 375 phone and 0.980 at
     * 390, and drew WHOLE at full size on 393 and everything above it. Since
     * DROVE-331 handed the name the bolt's 27 there is no supported width
     * that scales; the crossover where the longest name meets this floor is
     * `COMPOSER_ROW_MIN_MODEL_WIDTH`, 373 until then and 346 now.
     * `composerModelBudget` below has the full table.
     */
    minimumFontScale: 0.8,
} as const;

/**
 * Everything on the bubble's button row that is NOT the model's name, in
 * points (DROVE-236, DROVE-264, DROVE-284).
 *
 * Left to right, and this is Clay's row with read-aloud moved into the group:
 *
 *   the `+` disc, a gap, the session capsule
 *   (permission ‖ read-aloud ‖ effort ‖ model),
 *   a gap, the spacer, the MIC, a gap, SEND.
 *
 * IT IS INSIDE THE BUBBLE, which is why there are two insets rather than one.
 * `screenInset` is the composer's own gutter, `bubbleInset` is the bubble's
 * padding, and the row is laid out in what is left.
 *
 * ONE ROW AT EVERY WIDTH AGAIN, WHICH IS THE WHOLE OF DROVE-284. Clay, on what
 * DROVE-281 shipped: "Dude I don't like that extra row. Add the reading mode
 * whatever thing to the group and keep it all on the same row as send and +."
 * Both halves of that are one move. The read-aloud button stops being a loose
 * disc and becomes a segment of the capsule, and the second row goes away.
 *
 * WHY HIS INSTRUCTION IS THE REMEDY AND NOT JUST THE COMPLAINT. A loose disc
 * costs its own 39pt diameter PLUS a 6pt gap. A capsule segment costs a
 * segment plus a hairline and shares the capsule's ends. Moving read-aloud in
 * takes 45 off the row and puts 29 back (a 28pt segment and a hairline), and the arithmetic of the move is
 * only a third of what it buys: the other two thirds is that once the capsule
 * holds FOUR glyph segments, a segment being as wide as a disc stops being a
 * rounding error and becomes 156pt of a 393pt phone. It never needed to be.
 * `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH` is the argument and the measurement;
 * the short version is that a disc needs its own diameter because it is a
 * circle and a segment is bounded by hairlines, which is the same thing
 * `COMPOSER_MODEL_SEGMENT.paddingHorizontal` already established one segment
 * over.
 *
 * FIVE OBJECTS ON THE ROW SINCE DROVE-284, WHERE THERE WERE SIX. Send and the
 * mic stay apart (DROVE-264: "I might wanna type some stuff and then hit the
 * microphone and then say some stuff"), and read-aloud is the one that left.
 *
 * THE THREE REMAINING DISCS ARE ALL ONE WIDTH THOUGH TWO OF THEM ARE BARE
 * GLYPHS, and that is unchanged from DROVE-264. Send draws a full disc for Stop
 * and for the gate's lock, and the mic draws one the moment it is open, so a
 * narrower box would either shrink those circles below the `+`'s — two sizes of
 * circle on one row, which is DROVE-214's "one circle, so one value" broken —
 * or resize the box per face and reflow the row every time the agent starts a
 * turn.
 *
 * WHAT THE ROW COSTS, TICKET BY TICKET, AND WHAT IT LEAVES THE NAME. The last
 * column is DROVE-320, which UNDOES half of the column before it. DROVE-284's
 * air refinement was one trade with two sides — Clay said "spread them out",
 * granting the space, and "make the model text smaller", paying for it, so the
 * segments went 26 -> 28 and the name 13pt -> 12pt. He has now taken the
 * payment back ("I told you to make this bigger"), so the name returns to 13
 * and the row hands it 4pt: one point off each glyph segment (28 -> 27) and
 * one off the name's own padding (6 -> 5). Clay keeps half the air; the type
 * gets its whole point:
 *
 *   width   -264   +264   +266   +281   +284   +air   +320   +331   what the row draws now
 *   320      82     40     22    -17     40     32     36     63    the short Claude names whole or scaled; the long ones cut
 *   375     137     95     77     38     95     87     91    118    every name WHOLE at full size
 *   390     152    110     92     53    110    102    106    133    every name WHOLE at full size
 *   393     155    113     95     56    113    105    109    136    every name WHOLE at full size
 *   430     192    150    132     93    150    142    146    173    every name WHOLE at full size
 *
 * THE LAST COLUMN IS THE BOLT LEAVING (DROVE-331). Clay: "because of the
 * toggles in the sheet for auto-accept, we don't need it also in the bar
 * group." DROVE-281's segment was 27 wide and touched the padlock with no
 * hairline, so the row gives back exactly 27 at every width, and the name is
 * where it goes: the segments beside it keep their 27 (argued on
 * `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`), so the fixed row is 219 and every
 * supported width draws the longest name either picker offers WHOLE at 13pt.
 * 390's softening is gone with it. What 320 draws is below, on the honest
 * failure, which is now half a failure.
 *
 * A WIDER BUDGET AND A BIGGER NAME AT THE SAME TIME, which is the thing to
 * check rather than assume: the 4pt is handed over by terms that are NOT the
 * name (a segment and a padding), so the name's own budget grows while the
 * name grows into it. The longest name either picker offers needs 8% more ink
 * at 13pt and gets 4.6% more room plus 2pt of padding back, and the net at
 * every supported width is type that draws larger — 9.89pt -> 10.74pt at 375,
 * 12.00 -> 13.00 at 393 — on a scale floor that is less pressed than before.
 *
 * SO DROVE-284 HANDS BACK MORE THAN DROVE-281 SPENT: the fixed row goes 299 ->
 * 242 -> 250 with the air -> 246 with DROVE-320's point back off each segment
 * -> 219 with DROVE-331's bolt gone. That is 80 better than DROVE-281 and 41
 * better than the 260 DROVE-266 left, and 393 — the width Clay reads — went
 * from a second row to drawing `Gemini 3.1 Pro`, the longest name either
 * picker offers, WHOLE at full type size on one line, at 13pt. Nothing on
 * this row was dropped to get there and nothing was cut. The air's one
 * softening — 390 drawing the three 14-glyph Gemini names at 0.980 — stood
 * from the air refinement until DROVE-331, and the bolt's 27 clears it: 390
 * has 133 and the name needs 108.
 *
 * WHAT GIVES, IN ORDER, AND WHY IT IS STILL NOT THE NAME. The order is also
 * the order it is REPAID in, which is what DROVE-320 does: the name takes back
 * from 3 and 2, in that order, and never from 1.
 *
 *   1. The spacer, which costs nothing and at 320 was already zero.
 *   2. The model segment's own PADDING, 10 to 6 (DROVE-264) to 5 (DROVE-320),
 *      argued on `COMPOSER_MODEL_SEGMENT.paddingHorizontal`. The last step is
 *      a re-derivation, not a shave: 5 is the clearance the capsule's own
 *      segments give their widest glyph, which is the family this inset
 *      belongs to, where 6 was a gap between objects borrowed from the row.
 *   3. The capsule's glyph SEGMENTS, 39 to 26 (DROVE-284), back to 28 on
 *      Clay's "spread them out", and to 27 when he took back what paid for it
 *      (DROVE-320), argued on `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`. It is
 *      48pt across the four, which is what makes the single row affordable
 *      with a fourth control in the capsule and a 13pt name beside it.
 *   4. Then the name's TYPE SIZE, down to `minimumFontScale`. This is the
 *      give this ticket is BUYING BACK, and 2 and 3 are what it pays with.
 *
 * NOTHING PAST 1 GIVES ON ANY SUPPORTED WIDTH SINCE DROVE-331. With the bolt's
 * 27 in the name's budget the spacer has 10pt left at 375 under the longest
 * name at full size, so 2, 3 and 4 are the order for a phone narrower than
 * 375, which the app does not support. The order is kept because the row's
 * arithmetic is kept, and the crossover below is where it starts to matter.
 *
 * AND THE FIFTH IS GONE. DROVE-266's "the capsule stops sharing the row" was
 * the give with no bottom, and Clay has refused it: "I don't like that extra
 * row." So the list has a bottom again, and `COMPOSER_ROW_MIN_MODEL_WIDTH` is
 * where it is, at 346 since DROVE-331 — below every phone the app supports and
 * above 320.
 *
 * 320 IS THE HONEST FAILURE AND IT IS STATED RATHER THAN ROUTED AROUND, AND
 * SINCE DROVE-331 IT IS HALF A FAILURE. On one row a 320pt phone left the name
 * 36pt, and the SHORTEST name in any picker, `Opus 5`, needs 44 at the type
 * floor, so every name in every picker was cut there; DROVE-320's 4pt
 * narrowed that gap from 12 to 8 and did not close it. The bolt's 27 does:
 * 320 leaves the name 63 now, so `Opus 5`, `Fable 5` and `Sonnet 5` draw
 * WHOLE and `Opus 5 1M` and `Haiku 4.5` scale to fit, while `Opus 4.8 1M`,
 * `Sonnet 4.5` and every 12- and 14-glyph name are still cut. That half is
 * not shavable either, and the spec measures how far it is from being: the
 * segments would have to come down to 18 to buy `Gemini 3.1 Pro`, under the
 * 20pt glyph itself, so it is not a width a segment can be. What would have
 * to go at 320 for the long names is a control or the name itself. 320 is
 * below the narrowest phone this app supports — 375, per
 * statusRowLayout.spec.ts — so the trade is named and taken: 320 loses the
 * long names rather than 393 gaining a row.
 *
 * THE NAME ITSELF WAS THE OBVIOUS THING TO SPEND AND IT IS STILL REFUSED. A
 * glyph where the name is would buy about 62pt at a stroke and make every width
 * comfortable, 320 included. It is refused because the name is the one thing on
 * this row that carries a VALUE rather than a state: a padlock says which mode,
 * a dial says which level, and both are readable as pictures, but there is no
 * glyph for "Opus 5" that a person reads as "Opus 5". DROVE-138 was filed
 * precisely about `Opus 5 1M` being cut to `Opus 5...`, and DROVE-178 brought
 * the name back up into this capsule after Clay circled it on the status row
 * and drew an arrow at the gap.
 */
export const COMPOSER_BUBBLE_ROW_GEOMETRY = {
    /** The composer's outer gutter, each side. */
    screenInset: MOBILE_COMPOSER_METRICS.shellInset,
    /** The bubble's own padding, each side, inside that. */
    bubbleInset: MOBILE_COMPOSER_METRICS.bubbleInset,
    /**
     * The `+`, the MIC and SEND. THREE since DROVE-284: read-aloud was the
     * fourth and it is a capsule segment now. The last two are bare glyphs at
     * rest and keep the disc's box, because both still draw a full disc on one
     * of their faces.
     */
    discs: 3,
    disc: MOBILE_COMPOSER_METRICS.primaryActionSize,
    /**
     * `+` | capsule, capsule | spacer, mic | send. The spacer's floor is 0 and
     * the spacer itself is what separates it from the mic, so there are three
     * fixed gaps for five objects.
     */
    gaps: 3,
    gap: MOBILE_COMPOSER_METRICS.controlGap,
    /**
     * Permission mode, READ-ALOUD and the effort gauge (DROVE-284, DROVE-331).
     *
     * Four from DROVE-284, when Clay asked for "the reading mode whatever
     * thing" to join the group, until DROVE-331 took DROVE-281's auto-accept
     * bolt back out: "because of the toggles in the sheet for auto-accept, we
     * don't need it also in the bar group." The rule for what belongs here is
     * unchanged — the capsule holds the controls that say HOW this session
     * runs while the loose discs DO things — and auto-accept still is how it
     * runs; it is set in the padlock's sheet now and worn by the padlock, not
     * flipped by a segment of its own.
     */
    glyphSegments: 3,
    segment: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
    /**
     * THREE, FOR FOUR SEGMENTS (DROVE-331).
     *
     * mode ‖ read-aloud ‖ effort ‖ model, one rule between every pair. It was
     * three for FIVE from DROVE-284 to DROVE-331, because the padlock and the
     * bolt were the permission pair and touched with no rule between them
     * (DROVE-281: a hairline says "separate press"). With the bolt gone every
     * boundary left is a change of subject — permission to read-aloud,
     * read-aloud to effort, effort to the model's name — so the count did not
     * move when the segment did.
     */
    dividers: 3,
} as const;

/**
 * The narrowest width this row still spells the model's name on (DROVE-264,
 * 375 -> 389 by DROVE-266, 389 -> 428 by DROVE-281, 428 -> 371 by DROVE-284,
 * 371 -> 373 by its air refinement — the segments took two of the four
 * points the smaller name freed, and this line moved by exactly the other
 * two the arithmetic says — and 373 -> 346 by DROVE-331, the bolt's 27
 * exactly).
 *
 * UNMOVED BY DROVE-320, WHICH IS THE POINT OF PAYING FOR THE TYPE RATHER THAN
 * BORROWING IT. A 13pt name needs 6 more points than a 12pt one at the floor
 * (85 -> 91 on 6pt padding), and the padding and the segments hand over
 * exactly those 6 (2 + 4), so the crossover landed where it already was. Had
 * the type been raised on its own this line would have gone to 379 and taken
 * every 375 phone with it. The spec recomputes the crossover rather than
 * trusting this number, so that arithmetic cannot quietly stop being true.
 *
 * MOVED BY DROVE-331 BY ONE SEGMENT, DOWN. The auto-accept bolt left the
 * capsule and its 27 went to the name and nowhere else, so this line is 27
 * lower and 375 clears it by 29 rather than by 2. That margin is what turns
 * every scaled name on a supported width into a whole one.
 *
 * Not a taste line and not a device list: it is the width at which the budget
 * left over from `composerRowFixedWidth` can still hold the longest name the
 * pickers offer at `minimumFontScale`. The spec measures that crossover and
 * asserts this number against it rather than trusting it.
 *
 * IT MEANS A CUT NAME AGAIN, WHICH IS WHAT IT MEANT BEFORE DROVE-266. While
 * the capsule could take a row of its own, falling below this line was a
 * LAYOUT change and nothing was ever cut anywhere. Clay has rejected that row
 * — "I don't like that extra row" — so below this width the name is cut, and
 * the number matters again in the way it did originally.
 *
 * WHICH IS WHY IT IS BELOW EVERY PHONE THE APP SUPPORTS. 346 clears 375, the
 * narrowest handset statusRowLayout.spec.ts still supports, with 29pt to
 * spare, and clears 390, 393, 430 and 440 by more. It does NOT clear 320, and
 * that is the one honest failure of the single row — the short names now fit
 * there and the long ones do not; the argument is on
 * `COMPOSER_BUBBLE_ROW_GEOMETRY` and it is not fixable by rearranging this row.
 */
export const COMPOSER_ROW_MIN_MODEL_WIDTH = 346;


/** Everything on the row but the name, which is what the name gets the rest of. */
export function composerRowFixedWidth(): number {
    const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
    return g.discs * g.disc
        + g.gaps * g.gap
        + g.glyphSegments * g.segment
        + g.dividers;
}

/** The width the model segment needs for a name, at a given type scale. */
export function composerModelSegmentWidth(name: string, fontScale = 1): number {
    const m = COMPOSER_MODEL_SEGMENT;
    return Math.ceil(name.length * m.glyphWidth * fontScale) + 2 * m.paddingHorizontal;
}

/**
 * What is left for the model's name on a phone of `screenWidth`, once
 * everything else on the row has taken its fixed size. This is the gap the
 * ticket points at, measured rather than quoted.
 */
export function composerModelBudget(screenWidth: number): number {
    const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
    return screenWidth
        - 2 * g.screenInset
        - 2 * g.bubbleInset
        - composerRowFixedWidth();
}

/**
 * The smallest type scale that draws `name` whole on this phone, capped at 1.
 *
 * Below `minimumFontScale` the name would be cut instead of shrunk, which is
 * the DROVE-138 failure, so a value under the floor is the signal that the
 * floor is wrong rather than that the name is too long.
 */
export function composerModelScaleFor(name: string, screenWidth: number): number {
    const m = COMPOSER_MODEL_SEGMENT;
    const room = composerModelBudget(screenWidth) - 2 * m.paddingHorizontal;
    const ink = name.length * m.glyphWidth;
    if (ink <= 0) return 1;
    return Math.min(1, room / ink);
}

/** True when the name draws whole at 13pt on this phone, with no scaling. */
export function composerModelFits(name: string, screenWidth: number): boolean {
    return composerModelSegmentWidth(name) <= composerModelBudget(screenWidth);
}

export interface SessionPillModelLike {
    key?: string | null;
    modelId?: string | null;
    name?: string | null;
}

export interface SessionPillInput {
    /** The one-word permission mode, or null when the session has none. */
    modeLabel?: string | null;
    model?: SessionPillModelLike | null;
    effortLabel?: string | null;
}

export interface SessionPillLabel {
    mode: string | null;
    model: string | null;
    effort: string | null;
    /** The three present segments joined by the separator. */
    text: string;
}

const CLAUDE_FAMILY_NAMES: Record<string, string> = {
    fable: 'Fable',
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
};

// claude-<family>-<major>[-<minor>][-<yyyymmdd>][[1m]]. The date is a
// snapshot pin and says nothing a person wants on a 14pt chip; the bracket
// suffix is the 1M-context variant and does.
const CLAUDE_ID_PATTERN = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/i;

/**
 * The short model name for the pill. Known Claude ids map to the name people
 * use (`claude-fable-5` reads `Fable 5`, `claude-haiku-4-5` reads `Haiku 4.5`);
 * anything else is shown as the picker names it, and an id with no name at
 * all is kept as-is rather than guessed at.
 */
export function shortModelName(model: SessionPillModelLike | null | undefined): string | null {
    if (!model) return null;
    const id = (model.modelId ?? model.key ?? '').trim();
    const mapped = shortClaudeName(id) ?? shortClaudeName((model.name ?? '').trim());
    if (mapped) return mapped;
    const name = model.name?.trim();
    if (name) return name;
    return id || null;
}

function shortClaudeName(id: string): string | null {
    const match = CLAUDE_ID_PATTERN.exec(id);
    if (!match) return null;
    const family = CLAUDE_FAMILY_NAMES[match[1].toLowerCase()];
    const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
    return `${family} ${version}${match[4] ? ' 1M' : ''}`;
}

export function buildSessionPillLabel(input: SessionPillInput): SessionPillLabel {
    const mode = input.modeLabel?.trim() || null;
    const model = shortModelName(input.model);
    const effort = input.effortLabel?.trim() || null;
    return {
        mode,
        model,
        effort,
        text: [mode, model, effort].filter((segment): segment is string => !!segment).join(SESSION_PILL_SEPARATOR),
    };
}
