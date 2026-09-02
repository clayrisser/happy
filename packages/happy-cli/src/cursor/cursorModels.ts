/**
 * Cursor's model list, as the session publishes it to the app (DROVE-57).
 *
 * The app's model picker prefers `metadata.models` over its own hardcoded
 * table, so a Cursor session that publishes its list gets a picker of REAL
 * Cursor models that cannot drift from what the CLI accepts. The alternative —
 * a table in the app — is out of date the day Cursor ships a model.
 *
 * `cursor-agent --list-models` prints, after a header and a blank line:
 *   `auto - Auto (default)`
 *   `cursor-grok-4.6-xhigh-fast - Cursor Grok 4.6 Extra High Fast`
 * The id is what `--model` takes; the label is what a human recognises.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveCursorBin } from './cursorBin';
import { cursorOwnedFromEnv, cursorTurnEnv } from './cursorEnv';

const execFileAsync = promisify(execFile);

export interface CursorModelOption {
    code: string;
    value: string;
    description?: string | null;
}

/** Parse `--list-models` output. Anything that is not `id - Label` is skipped. */
export function parseCursorModels(stdout: string): CursorModelOption[] {
    const out: CursorModelOption[] = [];
    const seen = new Set<string>();
    for (const line of stdout.split('\n')) {
        const m = /^\s*([A-Za-z0-9._+-]+)\s+-\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const [, code, value] = m;
        if (seen.has(code)) continue;
        seen.add(code);
        out.push({ code, value });
    }
    return out;
}

/**
 * Ask the CLI. An empty list is a normal outcome, not an error: the picker
 * then simply does not appear, which is the honest result of not knowing what
 * this login can run.
 */
export async function listCursorModels(configDir: string, cwd: string): Promise<CursorModelOption[]> {
    try {
        const { stdout } = await execFileAsync(resolveCursorBin(), ['--list-models'], {
            cwd,
            // The same environment a TURN gets, not a bare spread of this
            // process's (DROVE-387). An --account session asks this question on
            // the account's own credential, and a stray inherited key must not
            // answer it either.
            env: cursorTurnEnv(configDir, cursorOwnedFromEnv()),
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
        });
        return parseCursorModels(stdout);
    } catch {
        return [];
    }
}

/**
 * MODEL AND EFFORT ARE ONE STRING, AND THAT IS MEASURED (DROVE-253).
 *
 * DROVE-253's plan called for effort as a bracket parameter — `--model
 * '<id>[effort=high]'` — because cursor-agent's own `--help` advertises it:
 *
 *   "Parameterized models accept quoted bracket overrides, e.g.
 *    'claude-opus-4-8[context=1m,effort=high,fast=false]'"
 *
 * It does not work on this login. Four spellings were run against a real turn
 * and all four exited 1 before contacting the model, including the exact id
 * out of the help text:
 *
 *   composer-2.5[effort=high]        Cannot use this model: ... exit 1
 *   claude-opus-4-8[effort=high]     Cannot use this model: ... exit 1
 *   claude-opus-4-8-high[effort=low] Cannot use this model: ... exit 1
 *   composer-2.5[bogusparam=1]       Cannot use this model: ... exit 1
 *
 * `--model` is validated against the flat allowlist `--list-models` prints,
 * and that list has no bracket entries. So a bracket is not a cheap win, it is
 * a broken turn.
 *
 * What the list DOES have is the effort tier spelled into the id:
 *
 *   claude-opus-5-low   claude-opus-5-medium   claude-opus-5-high
 *   claude-opus-5-xhigh (and -max, and a `-fast` twin of each)
 *
 * So effort is real and pickable; it is just not a second argument. Splitting
 * the id gives the app a model list of ~15 families instead of 60 near
 * duplicates, plus a genuine effort axis — and rejoining is a LOOKUP in the
 * list Cursor itself printed, never string concatenation, so a pick can only
 * ever produce an id that already exists.
 */

/** Effort tiers, weakest first. Order is the app's slider order. */
export const cursorEffortTiers = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CursorEffortTier = typeof cursorEffortTiers[number];

const tierSet = new Set<string>(cursorEffortTiers);

export interface CursorModelSplit {
    /** The id with its effort tier removed, e.g. `claude-opus-5-thinking`. */
    base: string;
    /** The tier that was removed, or null when the id carries none. */
    effort: CursorEffortTier | null;
    /** Whether `-fast` trailed the tier. Part of the base's identity, not effort. */
    fast: boolean;
}

/**
 * Split `claude-opus-5-thinking-xhigh-fast` into base + effort + fast.
 *
 * `-fast` is deliberately kept on the BASE, not treated as an effort: it is a
 * different serving tier of the same model, it exists at every tier, and a
 * slider that silently moved between fast and non-fast would change what the
 * turn costs without saying so.
 */
export function splitCursorModelId(id: string): CursorModelSplit {
    const fast = id.endsWith('-fast');
    const stem = fast ? id.slice(0, -'-fast'.length) : id;
    const cut = stem.lastIndexOf('-');
    if (cut > 0) {
        const tail = stem.slice(cut + 1);
        if (tierSet.has(tail)) {
            return { base: stem.slice(0, cut) + (fast ? '-fast' : ''), effort: tail as CursorEffortTier, fast };
        }
    }
    return { base: id, effort: null, fast };
}

export interface CursorModelCatalog {
    /** One row per family, for `metadata.models`. */
    models: CursorModelOption[];
    /** The union of tiers any family offers, for `metadata.thoughtLevels`. */
    efforts: CursorModelOption[];
    /** family -> tier -> the real id. Also holds `''` for a tier-less family. */
    ids: Record<string, Record<string, string>>;
}

/**
 * A label for the family, taken from one of its members with the tier words
 * stripped. `Claude Opus 5 1M Extra High Thinking` at tier `xhigh` becomes
 * `Claude Opus 5 1M Thinking`, which is what a human calls that model.
 */
function familyLabel(label: string, effort: CursorEffortTier | null): string {
    if (!effort) return label;
    const words: Record<CursorEffortTier, string[]> = {
        low: ['Low'],
        medium: ['Medium'],
        high: [],
        xhigh: ['Extra High'],
        max: ['Max'],
    };
    let out = label;
    for (const w of words[effort]) out = out.replace(w, '');
    return out.replace(/\s+/g, ' ').trim();
}

const effortLabels: Record<CursorEffortTier, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max',
};

/** Fold a flat `--list-models` result into families plus an effort axis. */
export function buildCursorModelCatalog(flat: CursorModelOption[]): CursorModelCatalog {
    const ids: Record<string, Record<string, string>> = {};
    const models: CursorModelOption[] = [];
    const seenBase = new Set<string>();
    const seenEffort = new Set<string>();

    for (const opt of flat) {
        const { base, effort } = splitCursorModelId(opt.code);
        const slot = ids[base] ?? (ids[base] = {});
        // First id wins for a tier, so Cursor's own ordering decides ties.
        if (!(( effort ?? '') in slot)) slot[effort ?? ''] = opt.code;
        if (!seenBase.has(base)) {
            seenBase.add(base);
            models.push({ code: base, value: familyLabel(opt.value, effort) });
        }
        if (effort) seenEffort.add(effort);
    }

    const efforts = cursorEffortTiers
        .filter((t) => seenEffort.has(t))
        .map((t) => ({ code: t, value: effortLabels[t] }));

    return { models, efforts, ids };
}

/**
 * The real `--model` argument for a family and an effort pick.
 *
 * Never concatenates. An effort a family does not offer, or a null effort on a
 * family that only exists at tiers, falls back to `high` and then to whatever
 * tier that family does have — because a turn that runs on the neighbouring
 * tier is better than a turn that exits 1 on an id Cursor never listed.
 * Returns null when the family is unknown, which means "leave `--model` off".
 */
export function resolveCursorModelId(
    catalog: CursorModelCatalog,
    base: string | null | undefined,
    effort: string | null | undefined,
): string | null {
    if (!base) return null;
    const slot = catalog.ids[base];
    if (!slot) return base;
    if (effort && slot[effort]) return slot[effort];
    if (slot['']) return slot[''];
    if (slot.high) return slot.high;
    for (const tier of cursorEffortTiers) {
        if (slot[tier]) return slot[tier];
    }
    return base;
}
