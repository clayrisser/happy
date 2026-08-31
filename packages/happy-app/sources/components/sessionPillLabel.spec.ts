/**
 * The composer's session label, and the room the model's name has on the
 * button row (DROVE-83, DROVE-111, DROVE-138, DROVE-178).
 *
 * The short names come from the model id, the mode and the effort are drawn
 * as glyphs, and the model's name is the capsule's third segment again. The
 * width arithmetic came back with it: DROVE-138 moved the name away because
 * six 63pt buttons were cutting `Opus 5 1M` to `Opus 5...`, so the point of
 * pinning it here is to show that the gap DROVE-153 opened is wide enough
 * that the same cut cannot happen twice.
 */
import { describe, expect, it } from 'vitest';
import {
    buildSessionPillLabel,
    COMPOSER_MODEL_SEGMENT,
    composerAudioDividers,
    composerModelBudget,
    composerModelFits,
    composerModelSegmentWidth,
    composerRowFixedWidth,
    COMPOSER_ROW_GEOMETRY,
    SESSION_PILL_SEPARATOR,
    shortModelName,
} from './sessionPillLabel';
import {
    getClaudeEffortLevels,
    getClaudeModelModes,
    getCodexEffortLevels,
    getCodexModelModes,
    getGeminiModelModes,
} from './modelModeOptions';

describe('shortModelName', () => {
    it('maps the Claude ids to the names people use', () => {
        expect(shortModelName({ key: 'claude-fable-5' })).toBe('Fable 5');
        expect(shortModelName({ key: 'claude-opus-5' })).toBe('Opus 5');
        expect(shortModelName({ key: 'claude-sonnet-5' })).toBe('Sonnet 5');
        expect(shortModelName({ key: 'claude-haiku-4-5' })).toBe('Haiku 4.5');
    });

    it('marks the 1M variant and drops a snapshot date', () => {
        expect(shortModelName({ key: 'claude-opus-5[1m]' })).toBe('Opus 5 1M');
        expect(shortModelName({ key: 'claude-sonnet-4-6-20260201' })).toBe('Sonnet 4.6');
    });

    it('maps from the id even when the picker named it after the id', () => {
        // includePaneModel adds a pane's model with name === key.
        expect(shortModelName({ key: 'claude-opus-4-8', name: 'claude-opus-4-8' })).toBe('Opus 4.8');
        expect(shortModelName({ key: 'claude-opus-5[1m]', name: 'Opus 5 [1M]' })).toBe('Opus 5 1M');
    });

    it('prefers modelId over key when both are present', () => {
        expect(shortModelName({ key: 'pane', modelId: 'claude-fable-5', name: 'pane' })).toBe('Fable 5');
    });

    it('keeps an unknown model as the picker names it, or as-is', () => {
        expect(shortModelName({ key: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' })).toBe('GPT-5.6 Sol');
        expect(shortModelName({ key: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' })).toBe('Gemini 2.5 Pro');
        expect(shortModelName({ key: 'my-fine-tune' })).toBe('my-fine-tune');
        expect(shortModelName({ key: 'claude-mythos-9' })).toBe('claude-mythos-9');
    });

    it('is null with no model', () => {
        expect(shortModelName(null)).toBeNull();
        expect(shortModelName(undefined)).toBeNull();
        expect(shortModelName({})).toBeNull();
    });
});

describe('buildSessionPillLabel', () => {
    it('reads mode, short model, effort with the middle dot', () => {
        const label = buildSessionPillLabel({
            modeLabel: 'Yolo',
            model: { key: 'claude-fable-5', name: 'Fable 5' },
            effortLabel: 'High',
        });
        expect(label).toEqual({ mode: 'Yolo', model: 'Fable 5', effort: 'High', text: 'Yolo · Fable 5 · High' });
        expect(SESSION_PILL_SEPARATOR).toBe(' · ');
    });

    it('drops a segment the session does not have rather than leaving a dangling dot', () => {
        expect(buildSessionPillLabel({ modeLabel: 'Default', model: { key: 'claude-opus-5' } }).text)
            .toBe('Default · Opus 5');
        expect(buildSessionPillLabel({ model: { key: 'claude-opus-5' }, effortLabel: 'Max' }).text)
            .toBe('Opus 5 · Max');
        expect(buildSessionPillLabel({ modeLabel: '  ' }).text).toBe('');
    });

});

/**
 * The budget, at the two widths the app supports.
 *
 * `statusRowLayout.spec.ts` calls 375 the narrowest phone still supported and
 * 393 the handset Clay is on, so those are the two that have to hold. 320 is
 * below the floor for both files, and it is stated rather than skipped.
 */
describe('the model segment on the button row (DROVE-178)', () => {
    it('has 143pt at 393 and 125 at 375 once the row is what it draws (DROVE-206)', () => {
        expect(composerModelBudget(393)).toBe(143);
        expect(composerModelBudget(375)).toBe(125);
    });

    /**
     * The budget is only worth a number if the terms it subtracts are the row
     * that is drawn, and for two tickets they were not: the `+` was counted
     * here after DROVE-196 put it beside the field, and the card's padding was
     * counted on top of the screen inset after DROVE-196 moved that padding
     * onto this row.
     *
     * So the claim is arithmetic rather than a remembered number: everything
     * on the row, plus the name's budget, is exactly the phone. A term that
     * goes stale fails this before it reaches a screenshot.
     */
    it('adds up to the phone, which is what makes the budget checkable', () => {
        for (const width of [320, 375, 393]) {
            expect(
                2 * COMPOSER_ROW_GEOMETRY.screenInset
                + composerRowFixedWidth()
                + composerModelBudget(width),
                `the row at ${width}`,
            ).toBe(width);
        }
    });

    /**
     * DROVE-206 moved two things and the name came out ahead of both.
     */
    it('gains what the plus gave back and pays for the waveform out of it', () => {
        const g = COMPOSER_ROW_GEOMETRY;
        // The `+` is inside the field now, so the row is not paying for it or
        // for the gap it needed. 44 + 6.
        expect(g).not.toHaveProperty('add');
        // And the audio capsule is three controls, not two.
        expect(g.audioButtons).toBe(3);
        expect(composerAudioDividers).toBe(2);
        // 50 back for the `+`, 20 back for the card padding that stopped
        // existing in DROVE-196, 45 spent on the waveform and its hairline.
        expect(composerModelBudget(393) - 119).toBe(24);
    });

    it('draws every Claude name whole at both widths, at full size', () => {
        // The two Clay named on the ticket are the first two. `Opus 4.8 1M`
        // is the longest of the family and the one that has to hold: 97pt
        // against 125 at 375, which is the tightest the row ever gets.
        for (const name of ['Fable 5', 'Opus 5 1M', 'Opus 5', 'Sonnet 5', 'Haiku 4.5', 'Opus 4.8 1M']) {
            expect(composerModelFits(name, 393), `${name} at 393`).toBe(true);
            expect(composerModelFits(name, 375), `${name} at 375`).toBe(true);
        }
        expect(composerModelSegmentWidth('Opus 5 1M')).toBe(83);
        expect(composerModelSegmentWidth('Opus 4.8 1M')).toBe(97);
    });

    it('scales rather than truncating, and after DROVE-206 the scale is headroom', () => {
        // Smaller before shorter is the rule the segment draws by, so the
        // honest number is how long a name each size buys. The full size now
        // carries every name the app has: `GPT-5.6 Luna` and `Gemini 3.1 Pro`
        // both used to need the scale at their width and neither does.
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        expect(scale).toBe(0.85);
        for (const [name, width] of [['GPT-5.6 Luna', 375], ['GPT-5.6 Sol', 375],
            ['Gemini 3.1 Pro', 393], ['Gemini 3 Flash', 393]] as const) {
            expect(composerModelFits(name, width), `${name} at ${width}`).toBe(true);
        }

        // What the scale is still FOR: a name longer than any shipping one.
        // 15 glyphs at full size on the narrow phone, 17 with the scale; 17
        // and 20 on Clay's. The reach is the claim, not the model list, so a
        // longer name arriving is measured rather than guessed at.
        const longest = (width: number, fontScale: number) => {
            let glyphs = 0;
            while (composerModelSegmentWidth('x'.repeat(glyphs + 1), fontScale)
                <= composerModelBudget(width)) glyphs += 1;
            return glyphs;
        };
        expect([longest(375, 1), longest(375, scale)]).toEqual([15, 17]);
        expect([longest(393, 1), longest(393, scale)]).toEqual([17, 20]);
    });

    it('is what the row could NOT hold before DROVE-153, which is why DROVE-138 moved it', () => {
        // Six 63pt buttons left 63 for the name, and `Opus 5 1M` needs 83.
        expect(composerModelSegmentWidth('Opus 5 1M')).toBeGreaterThan(63);
        expect(composerModelBudget(393)).toBeGreaterThan(63);
    });

    it('has 70pt at 320, below the floor both files draw at but no longer nothing', () => {
        expect(composerModelBudget(320)).toBe(70);
        // 46 could not hold the shortest name in the family. 70 holds it by a
        // point, which is not room to design against and is the reason 320
        // stays below the supported floor rather than a width the row is
        // tuned for. `Opus 5 1M` still does not fit and still scales.
        expect(composerModelFits('Fable 5', 320)).toBe(true);
        expect(composerModelFits('Opus 5 1M', 320)).toBe(false);
    });
});
