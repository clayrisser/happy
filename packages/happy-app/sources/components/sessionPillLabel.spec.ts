/**
 * The composer's session label and the model name's width (DROVE-83,
 * DROVE-111).
 *
 * The short names come from the model id, the mode and the effort are drawn
 * as glyphs now so only the model is spelled out, and it truncates at the
 * tail when the button row cannot hold it. The budget test is what keeps the
 * row honest: it is the screen minus every button and every gap, and
 * `Opus 5 1M` has to survive it.
 */
import { describe, expect, it } from 'vitest';
import {
    buildSessionPillLabel,
    composerModelNameFits,
    COMPOSER_MODEL_TRUNCATION,
    resolveComposerModelTextBudget,
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

    it('only ever truncates the model, and at the tail now the row runs left to right', () => {
        expect(COMPOSER_MODEL_TRUNCATION).toEqual({ segment: 'model', ellipsizeMode: 'tail' });
    });
});

describe('the model name on the button row at 393pt', () => {
    // add(42) + mode(38) + effort(38) + speaker(42) + mic(42) + primary(42)
    // + the primary's 8pt margin + seven 6pt gaps, inside 8pt of container
    // padding and 10pt of shell inset a side.
    it('leaves the name the screen minus every button and every gap', () => {
        expect(resolveComposerModelTextBudget(393))
            .toBe(393 - 16 - 20 - 42 - 76 - 126 - 8 - 42);
        expect(resolveComposerModelTextBudget(393)).toBe(63);
    });

    it('holds the names Clay actually runs', () => {
        for (const model of [
            { key: 'claude-opus-5[1m]' },
            { key: 'claude-fable-5' },
            { key: 'claude-opus-5' },
            { key: 'claude-sonnet-5' },
        ]) {
            const name = shortModelName(model);
            expect(composerModelNameFits(name, 393), name ?? '').toBe(true);
        }
    });

    // Not every model fits, and that is the deal DROVE-111 made: the mode and
    // the effort became glyphs so the model got the slack, and a name past
    // nine or ten characters still tail-truncates. The picker spells it out.
    it('reports a long provider name as one that will be cut', () => {
        expect(composerModelNameFits('Gemini 3.1 Flash Lite', 393)).toBe(false);
    });

    it('never claims a missing name does not fit', () => {
        expect(composerModelNameFits(null, 393)).toBe(true);
    });
});
