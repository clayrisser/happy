/**
 * The sentences one MCP server's sheet puts on screen (DROVE-291).
 *
 * Pure text, tested as pure text, for the reason mcpText.ts itself gives: the
 * wording and the transport have no reason to share a module, so a test of a
 * sentence should not have to boot React Native.
 *
 * The property that matters most here is the one about TIME. An MCP connection
 * belongs to a session, so a reading is a reading — the state says what was
 * found and a second line says when. A single sentence claiming "just now"
 * would be a lie exactly in the case the machine's cache exists to serve, and
 * these tests are what stops that sentence coming back.
 */

import { describe, expect, it } from 'vitest';

import { mcpHealthTitle, mcpHealthTone, mcpObservedAgo } from './mcpText';

describe('mcpObservedAgo', () => {
    const at = 1_700_000_000_000;

    it('counts up rather than showing a clock time nobody can use', () => {
        expect(mcpObservedAgo(at, at)).toBe('Seen just now');
        expect(mcpObservedAgo(at, at + 90_000)).toBe('Seen 2 minutes ago');
        expect(mcpObservedAgo(at, at + 60_000 * 61)).toBe('Seen 1 hour ago');
        expect(mcpObservedAgo(at, at + 86_400_000 * 3)).toBe('Seen 3 days ago');
    });

    it('says Seen and not Read, because they are two different facts', () => {
        // `Read` is when the machine looked at a config FILE; `Seen` is when it
        // last got an answer from a running SERVER. Both appear on the same
        // screen, and reading them in the same words is how they get confused.
        expect(mcpObservedAgo(at, at)).not.toContain('Read');
    });

    it('never reads as the future when the machine clock is a moment ahead', () => {
        expect(mcpObservedAgo(at + 5_000, at)).toBe('Seen just now');
    });
});

describe('mcpHealthTitle', () => {
    it('names each state in a word a person would use', () => {
        expect(mcpHealthTitle('connected')).toBe('Connected');
        expect(mcpHealthTitle('failing')).toBe('Not connecting');
        expect(mcpHealthTitle('needs-auth')).toBe('Needs sign-in');
        expect(mcpHealthTitle('unknown')).toBe('Not known');
    });

    it('never says a server is up, which is the one claim nothing may make', () => {
        for (const state of ['connected', 'failing', 'needs-auth', 'unknown'] as const) {
            expect(mcpHealthTitle(state).toLowerCase()).not.toContain('online');
            expect(mcpHealthTitle(state).toLowerCase()).not.toContain(' up');
        }
    });
});

describe('mcpHealthTone', () => {
    it('keeps unknown out of the warning colour', () => {
        // Codex has no verb that opens a connection, so every Codex server is
        // permanently unknown. Painting forty rows amber would teach Clay to
        // ignore amber, which costs him the one case that matters.
        expect(mcpHealthTone('unknown')).toBe('unknown');
        expect(mcpHealthTone('connected')).toBe('ok');
        expect(mcpHealthTone('failing')).toBe('warn');
        expect(mcpHealthTone('needs-auth')).toBe('warn');
    });
});
