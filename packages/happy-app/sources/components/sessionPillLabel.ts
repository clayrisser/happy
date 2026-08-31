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
 * thing on the row with priority: the spacer beside the capsule gives way
 * before the name does, and nothing else on the row shrinks.
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
    paddingHorizontal: 10,
    /**
     * Never an ellipsis. A name that will not fit at 13pt is drawn smaller
     * before it is ever cut, down to this scale, because `Opus 5...` is the
     * exact failure DROVE-138 was filed about.
     *
     * 0.80, DOWN FROM 0.85 (DROVE-236), and this is the one number the move
     * into the bubble actually spends. The floor exists so the longest name
     * the picker offers still draws WHOLE on the narrowest phone, and the
     * narrowest phone's budget fell 33pt when the row joined the `+` and send
     * inside the bubble. At 320 the budget is 82 and `Opus 4.8 1M` needs
     * 11 x 7 x scale + 20 <= 82, so scale <= 0.805. 0.80 is the whole point
     * below that.
     *
     * It is 10.4pt of type on one phone with one name, against losing the
     * name for a glyph, which was the other candidate and is the failure
     * DROVE-138 was filed about. `composerModelBudget` below has the full
     * table at 320, 375 and 393.
     */
    minimumFontScale: 0.8,
} as const;

/**
 * Everything on the bubble's button row that is NOT the model's name, in
 * points (DROVE-236).
 *
 * Left to right, and this is the row Clay drew in red:
 *
 *   the `+` disc, a gap, the session capsule (permission | effort | model),
 *   a gap, the spacer, the audio disc, a gap, the send / mic disc.
 *
 * IT IS INSIDE THE BUBBLE NOW, which is why there are two insets rather than
 * one. `screenInset` is the composer's own gutter, `bubbleInset` is the
 * bubble's padding, and the row is laid out in what is left. The old geometry
 * counted one inset because the row was a full-width row of its own under the
 * bubble.
 *
 * FOUR TERMS CHANGED AND ONE STALE ONE WENT WITH THEM:
 *
 *   - Two DISCS joined the row, the `+` and send, and the mic left it. Net
 *     one more 36pt object, plus their gaps.
 *   - The glyph segments are 36, not 44. That is
 *     `MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE`, and the trade it makes (a 36pt
 *     horizontal touch target) is argued where the constant is declared.
 *   - The audio capsule is one 36pt disc, not three 44pt buttons in a shared
 *     capsule with two hairlines. The pair collapsed into one control earlier
 *     in this same ticket and `audioButtons: 3` had been stale ever since,
 *     which made the budget 45pt PESSIMISTIC while the row was outside.
 *   - `bubbleInset` is new and costs 18.
 *
 * THE NET IS 33PT OFF THE NAME AT EVERY WIDTH, measured against what the row
 * actually drew rather than against what the stale constant claimed:
 *
 *   width   outside the bubble   inside it   the longest name that fits whole
 *   320     115                  82          Sonnet 5 (76); longer names scale
 *   375     170                  137         everything the picker offers
 *   393     188                  155         everything the picker offers
 *
 * WHAT GIVES, IN ORDER, AND WHY IT IS NOT THE NAME. The spacer goes first and
 * costs nothing. Then the name's TYPE SIZE, down to `minimumFontScale`, which
 * this ticket moves 0.85 -> 0.80 so that `Opus 4.8 1M`, the longest name the
 * Claude picker offers, still draws whole at 320. Nothing else on the row
 * shrinks and nothing is dropped.
 *
 * THE NAME ITSELF WAS THE OBVIOUS THING TO SPEND AND IT IS REFUSED. A glyph
 * where the name is would buy about 62pt at a stroke and make every width
 * comfortable. It is refused because the name is the one thing on this row
 * that carries a VALUE rather than a state: a padlock says which mode, a dial
 * says which level, and both are readable as pictures, but there is no glyph
 * for "Opus 5" that a person reads as "Opus 5". DROVE-138 was filed precisely
 * about `Opus 5 1M` being cut to `Opus 5...`, and DROVE-178 brought the name
 * back up into this capsule after Clay circled it on the status row and drew
 * an arrow at the gap. Replacing it with a glyph would undo both and put the
 * answer to "which model am I on" one tap away instead of on the screen. A
 * name at 10.4pt on one phone is a worse-looking row; a glyph is a row that
 * has stopped saying the thing.
 */
export const COMPOSER_BUBBLE_ROW_GEOMETRY = {
    /** The composer's outer gutter, each side. */
    screenInset: MOBILE_COMPOSER_METRICS.shellInset,
    /** The bubble's own padding, each side, inside that. */
    bubbleInset: MOBILE_COMPOSER_METRICS.bubbleInset,
    /** The `+`, the audio button and send / mic. */
    discs: 3,
    disc: MOBILE_COMPOSER_METRICS.primaryActionSize,
    /** `+` | capsule, capsule | spacer, audio | send. The spacer's floor is 0. */
    gaps: 3,
    gap: MOBILE_COMPOSER_METRICS.controlGap,
    /** Permission mode and the effort gauge. */
    glyphSegments: 2,
    segment: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    /** Between the mode, effort and model segments: three segments, two rules. */
    dividers: 2,
} as const;

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
