import { describe, expect, it } from 'vitest';
import { sessionHeaderSubtitle } from './sessionHeaderSubtitle';

describe('sessionHeaderSubtitle', () => {
    it('is the repository folder', () => {
        expect(sessionHeaderSubtitle('/Users/clay/Projects/bitspur/cattle-drover')).toBe('cattle-drover');
    });

    it('names the repo, not the worktree directory', () => {
        expect(sessionHeaderSubtitle('/Users/clay/Projects/happy/.dev/worktree/DROVE-213')).toBe('happy');
    });

    it('carries no branch and no second segment', () => {
        const subtitle = sessionHeaderSubtitle('/Users/clay/Projects/happy/.dev/worktree/lane/DROVE-213');
        expect(subtitle).toBe('happy');
        expect(subtitle).not.toContain('/');
        expect(subtitle).not.toContain('·');
    });

    it('handles windows separators and trailing slashes', () => {
        expect(sessionHeaderSubtitle('C:\\src\\cattle-drover\\')).toBe('cattle-drover');
    });

    it('is undefined without a path', () => {
        expect(sessionHeaderSubtitle(null)).toBeUndefined();
        expect(sessionHeaderSubtitle(undefined)).toBeUndefined();
        expect(sessionHeaderSubtitle('   ')).toBeUndefined();
    });
});
