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
     * App boot, in the order readAloudService.ts does it: the default is armed
     * from the persisted setting BEFORE the audio wiring publishes anything.
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

    it('turning it ON from settings holds the session and puts a card up', () => {
        // AC 1. The bug: this wrote the local setting and stopped there,
        // because the only `setEnabled` caller was an effect on a mounted
        // SessionView. Nothing here mounts one.
        launch(false);
        h.hold = [];
        h.reading = [];

        settings.write(true);

        expect(reader.isEnabled).toBe(true);
        expect(h.hold).toEqual([true]);
        expect(h.reading).toEqual(['reading']);
    });

    it('turning it OFF from settings releases the session and clears the card', () => {
        launch(true);
        h.hold = [];
        h.reading = [];

        settings.write(false);

        expect(reader.isEnabled).toBe(false);
        expect(h.hold).toEqual([false]);
        expect(h.reading).toEqual(['off']);
    });

    it('a cold launch with it persisted ON never publishes off', () => {
        // AC 2, and the sharper half of the ticket. `setReadingState('off')` is
        // not a missed publish, it is an ACTIVE teardown in native: it tears
        // down the remote commands and clears the now-playing card. The app
        // used to do that to itself at launch because no screen was up yet.
        launch(true);

        expect(h.reading).toEqual(['reading']);
        expect(h.reading).not.toContain('off');
        expect(h.hold).toEqual([true]);
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

    it('keeps DROVE-297: a session switched off stays off when the default comes on', () => {
        // The default is a DEFAULT. Turning the master switch on from settings
        // must not re-arm a session the user explicitly silenced.
        launch(false);
        reader.setSessionEnabled('quiet', false);

        settings.write(true);

        expect(reader.isSessionEnabled('quiet')).toBe(false);
        expect(reader.isSessionEnabled('other')).toBe(true);
    });

    it('keeps DROVE-226: arming at launch reads no history', async () => {
        // The one thing that sounds like it should break. A cold launch comes
        // up ARMED and SILENT: `defaultEnabled` decides whether the reader may
        // speak, and what it speaks comes from a timeline that is empty until
        // sync feeds it forward.
        launch(true);
        reader.focus('s1');
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
