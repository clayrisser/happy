import { describe, expect, it } from 'vitest';
import type { DroverGate } from 'drover-watch';

import { describePendingGates } from './pendingGatesSummary';

function gate(kind: 'todo' | 'question' | 'permission', title: string, preview: string): DroverGate {
    return { id: `${title}`, title, reason: '', preview, kind, createdAt: '1970-01-01T00:00:00.000Z' };
}

describe('describePendingGates', () => {
    it('is null with nothing waiting, so the banner does not render', () => {
        expect(describePendingGates([])).toBeNull();
    });

    it('shows a single gate its own words, with no title prefix to crowd them', () => {
        expect(describePendingGates([gate('question', 'Flip?', 'Move this session to work-2?')])).toEqual({
            title: '1 question waiting',
            subtitle: 'Move this session to work-2?',
            kind: 'question',
        });
    });

    it('calls a permission a permission', () => {
        expect(describePendingGates([gate('permission', 'Run Bash', 'ls')])).toEqual({
            title: '1 permission waiting',
            subtitle: 'ls',
            kind: 'permission',
        });
    });

    // DROVE-89. A to-do blocks nothing and is answered only by Done or Drop
    // it, so it is "for you", never "waiting", and never a permission.
    it('calls a to-do a to-do, for you rather than waiting', () => {
        expect(describePendingGates([gate('todo', 'Archive build 8', 'make ios/beta')])).toEqual({
            title: '1 to-do for you',
            subtitle: 'make ios/beta',
            kind: 'todo',
        });
        expect(describePendingGates([
            gate('todo', 'Archive build 8', 'make ios/beta'),
            gate('todo', 'Log in to the box', ''),
        ])?.title).toBe('2 to-dos for you');
    });

    it('leads a mix with the total and then lists each kind', () => {
        expect(describePendingGates([
            gate('todo', 'Archive build 8', 'make ios/beta'),
            gate('permission', 'Run Bash', 'rm -rf dist'),
        ])).toMatchObject({ title: '2 waiting: 1 to-do, 1 permission', kind: 'mixed' });
        expect(describePendingGates([
            gate('question', 'Flip?', 'Move it?'),
            gate('permission', 'Run Bash', 'rm -rf dist'),
            gate('permission', 'Run Bash', 'ls'),
        ])?.title).toBe('3 waiting: 1 question, 2 permissions');
        expect(describePendingGates([
            gate('todo', 'Archive build 8', ''),
            gate('question', 'Flip?', 'Move it?'),
            gate('permission', 'Run Bash', 'ls'),
        ])?.title).toBe('3 waiting: 1 to-do, 1 question, 1 permission');
    });

    it('drops the kind that is zero rather than saying "0 questions"', () => {
        expect(describePendingGates([
            gate('permission', 'Run Bash', 'ls'),
            gate('permission', 'Run Bash', 'pwd'),
        ])?.title).toBe('2 permissions waiting');
    });

    it('names which gate the preview belongs to once there is more than one', () => {
        expect(describePendingGates([
            gate('question', 'Flip?', 'Move it?'),
            gate('permission', 'Run Bash', 'ls'),
        ])?.subtitle).toBe('Flip? · Move it?');
    });

    it('falls back to the title when the gate arrived with an empty preview', () => {
        expect(describePendingGates([gate('permission', 'Run Bash', '   ')])?.subtitle).toBe('Run Bash');
    });
});
