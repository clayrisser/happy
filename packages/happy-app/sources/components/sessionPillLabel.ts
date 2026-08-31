/**
 * What the composer says about the session's mode, model and effort, and how
 * much room the model's name actually has (DROVE-83, DROVE-111).
 *
 * DROVE-83 read the three as one pill, `Yolo · Opus 5 1M · High`, on a row of
 * its own. DROVE-111 folded them into the button row: the mode is a glyph,
 * the effort is a meter, and the model is the only one still spelled out. So
 * the label is still built here (the glyph controls read `mode` and `effort`
 * to know they have something to draw, and `text` is what a screen reader
 * gets), but the width arithmetic is now about one name in one gap, not a
 * three-part string across a whole row.
 *
 * Pure, so the names and the budget can be tested without a renderer.
 * ComposerSessionControls.tsx draws them.
 */
import { MOBILE_COMPOSER_METRICS } from './agentInputLayout';

export const SESSION_PILL_SEPARATOR = ' · ';

/** The model name on the button row; small, because it shares the row. */
export const COMPOSER_MODEL_FONT_SIZE = 12;

/**
 * The mode and effort segments inside the session capsule.
 *
 * 44, up from 38 (DROVE-153). They were half a step under the row's buttons
 * because seven separate discs had to fit across 357pt. They no longer have to:
 * the mode, the effort and the model are one capsule now, the primary has moved
 * into the input, and the arithmetic below has that much more to spend.
 */
export const COMPOSER_SESSION_CONTROL_SIZE = 44;

/**
 * Everything on the action row that is NOT the model's name, on a phone.
 *
 * The row is three objects rather than seven discs after DROVE-153. Clay's two
 * reference shots are the reason: the Screenshot markup toolbar puts two
 * related actions in ONE shared capsule instead of two circles, and Messages
 * keeps a single + outside its field. So the row reads
 *
 *     (+)   [ mode | effort | model ]   ...   [ speaker | mic ]
 *
 * with the send/voice/stop inside the input capsule above it. Three tap
 * regions in the session capsule and two in the audio capsule, each its own
 * 44pt segment, so grouping costs nothing in reach.
 *
 * AgentInput's container padding and the glass shell inset on both sides are
 * paid first; the container padding is a literal in AgentInput (8 below 700pt),
 * mirrored here.
 */
export const COMPOSER_SESSION_ROW_GEOMETRY = {
    containerPaddingHorizontal: 8,
    shellInset: MOBILE_COMPOSER_METRICS.shellInset,
    /**
     * Two: add to the session capsule, and the session capsule to the audio
     * capsule. Segments inside a capsule have no gap between them, which is
     * what makes each capsule read as one object.
     */
    gaps: 2,
    gap: 8,
    addSize: MOBILE_COMPOSER_METRICS.actionSize,
    controlSize: COMPOSER_SESSION_CONTROL_SIZE,
    /** Speaker and mic. The primary is in the input capsule, not on this row. */
    voiceButtons: 2,
    voiceButtonSize: COMPOSER_SESSION_CONTROL_SIZE,
} as const;

/**
 * Only the model can truncate, and it truncates at the TAIL now. DROVE-83 cut
 * it in the middle because it sat between a mode word and an effort word and
 * both ends carried meaning. It sits at the end of the row's left group now,
 * so the front of the name is the half worth keeping.
 */
export const COMPOSER_MODEL_TRUNCATION = {
    segment: 'model',
    ellipsizeMode: 'tail',
} as const;

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

/**
 * A generous average advance for the system font at 12pt: SF Pro Text
 * averages under 6.5pt across mixed-case words, Roboto about the same. A name
 * that fits by this estimate fits on the phone; the estimate only ever errs
 * toward "does not fit".
 */
const AVERAGE_GLYPH_WIDTH = 6.5;

export function estimateComposerModelTextWidth(text: string): number {
    return text.length * AVERAGE_GLYPH_WIDTH;
}

/**
 * What is left for the model's name on a screen this wide, once every button
 * on the row and every gap between them has been paid for.
 */
export function resolveComposerModelTextBudget(screenWidth: number): number {
    const g = COMPOSER_SESSION_ROW_GEOMETRY;
    return screenWidth
        - 2 * g.containerPaddingHorizontal
        - 2 * g.shellInset
        - g.addSize
        - 2 * g.controlSize
        - g.voiceButtons * g.voiceButtonSize
        - g.gaps * g.gap;
}

/** True when the model's name is drawn whole rather than tail-truncated. */
export function composerModelNameFits(name: string | null, screenWidth: number): boolean {
    if (!name) return true;
    return estimateComposerModelTextWidth(name) <= resolveComposerModelTextBudget(screenWidth);
}
