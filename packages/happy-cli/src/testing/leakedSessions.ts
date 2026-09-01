/**
 * Which sessions in a sessions.json belong to a checkout (DROVE-336).
 *
 * A session leaked by a test or a benchmark run from a checkout carries that
 * checkout in its metadata: `path` is the cwd it started in, `happyLibDir` is
 * the packages/happy-cli it ran. Counting those before and after a run says
 * whether the run leaked, without blaming a real session Clay started
 * somewhere else in the meantime.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The daemon's persisted store, the one the phone lists. Always the real one. */
export const realSessionsFile = join(homedir(), '.happy', 'sessions.json');

interface SessionLike {
    id?: unknown;
    metadata?: { path?: unknown; happyLibDir?: unknown } | null;
}

function under(p: unknown, root: string): boolean {
    if (typeof p !== 'string') return false;
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return p === root || p.startsWith(prefix);
}

/**
 * The ids of every session whose metadata.path or happyLibDir is `root` or
 * under it. A file that is absent or not JSON is no sessions: this must never
 * be the thing that fails a run on a machine with no daemon.
 */
export function sessionsUnder(root: string, file: string = realSessionsFile): string[] {
    if (!existsSync(file)) return [];
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return [];
    }
    const sessions = (raw as { sessions?: unknown } | null)?.sessions;
    let entries: [string, SessionLike][];
    if (Array.isArray(sessions)) {
        entries = sessions.map((s, i) => [String((s as SessionLike)?.id ?? i), s as SessionLike]);
    } else if (sessions && typeof sessions === 'object') {
        entries = Object.entries(sessions as Record<string, SessionLike>);
    } else {
        return [];
    }
    return entries
        .filter(([, s]) => {
            const md = s?.metadata;
            return !!md && (under(md.path, root) || under(md.happyLibDir, root));
        })
        .map(([id]) => id);
}
