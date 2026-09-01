/**
 * The models pi ACTUALLY reports, resolved by full provider-qualified lookup
 * (DROVE-316).
 *
 * DROVE-253 settled the rule on Cursor and this is it applied one harness
 * over: a model string is only real if the CLI itself lists it. Cursor's own
 * --help documented a bracket syntax for effort that turned out to be rejected
 * outright, so a picker that let a human type a model produced turns that
 * failed at exec with a message about neither the model nor the syntax.
 *
 * pi has a sharper version of the same problem, and it is not hypothetical.
 * On this machine `openai/gpt-oss-120b` is listed TWICE:
 *
 *     huggingface  openai/gpt-oss-120b   131.1K  32.8K  yes  no
 *     lmstudio     openai/gpt-oss-120b   131.1K   8.2K  no   no
 *
 * One of those is served by LM Studio on :1234 and answers. The other is a
 * cloud endpoint this machine has no key for — ~/.pi/agent/auth.json is empty
 * by design. Guessing between them is a session that fails on its first turn
 * with an auth error about a provider nobody chose. So a short name that
 * matches more than one row is REFUSED here, before the session starts, with
 * both candidates named. pi itself refuses it too; this refuses it earlier and
 * says more.
 *
 * The table is `provider  id  context  max-out  thinking  images`, and the id
 * can itself contain slashes (`openai/gpt-oss-120b`), so a ref is the provider
 * and the id joined by the FIRST slash and split by the first slash — never by
 * the last, and never by splitting the whole ref on every slash.
 *
 * The header row spells its first column "provider", which is not one, so it is
 * dropped BY NAME rather than by position. A table that grew a title line above
 * it would break a `slice(1)` and not this.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Providers served by something running on this machine.
 *
 * Not a tidiness filter. pi knows about a great many models it has no key for,
 * and the ones that can actually answer here are the ones a local runtime is
 * serving — so this list decides which models are offered first and which
 * runtime gets health-checked before the session starts.
 */
export const PI_LOCAL_PROVIDERS: readonly string[] = [
    'lmstudio',
    'glm',
    'ollama',
    'llamacpp',
    'lmstudio-local',
];

export interface PiModel {
    provider: string;
    /** The id as pi prints it. May contain slashes. */
    id: string;
    /** `provider/id`, the form `--model` accepts. */
    ref: string;
    local: boolean;
}

export type PiModelResolution =
    | { ok: true; model: PiModel }
    | { ok: false; reason: 'unknown' | 'ambiguous' | 'empty'; message: string };

function localProviders(env: NodeJS.ProcessEnv): Set<string> {
    const raw = env.DROVER_PI_LOCAL;
    const list = raw ? raw.split(',') : PI_LOCAL_PROVIDERS;
    return new Set(list.map((s) => s.trim()).filter(Boolean));
}

/** Parse the `pi --list-models` table. */
export function parsePiModels(
    stdout: string,
    env: NodeJS.ProcessEnv = process.env,
): PiModel[] {
    const locals = localProviders(env);
    const out: PiModel[] = [];
    for (const line of stdout.split('\n')) {
        const cols = line.trim().split(/\s+/).filter(Boolean);
        if (cols.length < 2) continue;
        // Dropped by NAME, not by position. See the header note above.
        if (cols[0] === 'provider') continue;
        const provider = cols[0];
        const id = cols[1];
        out.push({ provider, id, ref: `${provider}/${id}`, local: locals.has(provider) });
    }
    return out;
}

/** Ask pi. An empty list is not an error here; the caller decides. */
export async function listPiModels(
    piBin: string,
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<PiModel[]> {
    try {
        const { stdout } = await execFileAsync(piBin, ['--list-models'], {
            cwd,
            env,
            timeout: 60_000,
            maxBuffer: 8 * 1024 * 1024,
        });
        return parsePiModels(stdout, env);
    } catch {
        return [];
    }
}

function listLocals(models: readonly PiModel[]): string {
    const local = models.filter((m) => m.local).map((m) => `    ${m.ref}`);
    if (local.length === 0) return '    (none — no local provider is registered)';
    return local.join('\n');
}

/**
 * `provider/id`, a bare id, or a unique substring -> the one model pi means.
 *
 * Exact first, so `lmstudio/openai/gpt-oss-120b` can never lose to a substring
 * that also matches a huggingface row. Then substring, and ONLY when it hits
 * exactly one row. Ambiguous and unknown are both errors that name the
 * alternatives; neither is ever resolved by picking the first, the local one,
 * or the shortest.
 */
export function resolvePiModel(
    models: readonly PiModel[],
    want: string,
): PiModelResolution {
    if (models.length === 0) {
        return {
            ok: false,
            reason: 'empty',
            message:
                'drover pi: pi listed no models at all. Is it configured?\n'
                + '  check with:  pi --list-models',
        };
    }
    const exact = models.filter((m) => m.ref === want);
    if (exact.length === 1) return { ok: true, model: exact[0] };

    const hits = models.filter((m) => m.ref.includes(want));
    if (hits.length === 1) return { ok: true, model: hits[0] };
    if (hits.length === 0) {
        return {
            ok: false,
            reason: 'unknown',
            message:
                `drover pi: pi does not report a model matching '${want}'.\n`
                + '  what it does report locally:\n'
                + `${listLocals(models)}\n`
                + '  everything:  pi --list-models',
        };
    }
    return {
        ok: false,
        reason: 'ambiguous',
        message:
            `drover pi: '${want}' matches ${hits.length} models. Name one exactly:\n`
            + hits.map((m) => `    ${m.ref}`).join('\n'),
    };
}

/**
 * The model pi would use with no flag, from pi's own settings.
 *
 * Read rather than guessed, and returned as a full ref so it goes through the
 * same lookup as an explicit pick.
 */
export function defaultPiModelRef(settings: unknown): string | null {
    if (!settings || typeof settings !== 'object') return null;
    const s = settings as { defaultProvider?: unknown; defaultModel?: unknown };
    if (typeof s.defaultProvider !== 'string' || typeof s.defaultModel !== 'string') return null;
    if (!s.defaultProvider || !s.defaultModel) return null;
    return `${s.defaultProvider}/${s.defaultModel}`;
}
