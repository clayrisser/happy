/**
 * Per session, and it dies with the session (DROVE-277).
 *
 * The two properties this store exists for, and they are both security
 * properties rather than conveniences: one lane's switch must not answer
 * another lane's prompts, and NOTHING must carry the switch across a relaunch.
 * "An auto-accept nobody remembers enabling" is how the ticket puts it, and
 * DROVE-239 is the incident it is describing.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { autoAcceptSessions, createAutoAcceptSessions } from './autoAcceptSessions';

beforeEach(() => {
    autoAcceptSessions.reset();
});

describe('per session', () => {
    it('is off for every session until one is switched on', () => {
        expect(autoAcceptSessions.isOn('a')).toBe(false);
        expect(autoAcceptSessions.get().size).toBe(0);
    });

    it('switches one session on and leaves every other alone', () => {
        autoAcceptSessions.set('a', true);
        expect(autoAcceptSessions.isOn('a')).toBe(true);
        expect(autoAcceptSessions.isOn('b')).toBe(false);
    });

    it('toggles, and says which state it landed in', () => {
        expect(autoAcceptSessions.toggle('a')).toBe(true);
        expect(autoAcceptSessions.isOn('a')).toBe(true);
        expect(autoAcceptSessions.toggle('a')).toBe(false);
        expect(autoAcceptSessions.isOn('a')).toBe(false);
    });

    it('ignores an empty session id rather than switching on a session that is not there', () => {
        autoAcceptSessions.set('', true);
        expect(autoAcceptSessions.get().size).toBe(0);
        expect(autoAcceptSessions.isOn('')).toBe(false);
    });
});

describe('the snapshot, for useSyncExternalStore', () => {
    it('swaps a new set on every change, so identity comparison is enough', () => {
        const before = autoAcceptSessions.get();
        autoAcceptSessions.set('a', true);
        expect(autoAcceptSessions.get()).not.toBe(before);
    });

    it('does not swap, or notify, when the write changes nothing', () => {
        autoAcceptSessions.set('a', true);
        const stable = autoAcceptSessions.get();
        let notified = 0;
        const stop = autoAcceptSessions.subscribe(() => { notified += 1; });
        autoAcceptSessions.set('a', true);
        expect(autoAcceptSessions.get()).toBe(stable);
        expect(notified).toBe(0);
        stop();
    });

    it('notifies subscribers on a real change and stops after unsubscribe', () => {
        let notified = 0;
        const stop = autoAcceptSessions.subscribe(() => { notified += 1; });
        autoAcceptSessions.set('a', true);
        expect(notified).toBe(1);
        stop();
        autoAcceptSessions.set('b', true);
        expect(notified).toBe(1);
    });
});

describe('it dies with the process, which is the whole security argument', () => {
    /**
     * A relaunch is a NEW module instance, so the honest way to test "comes
     * back off" is to build one and read it before anything touches it. This
     * is what makes the reset free: there is no persisted value to clear, no
     * migration, and no code path that could forget to clear it.
     */
    it('comes back OFF after a relaunch, with nothing having to reset it', () => {
        autoAcceptSessions.set('a', true);
        expect(autoAcceptSessions.isOn('a')).toBe(true);

        const afterRelaunch = createAutoAcceptSessions();
        expect(afterRelaunch.get().size).toBe(0);
        expect(afterRelaunch.isOn('a')).toBe(false);
    });

    it('carries nothing between two live instances, so a flip cannot inherit it', () => {
        const one = createAutoAcceptSessions();
        const two = createAutoAcceptSessions();
        one.set('shared-id', true);
        expect(two.isOn('shared-id')).toBe(false);
    });

    it('imports nothing that could persist it', () => {
        // The app's only durable stores are settings.ts (account-wide, synced
        // to every device) and localSettings.ts (device-wide, MMKV), and both
        // are reached through persistence.ts. This module reaches none of
        // them, and that ABSENCE is the feature — asserted rather than
        // commented, because an import added later would make the toggle
        // sticky with nothing else in the suite noticing.
        const source = readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), 'autoAcceptSessions.ts'),
            'utf8',
        );
        // No imports at all, which is the strongest form of the claim: with
        // nothing in the module graph there is nothing that could write a
        // durable copy. Read off the code rather than the prose, since the
        // header names those modules in order to say it reaches none of them.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/^\s*import\b/m);
        expect(code).not.toMatch(/\brequire\s*\(/);
        for (const forbidden of ['persistence', 'localSettings', 'MMKV', 'AsyncStorage']) {
            expect(code, forbidden).not.toContain(forbidden);
        }
    });
});
