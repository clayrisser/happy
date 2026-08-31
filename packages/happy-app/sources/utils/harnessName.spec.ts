import { describe, expect, it } from 'vitest';
import { harnessName } from './harnessName';

describe('harnessName', () => {
    it('names every harness the fork can start', () => {
        expect(harnessName('claude')).toBe('Claude');
        expect(harnessName('gemini')).toBe('Gemini');
        expect(harnessName('openclaw')).toBe('OpenClaw');
        expect(harnessName('agy')).toBe('Antigravity');
        expect(harnessName('cursor')).toBe('Cursor');
        // Capitalised the way the project spells itself. The raw slug is
        // lowercase and was rendering as "opencode" beside "Claude" and
        // "Cursor" on the same screen (DROVE-56).
        expect(harnessName('opencode')).toBe('OpenCode');
    });

    it('keeps both codex slugs, because both are on real sessions', () => {
        expect(harnessName('gpt')).toBe('Codex');
        expect(harnessName('openai')).toBe('Codex');
        expect(harnessName('codex')).toBe('Codex');
    });

    it('treats a session with no flavor as Claude', () => {
        // Every session written before the field existed. Rendering "Unknown"
        // there would relabel most of the history on the phone.
        expect(harnessName(undefined)).toBe('Claude');
        expect(harnessName(null)).toBe('Claude');
        expect(harnessName('')).toBe('Claude');
    });

    it('falls back to the slug, which is at least true', () => {
        expect(harnessName('something-new')).toBe('something-new');
    });
});
