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
 */
describe('Cursor session controls', () => {
    it('has no effort picker: Cursor spells effort inside the model id', () => {
        expect(getEffortLevelsForModel('cursor', 'cursor-grok-4.6-xhigh-fast')).toEqual([]);
        expect(getEffortLevelsForPicker('cursor', 'cursor-grok-4.6-xhigh-fast')).toEqual([]);
    });

    it('has no permission picker, because one option hides it', () => {
        const modes = getAvailablePermissionModes('cursor', null, t);
        expect(modes).toHaveLength(1);
        expect(modes[0].key).toBe('bypassPermissions');
        expect(modes[0].description).toMatch(/--force/);
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
