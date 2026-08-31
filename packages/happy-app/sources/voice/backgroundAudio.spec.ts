import { beforeEach, describe, expect, it } from 'vitest';
import { isForeground } from './foreground';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import type { Message } from '@/sync/typesMessage';

/**
 * Read-aloud keeps talking with the phone in a pocket (DROVE-189).
 *
 * The JS half, which is the half that ships over the air. The plist was never
 * the problem: `UIBackgroundModes: ["audio"]` has been in app.config.js since
 * DROVE-30, so the entitlement is already on his phone. What killed it was
 * `rest()`, which releases the audio session on a drained queue. In the
 * foreground that is right — ducked music comes back up. Behind the lock
 * screen it is fatal: an app with the audio background mode stays alive only
 * while its session is ACTIVE, so a drained queue let iOS suspend the process
 * and the next reply arrived at an app that was not running.
 *
 * The native half — interruption handling and the lock-screen controls — needs
 * a build and is listed as unverified until one exists.
 */

describe('background reading', () => {
    let stops = 0;
    let said: string[] = [];
    let reader: ReadAloudReader;

    function prose(id: string, text: string, createdAt: number): Message {
        return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
    }

    async function settle(): Promise<void> {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    beforeEach(() => {
        stops = 0;
        said = [];
        reader = new ReadAloudReader({
            speak(text: string, _options?: SpeakOptions) {
                said.push(text);
                return Promise.resolve();
            },
            stop() { stops += 1; },
        });
        reader.setEnabled(true);
        reader.focus('s1');
    });

    it('treats only `active` as the foreground', () => {
        // `inactive` is the shade coming down or a call banner. Holding the
        // session through it is right; the app is about to be background.
        expect(isForeground('active')).toBe(true);
        expect(isForeground('background')).toBe(false);
        expect(isForeground('inactive')).toBe(false);
    });

    it('hands the session back on a drained queue in the FOREGROUND', async () => {
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await settle();
        expect(said).toEqual(['One.']);
        expect(stops).toBeGreaterThan(0);
    });

    it('keeps the session on a drained queue in the BACKGROUND', async () => {
        // The whole fix. Stopping here is what let iOS suspend the app, and a
        // suspended app never hears the next reply, let alone reads it.
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await settle();
        expect(said).toEqual(['One.']);
        expect(stops).toBe(0);
    });

    it('carries on reading material that arrives while backgrounded', async () => {
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await settle();
        reader.onMessages('s1', [prose('m2', 'Two.', 2)]);
        await settle();
        expect(said).toEqual(['One.', 'Two.']);
    });

    it('lets the session go at the first idle moment back in the foreground', async () => {
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await settle();
        expect(stops).toBe(0);
        reader.setBackgrounded(false);
        await settle();
        expect(stops).toBeGreaterThan(0);
    });

    it('holds nothing once read-aloud is off, background or not', async () => {
        reader.setBackgrounded(true);
        reader.onMessages('s1', [prose('m1', 'One.', 1)]);
        await settle();
        reader.setEnabled(false);
        await settle();
        // Turning it off is an interrupt, which stops the engine outright.
        expect(stops).toBeGreaterThan(0);
    });
});
