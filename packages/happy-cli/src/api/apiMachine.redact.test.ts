/**
 * A planted secret goes through a real session spawn, and comes out of nothing
 * (DROVE-304).
 *
 * This is the end-to-end half of the fix. The unit tests in
 * `happy-wire/src/redact.test.ts` pin the redactor; this drives the actual
 * `spawn-happy-session` RPC handler with a REAL logger writing to a real file,
 * with `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` switched on and
 * `fetch` captured, and then greps both the file and the off-machine POST.
 *
 * The secret is PLANTED. `FIXTURESECRET` is the marker the drover's
 * tests/mcp.bats established (DROVE-296) so one grep covers every fixture value
 * on either side of the wire. Nothing in this file has ever been real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine } from './types';

// The planted values, one marker so a miss says which field carried it.
const plantedToken = 'sk-ant-FIXTURESECRET304token';
const plantedEnvValue = 'ghp_FIXTURESECRET304envvalue';

const { logsDir, sentBodies } = vi.hoisted(() => {
    // Hoisted, because both of these have to be true BEFORE any import runs:
    // the Logger picks its file path and reads the remote-logging flag in its
    // constructor, and that constructor runs at module load.
    const dir = require('node:fs').mkdtempSync(
        require('node:path').join(require('node:os').tmpdir(), 'drove304-'),
    ) as string;
    process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = 'true';
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:59999';
    return { logsDir: dir, sentBodies: [] as string[] };
});

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() })) }));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test',
        logsDir,
        isDaemonProcess: true,
    },
}));

// NOT mocked, deliberately: `@/ui/logger`. The whole assertion is about what
// the real logger writes to a real file.

vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));

// Captures every handler the machine registers, so the test can drive the
// spawn one directly instead of standing up a socket.
const registered = new Map<string, (params: unknown) => unknown>();
vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn((method: string, handler: (params: unknown) => unknown) => {
            registered.set(method, handler);
        });
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
    },
}));

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(() => ({ claude: false, codex: false, gemini: false, openclaw: false })),
}));
vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false,
    })),
}));
vi.mock('@/utils/lidState', () => ({ shouldReconnect: vi.fn(() => true) }));

const machine: Machine = {
    id: 'machine-1',
    metadata: { host: 'test', platform: 'darwin', happyCliVersion: 'test', homeDir: '/tmp' },
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 0,
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
} as unknown as Machine;

afterAll(() => {
    rmSync(logsDir, { recursive: true, force: true });
    delete process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
    delete process.env.HAPPY_SERVER_URL;
});

beforeEach(() => {
    registered.clear();
    sentBodies.length = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: { body?: string }) => {
            if (init?.body) sentBodies.push(init.body);
            return { ok: true } as unknown as Response;
        }),
    );
});

async function spawnWithPlantedSecret() {
    const { ApiMachineClient } = await import('./apiMachine');
    const { logger } = await import('@/ui/logger');
    const client = new ApiMachineClient('token-for-the-daemon', machine);
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));
    client.setRPCHandlers({
        spawnSession,
        resumeSession: undefined,
        stopSession: vi.fn(() => true),
        requestShutdown: vi.fn(),
    } as never);

    const handler = registered.get('spawn-happy-session');
    expect(handler).toBeDefined();
    await handler!({
        directory: '/Users/x/proj',
        sessionId: 'session-1',
        machineId: 'machine-1',
        agent: 'claude',
        permissionMode: 'default',
        modelMode: 'default',
        // THE TWO FIELDS THAT LEAKED.
        token: plantedToken,
        environmentVariables: { ANTHROPIC_API_KEY: plantedEnvValue },
    });

    // sendToRemoteServer is fire-and-forget; give the microtask queue its turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { logPath: logger.getLogPath(), spawnSession };
}

describe('a session spawn writes no credential anywhere', () => {
    it('leaves nothing in the daemon log file', async () => {
        const { logPath } = await spawnWithPlantedSecret();
        const written = readFileSync(logPath, 'utf8');
        // The line is there -- this is not passing because nothing was logged.
        expect(written).toContain('Spawning session');
        expect(written).not.toContain('FIXTURESECRET');
    });

    it('still says the things a failed spawn is debugged with', async () => {
        const { logPath } = await spawnWithPlantedSecret();
        const written = readFileSync(logPath, 'utf8');
        expect(written).toContain('/Users/x/proj');
        expect(written).toContain('claude');
        // Knowing an env override was SENT is what tells you the phone passed
        // one at all. The names and values are not needed for that.
        expect(written).toContain('environmentVariableCount');
    });

    it('sends nothing off the machine either, with the DANGEROUSLY flag set', async () => {
        await spawnWithPlantedSecret();
        // The flag really is on: something was posted, and it is not empty.
        expect(sentBodies.length).toBeGreaterThan(0);
        expect(sentBodies.join('\n')).not.toContain('FIXTURESECRET');
    });

    it('hands the real token to the spawn, because the session needs it', async () => {
        // The redaction is about what gets WRITTEN DOWN. A fix that also
        // scrubbed the value out of the params the daemon spawns with would
        // break every session on the machine.
        const { spawnSession } = await spawnWithPlantedSecret();
        const passed = (spawnSession.mock.calls as unknown as unknown[][])[0][0] as { token: string; environmentVariables: Record<string, string> };
        expect(passed.token).toBe(plantedToken);
        expect(passed.environmentVariables.ANTHROPIC_API_KEY).toBe(plantedEnvValue);
    });
});

describe('the logger is the net under the call sites', () => {
    it('masks a credential a future call site stringifies by hand', async () => {
        // The three call sites named in DROVE-304 are fixed at the source. This
        // is the fourth one, the one nobody has found yet.
        const { logger } = await import('@/ui/logger');
        logger.debug(`[some future code] posting with {"token":"${plantedToken}"}`);
        const written = readFileSync(logger.getLogPath(), 'utf8');
        expect(written).toContain('some future code');
        expect(written).not.toContain('FIXTURESECRET');
    });

    it('masks a credential handed over as an object arg', async () => {
        const { logger } = await import('@/ui/logger');
        logger.debug('[some future code] env is', { environmentVariables: { KEY: plantedEnvValue } });
        const written = readFileSync(logger.getLogPath(), 'utf8');
        expect(written).not.toContain('FIXTURESECRET');
    });

    it('leaves an ordinary line untouched', async () => {
        const { logger } = await import('@/ui/logger');
        logger.debug('[API MACHINE] Spawned session session-1');
        expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('[API MACHINE] Spawned session session-1');
    });
});
