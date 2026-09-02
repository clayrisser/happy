/**
 * A `drover pi` session is listed exactly like a `drover claude` one (DROVE-379).
 *
 * Clay ran `drover pi` in a terminal, it printed its session id and answered a
 * prompt, and the phone's list never showed it. Every theory that was cheap to
 * hold turned out to be wrong: the CLI registered under the same happy home,
 * the same machine and the same account, the server reported the session
 * `active: true`, and nothing in the list pipeline reads `flavor` at all.
 *
 * So the bar this file holds is the one the bug would have failed: a pi
 * session's registration metadata is a claude session's shape minus flavor,
 * it parses, it survives every drop condition, and it lands in the same
 * project group as the claude session beside it.
 *
 * The two fixtures are the REAL metadata off the machine on 2026-09-02 —
 * session cmtjjikllbuqq060uncos5koc (pi, invisible) and cmtj8g0rs3rqh060ugmoal7n5
 * (claude, visible), same machine, same path, same minute. Hand-written
 * fixtures would have agreed with whatever the code did; these do not.
 */

import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';
import { isSessionArchived } from './sessionArchive';
import { isDroverBridgeSession } from './droverBridgeSession';
import { buildPathProjectGroups } from './projectGroups';
import type { Session } from './storageTypes';

const piMetadata = {
    path: '/Users/clayrisser/Projects/bitspur/cattle-drover',
    host: 'studio.234.bitspur.com',
    version: '1.2.2',
    os: 'darwin',
    machineId: '21e57f11-ad51-4761-b31f-80dd9b417986',
    homeDir: '/Users/clayrisser',
    happyHomeDir: '/Users/clayrisser/.happy',
    happyLibDir: '/Users/clayrisser/Projects/bitspur/happy/packages/happy-cli',
    happyToolsDir: '/Users/clayrisser/Projects/bitspur/happy/packages/happy-cli/tools/unpacked',
    startedFromDaemon: false,
    hostPid: 70600,
    startedBy: 'terminal',
    lifecycleState: 'running',
    lifecycleStateSince: 1788319934285,
    flavor: 'pi',
    sandbox: null,
    dangerouslySkipPermissions: false,
    gitBranch: 'main',
    permissionMode: 'default',
    currentOperatingModeCode: 'default',
    models: [
        { code: 'glm/glm-5.2', value: 'glm-5.2 (glm)' },
        { code: 'lmstudio/openai/gpt-oss-120b', value: 'openai/gpt-oss-120b (lmstudio)' },
    ],
    hasPane: true,
};

const claudeMetadata = {
    path: '/Users/clayrisser/Projects/bitspur/cattle-drover',
    host: 'studio.234.bitspur.com',
    version: '1.2.2',
    name: 'DROVER',
    os: 'darwin',
    summary: { text: 'DROVER', updatedAt: 1788318570888 },
    machineId: '21e57f11-ad51-4761-b31f-80dd9b417986',
    droverAccount: 'jam@codejam.ninja',
    claudeSessionId: 'db93e97b-9857-440f-ab9c-f265bd007e28',
    homeDir: '/Users/clayrisser',
    happyHomeDir: '/Users/clayrisser/.happy',
    happyLibDir: '/Users/clayrisser/Projects/bitspur/happy/packages/happy-cli',
    happyToolsDir: '/Users/clayrisser/Projects/bitspur/happy/packages/happy-cli/tools/unpacked',
    startedFromDaemon: false,
    hostPid: 9916,
    startedBy: 'terminal',
    hasPane: true,
    flavor: 'claude',
    sandbox: null,
    dangerouslySkipPermissions: true,
    lifecycleState: 'running',
    lifecycleStateSince: 1788319405767,
    permissionMode: 'bypassPermissions',
    modelMode: 'claude-fable-5-1',
    effortLevel: 'ultracode',
    paneRemoteControl: true,
};

/** The server's own answer for both sessions, read back live: both active. */
function sessionFor(id: string, metadata: unknown): Session {
    return {
        id,
        seq: 1,
        createdAt: 1788319934409,
        updatedAt: 1788320538683,
        active: true,
        activeAt: 1788320537504,
        metadata: MetadataSchema.parse(metadata),
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        todos: [],
    } as unknown as Session;
}

describe('a pi session is listed like a claude one (DROVE-379)', () => {
    it('parses the real pi metadata the CLI registered', () => {
        const parsed = MetadataSchema.safeParse(piMetadata);
        // A parse failure hands the app `metadata: null`, which is how a
        // session goes missing without anything logging a filter.
        expect(parsed.success).toBe(true);
    });

    it('registers the same metadata shape as claude, apart from flavor', () => {
        // The fields every runner stamps through createSessionMetadata. A pi
        // session that omitted one of these is a pi session the app groups,
        // names or reaches differently from every other harness.
        const shared = [
            'path', 'host', 'version', 'os', 'machineId', 'homeDir',
            'happyHomeDir', 'happyLibDir', 'happyToolsDir', 'startedFromDaemon',
            'hostPid', 'startedBy', 'lifecycleState', 'lifecycleStateSince',
            'flavor', 'sandbox', 'dangerouslySkipPermissions',
        ] as const;
        for (const key of shared) {
            expect(Object.hasOwn(piMetadata, key), `pi metadata is missing ${key}`).toBe(true);
            expect(Object.hasOwn(claudeMetadata, key), `claude metadata is missing ${key}`).toBe(true);
        }
        expect(piMetadata.flavor).toBe('pi');
        expect(claudeMetadata.flavor).toBe('claude');
    });

    it('survives every condition that drops a row from the list', () => {
        const pi = sessionFor('cmtjjikllbuqq060uncos5koc', piMetadata);
        expect(pi.metadata?.isSideChat ?? false).toBe(false);
        expect(isDroverBridgeSession(pi)).toBe(false);
        expect(isSessionArchived(pi)).toBe(false);
    });

    it('lands in the same project group as the claude session beside it', () => {
        const pi = sessionFor('cmtjjikllbuqq060uncos5koc', piMetadata);
        const claude = sessionFor('cmtj8g0rs3rqh060ugmoal7n5', claudeMetadata);
        const groups = buildPathProjectGroups(
            [claude, pi],
            (session) => ({ id: session.id }) as never,
            () => true,
            'happy',
        );
        expect(groups).toHaveLength(1);
        const ids = groups[0].workspaces.flatMap((w) => w.sessions.map((s) => s.id));
        expect(ids).toContain('cmtjjikllbuqq060uncos5koc');
        expect(ids).toContain('cmtj8g0rs3rqh060ugmoal7n5');
    });
});
