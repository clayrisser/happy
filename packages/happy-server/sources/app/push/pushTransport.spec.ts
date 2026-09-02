/**
 * Push leaves the relay through Expo, and says so (DROVE-332).
 *
 * The relay drover runs on Clay's estate sends with the token the phone
 * registered under drover's OWN Expo project, so Expo signs for APNs and no
 * Apple key sits on the relay. The alternative — direct APNs — needs a .p8 that
 * is Clay's to mint, and it is not built.
 *
 * The assertion that matters is the second one: a relay TOLD to use APNs must
 * not quietly keep sending through Expo. Moving to APNs is exactly the decision
 * to take Expo out of the path, and a silent fallback would leave it in.
 */

import { describe, expect, it } from 'vitest';

import { pushTransport, sendPushNotifications } from './pushSend';

describe('the push transport', () => {
    it('is Expo, and needs no Apple key on the relay', () => {
        expect(pushTransport({})).toBe('expo');
        // A half-configured APNs is not APNs. Nothing is on the relay until all
        // three are, so this stays on the path that works.
        expect(pushTransport({ APNS_KEY_ID: 'ABC123' })).toBe('expo');
        expect(pushTransport({ APNS_KEY: 'k', APNS_TEAM_ID: 'T' })).toBe('expo');
    });

    it('reads all three APNs variables together as the choice to use APNs', () => {
        expect(pushTransport({ APNS_KEY: 'k', APNS_KEY_ID: 'ABC123', APNS_TEAM_ID: 'TEAM' })).toBe('apns');
    });

    it('sends nothing at all when there are no messages, whatever the transport', async () => {
        await expect(sendPushNotifications([])).resolves.toEqual([]);
    });
});
