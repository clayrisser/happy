/**
 * What fits on the status line, and what had to fold to make room (DROVE-138,
 * DROVE-178).
 *
 * The row gained the model's full name and the account it runs on, on the
 * busiest strip in the app, with no second line to spill onto. Then DROVE-178
 * took the model back to the button row, into the gap DROVE-153 opened, and
 * these numbers are re-measured with it gone. Every fixture below is the row
 * AS IT SHIPS: no model. The rows that still carry one are kept in one place,
 * under `what the row cost with the model on it`, because they are what says
 * how much DROVE-178 bought and because `statusRowFolds` still has the model
 * branch for a caller that passes one.
 *
 * The headline: the widest realistic row, a working session with a task list,
 * now needs only DROVE-155's tool-name fold at 375 and needs NOTHING at 393.
 * With the model on it, the same row folded the name AND the model whole at
 * both, and was still over at 320.
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

/** A working session on Clay's phone: a tool running, an account, a context reading. */
const workingRow = {
    live: 'Bash 1m 2s',
    liveExpands: true,
    quota: 'jamrizzi 23%',
    quotaExpands: true,
    contextGauge: true,
} as const;

/** The same row before DROVE-178, with the model's name still on it. */
const workingRowWithModel = { ...workingRow, model: 'Opus 5 1M' } as const;

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
 * session that keeps a list, on the phone.
 */
const mainThreadRowWithTasks = { ...mainThreadRow, tasks: '1/3 tasks' } as const;

/** The same three, as they were with the model on the row. */
const mainThreadRowWithModel = { ...mainThreadRow, model: 'Opus 5 1M' } as const;
const foldedToolNameWithModel = { ...mainThreadRowWithModel, live: '1m 2s 251.2k' } as const;
const mainThreadRowWithTasksAndModel = { ...mainThreadRowWithModel, tasks: '1/3 tasks' } as const;

describe('the row at 375pt, the narrowest phone still supported', () => {
    it('draws the whole of it, with the account on and the model gone', () => {
        expect(statusRowUsableWidth(375)).toBe(337);
        expect(estimateStatusRowWidth(workingRow)).toBe(221);
        expect(statusRowFits(workingRow, 375)).toBe(true);
    });

    it('is 70pt shorter than it was with the model on it, which is what DROVE-178 gave back', () => {
        expect(estimateStatusRowWidth(workingRowWithModel)).toBe(291);
        expect(estimateStatusRowWidth(workingRowWithModel) - estimateStatusRowWidth(workingRow)).toBe(70);
    });

    it('costs 52pt for the word `online`, which is why it went', () => {
        // The dot's colour was already the state, so the word repeated it and
        // cost the width the account needed. It is 52pt with its separator,
        // and with the model on the row that was the difference between
        // fitting at 375 and not. The word fits again now, and it is still
        // not coming back: the dot says the same thing for nothing.
        const withWord = { ...workingRow, connection: 'online' };
        expect(estimateStatusRowWidth(withWord) - estimateStatusRowWidth(workingRow)).toBe(52);
        expect(statusRowFits({ ...workingRowWithModel, connection: 'online' }, 375)).toBe(false);
    });

    it('held every model name Clay runs, whole, back when it drew one', () => {
        // Kept because it is the promise DROVE-138 made and the reason the
        // name was here at all: it was never truncated on this row. The
        // capsule keeps that promise now (sessionPillLabel.spec.ts).
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
    it('draws whole at 375 now the model has gone, where it used to need the name folded', () => {
        expect(estimateStatusRowWidth(mainThreadRow)).toBe(283);
        expect(statusRowFits(mainThreadRow, 375)).toBe(true);
        expect(statusRowFolds(mainThreadRow, 375)).toEqual({ toolName: false, model: false });
        // What the same row did with the model on it, which is why the fold
        // exists at all.
        expect(statusRowFits(mainThreadRowWithModel, 375)).toBe(false);
        expect(statusRowFits(foldedToolNameWithModel, 375)).toBe(true);
    });

    it('would still not fit with the word `week` back on the quota, at 320', () => {
        expect(statusRowFits({ ...foldedToolName, quota: 'jamrizzi 23% week' }, 320)).toBe(false);
    });

    it('keeps the tool name at 393 and 375, and gives it up at 320 by a single point', () => {
        for (const width of [393, 375]) {
            expect(statusRowFits(mainThreadRow, width), String(width)).toBe(true);
            expect(statusRowFolds(mainThreadRow, width), String(width))
                .toEqual({ toolName: false, model: false });
        }
        // 283 against 282 usable. Under the model it went at 375 as well.
        expect(statusRowUsableWidth(320)).toBe(282);
        expect(statusRowFolds(mainThreadRow, 320)).toEqual({ toolName: true, model: false });
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
        expect(estimateStatusRowWidth(mainThreadRowWithTasks)).toBe(366);
        expect(estimateStatusRowWidth({ ...mainThreadRowWithTasks, tasks: '10/12 tasks' })).toBe(378);
    });

    it('needs only the tool name at 393 and 375, and fits once it goes', () => {
        // This is the whole of DROVE-178's effect on the fold order. The same
        // row used to lose the name AND the model whole at both widths, and
        // was still over at 320 with both gone. Now one fold covers 393 and
        // 375, which are the two widths the app supports.
        for (const width of [393, 375]) {
            expect(statusRowFits(mainThreadRowWithTasks, width), String(width)).toBe(false);
            expect(statusRowFolds(mainThreadRowWithTasks, width), String(width))
                .toEqual({ toolName: true, model: false });
            expect(statusRowFits({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k' }, width), String(width))
                .toBe(true);
        }
    });

    it('is still over at 320 with the name gone, where the shrinking starts', () => {
        // 336 against 282 usable. There is no second fold left to fire, so
        // the row gives way in `statusRowShrink`'s order: the account first,
        // then the tool name's own segment. 320 is below the supported floor.
        expect(estimateStatusRowWidth({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k' })).toBe(336);
        expect(statusRowFolds(mainThreadRowWithTasks, 320)).toEqual({ toolName: true, model: false });
        expect(statusRowFits({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k' }, 320)).toBe(false);
    });

    it('folds nothing on a row that fits, and never a part that is not there', () => {
        expect(statusRowFolds(mainThreadRowWithTasks, 500)).toEqual({ toolName: false, model: false });
        expect(statusRowFolds({ ...mainThreadRowWithTasks, live: null, liveWithoutName: null }, 320))
            .toEqual({ toolName: false, model: false });
    });
});

/**
 * What the row cost with the model on it (DROVE-138 to DROVE-178).
 *
 * Kept, and only here, because it is the measurement DROVE-178 is justified
 * by. The badge is 83pt with its separator, and until it was counted the
 * estimate said a working row with a list fit at 393 by 2pt while the row
 * really needed 436: the tool name held, the account went to `jam…` and the
 * model to `Opus…`, which is the one thing this file promises never happens.
 * Every one of those numbers is a case that cannot occur any more.
 */
describe('what the row cost with the model on it', () => {
    it('was 436pt at its widest, 70 over the 366 it is now', () => {
        expect(estimateStatusRowWidth(mainThreadRowWithTasksAndModel)).toBe(436);
        expect(statusRowUsableWidth(393)).toBe(355);
    });

    it('folded the name AND the model whole at 393 and 375, and was still over at 320', () => {
        for (const width of [393, 375]) {
            expect(statusRowFolds(mainThreadRowWithTasksAndModel, width), String(width))
                .toEqual({ toolName: true, model: true });
            expect(statusRowFits(
                { ...mainThreadRowWithTasksAndModel, live: '1m 2s 251.2k', model: null },
                width,
            ), String(width)).toBe(true);
        }
        expect(statusRowFolds(mainThreadRowWithTasksAndModel, 320)).toEqual({ toolName: true, model: true });
        expect(statusRowFits(
            { ...mainThreadRowWithTasksAndModel, live: '1m 2s 251.2k', model: null },
            320,
        )).toBe(false);
    });

    it('still folds a model for a caller that passes one, so the branch is not dead code', () => {
        const idle = { tasks: '1/3 tasks', model: 'Opus 5 1M', quota: 'jamrizzi 23%', quotaExpands: true, contextGauge: true };
        expect(estimateStatusRowWidth(idle)).toBe(285);
        expect(statusRowFolds(idle, 393)).toEqual({ toolName: false, model: false });
        expect(statusRowFolds(idle, 320)).toEqual({ toolName: false, model: true });
    });
});

describe('the row at 393pt, the handset Clay is on', () => {
    it('has room to spare, so nothing is near its edge in normal use', () => {
        expect(statusRowFits(workingRow, 393)).toBe(true);
        // Was over 60 with the model on the row; the model's 70pt is on top.
        expect(statusRowUsableWidth(393) - estimateStatusRowWidth(workingRow)).toBeGreaterThan(130);
    });

    it('carries an idle session whole, without the live segment', () => {
        expect(statusRowFits({
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

    it('fits at 320pt now, where it used to be over budget and shrinking', () => {
        expect(statusRowFits(workingRow, 320)).toBe(true);
        expect(statusRowFits(workingRowWithModel, 320)).toBe(false);
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
        // The composer's text column, and it still lands on 19 after DROVE-214
        // rebuilt the bubble as two rows. It is now the gutter plus the
        // bubble's own padding, so the strip lines up with where the caret
        // actually starts rather than with a glyph offset that no longer
        // exists.
        expect(statusRowMetrics.paddingHorizontal).toBe(MOBILE_COMPOSER_LAYOUT.textInset);
        expect(statusRowMetrics.paddingHorizontal).toBe(19);
        expect(MOBILE_COMPOSER_LAYOUT.textInset)
            .toBe(MOBILE_COMPOSER_METRICS.shellInset + MOBILE_COMPOSER_METRICS.bubbleInset);
        expect(statusRowUsableWidth(393)).toBe(355);
    });
});
