/**
 * The model list's policy, with cursor-agent faked at the `list` seam
 * (DROVE-395). What `--list-models` itself returns for a real binary is
 * cursorModels.test.ts; this is what the session does with the answer.
 */
import { describe, expect, it } from 'vitest';

import type { CursorModelListing } from './cursorModels';
import { cursorFallbackDescription } from './cursorModels';
import { CursorModelPublisher, cursorListRetries, type CursorModelPatch } from './cursorModelPublisher';

const listed: CursorModelListing = {
    models: [
        { code: 'auto', value: 'Auto (default)' },
        { code: 'composer-2.5', value: 'Composer 2.5' },
        { code: 'cursor-grok-4.6-high', value: 'Cursor Grok 4.6' },
        { code: 'cursor-grok-4.6-xhigh', value: 'Cursor Grok 4.6 Extra High' },
    ],
    failure: null,
};

const locked: CursorModelListing = {
    models: [],
    failure: 'exit 1: keychain is locked or is denying access',
};

function harness(answers: CursorModelListing[], opts: { startedModel?: string | null; retries?: number } = {}) {
    const patches: CursorModelPatch[] = [];
    const warned: string[] = [];
    const logged: string[] = [];
    let calls = 0;
    const publisher = new CursorModelPublisher({
        list: async () => {
            calls += 1;
            return answers[Math.min(calls - 1, answers.length - 1)];
        },
        publish: (patch) => patches.push(patch),
        warn: (msg) => warned.push(msg),
        log: (msg) => logged.push(msg),
        ...opts,
    });
    return { publisher, patches, warned, logged, calls: () => calls };
}

describe('CursorModelPublisher', () => {
    it('publishes the real list folded into families, with its tier scale, when cursor-agent answers', async () => {
        const h = harness([listed]);
        await h.publisher.start();

        expect(h.patches).toHaveLength(1);
        expect(h.patches[0].models.map((m) => m.code)).toEqual(['auto', 'composer-2.5', 'cursor-grok-4.6']);
        expect(h.patches[0].thoughtLevels?.map((t) => t.code)).toEqual(['high', 'xhigh']);
        expect(h.publisher.hasListed).toBe(true);
        expect(h.publisher.resolve('cursor-grok-4.6', 'xhigh')).toBe('cursor-grok-4.6-xhigh');
        expect(h.warned).toEqual([]);
    });

    // The whole reason this file exists. A list that fails is said out loud
    // and still leaves the phone something true to draw: the running model,
    // marked, and no dial.
    it('a failed list is logged with its reason, and the capsule still gets the running model, '
        + 'marked, with no tier scale', async () => {
        const h = harness([locked], { startedModel: 'claude-opus-5-thinking-xhigh' });
        await h.publisher.start();

        expect(h.warned).toHaveLength(1);
        expect(h.warned[0]).toContain('keychain is locked or is denying access');
        expect(h.patches).toHaveLength(1);
        expect(h.patches[0].models).toEqual([
            { code: 'auto', value: 'Auto', description: cursorFallbackDescription },
            { code: 'claude-opus-5-thinking', value: 'claude-opus-5-thinking', description: cursorFallbackDescription },
        ]);
        expect(h.patches[0].thoughtLevels).toBeUndefined();
        expect(h.publisher.hasListed).toBe(false);
    });

    it('a pick of the started family resolves to the exact id the session began on, '
        + 'and a pick of auto is auto, before any list has landed', async () => {
        const h = harness([locked], { startedModel: 'claude-opus-5-thinking-xhigh' });
        // Before start() has even run: a pick that races the list still lands.
        expect(h.publisher.resolve('claude-opus-5-thinking', null)).toBe('claude-opus-5-thinking-xhigh');
        expect(h.publisher.resolve('claude-opus-5-thinking', 'xhigh')).toBe('claude-opus-5-thinking-xhigh');
        expect(h.publisher.resolve('auto', 'low')).toBe('auto');
        expect(h.publisher.resolve(null, null)).toBeNull();
        await h.publisher.start();
        expect(h.publisher.resolve('claude-opus-5-thinking', null)).toBe('claude-opus-5-thinking-xhigh');
    });

    it('a session started on no --model, or on auto, falls back to the one row auto', async () => {
        const none = harness([locked]);
        await none.publisher.start();
        expect(none.patches[0].models.map((m) => m.code)).toEqual(['auto']);

        const auto = harness([locked], { startedModel: 'auto' });
        await auto.publisher.start();
        expect(auto.patches[0].models.map((m) => m.code)).toEqual(['auto']);
    });

    it('asks again after a completed turn, and the real list replaces the fallback when it lands', async () => {
        const h = harness([locked, locked, listed], { startedModel: 'composer-2.5' });
        await h.publisher.start();
        expect(h.calls()).toBe(1);
        expect(h.publisher.hasListed).toBe(false);

        await h.publisher.afterTurn();
        expect(h.calls()).toBe(2);
        expect(h.publisher.hasListed).toBe(false);
        // A retry that fails does not republish the fallback the phone already has.
        expect(h.patches).toHaveLength(1);

        await h.publisher.afterTurn();
        expect(h.calls()).toBe(3);
        expect(h.publisher.hasListed).toBe(true);
        expect(h.patches).toHaveLength(2);
        expect(h.patches[1].models.map((m) => m.code)).toEqual(['auto', 'composer-2.5', 'cursor-grok-4.6']);
        expect(h.patches[1].thoughtLevels?.map((t) => t.code)).toEqual(['high', 'xhigh']);
        expect(h.publisher.resolve('cursor-grok-4.6', 'high')).toBe('cursor-grok-4.6-high');

        // Listed, so a later turn asks nothing.
        await h.publisher.afterTurn();
        expect(h.calls()).toBe(3);
    });

    it('stops asking at the bound, so a login that never answers is not asked forever', async () => {
        const h = harness([locked], { retries: 2 });
        await h.publisher.start();
        await h.publisher.afterTurn();
        await h.publisher.afterTurn();
        await h.publisher.afterTurn();
        await h.publisher.afterTurn();
        expect(h.calls()).toBe(3);
        expect(h.publisher.listAttempts).toBe(3);
        expect(h.patches).toHaveLength(1);
        expect(h.warned).toHaveLength(3);
        expect(h.warned[2]).toContain('not asking again');
    });

    it('the default bound is one ask plus cursorListRetries', async () => {
        const h = harness([locked]);
        await h.publisher.start();
        for (let i = 0; i < cursorListRetries + 5; i += 1) await h.publisher.afterTurn();
        expect(h.calls()).toBe(1 + cursorListRetries);
    });

    it('never runs two lists at once: a turn that ends mid-ask joins the ask', async () => {
        let release: (value: CursorModelListing) => void = () => {};
        let calls = 0;
        const patches: CursorModelPatch[] = [];
        const publisher = new CursorModelPublisher({
            list: () => {
                calls += 1;
                return new Promise<CursorModelListing>((resolve) => {
                    release = resolve;
                });
            },
            publish: (patch) => patches.push(patch),
        });
        const first = publisher.start();
        const second = publisher.afterTurn();
        expect(calls).toBe(1);
        release(listed);
        await Promise.all([first, second]);
        expect(calls).toBe(1);
        expect(patches).toHaveLength(1);
        expect(publisher.hasListed).toBe(true);
    });

    it('a list that throws is a failure with its message, not a lost session', async () => {
        const warned: string[] = [];
        const patches: CursorModelPatch[] = [];
        const publisher = new CursorModelPublisher({
            list: async () => {
                throw new Error('spawn EACCES');
            },
            publish: (patch) => patches.push(patch),
            warn: (msg) => warned.push(msg),
        });
        await expect(publisher.start()).resolves.toBeUndefined();
        expect(warned[0]).toContain('spawn EACCES');
        expect(patches[0].models.map((m) => m.code)).toEqual(['auto']);
    });
});
