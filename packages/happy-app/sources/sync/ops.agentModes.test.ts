import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}) {
    sessions['s1'] = {
        id: 's1',
        modelMode: fields.modelMode ?? null,
        effortLevel: fields.effortLevel ?? null,
        metadataVersion: 1,
        metadata: {
            hasPane: true,
            modelMode: fields.modelMode ?? null,
            effortLevel: fields.effortLevel ?? null,
            paneModel: fields.paneModel ?? null,
            paneEffort: fields.paneEffort ?? null,
        },
    };
}

describe('sessionSetAgentModes when the pane has moved under the app', () => {
    beforeEach(() => {
        for (const key of Object.keys(sessions)) delete sessions[key];
        emitWithAck.mockReset();
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });
        updateSessionAgentModes.mockReset();
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
