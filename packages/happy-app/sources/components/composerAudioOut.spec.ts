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

    /**
     * PAUSED IS THE ONE STATE YOU CANNOT GUESS (DROVE-258).
     *
     * Clay: "When I long press read and it pauses color it I dunno pause
     * colour maybe yellow or orange and show pause icon." Before this ticket
     * paused and reading drew the SAME glyph and were told apart by the disc
     * alone, so the only way to know which one you were in was to remember
     * what you last did. Read-aloud is the eyes-free feature; remembering is
     * exactly what it exists to save you.
     */
    it('reads PAUSED as a pause glyph on the pause disc', () => {
        const b = audioOutButton({ readAloudEnabled: true, paused: true });
        expect(b.state).toBe('paused');
        expect(b.glyph).toBe('pause');
        expect(b.fill).toBe('paused');
    });

    /**
     * THE RESUME PATH, and it is the one worth a test of its own: a control
     * stuck showing paused after a resume is worse than no indicator at all,
     * because it lies rather than being silent. BOTH carriers have to come
     * back, so both are asserted, and against the reading face rather than
     * against literals so they cannot drift apart.
     */
    it('hands BOTH carriers back on a resume, not just the colour', () => {
        const reading = audioOutButton({ readAloudEnabled: true });
        const paused = audioOutButton({ readAloudEnabled: true, paused: true });
        const resumed = audioOutButton({ readAloudEnabled: true, paused: false });
        expect(paused.glyph).not.toBe(reading.glyph);
        expect(paused.fill).not.toBe(reading.fill);
        expect(resumed.glyph).toBe(reading.glyph);
        expect(resumed.fill).toBe(reading.fill);
        expect(resumed.state).toBe('reading');
        expect(resumed.paused).toBe(false);
    });

    /**
     * And the whole round trip through the table that drives it, because the
     * button is drawn from a state some OTHER surface may have set: a
     * headphone squeeze and the lock screen land on the same `setPaused`.
     */
    it('draws reading again after a long press pauses and a long press resumes', () => {
        let paused = false;
        const step = () => {
            const button = audioOutButton({ readAloudEnabled: true, paused });
            const effect = transportEffect('long-press', button.state);
            if (effect === 'pause') paused = true;
            if (effect === 'resume') paused = false;
            return button;
        };
        expect(step().fill).toBe('accent');
        expect(step().fill).toBe('paused');
        const back = step();
        expect(back.fill).toBe('accent');
        expect(back.glyph).toBe('volume-high');
    });

    it('reads a LIVE CALL as the recording disc', () => {
        const b = audioOutButton({ readAloudEnabled: false, bossActive: true });
        expect(b.fill).toBe('recording');
    });

    /**
     * DROVE-236's CONSTRAINT, kept: four things read apart on two carriers.
     *
     * DROVE-258 spends one hue on paused and the constraint still holds, so
     * the assertion is unchanged apart from the set below: every PAIR differs
     * in at least one carrier, and now most pairs differ in both.
     */
    it('tells all four apart on two carriers', () => {
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
        // Three hues and a bare face, one per LIVE state, and every hue is one
        // composerControlColour.ts already had (DROVE-215, DROVE-258).
        expect(new Set(names.map((n) => faces[n].fill)))
            .toEqual(new Set(['none', 'paused', 'accent', 'recording']));
    });

    it('leaves OFF the one face with no colour, because nothing is happening on it', () => {
        // DROVE-215's rule, narrowed rather than broken. Read-aloud off is the
        // only state where the reader is not holding anything: no queue, no
        // place, no sound. Paused holds a place and is one press from speaking,
        // which is a live state and is what DROVE-258 gives the amber to.
        expect(audioOutButton({ readAloudEnabled: false }).fill).toBe('none');
        expect(audioOutButton({ readAloudEnabled: true, paused: true }).fill).not.toBe('none');
        expect(audioOutButton({ readAloudEnabled: true }).fill).not.toBe('none');
    });

    it('does not turn the glyph into a waveform during a call', () => {
        // The glyph's job is to say what a TAP will do, and a tap always means
        // read-aloud on or off. A waveform over a tap that toggles reading
        // would be DROVE-206's failure in a smaller box.
        const off = audioOutButton({ readAloudEnabled: false, bossActive: true });
        const on = audioOutButton({ readAloudEnabled: true, bossActive: true });
        expect(off.glyph).toBe('volume-mute-outline');
        expect(on.glyph).toBe('volume-high');
        // And the pause bars are not a waveform either: a paused reader in a
        // call still says what its TAP will do to read-aloud.
        expect(audioOutButton({ readAloudEnabled: true, paused: true, bossActive: true }).glyph)
            .toBe('pause');
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
