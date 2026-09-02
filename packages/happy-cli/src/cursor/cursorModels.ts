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
        const m = line.match(/^\s*([A-Za-z0-9._+-]+)\s+-\s+(.+?)\s*$/);
        if (!m) continue;
        const [, code, value] = m;
        if (seen.has(code)) continue;
        seen.add(code);
        out.push({ code, value });
    }
    return out;
}

/** What `--list-models` came back with, or why it did not. */
export interface CursorModelListing {
    models: CursorModelOption[];
    /**
     * Why `models` is empty, when it is: the exit and the last line
     * cursor-agent said, or the spawn error. Null when cursor-agent answered.
     *
     * This used to be `[]` for every failure, and the runner returned early on
     * `[]`, so a list that failed and a list that never ran were the same
     * thing from the phone: no picker, no label, nothing in the log
     * (DROVE-395). A locked login keychain exits 1 before printing a row, and
     * that is exactly what a session started from the phone hits.
     */
    failure: string | null;
}

export interface ListCursorModelsOptions {
    cwd: string;
    /**
     * The environment a TURN gets, handed in rather than rebuilt here. The
     * question the picker asks is "what can the next turn run", and the only
     * way that stays true is to ask it under the turn's own env, which is
     * why `CursorBackend.listModels()` is the caller (DROVE-387, DROVE-395).
     */
    env: NodeJS.ProcessEnv;
    /** The cursor-agent to ask. Resolved off PATH and ~/.local/bin when absent. */
    bin?: string;
    timeoutMs?: number;
}

const ansi = /\u001b\[[0-9;]*[A-Za-z]/g;

function lastLine(text: string | undefined): string | null {
    const lines = (text ?? '').replace(ansi, '').split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : null;
}

/** The reason, in one line: what exited how, and the last thing it said. */
export function describeCursorListFailure(error: unknown, bin: string, timeoutMs: number): string {
    const e = (error ?? {}) as {
        code?: unknown;
        killed?: boolean;
        signal?: string | null;
        stderr?: string;
        stdout?: string;
        message?: string;
    };
    if (e.code === 'ENOENT') return `${bin} not found (ENOENT)`;
    if (e.killed && e.signal) return `killed by ${e.signal} after ${timeoutMs}ms`;
    const exit = typeof e.code === 'number' ? `exit ${e.code}` : e.signal ? `signal ${e.signal}` : 'failed';
    const said = lastLine(e.stderr) ?? lastLine(e.stdout) ?? (e.message ? e.message.replace(ansi, '').trim() : null);
    return said ? `${exit}: ${said}` : exit;
}

/**
 * Ask the CLI. A failure is returned with its reason, never thrown and never
 * folded into an empty list: the caller decides what to publish in its place,
 * and the log says why the picker is short.
 */
export async function listCursorModels(opts: ListCursorModelsOptions): Promise<CursorModelListing> {
    const bin = opts.bin ?? resolveCursorBin();
    const timeout = opts.timeoutMs ?? 30_000;
    try {
        const { stdout } = await execFileAsync(bin, ['--list-models'], {
            cwd: opts.cwd,
            env: opts.env,
            timeout,
            maxBuffer: 4 * 1024 * 1024,
        });
        const models = parseCursorModels(stdout);
        if (models.length === 0) {
            return { models, failure: `exit 0 with no model rows: ${lastLine(stdout) ?? 'empty output'}` };
        }
        return { models, failure: null };
    } catch (error) {
        return { models: [], failure: describeCursorListFailure(error, bin, timeout) };
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

const defaultSuffix = /\s*\(default\)$/;
/** What the picker says under the row cursor-agent marked `(default)`. */
export const cursorDefaultDescription = "cursor-agent's default";

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
            // `auto - Auto (default)`: the suffix is a fact about the row, not
            // part of its name, and a 14pt chip has no room for it. It goes
            // where the picker shows facts.
            const isDefault = defaultSuffix.test(opt.value);
            const value = familyLabel(opt.value.replace(defaultSuffix, ''), effort);
            models.push(isDefault ? { code: base, value, description: cursorDefaultDescription } : { code: base, value });
        }
        if (effort) seenEffort.add(effort);
    }

    const efforts = cursorEffortTiers
        .filter((t) => seenEffort.has(t))
        .map((t) => ({ code: t, value: effortLabels[t] }));

    return { models, efforts, ids };
}

/** What the picker says under a row the session published without a list. */
export const cursorFallbackDescription = 'cursor-agent could not list models';

/**
 * The catalog a session runs on when `--list-models` did not answer
 * (DROVE-395).
 *
 * Two rows at most, and both are TRUE: `auto`, which is cursor-agent's own
 * default and the first row of every list it has ever printed, and the family
 * the session was started with. Each is marked, so the picker says why it is
 * short instead of looking like a login with two models.
 *
 * NO TIERS, on purpose. The started id is split the way a listed one is, so a
 * pick of its family resolves back to the exact id by lookup; but an effort
 * scale nobody listed would resolve to ids nobody listed, and a turn on one of
 * those exits 1. So the dial stays hidden until the real list lands, and this
 * catalog never grows one.
 */
export function fallbackCursorModelCatalog(startedModel: string | null | undefined): CursorModelCatalog {
    const flat: CursorModelOption[] = [{ code: 'auto', value: 'Auto' }];
    const started = startedModel?.trim();
    if (started && started !== 'auto') {
        flat.push({ code: started, value: splitCursorModelId(started).base });
    }
    const built = buildCursorModelCatalog(flat);
    return {
        models: built.models.map((m) => ({ code: m.code, value: m.value, description: cursorFallbackDescription })),
        efforts: [],
        ids: built.ids,
    };
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
