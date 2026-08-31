/**
 * THE STRIP IS THREE ZONES, MEASURED (DROVE-231).
 *
 * Not asserted as arithmetic. Every number below comes out of
 * `resolveFlexFrames` laying the real style tree out, which is DROVE-214's
 * whole point: the composer shipped visibly broken three times over a green
 * suite because the specs restated a MODEL of the geometry while the renderer's
 * own stylesheet did something else. So the centring here is proved by finding
 * the centre zone's frame and comparing its midpoint to the line's, not by
 * multiplying the widths that were supposed to produce it.
 *
 * The realistic session is Clay's own, the one he photographed for DROVE-223:
 * a Bash call four minutes in, six workers out, a task list, `jamrizzi` at 8%.
 */
import { describe, expect, it } from 'vitest';
import { findFrame, resolveFlexFrames } from './flexFrames';
import { STATUS_ROW_GIVE_WAY, statusRowUsableWidth } from './statusRowLayout';
import {
    resolveStatusStrip,
    noStatusStripFolds,
    statusStripAccountCap,
    statusStripDrawn,
    statusStripFolds,
    statusStripNode,
    statusStripOrderFor,
    statusStripQuotaText,
    statusStripZoneOf,
    statusStripZoneWidths,
    type StatusStripContent,
} from './statusStripLayout';

/** Clay's own row: `● Bash 4m 20s 👥6 ˄ · 1/3 tasks ˄ · 51.6k ◔ · jamrizzi 8% ˄`. */
const busy: StatusStripContent = {
    dot: true,
    toolName: 'Bash',
    elapsed: '4m 20s',
    tokens: '51.6k',
    workers: 6,
    liveExpands: true,
    tasks: '1/3 tasks',
    account: 'jamrizzi',
    quotaPercent: '8%',
    quotaExpands: true,
    contextGauge: true,
};

/** A session doing nothing: the dot, the account, the ring. */
const idle: StatusStripContent = {
    dot: true,
    account: 'jamrizzi',
    quotaPercent: '8%',
    quotaExpands: true,
    contextGauge: true,
};

function drawnAt(content: StatusStripContent, width: number) {
    return resolveStatusStrip(content, width, STATUS_ROW_GIVE_WAY);
}

describe('the token count is centred, at every width', () => {
    for (const width of [320, 375, 393]) {
        it(`puts the centre zone's midpoint on the line's midpoint at ${width}`, () => {
            const { frame } = drawnAt(busy, width);
            const centre = findFrame(frame, 'centre');
            expect(centre.x + centre.width / 2).toBe(frame.width / 2);
        });

        it(`starts the dot at the row's left edge at ${width}`, () => {
            const { frame } = drawnAt(busy, width);
            expect(findFrame(frame, 'dot').x).toBe(0);
        });

        it(`ends the quota on the row's right edge at ${width}`, () => {
            const { frame } = drawnAt(busy, width);
            const quota = findFrame(frame, 'quota');
            expect(quota.x + quota.width).toBe(frame.width);
        });
    }

    it('centres the tokens even when the two sides are nothing alike', () => {
        // The left zone is a dot and the right is a long account. A row of
        // segments would put the tokens wherever the left half ended.
        const lopsided: StatusStripContent = {
            ...idle,
            tokens: '51.6k',
            account: 'risserproperties',
        };
        const { frame } = drawnAt(lopsided, 393);
        const centre = findFrame(frame, 'centre');
        expect(centre.x + centre.width / 2).toBe(frame.width / 2);
        expect(findFrame(frame, 'dot').x).toBe(0);
    });

    it('holds the centre with nothing at all in the left zone but the dot', () => {
        const { frame } = drawnAt({ ...idle, tokens: '51.6k' }, 393);
        const centre = findFrame(frame, 'centre');
        expect(centre.x + centre.width / 2).toBe(frame.width / 2);
    });
});

describe('what each zone gets', () => {
    it('gives each side half of what the centre leaves', () => {
        const widths = statusStripZoneWidths(busy, 393);
        expect(widths.usable).toBe(statusRowUsableWidth(393));
        expect(widths.usable).toBe(339);
        expect(widths.centre).toBe(47);
        expect(widths.share).toBe((339 - 47) / 2);
        expect(widths.share).toBe(146);
    });

    it('wants 194 on the left before anything folds, at every width', () => {
        for (const width of [320, 375, 393]) {
            expect(statusStripZoneWidths(busy, width).left, String(width)).toBe(194);
        }
    });

    it('spends DROVE-223s budget, both insets counted', () => {
        // AgentInput's 8pt gutter and the row's 19pt inset, at both ends.
        expect(statusStripZoneWidths(busy, 320).usable).toBe(266);
        expect(statusStripZoneWidths(busy, 375).usable).toBe(321);
        expect(statusStripZoneWidths(busy, 393).usable).toBe(339);
    });
});

describe('the give-way order, zone by zone', () => {
    it('is one list and every entry has a zone', () => {
        for (const what of STATUS_ROW_GIVE_WAY) {
            expect(statusStripZoneOf[what], what).toBeDefined();
        }
    });

    it('folds the tool name and the clock at 393, and keeps the tasks badge', () => {
        const { folds, drawn } = drawnAt(busy, 393);
        expect(folds).toEqual({
            contextPercent: false,
            quotaWindow: false,
            toolName: true,
            elapsed: true,
            tasks: false,
            thinkingTokens: false,
            tokens: false,
        });
        expect(drawn.tasks).toBe('1/3 tasks');
        expect(statusStripZoneWidths(drawn, 393).left).toBe(128);
    });

    it('folds the same two at 375, which is the same row 18pt narrower', () => {
        const { folds } = drawnAt(busy, 375);
        expect(folds.toolName).toBe(true);
        expect(folds.elapsed).toBe(true);
        expect(folds.tasks).toBe(false);
        expect(statusStripZoneWidths(drawnAt(busy, 375).drawn, 375).left).toBe(128);
    });

    it('gives up the tasks badge too at 320, and nothing more', () => {
        const { folds, drawn } = drawnAt(busy, 320);
        expect(folds.tasks).toBe(true);
        expect(folds.tokens).toBe(false);
        expect(drawn.tokens).toBe('51.6k');
        expect(drawn.account).toBe('jamrizzi');
        expect(statusStripZoneWidths(drawn, 320).left).toBe(45);
    });

    it('never folds the workers or the dot, whatever the width', () => {
        for (const width of [320, 375, 393]) {
            const { drawn } = drawnAt(busy, width);
            expect(drawn.workers, String(width)).toBe(6);
            expect(drawn.dot, String(width)).toBe(true);
        }
    });

    it('NEVER folds a fact to relieve a zone it is not in', () => {
        // The left zone is 194 against a 146 share and the right is 76 against
        // the same, so the account must not be touched. Before this loop was
        // zone-aware a global order would have cut the name to make room on
        // the other side of the line.
        const { drawn } = drawnAt(busy, 393);
        expect(drawn.account).toBe('jamrizzi');
        expect(drawn.quotaPercent).toBe('8%');
    });

    it('does nothing at all to a row that already fits', () => {
        expect(drawnAt(idle, 393).folds).toEqual({
            contextPercent: false,
            quotaWindow: false,
            toolName: false,
            elapsed: false,
            tasks: false,
            thinkingTokens: false,
            tokens: false,
        });
    });

    it('takes the word `week` and leaves the number, never the other way round', () => {
        // No account to head the quota, so the window keeps its name: a bare
        // percent there would be nameless (DROVE-138). The fold takes the word
        // and the number survives it, which is the property that matters:
        // erasing the segment would be a deletion, not a fold.
        const nameless: StatusStripContent = {
            dot: true, tokens: '51.6k', quotaWindow: '8% week', quotaPercent: '8%', quotaExpands: true,
        };
        expect(statusStripQuotaText(nameless)).toBe('8% week');
        expect(statusStripQuotaText(statusStripDrawn(nameless, { ...noStatusStripFolds, quotaWindow: true })))
            .toBe('8%');
        // And it is the second cheapest thing on the strip, so it goes long
        // before the account or the tally.
        expect(STATUS_ROW_GIVE_WAY.indexOf('quotaWindow'))
            .toBeLessThan(STATUS_ROW_GIVE_WAY.indexOf('account'));
    });

    it('leaves the window name alone while the right zone fits', () => {
        // Zone-aware, again: `8% week` is 55pt against a 146pt share, so
        // nothing about a crowded LEFT zone may take the word off it.
        const nameless: StatusStripContent = {
            dot: true,
            tokens: '51.6k',
            workers: 9,
            liveExpands: true,
            elapsed: '1h 04m',
            toolName: 'mcp__playwright__browser_navigate',
            quotaWindow: '8% week',
            quotaPercent: '8%',
            quotaExpands: true,
        };
        expect(statusStripFolds(nameless, 320, STATUS_ROW_GIVE_WAY).quotaWindow).toBe(false);
    });
});

describe('the account truncates, and the cap is measured off this row', () => {
    it('caps the account at what the right zone leaves', () => {
        // Not a fraction of the whole line. DROVE-223's `45%` was a cap no
        // layout function could see, and it cut the most important word on the
        // strip while a third of the row sat empty.
        const cap = statusStripAccountCap(busy, 393)!;
        const widths = statusStripZoneWidths(busy, 393);
        expect(cap).toBeLessThan(widths.share);
        expect(cap).toBe(146 - (12 + 3) - (10 + 3));
    });

    it('has no cap when there is no account to cut', () => {
        expect(statusStripAccountCap({ ...busy, account: null }, 393)).toBeNull();
    });
});

describe('the tree itself', () => {
    it('positions nothing by hand', () => {
        // `resolveFlexFrames` throws on any style it does not model, and every
        // positional property is refused on purpose. If a future edit reaches
        // for an offset, this is where it stops.
        expect(() => resolveFlexFrames(statusStripNode(busy, 393), statusRowUsableWidth(393))).not.toThrow();
    });

    it('holds both sides open with a flex spacer, not a margin', () => {
        const frame = resolveFlexFrames(statusStripNode(idle, 393), statusRowUsableWidth(393));
        expect(findFrame(frame, 'leftSpacer')).toBeDefined();
        expect(findFrame(frame, 'rightSpacer').width).toBeGreaterThan(0);
    });

    it('never draws the working word, because the strip has no slot for one', () => {
        // `toolName` is the only label the content model has, and the caller
        // passes null for it while the main thread is working (DROVE-231).
        expect('workingWord' in busy).toBe(false);
        const frame = resolveFlexFrames(statusStripNode(busy, 393), statusRowUsableWidth(393));
        expect(findFrame(frame, 'workingWord')).toBeUndefined();
    });
});

/**
 * THE STRIP WHILE THE MAIN THREAD IS THINKING (DROVE-244).
 *
 * The label slot holds a word rather than a tool's name, and the numbers on
 * the line come from two different scopes. Both of those are things a width
 * budget can get wrong quietly, so they are measured here rather than argued.
 */
describe('the thinking state (DROVE-244)', () => {
    /** Clay's worst row, thinking: `● thinking 4m 20s 3.4k 👥6 ˄ · 1/3 tasks ˄ · 51.6k ◔ · jamrizzi 8% ˄`. */
    const thinking: StatusStripContent = {
        ...busy,
        toolName: 'thinking',
        stateWord: true,
        thinkingTokens: '3.4k',
    };

    it('is the widest the left zone ever gets, and the word is why', () => {
        // 245 against a 146 share at 393. The word costs 44 of it, so
        // SOMETHING established has to move in this state whatever the order
        // says — there is no arrangement where nothing gives.
        expect(statusStripZoneWidths(thinking, 393).left).toBe(245);
        expect(statusStripZoneWidths(busy, 393).left).toBe(194);
    });

    it('keeps the word at every width, ahead of everything else on the line', () => {
        for (const width of [320, 375, 393]) {
            const { drawn } = drawnAt(thinking, width);
            expect(drawn.toolName, String(width)).toBe('thinking');
            expect(drawn.dot, String(width)).toBe(true);
            expect(drawn.workers, String(width)).toBe(6);
        }
    });

    it('keeps the count at 375 and 393, and gives it up only at 320', () => {
        // What Clay asked for survives on the two phones he actually uses. At
        // 320 the badge has already gone and the line is still over, so the
        // count is the next thing and the word is what stays.
        expect(drawnAt(thinking, 393).drawn.thinkingTokens).toBe('3.4k');
        expect(drawnAt(thinking, 375).drawn.thinkingTokens).toBe('3.4k');
        expect(drawnAt(thinking, 320).drawn.thinkingTokens).toBeNull();
    });

    it('never truncates the line: every width fits once the folds are taken', () => {
        for (const width of [320, 375, 393]) {
            const { drawn } = drawnAt(thinking, width);
            const widths = statusStripZoneWidths(drawn, width);
            expect(widths.left, String(width)).toBeLessThanOrEqual(widths.share);
            expect(widths.right, String(width)).toBeLessThanOrEqual(widths.share);
            expect(widths.centre, String(width)).toBeLessThanOrEqual(widths.usable);
        }
    });

    it('keeps the account and the tally at every width, whatever the left zone costs', () => {
        // Zone-aware, and this is the state that tests it hardest: the left
        // zone is over by 99pt at 393 and the right zone is nowhere near its
        // share. Nothing about the word may cut the account.
        for (const width of [320, 375, 393]) {
            const { drawn } = drawnAt(thinking, width);
            expect(drawn.account, String(width)).toBe('jamrizzi');
            expect(drawn.quotaPercent, String(width)).toBe('8%');
            expect(drawn.tokens, String(width)).toBe('51.6k');
        }
    });

    it('folds the state word LAST, behind the centre figure and the account', () => {
        // DROVE-223's rule, kept by reordering the one list rather than by a
        // second one. A tool name goes third; the same slot holding the word
        // goes after everything.
        const order = statusStripOrderFor(thinking, STATUS_ROW_GIVE_WAY);
        expect(order[order.length - 1]).toBe('toolName');
        expect(order.indexOf('tokens')).toBeLessThan(order.indexOf('toolName'));
        expect(order.indexOf('account')).toBeLessThan(order.indexOf('toolName'));
        // A tool's name is untouched: same list, same ranks.
        expect(statusStripOrderFor(busy, STATUS_ROW_GIVE_WAY)).toEqual([...STATUS_ROW_GIVE_WAY]);
    });

    it('draws the count third, after the word and the clock', () => {
        // The shape Claude Code's own status line uses —
        // `Actualizing… (20s · ↓ 424 tokens)` — and the shape the strip's tool
        // state already has in `Bash 2m 58s`. Verb, clock, tokens, in both.
        const frame = resolveFlexFrames(statusStripNode(thinking, 393), statusRowUsableWidth(393));
        const at = (name: string) => findFrame(frame, name)!.x;
        expect(at('toolName')).toBeLessThan(at('elapsed'));
        expect(at('elapsed')).toBeLessThan(at('thinkingTokens'));
    });

    it('has no thinking count on the line while a tool is running', () => {
        // The two never share the row: the caller only supplies a count in the
        // thinking state, and the layout must not reserve room for one.
        expect(statusStripZoneWidths(busy, 393).left)
            .toBe(statusStripZoneWidths({ ...busy, thinkingTokens: null }, 393).left);
    });
});
