import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentModeRequest, resetAgentModeRequests } from './agentModeRequests';

const { emitWithAck, updateSessionAgentModes, sessions } = vi.hoisted(() => ({
    emitWithAck: vi.fn(),
    updateSessionAgentModes: vi.fn(),
    sessions: {} as Record<string, unknown>,
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { emitWithAck, machineRPC: vi.fn() },
}));

vi.mock('./sync', () => ({
    sync: {
        refreshSessions: vi.fn(),
        encryption: { getSessionEncryption: () => ({ encryptRaw: async () => 'sealed' }) },
    },
}));

// storage transitively pulls in react-native; these tests never touch it.
vi.mock('./storage', () => ({
    storage: { getState: () => ({ sessions, updateSessionAgentModes }) },
}));

/**
 * A pane session whose stored pick has drifted away from the pane (DROVE-191).
 *
 * `modelMode` is the app's REQUEST and `paneModel` is what the terminal is
 * actually running. They come apart every time the pane moves on its own:
 * `/model` typed at the keyboard, a flip, or DROVE-187's limit downgrade.
 */
function paneSession(fields: {
    modelMode?: string | null;
    effortLevel?: string | null;
    paneModel?: string | null;
    paneEffort?: string | null;
    permissionMode?: string | null;
    panePermissionMode?: string | null;
}) {
    sessions['s1'] = {
        id: 's1',
        modelMode: fields.modelMode ?? null,
        effortLevel: fields.effortLevel ?? null,
        permissionMode: fields.permissionMode ?? null,
        metadataVersion: 1,
        metadata: {
            hasPane: true,
            modelMode: fields.modelMode ?? null,
            effortLevel: fields.effortLevel ?? null,
            paneModel: fields.paneModel ?? null,
            paneEffort: fields.paneEffort ?? null,
            permissionMode: fields.permissionMode ?? null,
            panePermissionMode: fields.panePermissionMode ?? null,
        },
    };
}

describe('sessionSetAgentModes when the pane has moved under the app', () => {
    beforeEach(() => {
        for (const key of Object.keys(sessions)) delete sessions[key];
        emitWithAck.mockReset();
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });
        updateSessionAgentModes.mockReset();
        resetAgentModeRequests();
    });

    it('sends a pick that equals the stored request but not the pane', async () => {
        // The exact state Clay produced by typing `/model claude-sonnet-5` at
        // his own keyboard. The row correctly showed Sonnet 5, and tapping
        // Opus 5 [1M] wrote nothing at all: the value matched both the local
        // mirror and the synced metadata, so the patch was dropped before it
        // could become a frame. From his side the picker was dead.
        paneSession({ modelMode: 'claude-opus-5[1m]', paneModel: 'claude-sonnet-5' });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { modelMode: 'claude-opus-5[1m]' });

        expect(updateSessionAgentModes).toHaveBeenCalledWith('s1', { modelMode: 'claude-opus-5[1m]' });
    });

    it('sends an effort the pane refused, when it is picked again', async () => {
        paneSession({ effortLevel: 'max', paneEffort: 'high' });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { effortLevel: 'max' });

        expect(updateSessionAgentModes).toHaveBeenCalledWith('s1', { effortLevel: 'max' });
    });

    it('still sends nothing when the pane already agrees', async () => {
        paneSession({ modelMode: 'claude-sonnet-5', paneModel: 'claude-sonnet-5' });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { modelMode: 'claude-sonnet-5' });

        expect(updateSessionAgentModes).not.toHaveBeenCalled();
    });

    it('does not read a [1m] request as a disagreement, so nothing retypes', async () => {
        // The transcript reports `claude-opus-5` for the 1M variant as well —
        // the bracket picks the context window, not a different model. Reading
        // that as "the pane disagrees" would send a frame on every tap of the
        // row that is already running, and the CLI would type `/model` back at
        // a prompt that never moved. Same rule as resolvePaneModelKey.
        paneSession({ modelMode: 'claude-opus-5[1m]', paneModel: 'claude-opus-5' });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { modelMode: 'claude-opus-5[1m]' });

        expect(updateSessionAgentModes).not.toHaveBeenCalled();
    });

    it('sends a permission mode that equals the stored request but not the pane', async () => {
        // DROVE-199, and the one Clay hits most: shift+tab is a key on his own
        // keyboard, so the pane leaves the request behind every time he
        // presses it. The composer showed the padlock for `plan` because
        // resolveCurrentOption prefers panePermissionMode, so the row he
        // tapped to get back to Yolo was compared against a request that still
        // said `bypassPermissions` — and the pick was dropped before it could
        // become a frame.
        paneSession({ permissionMode: 'bypassPermissions', panePermissionMode: 'plan' });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { permissionMode: 'bypassPermissions' });

        expect(updateSessionAgentModes).toHaveBeenCalledWith('s1', { permissionMode: 'bypassPermissions' });
    });

    it('sends nothing when the pane is already in the mode picked', async () => {
        paneSession({ permissionMode: 'plan', panePermissionMode: 'plan' });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { permissionMode: 'plan' });

        expect(updateSessionAgentModes).not.toHaveBeenCalled();
    });

    it('does not read Yolo against bypassPermissions as a disagreement', async () => {
        // `yolo` is the Codex spelling of the same mode and the CLI folds it
        // with mapToClaudeMode, so the pane can only ever report
        // `bypassPermissions` for it. Comparing the raw strings would send a
        // frame on every tap of the row that is already running.
        paneSession({ permissionMode: 'yolo', panePermissionMode: 'bypassPermissions' });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { permissionMode: 'yolo' });

        expect(updateSessionAgentModes).not.toHaveBeenCalled();
    });

    it('writes down what was asked for, and what the pane held when it was asked (DROVE-217)', async () => {
        paneSession({ effortLevel: 'high', paneEffort: 'high' });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { effortLevel: 'max' });

        // This is what makes the composer show `max` at once and draw it as
        // unconfirmed: the ask, and the value it has to beat.
        const request = getAgentModeRequest('s1', 'effortLevel');
        expect(request?.value).toBe('max');
        expect(request?.observedWhenAsked).toBe('high');
    });

    it('starts no wait for a tap that sends nothing', async () => {
        paneSession({ effortLevel: 'high', paneEffort: 'high' });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { effortLevel: 'high' });

        expect(updateSessionAgentModes).not.toHaveBeenCalled();
        expect(getAgentModeRequest('s1', 'effortLevel')).toBeUndefined();
    });

    it('leaves a session with no pane alone', async () => {
        sessions['s1'] = {
            id: 's1',
            modelMode: 'claude-opus-5',
            metadataVersion: 1,
            metadata: { modelMode: 'claude-opus-5' },
        };
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('s1', { modelMode: 'claude-opus-5' });

        expect(updateSessionAgentModes).not.toHaveBeenCalled();
    });
});
