import { describe, expect, it, vi } from 'vitest';

// Same reason audioRouteGuard.spec.ts mocks it: vitest reaches the local expo
// module through an alias but not through autolinking. The port list is
// DROVE-92's truth about what counts as headphones.
vi.mock('drover-speech', () => ({
    routeHasHeadphones: (ports: readonly string[]) => ports.some((port) => [
        'Headphones',
        'BluetoothA2DPOutput',
        'BluetoothHFP',
        'BluetoothLE',
        'USBAudio',
    ].includes(port)),
}));

import { AudioRouteGuard } from './audioRouteGuard';
import { ReadAloudReader, type ReadAloudInterruption } from './readAloud';
import type { Message } from '@/sync/typesMessage';

/**
 * Unplugging the headphones PAUSES the reading at its place (DROVE-294).
 *
 * Clay, and he had said it before: "When headphones are disconnected it is
 * supposed to PAUSE the playback — I've told you this many times." DROVE-119
 * shipped a stop that also switched the reader off; DROVE-189 swung to the
 * other wrong verb and let the reply carry on out of the phone's speaker
 * under a toast. This file pins the verb every music app uses: route lost
 * mid-reading means pause-at-position, reader still ON, speaker never fed.
 *
 * The route guard here is the REAL one wired to a REAL reader, the same
 * wiring audioRouteGuardService.ts does in the app, so the pause the unplug
 * takes is the same pause the long press, the headphone press and the lock
 * screen take (DROVE-233) — one state, one position, resumable from any
 * surface.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

const headphones = ['BluetoothA2DPOutput'];
const speaker = ['Speaker'];

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface Rig {
    reader: ReadAloudReader;
    guard: AudioRouteGuard;
    said: string[];
    /** Resolves the utterance in flight, sentence by sentence. */
    gate: { release: (() => void) | null };
    toasts: number[];
    captures: ReadAloudInterruption[];
}

function rig(): Rig {
    const said: string[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const toasts: number[] = [];
    const captures: ReadAloudInterruption[] = [];
    const reader = new ReadAloudReader({
        speak(text: string) {
            said.push(text);
            return new Promise<void>((resolve) => { gate.release = resolve; });
        },
        stop() { },
    });
    reader.setEnabled(true);
    reader.focus('s1');
    reader.setSessionEnabled('s1', true);
    reader.addInterruptListener((reason) => captures.push(reason));
    // The exact dependencies audioRouteGuardService.ts wires, minus the
    // storage read and the watch: the decision layer against the real reader.
    const guard = new AudioRouteGuard({
        route: () => [],
        isSpeaking: () => reader.isSpeaking,
        isEnabled: () => reader.isEnabled,
        speaker: () => 'phone',
        pause: () => reader.setPaused(true),
        interrupt: () => reader.interrupt('headphones-unplugged'),
        announce: () => { toasts.push(said.length); },
    });
    return { reader, guard, said, gate, toasts, captures };
}

/** Read to the middle of the reply: 'One.' finished, 'Two.' in flight. */
async function midSentence(r: Rig): Promise<void> {
    r.guard.observe(headphones);
    r.reader.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 1)]);
    await settle();
    r.gate.release?.();
    await settle();
    expect(r.said).toEqual(['One.', 'Two.']);
}

describe('unplugging mid-reading (DROVE-294)', () => {
    it('pauses at the position: nothing more is fed to the speaker', async () => {
        const r = rig();
        await midSentence(r);
        r.guard.observe(speaker);
        expect(r.reader.isPaused).toBe(true);
        // The cut utterance settling must not pump the next sentence out of
        // the loudspeaker: this is DROVE-119's safety goal, held by the pause.
        r.gate.release?.();
        await settle();
        expect(r.said).toEqual(['One.', 'Two.']);
    });

    it('leaves the reader ON: pause is a third state, not a way to be off', async () => {
        const r = rig();
        await midSentence(r);
        r.guard.observe(speaker);
        expect(r.reader.isEnabled).toBe(true);
        expect(r.reader.isPaused).toBe(true);
    });

    it('plugging back in does not auto-resume: the pause is his to lift', async () => {
        // Consistent with iOS music and DROVE-289's rule that a pause he
        // holds only he lifts. Resume is his gesture — button, headphone
        // press, lock screen — and any of them works because it is the same
        // pause (DROVE-233).
        const r = rig();
        await midSentence(r);
        r.guard.observe(speaker);
        r.gate.release?.();
        r.guard.observe(headphones);
        await settle();
        expect(r.reader.isPaused).toBe(true);
        expect(r.said).toEqual(['One.', 'Two.']);
    });

    it('his resume continues at the NEXT sentence: nothing re-read, nothing skipped', async () => {
        // The pair of failure modes readAloudPause.spec.ts names: a resume
        // that restarts the reply says 'Two.' twice, one that behaves like a
        // START jumps to the tail and skips 'Three.'. Unplug-pause must hold
        // the same position every other pause holds (DROVE-233, DROVE-263:
        // nothing shortens what was heard).
        const r = rig();
        await midSentence(r);
        r.guard.observe(speaker);
        r.gate.release?.();
        await settle();
        r.reader.setPaused(false);
        for (let i = 0; i < 12; i++) { r.gate.release?.(); await settle(); }
        expect(r.said).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
    });

    it('still tells the captures, so a latched mic stops (DROVE-119)', async () => {
        const r = rig();
        await midSentence(r);
        r.guard.observe(speaker);
        expect(r.captures).toContain('headphones-unplugged');
    });

    it('announces after the pause: the toast describes a speaker already silent', async () => {
        const r = rig();
        await midSentence(r);
        r.guard.observe(speaker);
        expect(r.toasts).toEqual([2]);
        expect(r.reader.isPaused).toBe(true);
    });
});
