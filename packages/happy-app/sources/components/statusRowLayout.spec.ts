/**
 * What fits on the status line, and what had to fold to make room (DROVE-138).
 *
 * The row gained the model's full name and the account it runs on, on the
 * busiest strip in the app, with no second line to spill onto. These are the
 * numbers behind that: the widest realistic row draws whole at 375pt, and each
 * of the three folds is shown to be load-bearing by putting it back and
 * watching the row go over.
 */
import { describe, expect, it } from 'vitest';
import {
    estimateStatusRowWidth,
    showsContextPercent,
    statusRowFits,
    statusRowMetrics,
    statusRowQuotaText,
    statusRowShrink,
    statusRowUsableWidth,
    STATUS_ROW_MODEL_TRUNCATION,
} from './statusRowLayout';

/** A working session on Clay's phone: a tool running, an account, a model, a context reading. */
const workingRow = {
    live: 'Bash 1m 2s',
    liveExpands: true,
    model: 'Opus 5 1M',
    quota: 'jamrizzi 23%',
    quotaExpands: true,
    contextGauge: true,
} as const;

/**
 * The same row once DROVE-155's main-thread readout lands: the tool, the turn
 * clock, the live token count, and the agent count beside them. This is the
 * widest the row ever gets, so it is the one the folds have to be measured
 * against.
 */
const mainThreadRow = { ...workingRow, live: 'Bash 1m 2s 251.2k', agentCount: 3 } as const;

/** DROVE-155's own fold: the tool name goes and the numbers stay. */
const foldedToolName = { ...mainThreadRow, live: '1m 2s 251.2k' } as const;

describe('the row at 375pt, the narrowest phone still supported', () => {
    it('draws the whole of it, with the model and the account both on', () => {
        expect(statusRowUsableWidth(375)).toBe(339);
        expect(estimateStatusRowWidth(workingRow)).toBe(291);
        expect(statusRowFits(workingRow, 375)).toBe(true);
    });

    it('would not fit with the word `online` back on it, which is why it went', () => {
        // The dot's colour was already the state, so the word repeated it and
        // cost the width the account needed. It is 52pt with its separator.
        const withWord = { ...workingRow, connection: 'online' };
        expect(estimateStatusRowWidth(withWord) - estimateStatusRowWidth(workingRow)).toBe(52);
        expect(statusRowFits(withWord, 375)).toBe(false);
    });

    it('holds every model name Clay actually runs, whole', () => {
        for (const model of ['Opus 5 1M', 'Fable 5', 'Opus 5', 'Sonnet 5', 'GPT-5.6 Sol']) {
            expect(statusRowFits({ ...workingRow, model }, 375), model).toBe(true);
        }
    });
});

/**
 * The widest the row ever gets, and where the three folds are load-bearing.
 *
 * DROVE-155's readout costs 62pt more than the segment it replaces, which is
 * more than the slack left at 375. Its own fold covers it, but only if the
 * width it fires at rises from 360 to 375: measured here so the two lanes
 * agree on one number rather than each guessing.
 */
describe('the row once the main thread reports its own numbers (DROVE-155)', () => {
    it('needs the tool name folded away at 375, and fits once it is', () => {
        expect(statusRowFits(mainThreadRow, 375)).toBe(false);
        expect(statusRowFits(foldedToolName, 375)).toBe(true);
    });

    it('would not fit with the word `week` back on the quota', () => {
        expect(statusRowFits({ ...foldedToolName, quota: 'jamrizzi 23% week' }, 375)).toBe(false);
    });

    it('would not fit with the context percent printed as well as drawn', () => {
        expect(statusRowFits({ ...foldedToolName, context: '42% context' }, 375)).toBe(false);
    });

    it('keeps the tool name at 393, where there is room for it', () => {
        expect(statusRowFits(mainThreadRow, 393)).toBe(true);
    });
});

describe('the row at 393pt, the handset Clay is on', () => {
    it('has room to spare, so nothing is near its edge in normal use', () => {
        expect(statusRowFits(workingRow, 393)).toBe(true);
        expect(statusRowUsableWidth(393) - estimateStatusRowWidth(workingRow)).toBeGreaterThan(60);
    });

    it('carries an idle session whole, without the live segment', () => {
        expect(statusRowFits({
            model: 'Opus 5 1M',
            quota: 'jamrizzi 23%',
            quotaExpands: true,
            contextGauge: true,
        }, 393)).toBe(true);
    });
});

describe('when it does not fit', () => {
    it('gives way in the account first, then the model, then the live segment', () => {
        expect(statusRowShrink.account).toBeGreaterThan(statusRowShrink.model);
        expect(statusRowShrink.model).toBeGreaterThan(statusRowShrink.live);
    });

    it('never gives way in the quota or the context, because a cut number says nothing', () => {
        expect(statusRowShrink.quota).toBe(0);
        expect(statusRowShrink.context).toBe(0);
    });

    it('cuts the model at the tail, so the front of the name survives', () => {
        expect(STATUS_ROW_MODEL_TRUNCATION).toEqual({ segment: 'model', ellipsizeMode: 'tail' });
    });

    it('is over budget at 320pt, which is where the shrinking starts', () => {
        expect(statusRowFits(workingRow, 320)).toBe(false);
    });
});

describe('the quota segment', () => {
    it('is headed by the account, and drops the window word when it is', () => {
        expect(statusRowQuotaText('jamrizzi', 23, '23% week')).toBe('jamrizzi 23%');
        expect(statusRowQuotaText('  jamrizzi  ', 22.6, '23% week')).toBe('jamrizzi 23%');
    });

    it('keeps the window word when there is no account to head it', () => {
        expect(statusRowQuotaText(null, 23, '23% week')).toBe('23% week');
        expect(statusRowQuotaText('  ', 23, '23% week')).toBe('23% week');
    });

    it('is nothing at all when there is no figure', () => {
        expect(statusRowQuotaText('jamrizzi', null, '')).toBeNull();
    });
});

describe('the context gauge', () => {
    it('drops its percent once the account is on the row; the ring still fills', () => {
        expect(showsContextPercent('jamrizzi', false)).toBe(false);
    });

    it('keeps the percent when there is no account taking the width', () => {
        expect(showsContextPercent(null, false)).toBe(true);
        expect(showsContextPercent('   ', false)).toBe(true);
    });

    it('always prints the exact figure once it has been tapped', () => {
        expect(showsContextPercent('jamrizzi', true)).toBe(true);
    });
});

describe('the estimate itself', () => {
    it('counts the agents glyph and its count into the live segment (DROVE-155)', () => {
        const bare = estimateStatusRowWidth({ live: 'Bash 1m 2s' });
        const withAgents = estimateStatusRowWidth({ live: 'Bash 1m 2s', agentCount: 3 });
        expect(withAgents - bare).toBe(statusRowMetrics.agentsGlyph + statusRowMetrics.glyphWidth);
    });

    it('is nothing for a row with nothing on it', () => {
        expect(estimateStatusRowWidth({})).toBe(0);
    });
});
