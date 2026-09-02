import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SETTING REACHES NATIVE WITH NO SCREEN MOUNTED (DROVE-301).
 *
 * backgroundAudioHold.spec.ts pins what `startBackgroundAudio` does with a
 * reader whose state the test drives by hand. It cannot tell you whether the
 * SETTINGS TOGGLE ever moves that reader, which is the acceptance criterion
 * this ticket exists for, so this file wires the whole path instead: a fake
 * settings store, the real `startReadingDefault`, a REAL `ReadAloudReader`, and
 * the real `startBackgroundAudio` over a fake native module. The assertions are
 * on what native was told.
 *
 * THERE IS NO REACT ANYWHERE IN HERE, and no SessionView is ever mounted. That
 * is the claim written as a test rather than as a comment: the old code path
 * ran through an effect in `useVoiceComposer` gated on a mounted, non-embedded
 * session screen, so every test below would have seen nothing at all.
 *
 * `react-native` and `drover-speech` are mocked the way the other voice specs
 * mock them: vitest reaches the local native module through an alias but not
 * through autolinking.
 *
 * RETARGETED BY DROVE-386, AND THE REASON MATTERS MORE THAN THE DIFF. Every
 * assertion below used to be written against "the setting is what a session
 * nobody has touched inherits", so "the setting reached the reader" and "a
 * session started talking" were the same observation and the tests measured
 * the second to prove the first. Clay's rule splits them: the persisted
 * setting is a CAPABILITY, and arming is per session and his. So each test
 * here now measures the two separately — the capability landing on the reader
 * with no screen mounted (DROVE-301's actual acceptance criterion, untouched),
 * and a session being armed by hand afterwards putting the card up.
 *
 * NOTHING IS WEAKENED BY THAT. The publishes are still asserted exactly, the
 * cold-launch teardown DROVE-301 was filed for is still refused, and the one
 * test whose SENSE is inverted ("a cold launch comes up armed") says so in its
 * own body.
 */

const h = vi.hoisted(() => ({
    appState: { currentState: 'active' as string, listeners: [] as Array<(s: string) => void> },
    hold: [] as boolean[],
    reading: [] as string[],
}));

vi.mock('react-native', () => ({
    AppState: {
        get currentState() { return h.appState.currentState; },
        addEventListener: (_type: string, cb: (s: string) => void) => {
            h.appState.listeners.push(cb);
            return { remove() { h.appState.listeners = h.appState.listeners.filter((l) => l !== cb); } };
        },
    },
}));

vi.mock('drover-speech', () => ({
    holdAudioSession: (v: boolean) => { h.hold.push(v); return Promise.resolve(); },
    setReadingState: (v: string) => { h.reading.push(v); return Promise.resolve(); },
    addRemoteCommandListener: () => ({ remove() { } }),
    addSpeechInterruptionListener: () => ({ remove() { } }),
}));

import { startBackgroundAudio } from './backgroundAudio';
import { startReadingDefault } from './readingDefault';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import type { Message } from '@/sync/typesMessage';

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

/** An engine whose utterances finish when the test says so. */
class FakeEngine {
    spoken: string[] = [];
    private resolvers: Array<() => void> = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        for (const resolve of this.resolvers.splice(0)) resolve();
    }
}

/**
 * The persisted `localSettings.readAloudEnabled` and nothing else — the whole
 * of what Settings -> Voice, the channels screen and `DroverChannelsSheet`
 * write when the user flips the switch.
 */
class FakeSettings {
    private value: boolean;
    private listeners: Array<() => void> = [];

    constructor(initial: boolean) { this.value = initial; }

    read = (): boolean => this.value;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.push(listener);
        return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
    };

    /** What a settings row does: write the setting, notify the store. */
    write(next: boolean): void {
        this.value = next;
        for (const listener of this.listeners) listener();
    }

    /** A store change that did not touch this setting — a message arriving. */
    churn(): void {
        for (const listener of this.listeners) listener();
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('the read-aloud setting with no session screen mounted (DROVE-301)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;
    let settings: FakeSettings;
    let stopDefault: (() => void) | null;
    let stopAudio: (() => void) | null;

    beforeEach(() => {
        h.appState.currentState = 'active';
        h.appState.listeners = [];
        h.hold = [];
        h.reading = [];
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        stopDefault = null;
        stopAudio = null;
    });

    afterEach(() => {
        stopAudio?.();
        stopDefault?.();
    });

    /**
     * App boot, in the order readAloudService.ts does it: the capability lands
     * on the reader from the persisted setting BEFORE the audio wiring
     * publishes anything.
     */
    function launch(persisted: boolean): void {
        settings = new FakeSettings(persisted);
        stopDefault = startReadingDefault({
            read: settings.read,
            subscribe: settings.subscribe,
            setEnabled: (enabled) => reader.setEnabled(enabled),
        });
        stopAudio = startBackgroundAudio(reader);
    }

    it('turning it ON from settings reaches the reader with no screen mounted, and arms nothing', () => {
        // AC 1, WHICH IS STILL THE POINT OF DROVE-301. The bug it was filed
        // for is that this wrote the local setting and stopped there, because
        // the only `setEnabled` caller was an effect on a mounted SessionView.
        // Nothing here mounts one, and the setting still lands.
        //
        // What changed is the SECOND half of the old assertion. The setting
        // arriving used to be enough to hold the session and put a card up,
        // because an un-switched session inherited it. It no longer does
        // (DROVE-386): the capability landing is a fact about the phone, not a
        // command to start talking.
        launch(false);
        h.hold = [];
        h.reading = [];

        settings.write(true);

        expect(reader.readingReport().defaultEnabled).toBe(true);
        expect(reader.isEnabled).toBe(false);
        expect(h.hold).not.toContain(true);
        expect(h.reading).not.toContain('reading');
    });

    it('a session armed by hand afterwards holds the session and puts a card up, still with no screen', () => {
        // The other half of AC 1, and the half that proves the path is whole:
        // the card comes up from a module-scope reader with no SessionView
        // anywhere, exactly as DROVE-301 required. Only the trigger moved,
        // from "the setting arrived" to "he armed this session".
        launch(true);
        h.hold = [];
        h.reading = [];

        reader.setSessionEnabled('s1', true);

        expect(reader.isEnabled).toBe(true);
        expect(h.hold).toEqual([true]);
        expect(h.reading).toEqual(['reading']);
    });

    it('turning it OFF from settings releases the session and clears the card', () => {
        launch(true);
        reader.setSessionEnabled('s1', true);
        h.hold = [];
        h.reading = [];

        settings.write(false);

        expect(reader.isEnabled).toBe(false);
        expect(h.hold).toEqual([false]);
        expect(h.reading).toEqual(['off']);
        // Off is still the kill, per session as well as globally (DROVE-289).
        expect(reader.isSessionEnabled('s1')).toBe(false);
    });

    it('a cold launch with it persisted ON comes up with NO session reading (DROVE-386)', () => {
        // THIS TEST'S SENSE IS INVERTED AND HERE IS WHY. It used to read "a
        // cold launch with it persisted ON never publishes off", because
        // `setReadingState('off')` is an ACTIVE teardown in native — it tears
        // down the remote commands and clears the now-playing card — and
        // DROVE-301 was filed because the app did that to itself at launch
        // while no screen was up.
        //
        // Clay's rule makes the teardown CORRECT at launch: "even if it was
        // reading, if I close the app and reopen, it shouldn't". Nothing is
        // reading after a relaunch, so there is nothing for the lock screen to
        // show and publishing 'off' is the honest state rather than a
        // self-inflicted dismantling. The failure DROVE-301 named — a card
        // that should exist being torn down — is still refused, by the test
        // above: arm a session and the card comes up with no screen mounted.
        launch(true);

        expect(h.reading).toEqual(['off']);
        expect(h.hold).not.toContain(true);
        // And the capability DID land, so this is a silent phone rather than
        // a phone that never heard the setting. That distinction is the whole
        // of DROVE-301 and it is what this line keeps.
        expect(reader.readingReport().defaultEnabled).toBe(true);
    });

    it('a cold launch with it persisted OFF publishes off once, and holds nothing', () => {
        // The negative control, so the test above cannot pass by never
        // publishing. Off at launch is correct here: nothing is reading.
        launch(false);

        expect(h.reading).toEqual(['off']);
        expect(h.hold.every((v) => v === false)).toBe(true);
        expect(h.hold).not.toContain(true);
    });

    it('unrelated store churn does not re-publish', () => {
        // `storage.subscribe` fires on every message. `setEnabled` returns
        // early when the default has not moved, which is what keeps a bridge
        // call off the arrival path — and, more importantly, is what stops a
        // redundant `setEnabled(false)` from clearing the per-session switches.
        launch(true);
        h.hold = [];
        h.reading = [];

        settings.churn();
        settings.churn();

        expect(h.hold).toEqual([]);
        expect(h.reading).toEqual([]);
    });

    it('the capability coming on re-arms nothing, the session he silenced included', () => {
        // Was "a session switched off stays off when the default comes on",
        // which asserted the silenced session stayed off and any OTHER session
        // came on. The first clause is unchanged and the second is inverted:
        // no session comes on, because there is no longer a default to inherit
        // (DROVE-386). Turning the capability on is him making the feature
        // available, not him asking for audio.
        launch(false);
        reader.setSessionEnabled('quiet', false);

        settings.write(true);

        expect(reader.isSessionEnabled('quiet')).toBe(false);
        expect(reader.isSessionEnabled('other')).toBe(false);
    });

    it('keeps DROVE-226: a session armed at launch reads no history', async () => {
        // The one thing that sounds like it should break. An armed session is
        // ARMED and SILENT: the switch decides whether the reader may speak,
        // and what it speaks comes from a timeline that is empty until sync
        // feeds it forward.
        launch(true);
        reader.setSessionEnabled('s1', true);
        await settle();

        expect(reader.isEnabled).toBe(true);
        expect(engine.spoken).toEqual([]);

        // And it does read what arrives after, so the silence above is not the
        // reader being broken.
        reader.onMessages('s1', [prose('m1', 'Hello there.', 1)]);
        await settle();
        expect(engine.spoken).toEqual(['Hello there.']);
    });
});
