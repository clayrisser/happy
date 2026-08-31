import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HAPTIC_CALL_SITES, HAPTIC_KINDS, hapticAllowed } from './hapticKinds';
import { localSettingsDefaults } from '@/sync/localSettings';

/**
 * DROVE-190. The phone ships silent and the wrist does not, so these are the
 * assertions that have to hold: nothing of the notification kind fires with
 * the switch off, the switch is off out of the box, and the call-site
 * catalogue still matches the source.
 */

const appRoot = join(__dirname, '..', '..');

function source(file: string): string {
    return readFileSync(join(appRoot, file), 'utf8');
}

describe('phone haptics ship off', () => {
    it('the default is off, which is the whole point of the ticket', () => {
        expect(localSettingsDefaults.phoneHaptics).toBe(false);
    });

    it('no notification haptic is allowed with the switch off', () => {
        expect(hapticAllowed('notification', false)).toBe(false);
    });

    it('no interaction haptic is allowed with the switch off either', () => {
        expect(hapticAllowed('interaction', false)).toBe(false);
    });

    it('a notification haptic cannot be forced through by the preview flag path a component might copy', () => {
        // Preview is the demo screen's, and the demo screen plays interaction
        // taptics only. Nothing announces through it.
        const previewSites = HAPTIC_CALL_SITES.filter((s) => s.file.includes('settings/demo.tsx'));
        expect(previewSites.every((s) => s.kind === 'interaction')).toBe(true);
    });

    it('both kinds ride the one switch, so on means on', () => {
        for (const kind of HAPTIC_KINDS) {
            expect(hapticAllowed(kind, true)).toBe(true);
        }
    });
});

describe('the announce path is gated', () => {
    const announce = source('sources/sync/droverAnnounce.ts');

    it('droverAnnounce no longer reaches expo-haptics directly', () => {
        expect(announce).not.toContain('expo-haptics');
    });

    it('it announces through the gated helper', () => {
        expect(announce).toContain('hapticsAnnounce');
    });
});

describe('the wrist is untouched', () => {
    it('the watch buzz still hangs off the synced channel switch, not this one', () => {
        const channels = source('sources/sync/droverChannels.ts');
        const feed = source('sources/sync/droverWatchFeed.ts');
        expect(channels).toContain('local.announceHaptic');
        expect(feed).toContain('wakeDeserved');
        // Nothing on the wrist path may read the phone's local switch.
        expect(channels).not.toContain('phoneHaptics');
        expect(feed).not.toContain('phoneHaptics');
    });

    it('the drover haptic channel still ships on: that is the wrist', () => {
        const settings = source('sources/sync/settings.ts');
        expect(settings).toContain('droverAnnounceHaptic: true');
    });
});

describe('every haptic call site is classified', () => {
    const files = [
        'sources/sync/droverAnnounce.ts',
        'sources/components/AgentInput.tsx',
        'sources/voice/useVoiceComposer.ts',
        'sources/components/HomeDock.tsx',
        'sources/components/TabBar.tsx',
        'sources/components/PermissionModeSelector.tsx',
        'sources/components/LongPressCopyable.android.tsx',
        'sources/components/useCodeWrap.ts',
        'sources/components/DroverChannelsSheet.tsx',
        'sources/app/(app)/settings/demo.tsx',
    ];

    it('the catalogue names exactly the files that fire one', () => {
        expect(HAPTIC_CALL_SITES.map((s) => s.file).sort()).toEqual([...files].sort());
    });

    it('exactly one of them is the notification kind', () => {
        const notification = HAPTIC_CALL_SITES.filter((s) => s.kind === 'notification');
        expect(notification.map((s) => s.file)).toEqual(['sources/sync/droverAnnounce.ts']);
    });

    it('no file outside components/haptics.ts touches expo-haptics', () => {
        for (const file of files) {
            expect(source(file)).not.toContain('expo-haptics');
        }
    });
});
