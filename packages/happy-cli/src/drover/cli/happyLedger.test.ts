/**
 * The daemon's ledger, as `drover sessions` and `drover stale-sessions` read
 * and write it (DROVE-389).
 *
 * Pure throughout: every file is under a mkdtemp of this test's own, the
 * server is a function handed in, the crypto is a plain one that JSONs, and
 * nothing here reaches ~/.happy or a socket. The two verbs' own tests drive
 * the same module through their entry points; this file is the module on its
 * own, one function at a time.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { droverEnv } from './env';
import {
    LEDGER_MAX_AGE_MS,
    accessTokenOf,
    archiveEntry,
    fetchServerSessions,
    flavorOf,
    happyHomeOf,
    harnessOf,
    ledgerFileOf,
    ledgerRow,
    ledgerRows,
    markLedgerArchived,
    pidAlive,
    readLedger,
    refreshRows,
    serverStates,
    serverUrlOf,
    type ArchiveAnswer,
    type ArchiveTransport,
    type FetchLike,
    type LedgerCrypto,
    type LedgerEntry,
    type ServerSession,
} from './happyLedger';

const NOW = 1_800_000_000_000;
const KEY = Buffer.alloc(32, 7).toString('base64');

/** A crypto that JSONs: the ledger code never looks inside a blob, only round-trips it. */
const plainCrypto: LedgerCrypto = {
    encrypt: (_key, _variant, data) => new Uint8Array(Buffer.from(JSON.stringify(data), 'utf8')),
    decrypt: (_key, _variant, data) => JSON.parse(Buffer.from(data).toString('utf8')) as unknown,
    encodeBase64: (b) => Buffer.from(b).toString('base64'),
    decodeBase64: (s) => new Uint8Array(Buffer.from(s, 'base64')),
};

const blob = (data: unknown): string => plainCrypto.encodeBase64(plainCrypto.encrypt(new Uint8Array(), 'legacy', data));

type RawEntry = Record<string, unknown>;

/** One entry as persistSession writes it. */
function raw(md: Record<string, unknown>, extra: RawEntry = {}): RawEntry {
    return {
        agentStateVersion: 0,
        encryptionKey: KEY,
        encryptionVariant: 'legacy',
        metadata: md,
        metadataVersion: 1,
        savedAt: NOW - 1000,
        seq: 0,
        ...extra,
    };
}

let dir: string;
let file: string;

function writeLedger(sessions: Record<string, RawEntry>): void {
    writeFileSync(file, JSON.stringify({ sessions }, null, 2));
}

function entries(sessions: Record<string, RawEntry>): LedgerEntry[] {
    writeLedger(sessions);
    return readLedger(file, NOW);
}

/** A pid that is certainly dead: this process's, plus a number no pid table reaches. */
const DEAD_PID = 2 ** 22 - 1;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-ledger-'));
    file = join(dir, 'sessions.json');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('happyLedger — where the ledger is', () => {
    it('HAPPY_HOME_DIR names the home, with a leading ~ expanded; unset is the drover home', () => {
        expect(happyHomeOf({ HAPPY_HOME_DIR: '/x/happy' }, '/Users/x')).toBe('/x/happy');
        expect(happyHomeOf({ HAPPY_HOME_DIR: '~/h' }, '/Users/x')).toBe('/Users/x/h');
        expect(happyHomeOf({ HAPPY_HOME_DIR: '~' }, '/Users/x')).toBe('/Users/x');
        expect(happyHomeOf({ HAPPY_HOME_DIR: '~x/h' }, '/Users/x')).toBe('~x/h');
        const env = { STATE_DIR: dir };
        expect(happyHomeOf(env, '/Users/x')).toBe(droverEnv(env, '/Users/x').happyHome);
        expect(ledgerFileOf({ HAPPY_HOME_DIR: '/x/happy' }, '/Users/x')).toBe('/x/happy/sessions.json');
    });

    it('the flavor and the harness are one word spelled two ways', () => {
        expect(flavorOf('claude-code')).toBe('claude');
        expect(flavorOf('codex')).toBe('codex');
        expect(flavorOf(undefined)).toBe('claude');
        expect(flavorOf('')).toBe('claude');
        expect(harnessOf('claude')).toBe('claude-code');
        expect(harnessOf('opencode')).toBe('opencode');
    });
});

describe('happyLedger — readLedger', () => {
    it('an absent, unreadable or misshapen file is an empty ledger, never an error', () => {
        expect(readLedger(join(dir, 'nope.json'), NOW)).toEqual([]);
        writeFileSync(file, '{not json');
        expect(readLedger(file, NOW)).toEqual([]);
        writeFileSync(file, JSON.stringify({ sessions: [1, 2] }));
        expect(readLedger(file, NOW)).toEqual([]);
        writeFileSync(file, JSON.stringify({ sessions: { a: 'not an object', b: null } }));
        expect(readLedger(file, NOW)).toEqual([]);
    });

    it('maps the fields, defaults the flavor to claude, and keeps the key for the archive path', () => {
        const [e] = entries({
            'aaaaaaaa-0000-0000-0000-000000000000': raw({
                path: '/Users/x/Projects/one',
                hostPid: 4242,
                startedBy: 'daemon',
                lifecycleState: 'running',
                name: 'fix the build',
                flavor: 'codex',
                droverAccount: 'a',
                machineId: 'm1',
            }),
        });
        expect(e).toMatchObject({
            id: 'aaaaaaaa-0000-0000-0000-000000000000',
            flavor: 'codex',
            path: '/Users/x/Projects/one',
            hostPid: 4242,
            startedBy: 'daemon',
            lifecycleState: 'running',
            name: 'fix the build',
            droverAccount: 'a',
            machineId: 'm1',
            savedAt: NOW - 1000,
            metadataVersion: 1,
            encryptionVariant: 'legacy',
            encryptionKey: KEY,
        });
        expect(e.metadata.name).toBe('fix the build');
        const [bare] = entries({ b: raw({}) });
        expect(bare).toMatchObject({ flavor: 'claude', path: '', hostPid: null, startedBy: null, lifecycleState: null, name: null });
    });

    it('drops an entry older than the fortnight readPersistedSessions keeps, and one with no key', () => {
        const kept = entries({
            fresh: raw({ flavor: 'codex' }),
            stale: raw({ flavor: 'codex' }, { savedAt: NOW - LEDGER_MAX_AGE_MS }),
            keyless: raw({ flavor: 'codex' }, { encryptionKey: '' }),
        });
        expect(kept.map((e) => e.id)).toEqual(['fresh']);
    });
});

describe('happyLedger — the rows', () => {
    it('every flavor but claude, never one already archived, newest first, live or ended by the pid', () => {
        const alive = (pid: number | null): boolean => pid === 4242;
        const rows = ledgerRows(entries({
            old: raw({ flavor: 'codex', hostPid: 4242, path: '/a' }, { savedAt: NOW - 5000 }),
            claude: raw({ flavor: 'claude', hostPid: 4242, path: '/b' }),
            bare: raw({ hostPid: 4242, path: '/b2' }),
            archived: raw({ flavor: 'cursor', hostPid: 4242, lifecycleState: 'archived', path: '/c' }),
            gone: raw({ flavor: 'opencode', hostPid: 99, path: '/d', name: 'count to ten' }, { savedAt: NOW - 1000 }),
        }), alive);
        expect(rows.map((r) => [r.id, r.state])).toEqual([['gone', 'ended'], ['old', 'live']]);
        expect(rows[0]).toMatchObject({
            title: 'count to ten',
            cwd: '/d',
            harness: 'opencode',
            flavor: 'opencode',
            origin: 'terminal',
            inputChannel: 'socket',
            source: 'happy',
            hostPid: 99,
        });
        expect(Object.keys(rows[0])).not.toContain('encryptionKey');
        expect(JSON.stringify(rows)).not.toContain(KEY);
    });

    it('a row started by the daemon says so, and a title is the name or nothing', () => {
        const [e] = entries({ x: raw({ flavor: 'pi', startedBy: 'daemon', droverAccount: 'acct' }) });
        expect(ledgerRow(e, () => true)).toMatchObject({ origin: 'daemon', account: 'acct', title: null, state: 'live' });
    });

    it('pidAlive: this process yes, a pid nobody has no, null no', () => {
        expect(pidAlive(process.pid)).toBe(true);
        expect(pidAlive(DEAD_PID)).toBe(false);
        expect(pidAlive(null)).toBe(false);
        expect(pidAlive(0)).toBe(false);
    });
});

describe('happyLedger — the server', () => {
    it('the token is access.key\'s, and no file, or a file that is not JSON, is no login', () => {
        expect(accessTokenOf(dir)).toBeNull();
        writeFileSync(join(dir, 'access.key'), 'nope');
        expect(accessTokenOf(dir)).toBeNull();
        writeFileSync(join(dir, 'access.key'), JSON.stringify({ token: 't0k', secret: 's' }));
        expect(accessTokenOf(dir)).toBe('t0k');
    });

    it('which server is configuration.ts\'s chain without configuration.ts: env, mode, settings.json, hosted', () => {
        const home = join(dir, 'happy');
        mkdirSync(home);
        const env = { HAPPY_HOME_DIR: home, STATE_DIR: dir };
        expect(serverUrlOf(env, '/Users/x')).toEqual({ url: 'https://api.cluster-fluster.com' });
        writeFileSync(join(home, 'settings.json'), JSON.stringify({ serverUrl: 'http://settings:1' }));
        expect(serverUrlOf(env, '/Users/x')).toEqual({ url: 'http://settings:1' });
        expect(serverUrlOf({ ...env, DROVER_SERVER_MODE: 'local' }, '/Users/x')).toEqual({ url: 'http://127.0.0.1:7971' });
        expect(serverUrlOf({ ...env, HAPPY_SERVER_URL: 'http://env:2', DROVER_SERVER_MODE: 'local' }, '/Users/x')).toEqual({ url: 'http://env:2' });
        // A mode that cannot be honoured is a sentence, not a throw: a listing
        // verb reports it and goes on.
        const bad = serverUrlOf({ ...env, DROVER_SERVER_MODE: 'estate' }, '/Users/x');
        expect('error' in bad && bad.error).toContain('DROVER_ESTATE_URL is unset');
    });

    it('fetchServerSessions: the bearer, the client header, the mapped list; a non-200 and a timeout throw a sentence', async () => {
        const calls: Array<{ url: string; headers: Record<string, string> }> = [];
        const answering: FetchLike = async (url, init) => {
            calls.push({ url, headers: init.headers });
            return {
                ok: true,
                status: 200,
                json: async () => ({ sessions: [{ id: 's1', active: true, activeAt: 5, updatedAt: 6, metadata: 'm', metadataVersion: 3 }, null, { id: 's2' }] }),
            };
        };
        const listed = await fetchServerSessions('http://srv', 't0k', 1000, answering);
        expect(calls[0].url).toBe('http://srv/v1/sessions');
        expect(calls[0].headers.Authorization).toBe('Bearer t0k');
        expect(calls[0].headers['X-Happy-Client']).toMatch(/^cli-coding-session\//);
        expect(listed).toEqual([
            { id: 's1', active: true, activeAt: 5, updatedAt: 6, metadata: 'm', metadataVersion: 3 },
            { id: 's2', active: false, activeAt: 0, updatedAt: 0, metadata: null, metadataVersion: 0 },
        ]);

        const refusing: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) });
        await expect(fetchServerSessions('http://srv', 't', 1000, refusing)).rejects.toThrow('http://srv answered 401');

        const hanging: FetchLike = (_url, init) => new Promise((_res, rej) => {
            init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
        await expect(fetchServerSessions('http://srv', 't', 20, hanging)).rejects.toThrow('http://srv did not answer within 0s');
    });

    it('serverStates: listed entries carry the server\'s word, decrypted with their own key; unlisted are absent; a blob that will not open is state unknown', () => {
        const es = entries({
            a: raw({ flavor: 'codex' }),
            b: raw({ flavor: 'codex' }),
            c: raw({ flavor: 'codex' }),
        });
        const listed: ServerSession[] = [
            { id: 'a', active: false, activeAt: 1, updatedAt: 1, metadata: blob({ lifecycleState: 'archived' }), metadataVersion: 4 },
            { id: 'c', active: true, activeAt: 9, updatedAt: 9, metadata: 'not base64 json', metadataVersion: 2 },
            { id: 'zzz', active: true, activeAt: 9, updatedAt: 9, metadata: null, metadataVersion: 2 },
        ];
        const states = serverStates(es, listed, plainCrypto);
        expect(states.get('a')).toEqual({ active: false, activeAt: 1, metadataVersion: 4, lifecycleState: 'archived' });
        expect(states.has('b')).toBe(false);
        expect(states.get('c')).toEqual({ active: true, activeAt: 9, metadataVersion: 2, lifecycleState: null });
        expect(states.has('zzz')).toBe(false);
    });
});

describe('happyLedger — refreshRows', () => {
    const home = (): string => {
        const h = join(dir, 'happy');
        mkdirSync(h, { recursive: true });
        return h;
    };

    it('no rows: nothing asked, no note', async () => {
        const r = await refreshRows([], [], { HAPPY_HOME_DIR: dir }, '/Users/x', 100, async () => {
            throw new Error('asked');
        });
        expect(r).toEqual({ rows: [], note: null });
    });

    it('no login: the rows stand and the note says where it looked', async () => {
        const h = home();
        const es = entries({ a: raw({ flavor: 'codex' }) });
        const rows = ledgerRows(es, () => true);
        const r = await refreshRows(rows, es, { HAPPY_HOME_DIR: h, STATE_DIR: dir }, '/Users/x', 100, async () => {
            throw new Error('asked');
        });
        expect(r.rows).toBe(rows);
        expect(r.note).toBe(`note: no login under ${h}; 1 daemon-registered row(s) shown from the ledger, which cannot say whether they are archived`);
    });

    it('a mode that cannot be honoured, or a server that does not answer, is a note and the rows stand', async () => {
        const h = home();
        writeFileSync(join(h, 'access.key'), JSON.stringify({ token: 't' }));
        const es = entries({ a: raw({ flavor: 'codex' }) });
        const rows = ledgerRows(es, () => true);
        const bad = await refreshRows(rows, es, { HAPPY_HOME_DIR: h, STATE_DIR: dir, DROVER_SERVER_MODE: 'estate' }, '/Users/x', 100, async () => []);
        expect(bad.rows).toBe(rows);
        expect(bad.note).toContain('note: drover: DROVER_SERVER_MODE=estate but DROVER_ESTATE_URL is unset');
        const down = await refreshRows(rows, es, { HAPPY_HOME_DIR: h, STATE_DIR: dir }, '/Users/x', 100, async () => {
            throw new Error('http://srv did not answer within 1s');
        });
        expect(down.rows).toBe(rows);
        expect(down.note).toBe('note: the happy server did not answer (http://srv did not answer within 1s); 1 daemon-registered row(s) shown from the ledger, which cannot say whether they are archived');
    });

    it('the server\'s word: an archived row is dropped, a listed one carries active and activeAt, an unlisted one stands as it was', async () => {
        const h = home();
        writeFileSync(join(h, 'access.key'), JSON.stringify({ token: 't' }));
        const es = entries({
            archived: raw({ flavor: 'codex' }),
            listed: raw({ flavor: 'cursor' }),
            unlisted: raw({ flavor: 'pi' }),
        });
        const rows = ledgerRows(es, () => true);
        const asked: string[] = [];
        const r = await refreshRows(
            rows,
            es,
            { HAPPY_HOME_DIR: h, STATE_DIR: dir, HAPPY_SERVER_URL: 'http://srv' },
            '/Users/x',
            100,
            async (url, token, timeoutMs) => {
                asked.push(`${url} ${token} ${timeoutMs}`);
                return [
                    { id: 'archived', active: false, activeAt: 1, updatedAt: 1, metadata: blob({ lifecycleState: 'archived' }), metadataVersion: 2 },
                    { id: 'listed', active: true, activeAt: 77, updatedAt: 77, metadata: blob({ lifecycleState: 'running' }), metadataVersion: 2 },
                ];
            },
            async () => plainCrypto,
        );
        expect(asked).toEqual(['http://srv t 100']);
        expect(r.note).toBeNull();
        expect(r.rows.map((x) => x.id)).toEqual(['listed', 'unlisted']);
        expect(r.rows[0]).toMatchObject({ active: true, activeAt: 77 });
        expect(r.rows[1].active).toBeUndefined();
    });
});

describe('happyLedger — the archive', () => {
    interface Recorded {
        transport: ArchiveTransport;
        updates: Array<{ sid: string; expectedVersion: number; metadata: unknown }>;
        archived: string[];
        closed: number;
    }

    /** A transport that answers from a script, one answer per updateMetadata call, and records everything. */
    function recording(answers: ArchiveAnswer[]): Recorded {
        const rec: Recorded = { updates: [], archived: [], closed: 0, transport: undefined as unknown as ArchiveTransport };
        rec.transport = {
            async updateMetadata(sid, expectedVersion, metadata) {
                rec.updates.push({ sid, expectedVersion, metadata: JSON.parse(Buffer.from(metadata, 'base64').toString('utf8')) });
                return answers.shift() ?? { result: 'error' };
            },
            async archive(sid) {
                rec.archived.push(sid);
                return true;
            },
            close() {
                rec.closed++;
            },
        };
        return rec;
    }

    it('success: the metadata is stamped archived with a time, then POST /archive', async () => {
        const [e] = entries({ a: raw({ flavor: 'codex', name: 'n', lifecycleState: 'running' }, { metadataVersion: 3 }) });
        const rec = recording([{ result: 'success' }]);
        expect(await archiveEntry(e, rec.transport, plainCrypto, () => 12345)).toBe('archived');
        expect(rec.updates).toEqual([{
            sid: 'a',
            expectedVersion: 3,
            metadata: { flavor: 'codex', name: 'n', lifecycleState: 'archived', lifecycleStateSince: 12345 },
        }]);
        expect(rec.archived).toEqual(['a']);
    });

    it('a version mismatch is retried on the server\'s metadata and version; one already archived there is counted as such', async () => {
        const [e] = entries({ a: raw({ flavor: 'codex', name: 'old name' }, { metadataVersion: 1 }) });
        const retried = recording([
            { result: 'version-mismatch', version: 5, metadata: blob({ flavor: 'codex', name: 'new name', lifecycleState: 'running' }) },
            { result: 'success' },
        ]);
        expect(await archiveEntry(e, retried.transport, plainCrypto, () => 1)).toBe('archived');
        expect(retried.updates.map((u) => u.expectedVersion)).toEqual([1, 5]);
        expect(retried.updates[1].metadata).toMatchObject({ name: 'new name', lifecycleState: 'archived' });

        const theirs = recording([{ result: 'version-mismatch', version: 2, metadata: blob({ lifecycleState: 'archived' }) }]);
        expect(await archiveEntry(e, theirs.transport, plainCrypto, () => 1)).toBe('already-archived');
        expect(theirs.archived).toEqual(['a']);
    });

    it('an error, a timeout, or three mismatches running is failed, and nothing is POSTed', async () => {
        const [e] = entries({ a: raw({ flavor: 'codex' }) });
        for (const answers of [[{ result: 'error' as const }], [{ result: 'timeout' as const }]]) {
            const rec = recording(answers);
            expect(await archiveEntry(e, rec.transport, plainCrypto)).toBe('failed');
            expect(rec.archived).toEqual([]);
        }
        const mismatch: ArchiveAnswer = { result: 'version-mismatch', version: 9, metadata: blob({ lifecycleState: 'running' }) };
        const rec = recording([mismatch, mismatch, mismatch, mismatch]);
        expect(await archiveEntry(e, rec.transport, plainCrypto)).toBe('failed');
        expect(rec.updates).toHaveLength(3);
        expect(rec.archived).toEqual([]);
    });

    it('markLedgerArchived writes the state through, keeps everything else, and is a no-op on nothing', () => {
        writeLedger({
            a: raw({ flavor: 'codex', name: 'a', lifecycleState: 'running' }),
            b: raw({ flavor: 'pi', name: 'b', lifecycleState: 'running' }),
        });
        expect(markLedgerArchived(file, [], NOW)).toBe(0);
        expect(markLedgerArchived(join(dir, 'absent.json'), ['a'], NOW)).toBe(0);
        expect(markLedgerArchived(file, ['a', 'nope'], NOW)).toBe(1);
        const after = JSON.parse(readFileSync(file, 'utf8')) as { sessions: Record<string, { metadata: Record<string, unknown>; encryptionKey: string }> };
        expect(after.sessions.a.metadata).toEqual({ flavor: 'codex', name: 'a', lifecycleState: 'archived', lifecycleStateSince: NOW });
        expect(after.sessions.a.encryptionKey).toBe(KEY);
        expect(after.sessions.b.metadata).toEqual({ flavor: 'pi', name: 'b', lifecycleState: 'running' });
        // And the next read agrees: the archived one is out of the rows.
        expect(ledgerRows(readLedger(file, NOW), () => true).map((r) => r.id)).toEqual(['b']);
    });
});
