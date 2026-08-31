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

import { MOBILE_COMPOSER_METRICS } from './agentInputLayout';

export const SESSION_PILL_SEPARATOR = ' · ';

/**
 * The mode and effort segments inside the session capsule.
 *
 * 44, up from 38 (DROVE-153). They were half a step under the row's buttons
 * because seven separate discs had to fit across 357pt. They no longer have
 * to: the mode and the effort are one capsule now, the primary has moved into
 * the input, so the glyph segments are 44pt with nothing to squeeze. The
 * model segment (DROVE-178) is as tall, and as wide as its name needs.
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
     * exact failure DROVE-138 was filed about. At 0.85 the longest name the
     * picker offers still fits the narrowest phone; the spec pins it.
     */
    minimumFontScale: 0.85,
} as const;

/**
 * Everything on the phone's action row that is NOT the model's name, in
 * points, at the DROVE-153 sizes.
 *
 * The card is inset from the screen by `shellInset` and pads its content by
 * `shellInset` again. Then, left to right: the `+`, a gap, the mode and
 * effort segments, the model segment, the spacer, a gap, and the speaker and
 * mic capsule. The two hairline dividers inside the capsule are counted at a
 * point each, which over-counts them.
 */
export const COMPOSER_ROW_GEOMETRY = {
    screenInset: MOBILE_COMPOSER_METRICS.shellInset,
    cardPadding: MOBILE_COMPOSER_METRICS.shellInset,
    add: MOBILE_COMPOSER_METRICS.actionSize,
    gap: 6,
    glyphSegments: 2,
    segment: COMPOSER_SESSION_CONTROL_SIZE,
    dividers: 2,
    audioButtons: 2,
    audioButton: MOBILE_COMPOSER_METRICS.actionSize,
} as const;

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
    const g = COMPOSER_ROW_GEOMETRY;
    const usable = screenWidth - 2 * g.screenInset - 2 * g.cardPadding;
    const fixed = g.add + g.gap
        + g.glyphSegments * g.segment + g.dividers
        + g.gap + g.audioButtons * g.audioButton;
    return usable - fixed;
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
