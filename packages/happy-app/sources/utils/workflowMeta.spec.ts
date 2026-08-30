import { describe, it, expect } from 'vitest';
import { parseWorkflowMeta, parseWorkflowPhases } from './workflowMeta';

const realScript = `import { runPhase } from 'drover/workflow';

export const meta = {
  name: 'drover-deep-audit',
  description: 'Audit every drover gate and report the diff',
  phases: [
    { name: 'collect', steps: [{ name: 'read gates' }] },
    { name: 'report' },
  ],
}

export async function run(ctx) {
  await runPhase(ctx, 'collect');
}
`;

describe('parseWorkflowMeta', () => {
    it('reads name and description from a real script', () => {
        expect(parseWorkflowMeta(realScript)).toEqual({
            name: 'drover-deep-audit',
            description: 'Audit every drover gate and report the diff',
        });
    });

    it('does not leak a phase name over the meta name', () => {
        expect(parseWorkflowMeta(realScript).name).toBe('drover-deep-audit');
    });

    it('returns nothing for a script with no meta block', () => {
        expect(parseWorkflowMeta(`export async function run(ctx) {\n  return 1;\n}\n`)).toEqual({});
    });

    it('keeps an apostrophe inside a description', () => {
        const script = `export const meta = {\n  name: 'drover-deep-audit',\n  description: 'Audit the drover\\'s gates',\n}\n`;
        expect(parseWorkflowMeta(script)).toEqual({
            name: 'drover-deep-audit',
            description: "Audit the drover's gates",
        });
    });

    it('keeps an apostrophe inside a double-quoted description', () => {
        const script = `export const meta = {\n  name: "drover-deep-audit",\n  description: "Audit the drover's gates",\n}\n`;
        expect(parseWorkflowMeta(script).description).toBe("Audit the drover's gates");
    });

    it('returns nothing for a truncated script', () => {
        const script = `export const meta = {\n  name: 'drover-deep-au`;
        expect(parseWorkflowMeta(script)).toEqual({});
    });

    it('returns nothing for non-string input', () => {
        expect(parseWorkflowMeta(undefined)).toEqual({});
        expect(parseWorkflowMeta(null)).toEqual({});
        expect(parseWorkflowMeta({ script: 'x' })).toEqual({});
        expect(parseWorkflowMeta('')).toEqual({});
    });

    it('returns only the name when a description is absent', () => {
        const script = `export const meta = {\n  name: 'drover-deep-audit',\n  phases: [],\n}\n`;
        expect(parseWorkflowMeta(script)).toEqual({ name: 'drover-deep-audit' });
    });
});

describe('parseWorkflowPhases', () => {
    it('reads the phases Clay\'s scripts declare', () => {
        // Measured from the drover-defects-verify-and-file workflow in the transcript.
        const script = `export const meta = {
  name: 'drover-defects-verify-and-file',
  description: 'Adversarially verify each defect, then file one ticket per confirmed one',
  phases: [
    { title: 'Verify', detail: 'one skeptic per defect, must cite file:line or live state' },
    { title: 'File', detail: 'search Huly for a dupe, then create a BASED ticket with acceptance criteria' },
  ],
}

const DATE = '2026-08-28/29'`;
        expect(parseWorkflowPhases(script)).toEqual([
            { title: 'Verify', detail: 'one skeptic per defect, must cite file:line or live state' },
            { title: 'File', detail: 'search Huly for a dupe, then create a BASED ticket with acceptance criteria' },
        ]);
    });

    it('yields nothing for a computed phase list or a script without one', () => {
        expect(parseWorkflowPhases('export const meta = {\n  name: "x",\n  phases: PHASES,\n}')).toEqual([]);
        expect(parseWorkflowPhases('export const meta = {\n  name: "x",\n}')).toEqual([]);
        expect(parseWorkflowPhases(undefined)).toEqual([]);
    });
});
