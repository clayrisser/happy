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

/**
 * THE ANSWER PATH (DROVE-190).
 *
 * `drover status` prints the two halves separately — `announce visual,haptic
 * · answer visual` — and the announce half is covered above. The answer half
 * is the one Clay's phone is in his hand for: the gate card, the banner, the
 * notification action he taps from the lock screen.
 *
 * Haptic is announce-only in the channel model, so there is no answer-side
 * BUZZ to gate. What there is, is the interaction tap under the finger that
 * answers a gate, and that rides the same switch as everything else because
 * the answer route reaches the taptic engine only through components/haptics
 * — never expo-haptics, and never a helper of its own. Asserted here rather
 * than assumed, because a confirmation buzz on "Allow" is the single most
 * likely thing for someone to add next, and it would fire in his pocket the
 * moment a notification action ran headless.
 */
describe('the answer path is gated too', () => {
    const answerRoute = [
        'sources/sync/droverNotificationAnswer.ts',
        'sources/sync/droverNotificationActions.ts',
        'sources/components/sessionGateAction.ts',
        'sources/components/SessionGateOverlay.tsx',
        'sources/components/PendingGatesBanner.tsx',
    ];

    it('no file on the answer route reaches the taptic engine directly', () => {
        for (const file of answerRoute) {
            expect(source(file), file).not.toContain('expo-haptics');
        }
    });

    it('and none of them is an unclassified call site', () => {
        // Anything on this route that starts firing haptics has to join the
        // catalogue, which is what makes it answer to the switch.
        const catalogued = new Set(HAPTIC_CALL_SITES.map((s) => s.file));
        for (const file of answerRoute) {
            const fires = /\bhaptics(?:Light|Error|Selection|Confirm|Announce)\s*\(/.test(source(file));
            expect(fires && !catalogued.has(file), `${file} fires an uncatalogued haptic`).toBe(false);
        }
    });

    it('haptic stays announce-only in the channel model, so answering never buzzes on its own', () => {
        const channels = source('sources/sync/droverChannels.ts');
        // ANSWER_CHANNELS is visual and audio. A haptic answer would be a new
        // channel, and it would need its own trip through this ticket.
        expect(channels).toContain("ANSWER_CHANNELS = ['visual', 'audio']");
    });

    it('an answering tap is an interaction, and interactions are off with the switch off', () => {
        expect(hapticAllowed('interaction', false)).toBe(false);
    });
});
