/**
 * The daemon's session ledger, for the verbs that list and retire sessions
 * (DROVE-389).
 *
 * WHAT IT IS. Every session that reports itself to the daemon is written to
 * `<happy home>/sessions.json` (src/daemon/run.ts, persistSession): its id, the
 * metadata it announced, and the key its records are encrypted under. That is
 * every flavor — claude, codex, cursor, opencode, gemini, pi — because every
 * runner calls notifyDaemonSessionStarted. The drover bus, by contrast, knows
 * what the Claude Code hooks and the ~/.claude/projects scan tell it, so a
 * codex or opencode session started from the phone was on the phone and
 * nowhere in `drover sessions`: the green "cattle-drover" row Clay saw for a
 * killed opencode session, with nothing on the terminal to explain it. This
 * module is how `drover sessions` and `drover stale-sessions` read the ledger.
 *
 * WHAT IT IS NOT. Not the session machinery. Nothing here imports
 * configuration, persistence or api/api, which the tests of both verbs mock to
 * THROW on import (DROVE-336): the file is read with fs, the home is resolved
 * the way configuration.ts resolves it, the server the way serverUrl.ts does,
 * and the key material stays inside the entry for the archive path and is
 * never printed. The encryption and socket modules are imported lazily, by
 * the one path that writes.
 *
 * THE LEDGER IS A SNAPSHOT. The daemon writes an entry once, when the session
 * reports itself, so `lifecycleState` there is the STARTING state, 'running',
 * for every entry, including sessions the phone archived weeks ago. What is
 * current is the pid: hostPid is the runner, and a dead runner is a session
 * that ended, however it ended. So a row says live or ended from the pid, and
 * the SERVER is asked whether a session is already archived where a verb needs
 * to know: always before an archive is written, and best-effort in `drover
 * sessions`, which says so when it could not ask.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveServerUrls } from '../../serverUrl';
import { droverEnv } from './env';

type Env = Record<string, string | undefined>;

/** persistence.ts's SESSION_MAX_AGE_MS: what readPersistedSessions still returns. */
export const LEDGER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface LedgerEntry {
    id: string;
    /** metadata.flavor; 'claude' when the runner stamped none, as the app assumes. */
    flavor: string;
    /** metadata.path — the cwd the session started in. */
    path: string;
    hostPid: number | null;
    startedBy: string | null;
    /** As written at registration. 'running' for everything the daemon ever saw; see the header. */
    lifecycleState: string | null;
    name: string | null;
    droverAccount: string | null;
    claudeSessionId: string | null;
    machineId: string | null;
    /** When the daemon wrote the entry, epoch ms. */
    savedAt: number;
    metadataVersion: number;
    encryptionVariant: 'legacy' | 'dataKey';
    /** Base64. For the archive path only; never printed, never in --json. */
    encryptionKey: string;
    metadata: Record<string, unknown>;
}

/**
 * The happy home, the way configuration.ts reads it: HAPPY_HOME_DIR with a
 * leading ~ expanded, else the drover's happy home (~/.happy, or ~/.drover/happy
 * once `drover home migrate` has run).
 */
export function happyHomeOf(env: Env = process.env, home: string = homedir()): string {
    const raw = env.HAPPY_HOME_DIR;
    if (raw) return raw.replace(/^~(?=$|\/)/, home);
    return droverEnv(env, home).happyHome;
}

export function ledgerFileOf(env: Env = process.env, home: string = homedir()): string {
    return join(happyHomeOf(env, home), 'sessions.json');
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * The ledger, entry by entry, within the same fourteen-day window
 * readPersistedSessions applies. A file that is absent, unreadable or not the
 * expected shape is an empty ledger: this must never be the thing that fails a
 * verb on a machine with no daemon.
 */
export function readLedger(file: string, now: number = Date.now()): LedgerEntry[] {
    if (!existsSync(file)) return [];
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return [];
    }
    const sessions = (raw as { sessions?: unknown } | null)?.sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return [];
    const out: LedgerEntry[] = [];
    for (const [id, value] of Object.entries(sessions as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const e = value as Record<string, unknown>;
        const savedAt = typeof e.savedAt === 'number' ? e.savedAt : 0;
        if (now - savedAt >= LEDGER_MAX_AGE_MS) continue;
        const md = e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata)
            ? e.metadata as Record<string, unknown>
            : {};
        const key = str(e.encryptionKey);
        if (!key) continue;
        out.push({
            id,
            flavor: str(md.flavor) ?? 'claude',
            path: str(md.path) ?? '',
            hostPid: typeof md.hostPid === 'number' && md.hostPid > 0 ? md.hostPid : null,
            startedBy: str(md.startedBy),
            lifecycleState: str(md.lifecycleState),
            name: str(md.name),
            droverAccount: str(md.droverAccount),
            claudeSessionId: str(md.claudeSessionId),
            machineId: str(md.machineId),
            savedAt,
            metadataVersion: typeof e.metadataVersion === 'number' ? e.metadataVersion : 0,
            encryptionVariant: e.encryptionVariant === 'dataKey' ? 'dataKey' : 'legacy',
            encryptionKey: key,
            metadata: md,
        });
    }
    return out;
}

/** `kill -0`: alive, or alive but not ours (EPERM), which is still alive. */
export function pidAlive(pid: number | null): boolean {
    if (pid === null || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as { code?: string }).code === 'EPERM';
    }
}

/** The bus's word for a flavor: it says claude-code where the server says claude. */
export function harnessOf(flavor: string): string {
    return flavor === 'claude' ? 'claude-code' : flavor;
}

/** And back: the server's word for a bus harness, for the FLAVOR column. */
export function flavorOf(harness: unknown): string {
    if (typeof harness !== 'string' || harness === '') return 'claude';
    return harness === 'claude-code' ? 'claude' : harness;
}

/** One ledger entry in the shape of a bus row, so the renderer treats both alike. */
export interface LedgerRow {
    id: string;
    title: string | null;
    cwd: string;
    account: string | null;
    state: 'live' | 'ended';
    pane: null;
    paneAmbiguous: false;
    origin: 'daemon' | 'terminal';
    harness: string;
    flavor: string;
    /** The session socket is how the phone reaches every registered runner. */
    inputChannel: 'socket';
    hasSocket: false;
    endpoint: null;
    permissionMode: null;
    lastActivity: number;
    subagents: [];
    hostPid: number | null;
    startedBy: string | null;
    lifecycleState: string | null;
    /** Where the row came from, so a --json reader can tell it from a bus row. */
    source: 'happy';
    /** From the server, when it answered. */
    active?: boolean;
    activeAt?: number;
}

export function ledgerRow(entry: LedgerEntry, alive: (pid: number | null) => boolean = pidAlive): LedgerRow {
    return {
        id: entry.id,
        title: entry.name,
        cwd: entry.path,
        account: entry.droverAccount,
        state: alive(entry.hostPid) ? 'live' : 'ended',
        pane: null,
        paneAmbiguous: false,
        origin: entry.startedBy === 'daemon' ? 'daemon' : 'terminal',
        harness: harnessOf(entry.flavor),
        flavor: entry.flavor,
        inputChannel: 'socket',
        hasSocket: false,
        endpoint: null,
        permissionMode: null,
        lastActivity: entry.savedAt,
        subagents: [],
        hostPid: entry.hostPid,
        startedBy: entry.startedBy,
        lifecycleState: entry.lifecycleState,
        source: 'happy',
    };
}

/**
 * The rows the ledger adds to a table: every flavor but claude, newest first.
 * Claude is the bus's, hook by hook and transcript by transcript, and it
 * knows the pane, the account and the mode, which the ledger does not; a
 * second row for the same conversation under its happy id would be the
 * confusion this exists to end. An entry the ledger itself marks archived
 * (the archive path below writes that through) is gone from the phone and
 * gone from here.
 */
export function ledgerRows(entries: LedgerEntry[], alive: (pid: number | null) => boolean = pidAlive): LedgerRow[] {
    return entries
        .filter((e) => e.flavor !== 'claude' && e.lifecycleState !== 'archived')
        .sort((a, b) => b.savedAt - a.savedAt)
        .map((e) => ledgerRow(e, alive));
}

// --- the server ------------------------------------------------------------------

/** The bearer token out of access.key. Null when there is no login here. */
export function accessTokenOf(happyHome: string): string | null {
    try {
        const raw = JSON.parse(readFileSync(join(happyHome, 'access.key'), 'utf8')) as { token?: unknown };
        return str(raw?.token);
    } catch {
        return null;
    }
}

/**
 * Which server, the way configuration.ts decides it (HAPPY_SERVER_URL, then
 * the drover mode, then settings.json in the happy home, then hosted), without
 * constructing configuration. A mode that cannot be honoured is an error
 * string rather than a throw, because a listing verb reports it and goes on.
 */
export function serverUrlOf(env: Env = process.env, home: string = homedir()): { url: string } | { error: string } {
    const settingsFile = join(happyHomeOf(env, home), 'settings.json');
    const settings = (key: 'serverUrl' | 'webappUrl'): string | undefined => {
        try {
            const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
            return str(raw?.[key]) ?? undefined;
        } catch {
            return undefined;
        }
    };
    try {
        return { url: resolveServerUrls(env as NodeJS.ProcessEnv, settings).serverUrl };
    } catch (e) {
        return { error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
    }
}

/** One session as GET /v1/sessions returns it: the metadata still encrypted. */
export interface ServerSession {
    id: string;
    active: boolean;
    activeAt: number;
    updatedAt: number;
    metadata: string | null;
    metadataVersion: number;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The account's sessions, newest 150, as the server lists them. Throws with a
 * one-line reason on anything but a 200: the callers decide what a server
 * that did not answer means for them.
 */
export async function fetchServerSessions(
    serverUrl: string,
    token: string,
    timeoutMs: number,
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ServerSession[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(`${serverUrl}/v1/sessions`, {
            headers: { Authorization: `Bearer ${token}`, 'X-Happy-Client': `cli-coding-session/${cliVersion()}` },
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`${serverUrl} answered ${res.status}`);
        const body = await res.json() as { sessions?: unknown };
        const list = Array.isArray(body?.sessions) ? body.sessions : [];
        return list.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object').map((s) => ({
            id: String(s.id ?? ''),
            active: s.active === true,
            activeAt: typeof s.activeAt === 'number' ? s.activeAt : 0,
            updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
            metadata: str(s.metadata),
            metadataVersion: typeof s.metadataVersion === 'number' ? s.metadataVersion : 0,
        }));
    } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') throw new Error(`${serverUrl} did not answer within ${Math.round(timeoutMs / 1000)}s`);
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/** The crypto the archive and the refresh need, as an object so a test can hand in its own. */
export interface LedgerCrypto {
    encrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: unknown): Uint8Array;
    decrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: Uint8Array): unknown;
    encodeBase64(buffer: Uint8Array): string;
    decodeBase64(base64: string): Uint8Array;
}

/** The real one, loaded only when a caller gets this far: tweetnacl is not a listing's business. */
export async function ledgerCrypto(): Promise<LedgerCrypto> {
    const m = await import('../../api/encryption');
    return { encrypt: m.encrypt, decrypt: m.decrypt, encodeBase64: (b) => m.encodeBase64(b), decodeBase64: (s) => m.decodeBase64(s) };
}

/** What the server currently says about one ledger entry, decrypted with the entry's own key. */
export interface ServerState {
    active: boolean;
    activeAt: number;
    metadataVersion: number;
    lifecycleState: string | null;
}

/**
 * The server's word on each entry it still lists, keyed by id. An entry the
 * server no longer lists (it lists the newest 150) is simply absent, and a
 * blob the entry's key cannot open is reported with no lifecycleState rather
 * than dropped: the row is still real, only its state is unknown.
 */
export function serverStates(entries: LedgerEntry[], listed: ServerSession[], crypto: LedgerCrypto): Map<string, ServerState> {
    const byId = new Map(listed.map((s) => [s.id, s]));
    const out = new Map<string, ServerState>();
    for (const e of entries) {
        const s = byId.get(e.id);
        if (!s) continue;
        let lifecycleState: string | null = null;
        if (s.metadata) {
            try {
                const md = crypto.decrypt(crypto.decodeBase64(e.encryptionKey), e.encryptionVariant, crypto.decodeBase64(s.metadata)) as Record<string, unknown> | null;
                lifecycleState = str(md?.lifecycleState);
            } catch {
                lifecycleState = null;
            }
        }
        out.set(e.id, { active: s.active, activeAt: s.activeAt, metadataVersion: s.metadataVersion, lifecycleState });
    }
    return out;
}

/**
 * The rows `drover sessions` shows from the ledger, after the server has had
 * its say: one archived on the server is dropped, one it still lists carries
 * `active` and `activeAt`. Best effort, and honest about it: with no login,
 * a mode that does not resolve, or a server that does not answer within
 * `timeoutMs`, the rows are shown as the ledger has them and the note says
 * why they might already be gone from the phone.
 */
export async function refreshRows(
    rows: LedgerRow[],
    entries: LedgerEntry[],
    env: Env,
    home: string,
    timeoutMs: number,
    list: (serverUrl: string, token: string, timeoutMs: number) => Promise<ServerSession[]> = fetchServerSessions,
    crypto: () => Promise<LedgerCrypto> = ledgerCrypto,
): Promise<{ rows: LedgerRow[]; note: string | null }> {
    if (rows.length === 0) return { rows, note: null };
    const shown = `${rows.length} daemon-registered row(s) shown from the ledger, which cannot say whether they are archived`;
    const happyHome = happyHomeOf(env, home);
    const token = accessTokenOf(happyHome);
    if (!token) return { rows, note: `note: no login under ${happyHome}; ${shown}` };
    const server = serverUrlOf(env, home);
    if ('error' in server) return { rows, note: `note: ${server.error}; ${shown}` };
    let listed: ServerSession[];
    try {
        listed = await list(server.url, token, timeoutMs);
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return { rows, note: `note: the happy server did not answer (${reason}); ${shown}` };
    }
    const ids = new Set(rows.map((r) => r.id));
    const states = serverStates(entries.filter((e) => ids.has(e.id)), listed, await crypto());
    const kept: LedgerRow[] = [];
    for (const row of rows) {
        const state = states.get(row.id);
        if (state?.lifecycleState === 'archived') continue;
        if (state) {
            row.active = state.active;
            row.activeAt = state.activeAt;
        }
        kept.push(row);
    }
    return { rows: kept, note: null };
}

// --- the archive ------------------------------------------------------------------
//
// What the app's Archive button does, from the terminal: stamp
// lifecycleState='archived' into the metadata over the socket (the rule the
// app's isSessionArchived and the watch feed read), then POST /archive so the
// server marks it inactive too. The metadata write is versioned; a mismatch
// hands back the current metadata, which is re-read and re-stamped, and if
// the current metadata is already archived the job is done by somebody else.

export interface ArchiveAnswer {
    result: 'success' | 'version-mismatch' | 'error' | 'timeout';
    version?: number;
    metadata?: string;
}

export interface ArchiveTransport {
    updateMetadata(sid: string, expectedVersion: number, metadata: string): Promise<ArchiveAnswer>;
    /** POST /v1/sessions/:id/archive; true on a 2xx. */
    archive(sid: string): Promise<boolean>;
    close(): void;
}

export type ArchiveOutcome = 'archived' | 'already-archived' | 'failed';

export async function archiveEntry(
    entry: LedgerEntry,
    transport: ArchiveTransport,
    crypto: LedgerCrypto,
    now: () => number = Date.now,
): Promise<ArchiveOutcome> {
    const key = crypto.decodeBase64(entry.encryptionKey);
    let version = entry.metadataVersion;
    let meta: Record<string, unknown> = entry.metadata;
    for (let attempt = 0; attempt < 3; attempt++) {
        const updated = { ...meta, lifecycleState: 'archived', lifecycleStateSince: now() };
        const answer = await transport.updateMetadata(entry.id, version, crypto.encodeBase64(crypto.encrypt(key, entry.encryptionVariant, updated)));
        if (answer.result === 'success') {
            await transport.archive(entry.id);
            return 'archived';
        }
        if (answer.result !== 'version-mismatch') return 'failed';
        if (typeof answer.version === 'number') version = answer.version;
        let current: Record<string, unknown> | null = null;
        if (answer.metadata) {
            try {
                current = crypto.decrypt(key, entry.encryptionVariant, crypto.decodeBase64(answer.metadata)) as Record<string, unknown> | null;
            } catch {
                current = null;
            }
        }
        if (current) meta = current;
        if (current?.lifecycleState === 'archived') {
            await transport.archive(entry.id);
            return 'already-archived';
        }
    }
    return 'failed';
}

/** The CLI version the server sees in X-Happy-Client, from this package. */
function cliVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
        return str(pkg.version) ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * The real transport: one user-scoped socket on /v1/updates, the same one the
 * archive-leaked-sessions script used, and plain HTTP for the POST. Loaded
 * only here, by the one caller that writes.
 */
export async function socketArchiveTransport(serverUrl: string, token: string, timeoutMs: number = 8000): Promise<ArchiveTransport> {
    const { io } = await import('socket.io-client');
    const happyClient = `cli-coding-session/${cliVersion()}`;
    const socket = io(serverUrl, {
        auth: { token, clientType: 'user-scoped' as const, happyClient },
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
        withCredentials: true,
        autoConnect: false,
    });
    await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`${serverUrl} did not accept the socket within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        socket.on('connect', () => {
            clearTimeout(timer);
            res();
        });
        socket.on('connect_error', (e: Error) => {
            clearTimeout(timer);
            rej(e);
        });
        socket.connect();
    });
    return {
        async updateMetadata(sid, expectedVersion, metadata) {
            try {
                return await socket.timeout(timeoutMs).emitWithAck('update-metadata', { sid, expectedVersion, metadata }) as ArchiveAnswer;
            } catch {
                return { result: 'timeout' };
            }
        },
        async archive(sid) {
            try {
                const res = await fetch(`${serverUrl}/v1/sessions/${sid}/archive`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'X-Happy-Client': happyClient, 'Content-Type': 'application/json' },
                    body: '{}',
                    signal: AbortSignal.timeout(timeoutMs),
                });
                return res.ok;
            } catch {
                return false;
            }
        },
        close() {
            socket.disconnect();
        },
    };
}

/**
 * Write the archive through to the ledger, so the next `drover sessions` does
 * not list a session the server has just retired. The same tmp-then-rename the
 * daemon uses, on the same file; entries the daemon added in between are kept,
 * because the file is re-read first.
 */
export function markLedgerArchived(file: string, ids: string[], now: number = Date.now()): number {
    if (ids.length === 0 || !existsSync(file)) return 0;
    let raw: { sessions?: Record<string, { metadata?: Record<string, unknown> }> };
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return 0;
    }
    if (!raw?.sessions || typeof raw.sessions !== 'object') return 0;
    let marked = 0;
    for (const id of ids) {
        const entry = raw.sessions[id];
        if (!entry || typeof entry !== 'object') continue;
        entry.metadata = { ...(entry.metadata ?? {}), lifecycleState: 'archived', lifecycleStateSince: now };
        marked++;
    }
    if (marked === 0) return 0;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
    renameSync(tmp, file);
    return marked;
}
