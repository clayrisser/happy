import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64, encrypt } from '@/api/encryption';

const mocks = vi.hoisted(() => ({
    mockReadPersistedSessions: vi.fn(),
    mockReadCredentials: vi.fn(),
    mockClaudeFindLastSession: vi.fn(),
    mockAxiosGet: vi.fn(),
}));

vi.mock('@/persistence', () => ({
    readPersistedSessions: mocks.mockReadPersistedSessions,
    readCredentials: mocks.mockReadCredentials,
}));

vi.mock('@/claude/utils/claudeFindLastSession', () => ({
    claudeFindLastSession: mocks.mockClaudeFindLastSession,
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://api.example.test',
        currentCliVersion: '1.2.2',
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

vi.mock('axios', () => ({
    default: { get: mocks.mockAxiosGet },
}));

import { findHappySessionForClaudeSession, resumedClaudeSessionId } from './reattachClaudeSession';

const claudeId = '9ae61ba4-8a3b-452f-a294-da49d0019c79';
const otherClaudeId = '11111111-2222-4333-8444-555555555555';

describe('resumedClaudeSessionId', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reads --resume <uuid> even after the drover default flag', () => {
        expect(resumedClaudeSessionId(['--dangerously-skip-permissions', '--resume', claudeId], '/repo')).toBe(claudeId);
        expect(resumedClaudeSessionId(['-r', claudeId], '/repo')).toBe(claudeId);
    });

    it('leaves the picker and non-uuid values alone', () => {
        expect(resumedClaudeSessionId(['--resume'], '/repo')).toBeNull();
        expect(resumedClaudeSessionId(['--resume', '--dangerously-skip-permissions'], '/repo')).toBeNull();
        expect(resumedClaudeSessionId(['--resume', 'not-a-uuid'], '/repo')).toBeNull();
        expect(resumedClaudeSessionId(undefined, '/repo')).toBeNull();
        expect(resumedClaudeSessionId(['--model', 'opus'], '/repo')).toBeNull();
    });

    it('reads the args bin/drover builds from its own picker (DROVE-50)', () => {
        // A bare `drover --resume` no longer reaches this CLI bare: bin/drover
        // picks the transcript first and prepends `--resume <id>` to whatever
        // else was typed, after its own default flag. This is the shape that
        // has to resolve, or the reattach never runs and the phone gets a
        // second, empty session for a conversation it already holds.
        const fromPicker = ['--dangerously-skip-permissions', '--resume', claudeId, '--model', 'opus'];
        expect(resumedClaudeSessionId(fromPicker, '/repo')).toBe(claudeId);
        // `drover -c` is rewritten the same way, so the CLI never has to ask
        // claudeFindLastSession itself for a drover-started session.
        expect(mocks.mockClaudeFindLastSession).not.toHaveBeenCalled();
    });

    it('resolves --continue the way claudeLocal does', () => {
        mocks.mockClaudeFindLastSession.mockReturnValue(claudeId);
        expect(resumedClaudeSessionId(['--continue'], '/repo')).toBe(claudeId);
        expect(mocks.mockClaudeFindLastSession).toHaveBeenCalledWith('/repo');
        mocks.mockClaudeFindLastSession.mockReturnValue(null);
        expect(resumedClaudeSessionId(['-c'], '/repo')).toBeNull();
    });
});

describe('findHappySessionForClaudeSession', () => {
    const keyA = new Uint8Array(32).fill(1);
    const keyB = new Uint8Array(32).fill(2);

    function serverSession(opts: {
        id: string;
        key: Uint8Array;
        metadata: Record<string, unknown>;
        updatedAt: number;
        active?: boolean;
        activeAt?: number;
        seq?: number;
    }) {
        return {
            id: opts.id,
            seq: opts.seq ?? 10,
            updatedAt: opts.updatedAt,
            active: opts.active ?? false,
            activeAt: opts.activeAt ?? opts.updatedAt,
            metadata: encodeBase64(encrypt(opts.key, 'legacy', opts.metadata)),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 3,
        };
    }

    function persisted(key: Uint8Array) {
        return {
            encryptionKey: encodeBase64(key),
            encryptionVariant: 'legacy' as const,
            seq: 0,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: { path: '/repo' },
            savedAt: Date.now(),
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockReadCredentials.mockResolvedValue({ token: 'tok', encryption: { type: 'legacy', secret: keyA } });
        mocks.mockReadPersistedSessions.mockReturnValue({ 'happy-a': persisted(keyA), 'happy-b': persisted(keyB) });
    });

    it('returns the Happy session whose server metadata names the Claude session, with server versions', async () => {
        mocks.mockAxiosGet.mockResolvedValue({
            data: {
                sessions: [
                    serverSession({ id: 'happy-b', key: keyB, metadata: { path: '/repo', claudeSessionId: otherClaudeId }, updatedAt: 2000 }),
                    serverSession({ id: 'happy-a', key: keyA, metadata: { path: '/repo', claudeSessionId: claudeId, name: 'titled' }, updatedAt: 1000, seq: 41 }),
                    // Not in the local store: no key, so it cannot be a candidate.
                    serverSession({ id: 'happy-foreign', key: keyB, metadata: { path: '/repo', claudeSessionId: claudeId }, updatedAt: 3000 }),
                ],
            },
        });

        await expect(findHappySessionForClaudeSession(claudeId)).resolves.toMatchObject({
            id: 'happy-a',
            seq: 41,
            metadataVersion: 7,
            agentStateVersion: 3,
            encryptionVariant: 'legacy',
            encryptionKey: keyA,
            metadata: { claudeSessionId: claudeId, name: 'titled' },
        });
        expect(mocks.mockAxiosGet).toHaveBeenCalledWith(
            'https://api.example.test/v1/sessions',
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
        );
    });

    it('prefers the most recently updated of several matches', async () => {
        mocks.mockAxiosGet.mockResolvedValue({
            data: {
                sessions: [
                    serverSession({ id: 'happy-a', key: keyA, metadata: { path: '/repo', claudeSessionId: claudeId }, updatedAt: 1000 }),
                    serverSession({ id: 'happy-b', key: keyB, metadata: { path: '/repo', claudeSessionId: claudeId }, updatedAt: 5000 }),
                ],
            },
        });

        await expect(findHappySessionForClaudeSession(claudeId)).resolves.toMatchObject({ id: 'happy-b' });
    });

    it('refuses to join a session another wrapper is still driving', async () => {
        mocks.mockAxiosGet.mockResolvedValue({
            data: {
                sessions: [
                    serverSession({
                        id: 'happy-a', key: keyA, metadata: { path: '/repo', claudeSessionId: claudeId },
                        updatedAt: Date.now(), active: true, activeAt: Date.now() - 2_000,
                    }),
                ],
            },
        });

        await expect(findHappySessionForClaudeSession(claudeId)).resolves.toBeNull();
    });

    it('joins a session the server still calls active when its keepalives stopped a while ago', async () => {
        mocks.mockAxiosGet.mockResolvedValue({
            data: {
                sessions: [
                    serverSession({
                        id: 'happy-a', key: keyA, metadata: { path: '/repo', claudeSessionId: claudeId },
                        updatedAt: Date.now(), active: true, activeAt: Date.now() - 5 * 60_000,
                    }),
                ],
            },
        });

        await expect(findHappySessionForClaudeSession(claudeId)).resolves.toMatchObject({ id: 'happy-a' });
    });

    it('resolves the args bin/drover builds from its own picker onto the session that already holds the transcript (DROVE-50)', async () => {
        // The two halves of the fix, joined without a mock between them.
        //
        // Before DROVE-50 a bare `drover --resume` reached this CLI still
        // bare, resumedClaudeSessionId returned null, findHappySessionFor-
        // ClaudeSession was never called, and runClaude minted a second Happy
        // session for a conversation the phone already had one for. Now
        // bin/drover's picker resolves the transcript first and starts the CLI
        // with these args, so the same run finds `happy-a` and joins it.
        //
        // What runClaude does with a non-null answer is pinned next door in
        // runClaude.test.ts: api.getOrCreateSession is not called at all.
        mocks.mockAxiosGet.mockResolvedValue({
            data: {
                sessions: [
                    serverSession({ id: 'happy-a', key: keyA, metadata: { path: '/repo', claudeSessionId: claudeId, name: 'DROVER' }, updatedAt: 1000 }),
                ],
            },
        });

        const fromPicker = ['--dangerously-skip-permissions', '--resume', claudeId, '--model', 'opus'];
        const resolved = resumedClaudeSessionId(fromPicker, '/repo');
        expect(resolved).toBe(claudeId);
        await expect(findHappySessionForClaudeSession(resolved!)).resolves.toMatchObject({
            id: 'happy-a',
            // The name the app already knows survives, which is the other half
            // of "the conversation is gone" from the phone.
            metadata: { claudeSessionId: claudeId, name: 'DROVER' },
        });

        // And the shape it used to arrive in still resolves to nothing, so the
        // null branch this replaced is still the one an unwrapped `claude
        // --resume` (or DROVER_RESUME_PICKER=0) takes.
        expect(resumedClaudeSessionId(['--dangerously-skip-permissions', '--resume'], '/repo')).toBeNull();
    });

    it('falls back to a fresh session when nothing matches, the store is empty, or the server is down', async () => {
        mocks.mockAxiosGet.mockResolvedValue({
            data: { sessions: [serverSession({ id: 'happy-a', key: keyA, metadata: { path: '/repo', claudeSessionId: otherClaudeId }, updatedAt: 1 })] },
        });
        await expect(findHappySessionForClaudeSession(claudeId)).resolves.toBeNull();

        mocks.mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(findHappySessionForClaudeSession(claudeId)).resolves.toBeNull();

        mocks.mockReadPersistedSessions.mockReturnValue({});
        mocks.mockAxiosGet.mockClear();
        await expect(findHappySessionForClaudeSession(claudeId)).resolves.toBeNull();
        expect(mocks.mockAxiosGet).not.toHaveBeenCalled();
    });
});
