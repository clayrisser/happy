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
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
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
 * inside the bubble's own button row, which is 36 tall, so it takes
 * `MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE`. This stays the default because the
 * component still takes a size and 44 is what a capsule on a row of its own
 * should be.
 */
export const COMPOSER_SESSION_CONTROL_SIZE = 44;

/**
 * The model's name inside the capsule (DROVE-178).
 *
 * 13pt, a step up from the 12 the DROVE-111 row squeezed it to, because the
 * name now has DROVE-153's gap to itself rather than 63pt between six
 * buttons. `glyphWidth` is a generous average advance for the system font at
 * 13pt, so the estimate only ever errs toward "does not fit".
 * `paddingHorizontal` is the inset each side of the text: the same air the
 * 44pt glyph segments give their 20pt glyphs.
 */
export const COMPOSER_MODEL_SEGMENT = {
    fontSize: 13,
    glyphWidth: 7,
    /**
     * The inset each side of the text, and the one thing this segment gives up
     * to pay for DROVE-264's second voice control.
     *
     * 6, DOWN FROM 10. It was "the same air the 44pt glyph segments give their
     * 20pt glyphs", which was true of a 44pt segment and stopped being true when
     * DROVE-236 made the segments 36; at 36 that air is 8, so the 10 was already
     * a number nothing was measuring. 6 is `controlGap`, the row's one air gap,
     * and it is the right one HERE rather than merely the smallest: every other
     * segment on this row is bounded by a circle's rim or a disc's edge and needs
     * a rim's clearance, and this one is bounded by two hairlines, which need a
     * gap's.
     *
     * WHAT THE 8pt BUYS, which is the reason it is spent rather than admired.
     * With 10 and DROVE-264's extra control, `Gemini 3.1 Pro` lands at scale
     * 0.765 on a 375 phone, under the floor, which is DROVE-138's cut name
     * arriving on a shipping model. With 6 it is 0.847, and `Opus 4.8 1M` — the
     * longest the Claude picker offers, the name DROVE-236 moved the floor for —
     * goes back to drawing WHOLE at 375 instead of scaled.
     */
    paddingHorizontal: 6,
    /**
     * Never an ellipsis. A name that will not fit at 13pt is drawn smaller
     * before it is ever cut, down to this scale, because `Opus 5...` is the
     * exact failure DROVE-138 was filed about.
     *
     * 0.80 since DROVE-236, and DROVE-264 deliberately did NOT move it again.
     *
     * The floor exists so the longest name the picker offers still draws WHOLE
     * on the narrowest phone it can. DROVE-236 moved it 0.85 -> 0.80 to keep
     * `Opus 4.8 1M` whole at 320; DROVE-264 put a second voice control on the
     * row and no floor above zero rescues 320 any more, so lowering it again
     * would buy nothing and cost type everywhere. The 8pt came out of the
     * segment's padding instead, which is a give with a bottom.
     *
     * What it is still FOR is 375 and up, where it is doing real work: the two
     * 14-glyph Gemini names land at 0.847 there, and the crossover where the
     * longest of them meets this floor is 371pt. `composerModelBudget` below
     * has the full table at 320, 375 and 393.
     */
    minimumFontScale: 0.8,
} as const;

/**
 * Everything on the bubble's button row that is NOT the model's name, in
 * points (DROVE-236, DROVE-264).
 *
 * Left to right, and this is Clay's row with DROVE-264's second voice control
 * in it:
 *
 *   the `+` disc, a gap, the session capsule (permission | effort | model),
 *   a gap, the spacer, the audio disc, a gap, the MIC, a gap, SEND.
 *
 * IT IS INSIDE THE BUBBLE, which is why there are two insets rather than one.
 * `screenInset` is the composer's own gutter, `bubbleInset` is the bubble's
 * padding, and the row is laid out in what is left.
 *
 * SIX OBJECTS SINCE DROVE-264, WHERE THERE WERE FIVE. That ticket un-collapsed
 * send and the mic, because a single morphing button cannot draw "type a bit,
 * dictate the rest, then send": reaching the mic requires send to disappear.
 * So one more object and one more 6pt gap, and this is the file that says what
 * it costs.
 *
 * THE OBJECTS ARE ALL ONE WIDTH THOUGH TWO OF THEM ARE NOW BARE GLYPHS, and
 * that is a decision rather than an oversight. Send and the mic at rest draw no
 * circle (DROVE-264), so their INK is about 18pt and a narrower box would buy
 * the name back some of what this ticket spends. It is refused twice over.
 * Send still draws a full disc for Stop and for the gate's lock, and the mic
 * draws one the moment it is open, so a narrower box would either shrink those
 * circles below the `+`'s and the audio button's — three sizes of circle on one
 * row, which is DROVE-214's "one circle, so one value" broken — or resize the
 * box per face and reflow the row every time the agent starts a turn.
 *
 * THE COST, MEASURED, AND WHAT IT DOES TO EACH PHONE. Three columns, because
 * DROVE-266 grew every object on the row 36 -> 39 and that is six objects, so
 * it spends 18 more:
 *
 *   width   -264   +264   +266   what the row still draws at 39
 *   320      82     40     22    the capsule takes its own row (see below)
 *   375     137     95     77    the capsule takes its own row
 *   390     152    110     92    every name; Gemini 3.1 Pro at 0.816
 *   393     155    113     95    every name; Gemini 3.1 Pro at 0.847
 *
 * WHAT GIVES, IN ORDER, AND WHY IT IS STILL NOT THE NAME.
 *
 *   1. The spacer, which costs nothing and at 320 was already zero.
 *   2. The model segment's own PADDING, 10 to 6, argued on
 *      `COMPOSER_MODEL_SEGMENT.paddingHorizontal`. This is the real give and it
 *      is 8pt: without it `Gemini 3.1 Pro` lands at 0.765 on a 375 phone, under
 *      the floor, which is a shipping name being CUT.
 *   3. Then the name's TYPE SIZE, down to `minimumFontScale`.
 *
 * A FOURTH GIVE ARRIVED IN DROVE-266, AND IT IS THE ONE WITH NO BOTTOM:
 *
 *   4. The capsule stops sharing the row. `composerCapsuleOwnRow` below.
 *
 * That is what turns this from a budget with a failure at the narrow end into a
 * layout that holds at every width. Clay asked for bigger buttons, six objects
 * on this row take the size, so a point costs the name six and the crossover
 * moves 371 -> 389. At 390 and 393 the single row still holds and every name in
 * both pickers still draws: `Opus 4.8 1M` whole, `Gemini 3.1 Pro` at 0.847 and
 * 0.816, both over the floor. Below 389 the capsule takes a row of its own and
 * gets the bubble's whole interior — 202pt at 320, 27 glyphs — so nothing is cut
 * and nothing is scaled past the floor anywhere.
 *
 * WHICH ALSO SETTLES 320, THE HONEST HALF DROVE-264 COULD ONLY NAME. It said
 * plainly that no name in either picker cleared 320 once a sixth object was on
 * the row, `Opus 5` at 0.667 included, and that the remedy was the capsule
 * taking a row of its own — vertical space, which a phone has, instead of the
 * name, which it does not. That is now built rather than written down.
 * `COMPOSER_ROW_MIN_MODEL_WIDTH` is the line, and the spec measures the
 * crossover rather than trusting the number.
 *
 * THE NAME ITSELF WAS THE OBVIOUS THING TO SPEND AND IT IS STILL REFUSED. A
 * glyph where the name is would buy about 62pt at a stroke and make every width
 * comfortable. It is refused because the name is the one thing on this row that
 * carries a VALUE rather than a state: a padlock says which mode, a dial says
 * which level, and both are readable as pictures, but there is no glyph for
 * "Opus 5" that a person reads as "Opus 5". DROVE-138 was filed precisely about
 * `Opus 5 1M` being cut to `Opus 5...`, and DROVE-178 brought the name back up
 * into this capsule after Clay circled it on the status row and drew an arrow
 * at the gap.
 */
export const COMPOSER_BUBBLE_ROW_GEOMETRY = {
    /** The composer's outer gutter, each side. */
    screenInset: MOBILE_COMPOSER_METRICS.shellInset,
    /** The bubble's own padding, each side, inside that. */
    bubbleInset: MOBILE_COMPOSER_METRICS.bubbleInset,
    /**
     * The `+`, the audio button, the MIC and SEND. Four since DROVE-264: the
     * last two are bare glyphs at rest and keep the disc's box, because both
     * still draw a full disc on one of their faces.
     */
    discs: 4,
    disc: MOBILE_COMPOSER_METRICS.primaryActionSize,
    /**
     * `+` | capsule, capsule | spacer, audio | mic, mic | send. The spacer's
     * floor is 0.
     */
    gaps: 4,
    gap: MOBILE_COMPOSER_METRICS.controlGap,
    /** Permission mode and the effort gauge. */
    glyphSegments: 2,
    segment: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    /** Between the mode, effort and model segments: three segments, two rules. */
    dividers: 2,
} as const;

/**
 * The narrowest width this row still spells the model's name on (DROVE-264,
 * moved 375 -> 389 by DROVE-266).
 *
 * Not a taste line and not a device list: it is the width at which the budget
 * left over from `composerRowFixedWidth` can still hold the longest name the
 * pickers offer at `minimumFontScale`. The spec measures that crossover and
 * asserts this number against it rather than trusting it.
 *
 * IT IS THE CROSSOVER ITSELF NOW, not the narrowest phone above it. While
 * falling below it meant a CUT NAME the constant was rounded up to a real
 * handset, because shipping a fault at 371..374 that no device could reach was
 * pointless precision. Below it now means the capsule takes a row of its own,
 * which is a layout that works at every width, so the honest place for the line
 * is where the arithmetic puts it: 389. The narrowest real phone above it is
 * 390, and 393 — the one Clay reads — has 6pt of margin at the type floor.
 */
export const COMPOSER_ROW_MIN_MODEL_WIDTH = 389;

/**
 * Whether the session capsule takes a ROW OF ITS OWN (DROVE-266).
 *
 * This is DROVE-264's named remedy, built rather than left as a note. That
 * ticket put a sixth object on the row, said plainly that 320 no longer held,
 * and wrote down what to do about it: "give the capsule a row of its own again
 * below it (DROVE-196's layout, which DROVE-236 reversed) — vertical space,
 * which a phone has, instead of the name, which it does not".
 *
 * WHAT MADE IT NO LONGER OPTIONAL. Clay asked for bigger buttons, and six
 * objects on this row take that size, so a point of growth costs the name six.
 * The table is on `primaryActionSize`, and its first line is the one that
 * settles this: at 37, one point up from 36, the crossover is already 377 and
 * 375 is a phone people hold. There is no growth small enough to keep the
 * single row at 375, so either the size stays where it is and Clay is told no,
 * or the capsule gets its row. It gets its row.
 *
 * AND IT FIXES 320 ON THE WAY, which DROVE-264 could only name. Below this
 * width nothing is cut and nothing shrinks past the floor at any width the app
 * runs on, including 320, where every name in both pickers has failed since
 * DROVE-264. On its own row the capsule has the bubble's whole interior: 202pt
 * for the name at 320, which is 27 glyphs, against the 22pt it has on the
 * single row.
 *
 * WHAT IT COSTS is one action row's height plus a gap, on the phones below the
 * line and on no others. That is the trade DROVE-264 pointed at — vertical
 * space, which a phone has.
 */
export function composerCapsuleOwnRow(screenWidth: number): boolean {
    return screenWidth < COMPOSER_ROW_MIN_MODEL_WIDTH;
}

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
