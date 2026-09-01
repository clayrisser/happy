import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The session is held whenever read-aloud is ON (DROVE-233 nowplaying-card).
 *
 * backgroundAudio.spec.ts pins the reader's rest/stop behaviour. This file pins
 * the OTHER half — `startBackgroundAudio`'s hold decision — which used to be
 * `backgrounded && isEnabled` and is now `isEnabled` alone. The reason is the
 * missing lock-screen card: the DROVE-259 keepalive is the app's only audio
 * producer and it is gated `guard sessionHeld` in native, so read-aloud on in
 * the FOREGROUND with no sentence in flight held nothing, produced nothing, and
 * iOS drew no card there (the H2a half). Holding while enabled — foreground
 * included — keeps a producer alive. It costs nothing in ducked music any more:
 * read-aloud is PRIMARY audio now, not a ducking session (the Swift
 * `.duckOthers` drop), so there is no music to dip by holding in the foreground.
 *
 * `react-native` and `drover-speech` are mocked the same way the other voice
 * specs mock the local native module: vitest reaches it through an alias but
 * not through autolinking.
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
    speechInterruptionsHandled: () => true,
}));

import { startBackgroundAudio, type BackgroundReader } from './backgroundAudio';

/** A reader whose state the test drives, firing the two listeners the hold reads. */
class FakeReader implements BackgroundReader {
    isEnabled = true;
    isPaused = false;
    backgrounded = false;
    private interruptListeners: Array<(reason: string) => void> = [];
    private transportListeners: Array<() => void> = [];

    setBackgrounded(backgrounded: boolean): void { this.backgrounded = backgrounded; }
    setPaused(paused: boolean): void { this.isPaused = paused; this.fireTransport(); }
    audioSessionRecovered(): void { }
    addInterruptListener(listener: (reason: string) => void): () => void {
        this.interruptListeners.push(listener);
        return () => { this.interruptListeners = this.interruptListeners.filter((l) => l !== listener); };
    }
    addTransportListener(listener: () => void): () => void {
        this.transportListeners.push(listener);
        return () => { this.transportListeners = this.transportListeners.filter((l) => l !== listener); };
    }

    /** Turn read-aloud on/off the way an interrupt does, so the hold re-applies. */
    setEnabled(enabled: boolean): void {
        this.isEnabled = enabled;
        for (const l of this.interruptListeners) l('toggled');
    }
    /** A pause/resume publishes through the transport listener. */
    fireTransport(): void { for (const l of this.transportListeners) l(); }
}

describe('holding the session (DROVE-233 nowplaying-card)', () => {
    let reader: FakeReader;
    let dispose: () => void;

    beforeEach(() => {
        h.appState.currentState = 'active';
        h.appState.listeners = [];
        h.hold = [];
        h.reading = [];
        reader = new FakeReader();
    });

    afterEach(() => { dispose?.(); });

    function background(): void {
        h.appState.currentState = 'background';
        for (const l of h.appState.listeners) l('background');
    }

    it('holds the session with read-aloud ON in the FOREGROUND', () => {
        // The whole change. Old code was `backgrounded && isEnabled`, so this
        // held nothing in the foreground and the keepalive never ran, so no
        // card. Enabled alone now holds it.
        reader.isEnabled = true;
        dispose = startBackgroundAudio(reader);
        expect(h.hold).toEqual([true]);
    });

    it('holds the session with read-aloud ON in the BACKGROUND (unchanged)', () => {
        reader.isEnabled = true;
        h.appState.currentState = 'background';
        dispose = startBackgroundAudio(reader);
        expect(h.hold).toEqual([true]);
    });

    it('holds nothing while read-aloud is OFF, foreground or background', () => {
        reader.isEnabled = false;
        dispose = startBackgroundAudio(reader);
        background();
        // Never asked to hold; the one call is the initial false.
        expect(h.hold.every((v) => v === false)).toBe(true);
        expect(h.hold).not.toContain(true);
    });

    it('keeps holding while PAUSED in the foreground (pause is not off)', () => {
        // A pause that released the session would let iOS suspend the app, and a
        // suspended app cannot be resumed from the lock screen (DROVE-233).
        reader.isEnabled = true;
        dispose = startBackgroundAudio(reader);
        expect(h.hold).toEqual([true]);
        reader.setPaused(true);
        // Still held: the hold reads isEnabled, which stays true through a pause.
        expect(h.hold).toEqual([true]);
        expect(h.reading[h.reading.length - 1]).toBe('paused');
    });

    it('releases the session when read-aloud goes OFF', () => {
        reader.isEnabled = true;
        dispose = startBackgroundAudio(reader);
        expect(h.hold).toEqual([true]);
        reader.setEnabled(false);
        expect(h.hold).toEqual([true, false]);
        expect(h.reading[h.reading.length - 1]).toBe('off');
    });

    it('publishes a reading card in the foreground with no sentence in flight', () => {
        // The card exists because read-aloud is on, not because something is
        // being said this instant (DROVE-233).
        reader.isEnabled = true;
        reader.isPaused = false;
        dispose = startBackgroundAudio(reader);
        expect(h.reading).toEqual(['reading']);
    });
});
