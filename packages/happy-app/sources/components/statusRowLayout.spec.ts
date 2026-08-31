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
 *
 * AND DROVE-223 RE-MEASURED THE ROW'S OWN WIDTH, which every number below sat
 * on. The strip is inside AgentInput's 8pt gutter as well as its own 19pt
 * inset, so a phone gives it `screenWidth - 54` and this file was pinning
 * `screenWidth - 38`. 16pt of width that does not exist, which is what the
 * renderer's `45%` cap was spending when it cut `working` to `wor…` on a row
 * two thirds empty. Everything under `the row's real width` measures that, and
 * the fold cases are re-pinned against it.
 */
import { describe, expect, it } from 'vitest';
import { MOBILE_COMPOSER_LAYOUT, MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import {
    estimateStatusRowWidth,
    showsContextPercent,
    statusRowFits,
    statusRowFolds,
    statusRowGiveWayRank,
    statusRowLiveCap,
    statusRowMetrics,
    statusRowQuotaText,
    statusRowChromeWidth,
    statusRowSegments,
    statusRowShrink,
    statusRowUsableWidth,
    STATUS_ROW_GIVE_WAY,
    STATUS_ROW_MODEL_TRUNCATION,
} from './statusRowLayout';

/** No fold fired. Four of them now: the two numbers joined the name and the model. */
const noFolds = { toolName: false, model: false, tokens: false, elapsed: false } as const;

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
    // The pieces, so the token and clock folds have something to take apart
    // (DROVE-223). `live` is still what is drawn and what the estimate reads.
    liveLabel: 'Bash',
    liveElapsed: '1m 2s',
    liveTokens: '251.2k',
    agentCount: 3,
} as const;

/**
 * The row Clay photographed for DROVE-223: no tool, so the label is the
 * WORKING WORD, six agents out, and an account called `main`.
 */
const workingWordRow = {
    live: 'working 4m 20s 51.6k',
    liveWithoutName: '4m 20s 51.6k',
    liveLabel: 'working',
    liveElapsed: '4m 20s',
    liveTokens: '51.6k',
    workingWord: true,
    agentCount: 6,
    liveExpands: true,
    quota: 'main 8%',
    quotaExpands: true,
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
        expect(statusRowUsableWidth(375)).toBe(321);
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
        expect(statusRowFolds(mainThreadRow, 375)).toEqual(noFolds);
        // What the same row did with the model on it, which is why the fold
        // exists at all.
        expect(statusRowFits(mainThreadRowWithModel, 375)).toBe(false);
        // 323 against the 321 the phone really has. It read as fitting under
        // the 16pt of width DROVE-223 took out of the budget; with the real
        // number the name alone no longer saves that row and the model has to
        // go with it. Nothing on the phone draws a model, so this is history.
        expect(estimateStatusRowWidth(foldedToolNameWithModel)).toBe(323);
        expect(statusRowFits(foldedToolNameWithModel, 375)).toBe(false);
    });

    it('would still not fit with the word `week` back on the quota, at 320', () => {
        expect(statusRowFits({ ...foldedToolName, quota: 'jamrizzi 23% week' }, 320)).toBe(false);
    });

    it('keeps the tool name at 393 and 375, and gives it up at 320 by a single point', () => {
        for (const width of [393, 375]) {
            expect(statusRowFits(mainThreadRow, width), String(width)).toBe(true);
            expect(statusRowFolds(mainThreadRow, width), String(width)).toEqual(noFolds);
        }
        // 283 against 282 usable. Under the model it went at 375 as well.
        expect(statusRowUsableWidth(320)).toBe(266);
        expect(statusRowFolds(mainThreadRow, 320)).toEqual({ ...noFolds, toolName: true });
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

    it('needs the tool name at 393, and the token count as well at 375', () => {
        // The name alone still covers 393: 336 against the 339 the phone
        // really has. At 375 it leaves the row 15pt over, so the next step in
        // STATUS_ROW_GIVE_WAY fires and the live TOKEN count goes. Not the
        // working word, which is not a step at all (DROVE-223). Under the old
        // budget this row read as fitting at 375 by a single point.
        expect(statusRowFolds(mainThreadRowWithTasks, 393)).toEqual({ ...noFolds, toolName: true });
        expect(estimateStatusRowWidth({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k' })).toBe(336);
        expect(statusRowFits({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k' }, 393)).toBe(true);

        expect(statusRowFolds(mainThreadRowWithTasks, 375))
            .toEqual({ ...noFolds, toolName: true, tokens: true });
        expect(estimateStatusRowWidth({ ...mainThreadRowWithTasks, live: '1m 2s' })).toBe(294);
        expect(statusRowFits({ ...mainThreadRowWithTasks, live: '1m 2s' }, 375)).toBe(true);
    });

    it('is still over at 320 with the name and the tokens gone, where the shrinking starts', () => {
        // 294 against 266 usable, with the name and the token count already
        // folded. The clock cannot go too, because that would leave the live
        // segment with nothing in it, so the row gives way in
        // `statusRowShrink`'s order instead and the ACCOUNT is what is cut.
        // The working word is never among the candidates. 320 is below the
        // supported floor.
        expect(estimateStatusRowWidth({ ...mainThreadRowWithTasks, live: '1m 2s' })).toBe(294);
        expect(estimateStatusRowWidth({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k' })).toBe(336);
        expect(statusRowFolds(mainThreadRowWithTasks, 320))
            .toEqual({ ...noFolds, toolName: true, tokens: true });
        expect(statusRowFits({ ...mainThreadRowWithTasks, live: '1m 2s 251.2k' }, 320)).toBe(false);
    });

    it('folds nothing on a row that fits, and never a part that is not there', () => {
        expect(statusRowFolds(mainThreadRowWithTasks, 500)).toEqual(noFolds);
        expect(statusRowFolds({
            ...mainThreadRowWithTasks,
            live: null,
            liveWithoutName: null,
            liveLabel: null,
            liveElapsed: null,
            liveTokens: null,
        }, 320)).toEqual(noFolds);
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
        expect(statusRowUsableWidth(393)).toBe(339);
    });

    it('folded the name AND the model whole at 393, and the tokens too at 375', () => {
        expect(statusRowFolds(mainThreadRowWithTasksAndModel, 393))
            .toEqual({ ...noFolds, toolName: true, model: true });
        expect(statusRowFits(
            { ...mainThreadRowWithTasksAndModel, live: '1m 2s 251.2k', model: null },
            393,
        )).toBe(true);
        // 336 against 321 at 375, so the token count goes after the model.
        for (const width of [375, 320]) {
            expect(statusRowFolds(mainThreadRowWithTasksAndModel, width), String(width))
                .toEqual({ ...noFolds, toolName: true, model: true, tokens: true });
            expect(statusRowFits(
                { ...mainThreadRowWithTasksAndModel, live: '1m 2s 251.2k', model: null },
                width,
            ), String(width)).toBe(false);
        }
    });

    it('still folds a model for a caller that passes one, so the branch is not dead code', () => {
        const idle = { tasks: '1/3 tasks', model: 'Opus 5 1M', quota: 'jamrizzi 23%', quotaExpands: true, contextGauge: true };
        expect(estimateStatusRowWidth(idle)).toBe(285);
        expect(statusRowFolds(idle, 393)).toEqual(noFolds);
        expect(statusRowFolds(idle, 320)).toEqual({ ...noFolds, model: true });
    });
});

describe('the row at 393pt, the handset Clay is on', () => {
    it('has room to spare, so nothing is near its edge in normal use', () => {
        expect(statusRowFits(workingRow, 393)).toBe(true);
        // Was over 60 with the model on the row; the model's 70pt is on top.
        expect(statusRowUsableWidth(393) - estimateStatusRowWidth(workingRow)).toBe(118);
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

/**
 * DROVE-223: the row's REAL width, and the word that was cut on it.
 *
 * Clay's photograph is `● wor… 4m 20s 51.6k ⛄6 ˄ · main 8% ˄` on a 393pt
 * phone. The working state, the leftmost and most important fact on the line,
 * cut to three letters while the account beside it drew whole and the right
 * two thirds of the row were empty. Two terms were wrong and neither of them
 * was the strip being narrow.
 */
describe("the row's real width (DROVE-223)", () => {
    it('takes AgentInput\'s gutter off as well as its own inset, which is 16pt a phone', () => {
        // 8 + 19 = the 27pt from the screen edge to the dot in the photograph.
        // The budget was taking only the 19.
        expect(statusRowMetrics.outerGutter).toBe(MOBILE_COMPOSER_METRICS.shellGutter);
        expect(statusRowMetrics.outerGutter + statusRowMetrics.paddingHorizontal).toBe(27);
        expect(statusRowUsableWidth(393)).toBe(339);
        expect(statusRowUsableWidth(375)).toBe(321);
        expect(statusRowUsableWidth(320)).toBe(266);
        for (const width of [320, 375, 393]) {
            expect(statusRowUsableWidth(width), String(width)).toBe(width - 54);
        }
    });

    it('adds its terms up to the row it draws, with nothing left over', () => {
        // The whole budget, spelled out: the dot and its margin, one separator
        // between each pair of segments, and the segments themselves. The
        // photographed row is 236 by this estimate and measures 244 on the
        // phone, which is `glyphWidth` running about 3% lean in IBM Plex Sans.
        const segments = statusRowSegments(workingWordRow);
        expect(segments).toEqual([
            { key: 'live', width: 153 },
            { key: 'quota', width: 55 },
        ]);
        expect(statusRowChromeWidth(segments.length))
            .toBe(statusRowMetrics.dot + statusRowMetrics.dotMarginRight + statusRowMetrics.separator);
        expect(estimateStatusRowWidth(workingWordRow))
            .toBe(statusRowChromeWidth(2) + 153 + 55);
        expect(estimateStatusRowWidth(workingWordRow)).toBe(236);
    });

    it('shows the working word whole at 320, 375 and 393, which is the ticket', () => {
        for (const width of [320, 375, 393]) {
            expect(statusRowFits(workingWordRow, width), String(width)).toBe(true);
            expect(statusRowFolds(workingWordRow, width), String(width)).toEqual(noFolds);
            // And no cap over the segment carrying it, so nothing inside it
            // is asked to shrink while the row has room.
            expect(statusRowLiveCap(workingWordRow, width), String(width)).toBeNull();
        }
        // 236 of 339 at 393: a hundred points of line still empty beside the
        // word that was being cut.
        expect(statusRowUsableWidth(393) - estimateStatusRowWidth(workingWordRow)).toBe(103);
    });

    it('is the 45% cap that cut it, and the arithmetic of how', () => {
        // The cap was a share of the WHOLE row, so it did not move when the
        // row emptied. At 393 it is 152.55 against a live segment of 153 by
        // this estimate, and about 163 in the font the row really draws, so
        // the only child under it that can shrink took the whole overage. That
        // child is the label, and with no tool running the label is the
        // working word.
        const live = statusRowSegments(workingWordRow).find((segment) => segment.key === 'live');
        expect(live!.width).toBe(153);
        expect(0.45 * statusRowUsableWidth(393)).toBeLessThan(live!.width);
    });

    it('caps a tool name off what the rest of the line does not need, not off 45%', () => {
        // The reason the cap existed is still met: a 30-character MCP name is
        // held to its share and cannot squeeze the account.
        const mcp = {
            ...workingWordRow,
            workingWord: false,
            liveLabel: 'mcp__chrome_devtools__take_screenshot',
            live: 'mcp__chrome_devtools__take_screenshot 4m 20s 51.6k',
        };
        expect(statusRowLiveCap(mcp, 393)).toBe(statusRowUsableWidth(393) - statusRowChromeWidth(2) - 55);
        expect(statusRowLiveCap(mcp, 393)).toBe(256);
        expect(statusRowLiveCap(mcp, 375)).toBe(238);
        // And it never bites a row that fits: the cap is what is left, so it
        // is at least the segment's own width whenever the row is inside its
        // budget.
        expect(statusRowLiveCap(mainThreadRow, 393)!).toBeGreaterThanOrEqual(
            statusRowSegments(mainThreadRow).find((segment) => segment.key === 'live')!.width,
        );
    });

    it('drops the tokens and then the clock before the working word, never the word', () => {
        // The widest a working-word row gets: six agents out, a task list, an
        // account and the gauge. 384 against 339 at 393, so two facts have to
        // go, and STATUS_ROW_GIVE_WAY says which two.
        const worst = {
            ...workingWordRow,
            tasks: '1/3 tasks',
            quota: 'jamrizzi 23%',
            contextGauge: true,
        };
        expect(estimateStatusRowWidth(worst)).toBe(384);
        for (const width of [320, 375, 393]) {
            const folds = statusRowFolds(worst, width);
            expect(folds, String(width)).toEqual({ ...noFolds, tokens: true, elapsed: true });
            expect(folds.toolName, String(width)).toBe(false);
        }
        // What is left is the word and the agents: 306, inside 339 and 321.
        const folded = { ...worst, live: 'working' };
        expect(estimateStatusRowWidth(folded)).toBe(306);
        expect(statusRowFits(folded, 393)).toBe(true);
        expect(statusRowFits(folded, 375)).toBe(true);
        // At 320, below the supported floor, the ACCOUNT is what gives next.
        // Still not the word: it has no step left below it.
        expect(statusRowFits(folded, 320)).toBe(false);
        expect(statusRowShrink.account).toBeGreaterThan(statusRowShrink.live);
    });
});

/**
 * The order itself, as a rule the next fact added to the line inherits.
 */
describe('the order the row gives way in (DROVE-223, DROVE-231)', () => {
    it('has no working word on it at all, because the strip has none', () => {
        // DROVE-223's rule was "the working word goes last". DROVE-231 took
        // the word off the line entirely and gave the state to the dot, which
        // never gives way, so the rule is now kept by construction. A rank for
        // a fact the strip cannot draw would be a rank nothing can honour.
        expect(STATUS_ROW_GIVE_WAY).not.toContain('workingWord');
    });

    it('puts the tally LAST, because Clay put it on the centre of the line', () => {
        expect(STATUS_ROW_GIVE_WAY[STATUS_ROW_GIVE_WAY.length - 1]).toBe('tokens');
        for (const earlier of ['contextPercent', 'quotaWindow', 'toolName', 'elapsed', 'tasks', 'account'] as const) {
            expect(statusRowGiveWayRank(earlier), earlier)
                .toBeLessThan(statusRowGiveWayRank('tokens'));
        }
    });

    it('keeps every pair DROVE-223 fixed, except the one Clay moved', () => {
        // Untouched: a tool's name folds before the account, and the account
        // truncates before the number beside it.
        expect(statusRowGiveWayRank('toolName')).toBeLessThan(statusRowGiveWayRank('account'));
        expect(statusRowGiveWayRank('account')).toBeLessThan(statusRowGiveWayRank('tokens'));
        // Moved: 223 had the tally give way before the clock. The tally is now
        // one of the three zones and the clock is not, so they swapped.
        expect(statusRowGiveWayRank('elapsed')).toBeLessThan(statusRowGiveWayRank('tokens'));
    });

    it('protects the task badge above the tool name, which is DROVE-167s rule', () => {
        // That ticket ruled the tool name folds to PAY for the badge, so the
        // badge is the more protected of the two. It sits under the clock
        // because Clay has asked for the task list by name three times and has
        // never asked for the clock, and because the badge is the only tap on
        // the strip that opens the list at all.
        expect(statusRowGiveWayRank('toolName')).toBeLessThan(statusRowGiveWayRank('tasks'));
        expect(statusRowGiveWayRank('elapsed')).toBeLessThan(statusRowGiveWayRank('tasks'));
    });

    it('is the same order the flex weights say, so the two cannot disagree', () => {
        // A bigger weight gives more, so the weights run against the ranks.
        expect(statusRowShrink.account).toBeGreaterThan(statusRowShrink.live);
        expect(statusRowGiveWayRank('toolName')).toBeLessThan(statusRowGiveWayRank('account'));
        expect(statusRowShrink.quota).toBe(0);
        expect(statusRowShrink.context).toBe(0);
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
        // DROVE-223's own gutter is outside this and unchanged, so the row's
        // width does not move either.
        expect(statusRowUsableWidth(393)).toBe(339);
    });
});
