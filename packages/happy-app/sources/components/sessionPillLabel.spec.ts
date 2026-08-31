/**
 * The session pill's label and the session sheet's row model (DROVE-83).
 *
 * The pill reads `<mode> · <short model> · <effort>`, the short names come
 * from the model id, only the model segment may truncate and only in the
 * middle, and every model the pickers offer fits at default font on a 393pt
 * screen. The sheet lists a row per setting the session can change, in the
 * pill's order.
 */
import { describe, expect, it } from 'vitest';
import {
    buildSessionPillLabel,
    buildSessionSheetRows,
    resolveSessionPillTextBudget,
    SESSION_PILL_SEPARATOR,
    SESSION_PILL_TRUNCATION,
    sessionPillFits,
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

    it('only ever truncates the model, in the middle', () => {
        expect(SESSION_PILL_TRUNCATION).toEqual({ segment: 'model', ellipsizeMode: 'middle' });
    });
});

describe('sessionPillFits at 393pt', () => {
    const widest = (names: string[]) => names
        .reduce((widest, name) => (name.length > widest.length ? name : widest), '');
    // The widest one-word mode any harness ships, and each harness's widest
    // effort name, paired with that harness's own models.
    const widestMode = 'Workspace';
    const harnesses = [
        { models: getClaudeModelModes(), effort: widest(getClaudeEffortLevels().map((level) => level.name)) },
        { models: getCodexModelModes(), effort: widest(getCodexEffortLevels('gpt-5.6-sol').map((level) => level.name)) },
        { models: getGeminiModelModes(), effort: null },
    ];

    it('leaves the text a budget of the screen minus the paddings', () => {
        expect(resolveSessionPillTextBudget(393)).toBe(393 - 16 - 20 - 24);
    });

    it('fits every model in the pickers with the widest mode and effort', () => {
        for (const { models, effort } of harnesses) {
            expect(models.length).toBeGreaterThan(0);
            for (const model of models) {
                const label = buildSessionPillLabel({ modeLabel: widestMode, model, effortLabel: effort });
                expect(sessionPillFits(label, 393), label.text).toBe(true);
            }
        }
    });

    it('reports a model name that would overflow so the pill knows to cut it', () => {
        const label = buildSessionPillLabel({
            modeLabel: widestMode,
            model: { key: 'x'.repeat(60) },
            effortLabel: 'Ultracode',
        });
        expect(sessionPillFits(label, 393)).toBe(false);
    });
});

describe('buildSessionSheetRows', () => {
    it('lists permission, model, effort in the pill order with the current values', () => {
        expect(buildSessionSheetRows({
            effort: { title: 'EFFORT', value: 'High', available: true },
            model: { title: 'MODEL', value: 'Fable 5', available: true },
            permission: { title: 'PERMISSION MODE', value: 'Yolo', available: true },
        })).toEqual([
            { key: 'permission', title: 'PERMISSION MODE', value: 'Yolo' },
            { key: 'model', title: 'MODEL', value: 'Fable 5' },
            { key: 'effort', title: 'EFFORT', value: 'High' },
        ]);
    });

    it('has no row for a setting the session cannot change', () => {
        expect(buildSessionSheetRows({
            permission: { title: 'PERMISSION MODE', value: 'Yolo', available: true },
            model: { title: 'MODEL', value: 'Opus 5', available: false },
            effort: null,
        })).toEqual([{ key: 'permission', title: 'PERMISSION MODE', value: 'Yolo' }]);
        expect(buildSessionSheetRows({})).toEqual([]);
    });
});
