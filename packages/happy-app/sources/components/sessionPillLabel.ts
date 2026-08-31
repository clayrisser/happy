/**
 * The session pill on the compact composer (DROVE-83): what it reads, how
 * it truncates, and the rows of the sheet it opens.
 *
 * Pure so the label and the row model can be tested without a renderer. The
 * pill itself is ComposerSessionPill.tsx; the sheet rows are drawn by
 * AgentInput from the row model returned here.
 */
import { MOBILE_COMPOSER_METRICS } from './agentInputLayout';

export const SESSION_PILL_SEPARATOR = ' · ';

/** Matches the composer chips the pill replaces. */
export const SESSION_PILL_FONT_SIZE = 14;

/**
 * Horizontal room the pill's text does NOT get on a phone: AgentInput's
 * container padding, the glass shell inset, and the pill's own padding, each
 * on both sides. The container padding is a literal in AgentInput (8 below
 * 700pt), mirrored here.
 */
export const SESSION_PILL_GEOMETRY = {
    containerPaddingHorizontal: 8,
    shellInset: MOBILE_COMPOSER_METRICS.shellInset,
    paddingHorizontal: 12,
    height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
} as const;

/**
 * Only the model may truncate, and it truncates in the middle. The mode and
 * the effort are one word each and are never cut.
 */
export const SESSION_PILL_TRUNCATION = {
    segment: 'model',
    ellipsizeMode: 'middle',
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
 * A generous average advance for the system font at 14pt: SF Pro Text
 * averages under 7pt across mixed-case words, Roboto about the same. A label
 * that fits by this estimate fits on the phone; the estimate only ever errs
 * toward "does not fit".
 */
const AVERAGE_GLYPH_WIDTH = 7.5;

export function estimateSessionPillTextWidth(text: string): number {
    return text.length * AVERAGE_GLYPH_WIDTH;
}

/** The width the pill's text can use on a screen this wide. */
export function resolveSessionPillTextBudget(screenWidth: number): number {
    return screenWidth
        - 2 * SESSION_PILL_GEOMETRY.containerPaddingHorizontal
        - 2 * SESSION_PILL_GEOMETRY.shellInset
        - 2 * SESSION_PILL_GEOMETRY.paddingHorizontal;
}

/** True when the whole label fits without the model segment truncating. */
export function sessionPillFits(label: SessionPillLabel, screenWidth: number): boolean {
    return estimateSessionPillTextWidth(label.text) <= resolveSessionPillTextBudget(screenWidth);
}

export type SessionSheetRowKey = 'permission' | 'model' | 'effort';

export interface SessionSheetRowInput {
    title: string;
    /** The current value as the pill shows it, or a placeholder when unset. */
    value: string;
    /** False when the session offers no choice here: no options, or no handler. */
    available: boolean;
}

export interface SessionSheetRow {
    key: SessionSheetRowKey;
    title: string;
    value: string;
}

export interface SessionSheetInput {
    permission?: SessionSheetRowInput | null;
    model?: SessionSheetRowInput | null;
    effort?: SessionSheetRowInput | null;
}

/**
 * The rows of the session sheet, in the order the pill reads them. A setting
 * the session cannot change has no row: a row that opens nothing is worse than
 * no row.
 */
export function buildSessionSheetRows(input: SessionSheetInput): SessionSheetRow[] {
    const rows: SessionSheetRow[] = [];
    const keys: SessionSheetRowKey[] = ['permission', 'model', 'effort'];
    for (const key of keys) {
        const row = input[key];
        if (!row || !row.available) continue;
        rows.push({ key, title: row.title, value: row.value });
    }
    return rows;
}
