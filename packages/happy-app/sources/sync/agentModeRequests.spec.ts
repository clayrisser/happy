/**
 * When a pick is still waiting on the pane, and when it has stopped waiting
 * (DROVE-217).
 *
 * The four exits in agentModeRequests.ts are the whole point of this file. A
 * colour that says "in flight" is only worth drawing if it reliably STOPS, so
 * every way it can stop is pinned here, refusal included.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
    AGENT_MODE_PENDING_GIVE_UP_MS,
    agentModePendingState,
    getAgentModeRequest,
    noteAgentModeRequest,
    paneAgrees,
    paneDisagreesWithRequest,
    paneObservedMode,
    reapplyRequest,
    resetAgentModeRequests,
    type AgentModeControl,
} from './agentModeRequests';
import type { Metadata } from './storageTypes';

const T0 = 1_000_000;

function pane(fields: Partial<Metadata>): Metadata {
    return { hasPane: true, ...fields } as Metadata;
}

/** The ordinary shape: we asked for `want`, the pane still holds `was`. */
function asked(field: AgentModeControl, want: string | null, was: string | null, at = T0) {
    return { value: want, observedWhenAsked: was, at };
}

describe('what the pane is observed to hold', () => {
    it('reads the field for each control', () => {
        const metadata = pane({ paneModel: 'claude-sonnet-5', paneEffort: 'high', panePermissionMode: 'plan' });
        expect(paneObservedMode(metadata, 'modelMode')).toBe('claude-sonnet-5');
        expect(paneObservedMode(metadata, 'effortLevel')).toBe('high');
        expect(paneObservedMode(metadata, 'permissionMode')).toBe('plan');
    });

    it('reports nothing for a session with no pane, which has no observation to wait on', () => {
        const metadata = { hasPane: false, paneEffort: 'high' } as Metadata;
        expect(paneObservedMode(metadata, 'effortLevel')).toBeNull();
    });
});

describe('folding the three vocabularies', () => {
    it('reads a bracket variant of the model as the model, which the transcript cannot tell apart', () => {
        expect(paneAgrees('modelMode', 'claude-opus-5[1m]', 'claude-opus-5')).toBe(true);
        expect(paneAgrees('modelMode', 'claude-opus-5[1m]', 'claude-sonnet-5')).toBe(false);
    });

    it('folds the app’s permission key forward into the Claude mode the pane speaks', () => {
        expect(paneAgrees('permissionMode', 'yolo', 'bypassPermissions')).toBe(true);
        expect(paneAgrees('permissionMode', 'safe-yolo', 'default')).toBe(true);
        expect(paneAgrees('permissionMode', 'plan', 'acceptEdits')).toBe(false);
    });

    it('compares effort as the same word on both sides', () => {
        expect(paneAgrees('effortLevel', 'ultracode', 'ultracode')).toBe(true);
        expect(paneAgrees('effortLevel', 'max', 'high')).toBe(false);
    });
});

describe('the DROVE-191/199 change test, which ops.ts and the composer now share', () => {
    it('calls a pick the pane contradicts a disagreement, whatever the stored request says', () => {
        expect(paneDisagreesWithRequest(pane({ paneEffort: 'high' }), 'effortLevel', 'max')).toBe(true);
        expect(paneDisagreesWithRequest(pane({ panePermissionMode: 'plan' }), 'permissionMode', 'yolo')).toBe(true);
    });

    it('does not treat an unread pane as a disagreement: nothing read is not the same as default', () => {
        expect(paneDisagreesWithRequest(pane({}), 'permissionMode', 'yolo')).toBe(false);
        expect(paneDisagreesWithRequest(null, 'effortLevel', 'max')).toBe(false);
    });
});

describe('a pick is pending while the terminal has not answered', () => {
    it('waits when the pane still holds what it held at the ask', () => {
        expect(agentModePendingState('effortLevel', {
            request: asked('effortLevel', 'max', 'high'),
            stored: 'max',
            observed: 'high',
            now: T0 + 1_500,
        })).toBe('pending');
    });

    it('waits for the model and the permission mode on the same rule, not just effort', () => {
        expect(agentModePendingState('modelMode', {
            request: asked('modelMode', 'claude-opus-5[1m]', 'claude-sonnet-5'),
            stored: 'claude-opus-5[1m]',
            observed: 'claude-sonnet-5',
            now: T0 + 900,
        })).toBe('pending');
        expect(agentModePendingState('permissionMode', {
            request: asked('permissionMode', 'yolo', 'plan'),
            stored: 'yolo',
            observed: 'plan',
            now: T0 + 400,
        })).toBe('pending');
    });

    it('is settled when nothing was asked for from this device', () => {
        expect(agentModePendingState('effortLevel', {
            request: undefined,
            stored: 'max',
            observed: 'high',
            now: T0,
        })).toBe('settled');
    });

    it('is settled when the pane has reported nothing at all, since there is no answer to wait for', () => {
        expect(agentModePendingState('effortLevel', {
            request: asked('effortLevel', 'max', null),
            stored: 'max',
            observed: null,
            now: T0 + 1_000,
        })).toBe('settled');
    });
});

describe('every way a wait ends', () => {
    it('CONFIRMED: the pane reports the value that was asked for', () => {
        expect(agentModePendingState('effortLevel', {
            request: asked('effortLevel', 'max', 'high'),
            stored: 'max',
            observed: 'max',
            now: T0 + 2_200,
        })).toBe('settled');
    });

    it('CONFIRMED through the fold: ultracode is confirmed as ultracode, not snapped to xhigh', () => {
        expect(agentModePendingState('effortLevel', {
            request: asked('effortLevel', 'ultracode', 'high'),
            stored: 'ultracode',
            observed: 'ultracode',
            now: T0 + 2_000,
        })).toBe('settled');
    });

    it('CONFIRMED through the fold: yolo is confirmed by bypassPermissions', () => {
        expect(agentModePendingState('permissionMode', {
            request: asked('permissionMode', 'yolo', 'plan'),
            stored: 'yolo',
            observed: 'bypassPermissions',
            now: T0 + 700,
        })).toBe('settled');
    });

    it('ROLLED BACK: the CLI refused it and mirrored the pane into the request, so the ask is gone', () => {
        // DROVE-164 / DROVE-191 / DROVE-199 all do exactly this, and all three
        // put a line in the chat saying why. The colour stops; it does not go
        // and invent a second explanation.
        expect(agentModePendingState('effortLevel', {
            request: asked('effortLevel', 'ultracode', 'high'),
            stored: 'high',
            observed: 'high',
            now: T0 + 3_000,
        })).toBe('settled');
    });

    it('ROLLED BACK for a mode the ring will not take, which is the DROVE-199 case exactly', () => {
        expect(agentModePendingState('permissionMode', {
            request: asked('permissionMode', 'yolo', 'acceptEdits'),
            stored: 'acceptEdits',
            observed: 'acceptEdits',
            now: T0 + 1_800,
        })).toBe('settled');
    });

    it('CONTRADICTED: the pane moved somewhere else, so somebody at the keyboard won', () => {
        expect(agentModePendingState('modelMode', {
            request: asked('modelMode', 'claude-opus-5[1m]', 'claude-sonnet-5'),
            stored: 'claude-opus-5[1m]',
            observed: 'claude-fable-5',
            now: T0 + 5_000,
        })).toBe('settled');
    });

    it('GIVEN UP: silence does not go on forever', () => {
        const request = asked('effortLevel', 'max', 'high');
        const input = { request, stored: 'max', observed: 'high' };
        expect(agentModePendingState('effortLevel', { ...input, now: T0 + AGENT_MODE_PENDING_GIVE_UP_MS - 1 })).toBe('pending');
        expect(agentModePendingState('effortLevel', { ...input, now: T0 + AGENT_MODE_PENDING_GIVE_UP_MS })).toBe('settled');
    });

    it('gives up well past the slowest confirmation measured on a real session', () => {
        // The tail on Clay's 2026-08-31 logs: 11.0s for an effort that landed,
        // and the CLI's own budget for one attempt is its 8s outcome deadline
        // plus a 2s gate retry. The bound is long on purpose — snapping back at
        // ten seconds would undo a slow pick in front of him and then re-do it.
        expect(AGENT_MODE_PENDING_GIVE_UP_MS).toBeGreaterThan(11_000 + 8_000 + 2_000);
    });
});

describe('the record of what this device asked for', () => {
    beforeEach(() => resetAgentModeRequests());

    it('remembers the value and what the pane held at the time', () => {
        noteAgentModeRequest('s1', 'effortLevel', 'max', 'high', T0);
        expect(getAgentModeRequest('s1', 'effortLevel')).toEqual({ value: 'max', observedWhenAsked: 'high', at: T0 });
    });

    it('replaces an earlier ask for the same field rather than stacking waits', () => {
        noteAgentModeRequest('s1', 'effortLevel', 'max', 'high', T0);
        noteAgentModeRequest('s1', 'effortLevel', 'low', 'high', T0 + 500);
        expect(getAgentModeRequest('s1', 'effortLevel')?.value).toBe('low');
    });

    it('keeps the three fields and the sessions apart', () => {
        noteAgentModeRequest('s1', 'effortLevel', 'max', 'high', T0);
        noteAgentModeRequest('s1', 'modelMode', 'claude-sonnet-5', 'claude-opus-5', T0);
        noteAgentModeRequest('s2', 'effortLevel', 'low', 'high', T0);
        expect(getAgentModeRequest('s1', 'modelMode')?.value).toBe('claude-sonnet-5');
        expect(getAgentModeRequest('s2', 'effortLevel')?.value).toBe('low');
        expect(getAgentModeRequest('s1', 'permissionMode')).toBeUndefined();
    });

    it('drops records nothing can be waiting on any more, so a long session does not accumulate them', () => {
        noteAgentModeRequest('s1', 'effortLevel', 'max', 'high', T0);
        noteAgentModeRequest('s2', 'modelMode', 'claude-sonnet-5', null, T0 + AGENT_MODE_PENDING_GIVE_UP_MS);
        expect(getAgentModeRequest('s1', 'effortLevel')).toBeUndefined();
        expect(getAgentModeRequest('s2', 'modelMode')).toBeDefined();
    });

    it('records a reset, which is a real pick and not an absent one', () => {
        noteAgentModeRequest('s1', 'effortLevel', null, 'high', T0);
        expect(getAgentModeRequest('s1', 'effortLevel')?.value).toBeNull();
        expect(agentModePendingState('effortLevel', {
            request: getAgentModeRequest('s1', 'effortLevel'),
            stored: null,
            observed: 'high',
            now: T0 + 500,
        })).toBe('pending');
    });
});

describe("the CLI's own re-apply after a relaunch (DROVE-232)", () => {
    const reapply = (fields: Partial<Metadata>, stored: string | null, observed: string | null) =>
        reapplyRequest(pane(fields), stored, observed);

    it('is no request at all on a session that did not relaunch', () => {
        expect(reapply({}, 'max', 'high')).toBeUndefined();
    });

    it('defends the stored pick rather than choosing anything', () => {
        expect(reapply({ modeReapplyAt: T0 }, 'max', 'high'))
            .toEqual({ value: 'max', observedWhenAsked: 'high', at: T0 });
    });

    it('draws nothing while the new pane has yet to say anything', () => {
        // The CLI clears the pane fields as it relaunches, so there is nothing
        // to wait on and the composer falls back to the request.
        expect(agentModePendingState('effortLevel', {
            request: reapply({ modeReapplyAt: T0 }, 'max', null),
            stored: 'max',
            observed: null,
            now: T0 + 500,
        })).toBe('settled');
    });

    it('waits while the new process is on the wrong effort', () => {
        // This is Clay's bug: main hit its wall, the session moved to jamrizzi,
        // and the fresh Claude came up on that account's default.
        expect(agentModePendingState('effortLevel', {
            request: reapply({ modeReapplyAt: T0, paneEffort: 'high' }, 'max', 'high'),
            stored: 'max',
            observed: 'high',
            now: T0 + 500,
        })).toBe('pending');
    });

    it('settles when the re-apply lands', () => {
        expect(agentModePendingState('effortLevel', {
            request: reapply({ modeReapplyAt: T0, paneEffort: 'max' }, 'max', 'max'),
            stored: 'max',
            observed: 'max',
            now: T0 + 500,
        })).toBe('settled');
    });

    it('settles at the pane value when the new account refuses it', () => {
        // The CLI mirrored the refusal back into the request, which is the
        // signal. The reason is already a line in the chat; the control just
        // stops claiming a pick the terminal would not take.
        expect(agentModePendingState('effortLevel', {
            request: reapply({ modeReapplyAt: T0, paneEffort: 'high' }, 'max', 'high'),
            stored: 'high',
            observed: 'high',
            now: T0 + 500,
        })).toBe('settled');
    });

    it('gives up on the same bound as any other wait, so a dead CLI cannot hold it amber', () => {
        expect(agentModePendingState('effortLevel', {
            request: reapply({ modeReapplyAt: T0, paneEffort: 'high' }, 'max', 'high'),
            stored: 'max',
            observed: 'high',
            now: T0 + AGENT_MODE_PENDING_GIVE_UP_MS,
        })).toBe('settled');
    });

    it('waits on the model and the permission mode too, folded as always', () => {
        expect(agentModePendingState('modelMode', {
            request: reapply({ modeReapplyAt: T0, paneModel: 'claude-sonnet-5' }, 'claude-opus-5', 'claude-sonnet-5'),
            stored: 'claude-opus-5',
            observed: 'claude-sonnet-5',
            now: T0 + 500,
        })).toBe('pending');
        // ...and the [1m] variant is not a disagreement.
        expect(agentModePendingState('modelMode', {
            request: reapply({ modeReapplyAt: T0, paneModel: 'claude-opus-5' }, 'claude-opus-5[1m]', 'claude-opus-5'),
            stored: 'claude-opus-5[1m]',
            observed: 'claude-opus-5',
            now: T0 + 500,
        })).toBe('settled');
        expect(agentModePendingState('permissionMode', {
            request: reapply({ modeReapplyAt: T0, panePermissionMode: 'default' }, 'yolo', 'default'),
            stored: 'yolo',
            observed: 'default',
            now: T0 + 500,
        })).toBe('pending');
    });
});
