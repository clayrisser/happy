import { describe, expect, it } from 'vitest';

import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    getEffortLevelsForPicker,
} from '@/components/modelModeOptions';
import { getCodeAgentDefaults, normalizeAgentKey } from '@/sync/agentDefaults';
import { isHarnessAvailable, HARNESS_NAMES, HARNESS_ORDER } from '@/utils/harnessCatalog';
import { harnessName } from '@/utils/harnessName';

const t = ((key: string) => key) as any;

/**
 * DROVE-57's reopening: every Claude-specific control must be ABSENT on a
 * Cursor session, never present and inert. These assert the absence, because
 * the failure mode is a control that renders and does nothing.
 *
 * DROVE-253 changed the ANSWER for two of them without changing that rule.
 * Effort and permission modes are now real for this harness, so the assertion
 * is no longer "never" but "only when the session published one". A control
 * still never renders on nothing.
 */
describe('Cursor session controls', () => {
    it('has no effort picker until the session publishes its scale, because '
        + 'Cursor spells effort inside the model id and the bracket override '
        + 'its help advertises was measured to be rejected', () => {
        expect(getEffortLevelsForModel('cursor', 'cursor-grok-4.6-xhigh-fast')).toEqual([]);
        expect(getEffortLevelsForPicker('cursor', 'cursor-grok-4.6-xhigh-fast')).toEqual([]);
    });

    it('lists the tiers the session published, so a pick is a tier that '
        + 'really exists in --list-models', () => {
        const metadata = {
            thoughtLevels: [
                { code: 'low', value: 'Low' },
                { code: 'xhigh', value: 'Extra High' },
            ],
        } as any;
        const levels = getEffortLevelsForModel('cursor', 'cursor-grok-4.6', metadata);
        expect(levels.map((l) => l.key)).toEqual(['low', 'xhigh']);
    });

    it('has no permission picker until the session publishes its modes, '
        + 'because one option hides it', () => {
        const modes = getAvailablePermissionModes('cursor', null, t);
        expect(modes).toHaveLength(1);
        expect(modes[0].key).toBe('bypassPermissions');
        expect(modes[0].description).toMatch(/--force/);
    });

    it('lists the modes the session published, which is how --mode plan and '
        + '--mode ask reach the picker with no app release', () => {
        const metadata = {
            operatingModes: [
                { code: 'bypassPermissions', value: 'Full access', description: 'Every tool call runs. --force' },
                { code: 'plan', value: 'Plan', description: 'Read-only. --mode plan' },
                { code: 'read-only', value: 'Read only', description: 'Read-only. --mode ask' },
            ],
        } as any;
        const modes = getAvailablePermissionModes('cursor', metadata, t).map((m) => m.key);
        expect(modes).toContain('plan');
        expect(modes).toContain('read-only');
        expect(modes.length).toBeGreaterThan(1);
    });

    it('never falls through to Claude permission modes', () => {
        const claude = getAvailablePermissionModes('claude', null, t).map((m) => m.key);
        const cursor = getAvailablePermissionModes('cursor', null, t).map((m) => m.key);
        expect(claude.length).toBeGreaterThan(1);
        expect(cursor).not.toEqual(claude);
    });

    it('has no model picker until the session publishes its own list', () => {
        expect(getAvailableModels('cursor', null, t)).toEqual([]);
    });

    it('lists what the session published, so the keys are what --model takes', () => {
        const metadata = {
            models: [
                { code: 'auto', value: 'Auto (default)' },
                { code: 'cursor-grok-4.6-xhigh-fast', value: 'Cursor Grok 4.6 Extra High Fast' },
            ],
        } as any;
        const models = getAvailableModels('cursor', metadata, t);
        expect(models.map((m) => m.key)).toEqual(['auto', 'cursor-grok-4.6-xhigh-fast']);
    });

    it('defaults to Cursor, not to Claude', () => {
        expect(normalizeAgentKey('cursor')).toBe('cursor');
        const defaults = getCodeAgentDefaults('cursor');
        expect(defaults.effortLevel).toBeNull();
        expect(defaults.modelMode).toBe('auto');
        expect(defaults.permissionMode).toBe('bypassPermissions');
    });

    it('is named Cursor everywhere it is named', () => {
        expect(harnessName('cursor')).toBe('Cursor');
        expect(HARNESS_NAMES.cursor).toBe('Cursor');
        expect(HARNESS_ORDER).toContain('cursor');
    });

    it('is only offered on a machine that reported cursor-agent', () => {
        const available = (availability: any) => isHarnessAvailable({
            availability,
            happyAgentAvailable: false,
            key: 'cursor',
        });
        expect(available(null)).toBe(false);
        expect(available({ claude: true })).toBe(false);
        expect(available({ cursor: false })).toBe(false);
        expect(available({ cursor: true })).toBe(true);
    });
});
