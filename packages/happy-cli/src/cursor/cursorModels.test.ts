import { describe, it, expect } from 'vitest';

import {
    parseCursorModels,
    splitCursorModelId,
    buildCursorModelCatalog,
    resolveCursorModelId,
} from './cursorModels';

/**
 * A verbatim slice of `cursor-agent --list-models` on 2026.08.25-3e8eec8. Kept
 * real rather than invented, because every rule below is a rule about what
 * Cursor actually prints.
 */
const listed = `Available models

auto - Auto (default)
gpt-5.2 - GPT-5.2
composer-2.5 - Composer 2.5
composer-2.5-fast - Composer 2.5 Fast
cursor-grok-4.6-low - Cursor Grok 4.6 Low
cursor-grok-4.6-high - Cursor Grok 4.6
cursor-grok-4.6-xhigh - Cursor Grok 4.6 Extra High
cursor-grok-4.6-xhigh-fast - Cursor Grok 4.6 Extra High Fast
claude-opus-5-thinking-low - Claude Opus 5 1M Low Thinking
claude-opus-5-thinking-high - Claude Opus 5 1M Thinking
claude-opus-5-thinking-max - Claude Opus 5 1M Max Thinking
`;

describe('splitCursorModelId', () => {
    it('pulls the effort tier out of the id', () => {
        expect(splitCursorModelId('cursor-grok-4.6-xhigh'))
            .toEqual({ base: 'cursor-grok-4.6', effort: 'xhigh', fast: false });
        expect(splitCursorModelId('claude-opus-5-thinking-max'))
            .toEqual({ base: 'claude-opus-5-thinking', effort: 'max', fast: false });
    });

    it('keeps -fast on the base, because it is a serving tier and not an '
        + 'effort: a slider that moved between fast and slow would change what '
        + 'the turn costs without saying so', () => {
        expect(splitCursorModelId('cursor-grok-4.6-xhigh-fast'))
            .toEqual({ base: 'cursor-grok-4.6-fast', effort: 'xhigh', fast: true });
    });

    it('leaves an id with no tier alone', () => {
        expect(splitCursorModelId('gpt-5.2')).toEqual({ base: 'gpt-5.2', effort: null, fast: false });
        expect(splitCursorModelId('auto')).toEqual({ base: 'auto', effort: null, fast: false });
        expect(splitCursorModelId('composer-2.5'))
            .toEqual({ base: 'composer-2.5', effort: null, fast: false });
    });

    it('does not mistake a version fragment for a tier', () => {
        expect(splitCursorModelId('claude-opus-4-8').effort).toBeNull();
    });
});

describe('buildCursorModelCatalog', () => {
    const catalog = buildCursorModelCatalog(parseCursorModels(listed));

    it('collapses sixty near-duplicates into families', () => {
        expect(catalog.models.map((m) => m.code)).toEqual([
            'auto',
            'gpt-5.2',
            'composer-2.5',
            'composer-2.5-fast',
            'cursor-grok-4.6',
            'cursor-grok-4.6-fast',
            'claude-opus-5-thinking',
        ]);
    });

    it('offers only the tiers that some family really has, weakest first', () => {
        expect(catalog.efforts.map((e) => e.code)).toEqual(['low', 'high', 'xhigh', 'max']);
    });

    it('names a family the way a human does, with the tier words removed', () => {
        const grok = catalog.models.find((m) => m.code === 'cursor-grok-4.6');
        expect(grok?.value).toBe('Cursor Grok 4.6');
        const opus = catalog.models.find((m) => m.code === 'claude-opus-5-thinking');
        expect(opus?.value).toBe('Claude Opus 5 1M Thinking');
    });
});

describe('resolveCursorModelId', () => {
    const catalog = buildCursorModelCatalog(parseCursorModels(listed));

    it('rejoins family and tier by LOOKUP, so it can only ever name an id '
        + 'cursor-agent already listed', () => {
        expect(resolveCursorModelId(catalog, 'cursor-grok-4.6', 'xhigh')).toBe('cursor-grok-4.6-xhigh');
        expect(resolveCursorModelId(catalog, 'cursor-grok-4.6-fast', 'xhigh'))
            .toBe('cursor-grok-4.6-xhigh-fast');
        expect(resolveCursorModelId(catalog, 'claude-opus-5-thinking', 'max'))
            .toBe('claude-opus-5-thinking-max');
    });

    it('a family with no tiers ignores the effort pick entirely', () => {
        expect(resolveCursorModelId(catalog, 'composer-2.5', 'max')).toBe('composer-2.5');
        expect(resolveCursorModelId(catalog, 'auto', 'low')).toBe('auto');
    });

    it('a tier the family does not have falls back to one it does, because a '
        + 'neighbouring tier beats exit 1 on an id that was never listed', () => {
        expect(resolveCursorModelId(catalog, 'cursor-grok-4.6', 'medium')).toBe('cursor-grok-4.6-high');
        expect(resolveCursorModelId(catalog, 'cursor-grok-4.6', null)).toBe('cursor-grok-4.6-high');
        // No `high` on this one, so the weakest tier it has.
        const partial = buildCursorModelCatalog([{ code: 'x-low', value: 'X Low' }]);
        expect(resolveCursorModelId(partial, 'x', null)).toBe('x-low');
    });

    it('an unknown family is passed through, and no family means no --model', () => {
        expect(resolveCursorModelId(catalog, 'something-new', 'high')).toBe('something-new');
        expect(resolveCursorModelId(catalog, null, 'high')).toBeNull();
    });

    it('never produces a bracket, which was measured to be REJECTED: '
        + "`--model 'composer-2.5[effort=high]'` exits 1 with "
        + '"Cannot use this model"', () => {
        for (const family of catalog.models) {
            for (const effort of [null, 'low', 'medium', 'high', 'xhigh', 'max']) {
                const id = resolveCursorModelId(catalog, family.code, effort);
                expect(id).not.toContain('[');
            }
        }
    });
});
