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
     * buy the width that fails: 320 leaves the name 40pt and the SHORTEST name
     * in any picker needs 46 at 0.8, so the floor would have to go under 0.6 to
     * rescue a phone nobody holds, at the cost of type on every phone somebody
     * does.
     *
     * What it is FOR is the widths that scale, and after DROVE-284 there is
     * exactly one: the three 14-glyph Gemini names land at 0.847 on a 375
     * phone, and draw WHOLE at full size on 390 and everything above it. The
     * crossover where they meet this floor is `COMPOSER_ROW_MIN_MODEL_WIDTH`.
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
 *   (permission | auto-accept ‖ read-aloud ‖ effort ‖ model),
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
 * takes 45 off the row and puts 27 back (a 26pt segment and a hairline), and the arithmetic of the move is
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
 * WHAT THE ROW COSTS, TICKET BY TICKET, AND WHAT IT LEAVES THE NAME:
 *
 *   width   -264   +264   +266   +281   +284   what the row draws now
 *   320      82     40     22    -17     40    every name cut; below the floor
 *   375     137     95     77     38     95    every name whole or scaled ≥0.8
 *   390     152    110     92     53    110    every name WHOLE at full size
 *   393     155    113     95     56    113    every name WHOLE at full size
 *   430     192    150    132     93    150    every name WHOLE at full size
 *
 * SO DROVE-284 HANDS BACK MORE THAN DROVE-281 SPENT: the fixed row goes 299 ->
 * 242, which is 17pt better than the 260 DROVE-266 left, and 393 — the width
 * Clay reads — goes from a second row to drawing `Gemini 3.1 Pro`, the longest
 * name either picker offers, WHOLE at full type size on one line. Nothing on
 * this row was dropped to get there and nothing was cut.
 *
 * WHAT GIVES, IN ORDER, AND WHY IT IS STILL NOT THE NAME.
 *
 *   1. The spacer, which costs nothing and at 320 was already zero.
 *   2. The model segment's own PADDING, 10 to 6 (DROVE-264), argued on
 *      `COMPOSER_MODEL_SEGMENT.paddingHorizontal`.
 *   3. The capsule's glyph SEGMENTS, 39 to 26 (DROVE-284), argued on
 *      `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`. This is the new give and it is
 *      52pt across the four, which is what makes the single row affordable
 *      again with a fourth control in the capsule.
 *   4. Then the name's TYPE SIZE, down to `minimumFontScale`.
 *
 * AND THE FIFTH IS GONE. DROVE-266's "the capsule stops sharing the row" was
 * the give with no bottom, and Clay has refused it: "I don't like that extra
 * row." So the list has a bottom again, and `COMPOSER_ROW_MIN_MODEL_WIDTH` is
 * where it is, at 371 — below every phone the app supports and above 320.
 *
 * 320 IS THE HONEST FAILURE AND IT IS STATED RATHER THAN ROUTED AROUND. On one
 * row a 320pt phone leaves the name 40pt, and the SHORTEST name in any picker,
 * `Opus 5`, needs 46 at the type floor, so every name in every picker is cut
 * there. It is not shavable either, and the spec measures how far it is from
 * being: the segments would have to come down to 24 to buy `Opus 5` and to 13
 * to buy `Gemini 3.1 Pro`, and the capsule draws a 20pt glyph, so neither is a
 * width a segment can be. What would have to go at 320 is a control or the name
 * itself. 320 is below the narrowest phone this app supports — 375, per
 * statusRowLayout.spec.ts — so the trade is named and taken: 320 loses the name
 * rather than 393 gaining a row.
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
     * Permission mode, auto-accept, READ-ALOUD and the effort gauge
     * (DROVE-284).
     *
     * Four since Clay asked for "the reading mode whatever thing" to join the
     * group. It belongs there under the capsule's own rule: the capsule holds
     * the controls that say HOW this session runs while the loose discs DO
     * things, and whether the agent reads its answers aloud is how it runs, the
     * same way answering prompts unasked is (DROVE-281).
     */
    glyphSegments: 4,
    segment: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
    /**
     * THREE, FOR FIVE SEGMENTS (DROVE-284).
     *
     * mode | auto-accept ‖ read-aloud ‖ effort ‖ model. The padlock and the
     * bolt are the two permission controls and they touch with NO rule between
     * them, which is DROVE-281's grouping doing the talking: a hairline says
     * "separate press", and those two are a pair. The rules stay where the
     * subject changes — permission to read-aloud, read-aloud to effort, and
     * effort to the model's name.
     */
    dividers: 3,
} as const;

/**
 * The narrowest width this row still spells the model's name on (DROVE-264,
 * 375 -> 389 by DROVE-266, 389 -> 428 by DROVE-281, and 428 -> 371 here).
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
 * WHICH IS WHY IT IS BELOW EVERY PHONE THE APP SUPPORTS. 371 clears 375, the
 * narrowest handset statusRowLayout.spec.ts still supports, with 4pt to spare,
 * and clears 390, 393, 430 and 440 by more. It does NOT clear 320, and that is
 * the one honest failure of the single row; the argument is on
 * `COMPOSER_BUBBLE_ROW_GEOMETRY` and it is not fixable by rearranging this row.
 */
export const COMPOSER_ROW_MIN_MODEL_WIDTH = 371;


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
