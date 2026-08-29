import { describe, expect, it } from 'vitest';
import type { DroverGate } from 'drover-watch';

import { describePendingGates } from './pendingGatesSummary';

function gate(kind: 'question' | 'permission', title: string, preview: string): DroverGate {
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
        });
    });

    it('counts questions and permissions separately', () => {
        const summary = describePendingGates([
            gate('question', 'Flip?', 'Move it?'),
            gate('permission', 'Run Bash', 'rm -rf dist'),
            gate('permission', 'Run Bash', 'ls'),
        ]);
        expect(summary?.title).toBe('1 question and 2 permissions waiting');
    });

    it('drops the half that is zero rather than saying "0 questions"', () => {
        expect(describePendingGates([
            gate('permission', 'Run Bash', 'ls'),
            gate('permission', 'Run Bash', 'pwd'),
        ])?.title).toBe('2 permissions waiting');
    });

    it('names which gate the preview belongs to once there is more than one', () => {
        expect(describePendingGates([
            gate('question', 'Flip?', 'Move it?'),
            gate('permission', 'Run Bash', 'ls'),
        ])?.subtitle).toBe('Flip? — Move it?');
    });

    it('falls back to the title when the gate arrived with an empty preview', () => {
        expect(describePendingGates([gate('permission', 'Run Bash', '   ')])?.subtitle).toBe('Run Bash');
    });
});
