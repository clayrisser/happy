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
import { MOBILE_COMPOSER_LAYOUT, MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import {
    estimateStatusRowWidth,
    showsContextPercent,
    statusRowFits,
    statusRowFolds,
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
 * clock, the live token count, and the agent count beside them.
 */
const mainThreadRow = {
    ...workingRow,
    live: 'Bash 1m 2s 251.2k',
    liveWithoutName: '1m 2s 251.2k',
    agentCount: 3,
} as const;

/** DROVE-155's own fold: the tool name goes and the numbers stay. */
const foldedToolName = { ...mainThreadRow, live: '1m 2s 251.2k' } as const;

/**
 * And with a task list (DROVE-167). THIS is the widest the row gets: a working
 * session that keeps a list, on the phone, with the model still on the row.
 */
const mainThreadRowWithTasks = { ...mainThreadRow, tasks: '1/3 tasks' } as const;

/** The row DROVE-178 leaves, with the model back on the button row. */
const { model: _model, ...mainThreadRowWithTasksNoModel } = mainThreadRowWithTasks;

describe('the row at 375pt, the narrowest phone still supported', () => {
    it('draws the whole of it, with the model and the account both on', () => {
        expect(statusRowUsableWidth(375)).toBe(337);
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
 * DROVE-155's readout costs 62pt more than the segment it replaced, which is
 * more than the slack left at 375. Its own tool-name fold covers it, and the
 * row asks these functions when to fire it rather than comparing the width to
 * a constant: with a model and an account on the line, the width the name
 * stops fitting at depends on how long all three happen to be.
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
        expect(statusRowFolds(mainThreadRow, 393)).toEqual({ toolName: false, model: false });
    });

    it('folds the name and nothing else at 375', () => {
        expect(statusRowFolds(mainThreadRow, 375)).toEqual({ toolName: true, model: false });
    });
});

/**
 * The tasks segment, and the two folds that pay for it.
 *
 * The badge is 83pt with its separator, and until it was counted here the
 * estimate said a working row with a list fit at 393 by 2pt while the row
 * really needed 436. The tool name held, the account went to `jam…` and the
 * model to `Opus…`, which is the one thing this file promises never happens.
 */
describe('the row with a task list on it (DROVE-167)', () => {
    it('costs the badge, its chevron and a separator', () => {
        expect(estimateStatusRowWidth(mainThreadRowWithTasks) - estimateStatusRowWidth(mainThreadRow))
            .toBe(9 * statusRowMetrics.glyphWidth + statusRowMetrics.chevron + statusRowMetrics.separator);
        expect(estimateStatusRowWidth(mainThreadRowWithTasks)).toBe(436);
        expect(estimateStatusRowWidth({ ...mainThreadRowWithTasks, tasks: '10/12 tasks' })).toBe(448);
    });

    it('does not fit at 393 with the name folded, so the model folds too, and then it does', () => {
        expect(statusRowFits(mainThreadRowWithTasks, 393)).toBe(false);
        expect(statusRowFits({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k' }, 393)).toBe(false);
        expect(statusRowFolds(mainThreadRowWithTasks, 393)).toEqual({ toolName: true, model: true });
        expect(statusRowFits({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k', model: null }, 393)).toBe(true);
    });

    it('folds the same two at 375, and is over at 320 with both gone, where the shrinking starts', () => {
        expect(statusRowFolds(mainThreadRowWithTasks, 375)).toEqual({ toolName: true, model: true });
        expect(statusRowFits({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k', model: null }, 375)).toBe(true);
        expect(statusRowFolds(mainThreadRowWithTasks, 320)).toEqual({ toolName: true, model: true });
        expect(statusRowFits({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k', model: null }, 320)).toBe(false);
    });

    it('needs only the name folded once the model is off the row (DROVE-178), at 393 and at 375', () => {
        expect(estimateStatusRowWidth(mainThreadRowWithTasksNoModel)).toBe(366);
        for (const width of [393, 375]) {
            expect(statusRowFits(mainThreadRowWithTasksNoModel, width), String(width)).toBe(false);
            expect(statusRowFolds(mainThreadRowWithTasksNoModel, width), String(width))
                .toEqual({ toolName: true, model: false });
            expect(statusRowFits({ ...mainThreadRowWithTasksNoModel, live: '1m 2s 251.2k' }, width), String(width))
                .toBe(true);
        }
        // 320 is over with the name gone and has no model to fold: it shrinks.
        expect(statusRowFolds(mainThreadRowWithTasksNoModel, 320)).toEqual({ toolName: true, model: false });
    });

    it('keeps the model on an idle row with a list at 393 and 375, and folds it at 320', () => {
        const idle = { tasks: '1/3 tasks', model: 'Opus 5 1M', quota: 'jamrizzi 23%', quotaExpands: true, contextGauge: true };
        expect(estimateStatusRowWidth(idle)).toBe(285);
        expect(statusRowFolds(idle, 393)).toEqual({ toolName: false, model: false });
        expect(statusRowFolds(idle, 375)).toEqual({ toolName: false, model: false });
        expect(statusRowFolds(idle, 320)).toEqual({ toolName: false, model: true });
    });

    it('folds nothing on a row that fits, and never a part that is not there', () => {
        expect(statusRowFolds(mainThreadRowWithTasks, 500)).toEqual({ toolName: false, model: false });
        expect(statusRowFolds({ ...mainThreadRowWithTasksNoModel, live: null, liveWithoutName: null }, 320))
            .toEqual({ toolName: false, model: false });
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
        expect(showsContextPercent('jamrizzi', false, false)).toBe(false);
    });

    it('drops it while the main thread works too, where the token count is the cost readout (DROVE-155)', () => {
        expect(showsContextPercent(null, false, true)).toBe(false);
    });

    it('keeps the percent on an idle session with no account taking the width', () => {
        expect(showsContextPercent(null, false, false)).toBe(true);
        expect(showsContextPercent('   ', false, false)).toBe(true);
    });

    it('always prints the exact figure once it has been tapped', () => {
        expect(showsContextPercent('jamrizzi', true, true)).toBe(true);
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

    it('takes the row\'s inset off the composer\'s metrics, the same expression the row draws with', () => {
        expect(statusRowMetrics.paddingHorizontal)
            .toBe(MOBILE_COMPOSER_METRICS.shellInset + MOBILE_COMPOSER_LAYOUT.addGlyphOffset);
        expect(statusRowMetrics.paddingHorizontal).toBe(19);
        expect(statusRowUsableWidth(393)).toBe(355);
    });
});
