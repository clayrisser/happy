import { describe, expect, it } from 'vitest';
import { audioOutButton } from './composerAudioOut';
import { transportEffect } from '@/voice/readAloudTransport';

/**
 * THE ONE AUDIO-OUT BUTTON (DROVE-236).
 *
 * Two questions and they are separate: what a gesture MEANS is
 * readAloudTransport.spec.ts, and what the button LOOKS like is here. The one
 * that matters is the second, because the ticket's hard constraint is that four
 * things read apart without a colour each.
 */

const shown = { readAloudEnabled: false };

describe('what the collapsed button draws', () => {
    it('is not drawn at all where the surface has no reader', () => {
        expect(audioOutButton({ readAloudEnabled: undefined }).shown).toBe(false);
    });

    it('reads NORMAL as a slashed speaker on no disc', () => {
        const b = audioOutButton(shown);
        expect(b.state).toBe('off');
        expect(b.glyph).toBe('volume-mute-outline');
        expect(b.fill).toBe('none');
    });

    it('reads READING as a speaker with waves on the accent disc', () => {
        const b = audioOutButton({ readAloudEnabled: true });
        expect(b.state).toBe('reading');
        expect(b.glyph).toBe('volume-high');
        expect(b.fill).toBe('accent');
    });

    it('reads PAUSED as the reading glyph with the disc taken away', () => {
        const b = audioOutButton({ readAloudEnabled: true, paused: true });
        expect(b.state).toBe('paused');
        expect(b.glyph).toBe('volume-high');
        expect(b.fill).toBe('none');
    });

    it('reads a LIVE CALL as the recording disc', () => {
        const b = audioOutButton({ readAloudEnabled: false, bossActive: true });
        expect(b.fill).toBe('recording');
    });

    /**
     * THE TICKET'S CONSTRAINT, as an assertion rather than as prose: no state
     * has a colour of its own. Two carriers, four things, and each PAIR differs
     * in at least one carrier.
     */
    it('tells all four apart on two carriers, with no hue per state', () => {
        const faces = {
            normal: audioOutButton({ readAloudEnabled: false }),
            paused: audioOutButton({ readAloudEnabled: true, paused: true }),
            reading: audioOutButton({ readAloudEnabled: true }),
            boss: audioOutButton({ readAloudEnabled: false, bossActive: true }),
        };
        const names = Object.keys(faces) as (keyof typeof faces)[];
        for (const a of names) {
            for (const b of names) {
                if (a === b) continue;
                const differs = faces[a].glyph !== faces[b].glyph
                    || faces[a].fill !== faces[b].fill;
                expect(differs, `${a} vs ${b}`).toBe(true);
            }
        }
        // And there are only ever two hues in the whole button, both of which
        // already meant "happening now" before this ticket (DROVE-215).
        expect(new Set(names.map((n) => faces[n].fill)))
            .toEqual(new Set(['none', 'accent', 'recording']));
    });

    it('never puts a colour on a state where nothing is happening', () => {
        // DROVE-215: "a control that merely HOLDS a value is not active". Off
        // holds nothing and paused holds a place, and neither is a sound coming
        // out of the phone.
        expect(audioOutButton({ readAloudEnabled: false }).fill).toBe('none');
        expect(audioOutButton({ readAloudEnabled: true, paused: true }).fill).toBe('none');
    });

    it('does not turn the glyph into a waveform during a call', () => {
        // The glyph's job is to say what a TAP will do, and a tap always means
        // read-aloud on or off. A waveform over a tap that toggles reading
        // would be DROVE-206's failure in a smaller box.
        const off = audioOutButton({ readAloudEnabled: false, bossActive: true });
        const on = audioOutButton({ readAloudEnabled: true, bossActive: true });
        expect(off.glyph).toBe('volume-mute-outline');
        expect(on.glyph).toBe('volume-high');
    });

    it('refuses a fourth state from a stale paused flag', () => {
        const b = audioOutButton({ readAloudEnabled: false, paused: true });
        expect(b.paused).toBe(false);
        expect(b.state).toBe('off');
    });

    it('names itself for a screen reader in every state', () => {
        expect(audioOutButton({ readAloudEnabled: false }).labelKey)
            .toBe('agentInput.streamTalk.off');
        expect(audioOutButton({ readAloudEnabled: true }).labelKey)
            .toBe('agentInput.streamTalk.on');
        expect(audioOutButton({ readAloudEnabled: true, paused: true }).labelKey)
            .toBe('agentInput.streamTalk.paused');
        expect(audioOutButton({ readAloudEnabled: true, bossActive: true }).labelKey)
            .toBe('agentInput.audioOut.boss');
    });
});

describe('the button and the table agree about which row he is on', () => {
    it('hands the transport table the state it will be asked about', () => {
        // The button does not decide anything; it reports the state the table
        // reads, so what is drawn and what a long press does cannot diverge.
        const cases = [
            { input: { readAloudEnabled: false }, longPress: 'boss-mode' },
            { input: { readAloudEnabled: true }, longPress: 'pause' },
            { input: { readAloudEnabled: true, paused: true }, longPress: 'resume' },
        ] as const;
        for (const { input, longPress } of cases) {
            expect(transportEffect('long-press', audioOutButton(input).state)).toBe(longPress);
        }
    });
});
