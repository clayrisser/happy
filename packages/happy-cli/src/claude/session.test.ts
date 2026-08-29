import { describe, expect, it } from 'vitest';

import { defaultSessionName, isDefaultSessionName, resumesExistingTranscript } from './session';

describe('resumesExistingTranscript', () => {
    it('answers yes to every shape of resume the CLI accepts', () => {
        // Bare `--resume` is the one that matters. It opens Claude's picker, so
        // the transcript id does not exist until the SessionStart hook fires,
        // which is why reattachClaudeSession cannot see it and why gating the
        // replay guard on a successful reattach missed it entirely.
        expect(resumesExistingTranscript(['--resume'])).toBe(true);
        expect(resumesExistingTranscript(['-r'])).toBe(true);
        expect(resumesExistingTranscript(['--continue'])).toBe(true);
        expect(resumesExistingTranscript(['-c'])).toBe(true);
        expect(resumesExistingTranscript(['--resume', '9ae61ba4-8a3b-452f-a294-da49d0019c79'])).toBe(true);
        expect(resumesExistingTranscript(['--dangerously-skip-permissions', '-r'])).toBe(true);
    });

    it('answers no to a fresh start, which has no history to mistake for activity', () => {
        expect(resumesExistingTranscript(undefined)).toBe(false);
        expect(resumesExistingTranscript([])).toBe(false);
        expect(resumesExistingTranscript(['--dangerously-skip-permissions'])).toBe(false);
    });

    it('does not match a flag that merely starts the same way', () => {
        // `--resume-from` is not `--resume`, and a substring match here would
        // silently pre-mark a fresh transcript and swallow the first turn.
        expect(resumesExistingTranscript(['--resume-from'])).toBe(false);
        expect(resumesExistingTranscript(['--continue-on-error'])).toBe(false);
    });
});

describe('defaultSessionName', () => {
    it('is the working directory basename', () => {
        expect(defaultSessionName('/Users/clay/Projects/bitspur/cattle-drover')).toBe('cattle-drover');
    });

    it('carries the drover account in the same shape a flip stamps', () => {
        expect(defaultSessionName('/Users/clay/Projects/bitspur/cattle-drover', 'work'))
            .toBe('[work] cattle-drover');
    });

    it('falls back to the whole path when there is no basename', () => {
        expect(defaultSessionName('/')).toBe('/');
    });
});

describe('isDefaultSessionName', () => {
    const cwd = '/Users/clay/Projects/bitspur/cattle-drover';

    it('recognises its own output, with or without an account prefix', () => {
        expect(isDefaultSessionName('cattle-drover', cwd)).toBe(true);
        expect(isDefaultSessionName('[work] cattle-drover', cwd)).toBe(true);
        expect(isDefaultSessionName('[personal] cattle-drover', cwd)).toBe(true);
    });

    it('treats an unnamed session as ours to name', () => {
        expect(isDefaultSessionName(undefined, cwd)).toBe(true);
        expect(isDefaultSessionName('', cwd)).toBe(true);
    });

    it('refuses a real title, so a flip or a resume cannot turn it back into a path', () => {
        expect(isDefaultSessionName('Fix the replay storm', cwd)).toBe(false);
        expect(isDefaultSessionName('titled by the app', cwd)).toBe(false);
        // A title that merely mentions the project is still a title.
        expect(isDefaultSessionName('cattle-drover: naming sessions', cwd)).toBe(false);
        expect(isDefaultSessionName('[work] something else', cwd)).toBe(false);
    });
});
