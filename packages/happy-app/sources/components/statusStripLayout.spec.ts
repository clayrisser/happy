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
import {
    STATUS_ROW_GIVE_WAY,
    STATUS_ROW_MODEL_TRUNCATION,
    statusRowUsableWidth,
} from './statusRowLayout';
import {
    resolveStatusStrip,
    noStatusStripFolds,
    statusStripAccountCap,
    statusStripDrawn,
    statusStripFolds,
    statusStripMetrics,
    statusStripNode,
    statusStripQuotaText,
    statusStripZoneOf,
    statusStripZoneWidths,
    type StatusStripContent,
} from './statusStripLayout';
import { formatTokens } from '@/utils/liveStatus';

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

    it('folds the tasks badge as well at 375, which is the floor being paid for', () => {
        // DROVE-231 folded the same two here as at 393 and kept the badge, on
        // a 137pt share. The share has not moved; what it may SPEND has
        // (DROVE-250). 128pt of left zone against a 121pt budget is 7pt over,
        // and the badge is the next rank down. 393 is untouched — see above —
        // which is the width Clay photographed.
        const { folds } = drawnAt(busy, 375);
        expect(folds.toolName).toBe(true);
        expect(folds.elapsed).toBe(true);
        expect(folds.tasks).toBe(true);
        expect(statusStripZoneWidths(busy, 375).budget).toBe(121);
        expect(statusStripZoneWidths(drawnAt(busy, 375).drawn, 375).left).toBe(45);
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
    it('caps the account at what the right zone BUDGET leaves', () => {
        // Not a fraction of the whole line. DROVE-223's `45%` was a cap no
        // layout function could see, and it cut the most important word on the
        // strip while a third of the row sat empty.
        //
        // And not the share either (DROVE-250). A cap that spends the whole
        // share lets the name end exactly where the tally begins, which is the
        // photograph. The 16pt floor comes off first, so the cap is 16 less
        // than DROVE-223 measured and the gap it buys is guaranteed.
        const cap = statusStripAccountCap(busy, 393)!;
        const widths = statusStripZoneWidths(busy, 393);
        expect(widths.gap).toBe(16);
        expect(widths.budget).toBe(146 - 16);
        expect(cap).toBeLessThan(widths.budget);
        expect(cap).toBe(130 - (12 + 3) - (10 + 3));
        expect(cap).toBe(102);
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
 * THE CENTRE ZONE UNDER A SESSION TOTAL (DROVE-241).
 *
 * The strip's number stopped being the turn and became the session, and a
 * session total only ever grows: Clay's reached 1.3M in an evening. So the
 * question DROVE-223 would ask is whether the centre zone can outgrow its
 * budget, and the answer is no, for a reason that is a property of
 * `formatTokens` rather than a happy accident of tonight's numbers.
 *
 * `formatTokens` returns AT MOST SIX CHARACTERS. One decimal, one suffix, and
 * a promotion at 0.99995 of each tier so `999_999` renders `1.0M` instead of
 * the seven-character `1000.0k`. Six characters is 36pt at the row's 6pt
 * advance, so the centre is bounded whatever the session spends, and the
 * widest string is a number in the high hundreds of its tier rather than a
 * big one.
 */
describe('the centre holds a session total, at every width (DROVE-241)', () => {
    /** The centre is the number, the 3pt gap and the 14pt ring. Nothing else. */
    const centreOf = (tokens: string, width: number) =>
        statusStripZoneWidths({ ...busy, tokens }, width).centre;

    it('is never wider than six characters can draw', () => {
        // Every tier's widest string, and they are all the same width.
        for (const widest of ['999.9k', '999.9M', '999.9B']) {
            expect(formatTokens(999_900).length, widest).toBe(6);
            expect(centreOf(widest, 393), widest).toBe(6 * 6 + 3 + 14);
            expect(centreOf(widest, 393), widest).toBe(53);
        }
    });

    it('is NARROWER at 10M than at 999.9k, which is the whole point', () => {
        // Ten million is `10.0M`, five characters. A session that grows past a
        // million gets a SHORTER string, not a longer one, because the tier
        // promotes before the digits do. There is no width event at 10M and
        // none at a billion either.
        expect(formatTokens(10_000_000)).toBe('10.0M');
        expect(formatTokens(1_300_000)).toBe('1.3M');
        expect(formatTokens(9_999_999_999)).toBe('10.0B');
        for (const width of [320, 375, 393]) {
            expect(centreOf('10.0M', width), String(width)).toBeLessThan(centreOf('999.9k', width));
        }
    });

    it('costs the sides 3pt against the turn figure it replaced, at 320 / 375 / 393', () => {
        // `51.6k` is the turn on the row Clay photographed; `1.3M` is what his
        // session had actually spent by then. The session total is the SHORTER
        // string of the two, so each side zone gains 3pt rather than losing
        // any. Pinned per width because the share is what the folds spend.
        const shares = (tokens: string) => [320, 375, 393]
            .map((width) => statusStripZoneWidths({ ...busy, tokens }, width).share);
        expect(shares('51.6k')).toEqual([109.5, 137, 146]);
        expect(shares('1.3M')).toEqual([112.5, 140, 149]);
        // And the worst case the format can produce, which is the one the
        // budget has to survive rather than tonight's number.
        expect(shares('999.9k')).toEqual([106.5, 134, 143]);
    });

    it('folds exactly what DROVE-231 folded, with the widest total on the line', () => {
        // THE ACCEPTANCE CRITERION. A total in the millions must not cost the
        // row a fact it kept before. The give-way order is unchanged at all
        // three widths: the tool name and the clock at 393 and 375, the tasks
        // badge as well at 320.
        //
        // DROVE-250 revised the second half of that. The centre still costs
        // the sides nothing it did not cost before, but the 16pt zone floor
        // does, and on the widest total the badge is what pays it at 393 and
        // 375 as well as at 320. The criterion that survives whole is the one
        // about the CENTRE: the tally is never the thing that gives way, and
        // it is on the line at every width below.
        const widest = { ...busy, tokens: '999.9k' };
        for (const width of [320, 375, 393]) {
            expect(drawnAt(widest, width).folds, String(width)).toEqual({
                ...noStatusStripFolds,
                toolName: true,
                elapsed: true,
                tasks: true,
            });
        }
        // And the number itself is never the thing that gives way: it is last
        // on STATUS_ROW_GIVE_WAY and the centre fits at every width.
        for (const width of [320, 375, 393]) {
            expect(drawnAt(widest, width).drawn.tokens, String(width)).toBe('999.9k');
        }
    });

    it('would have overflowed on the old format, which is why the tier promotes', () => {
        // `1000.0k` is what DROVE-184's formatter returned for 999_999: seven
        // characters, 42pt, and it arrived in the narrow band right below the
        // million Clay was watching for. 6pt of extra centre is 3pt off each
        // side's share, and at 320 the shares are already inside 110.
        expect(centreOf('1000.0k', 320)).toBe(59);
        expect(centreOf('999.9k', 320)).toBe(53);
        expect(formatTokens(999_999)).toBe('1.0M');
        expect(formatTokens(999_999)).not.toBe('1000.0k');
    });
});

/**
 * THE STRIP WHILE THE MAIN THREAD IS THINKING (DROVE-244, corrected by
 * DROVE-250).
 *
 * DROVE-244 put the word `thinking` in the label slot and measured what it
 * cost: 44pt of a 146pt share, paid for with the clock, the badge and — at
 * 320 — the count Clay had actually asked for. Clay struck the word out in
 * red: "I told you NOT to put this word thinking here. The dot covers it. We
 * have precious space here."
 *
 * So the word is gone and the NUMBER stays, which is the half of 244 he asked
 * for by name. What is measured here is that the state now costs the line
 * almost nothing: the same row that lost three facts to the word loses one to
 * the 16pt zone floor, and the count survives at every width.
 */
describe('the thinking state, with no word in it (DROVE-250 over DROVE-244)', () => {
    /** Clay's row while thinking: `● 4m 20s 3.4k 👥6 ˄ · 1/3 tasks ˄ · 51.6k ◔ · jamrizzi 8% ˄`. */
    const thinking: StatusStripContent = {
        ...busy,
        toolName: null,
        thinkingTokens: '3.4k',
    };

    it('draws no state word, because the content model has no slot for one', () => {
        // `toolName` is the only label there is and the caller passes null for
        // it whenever no tool is in flight. Two words have now been refused
        // here — `working` in DROVE-231, `thinking` in DROVE-250 — and both
        // for the same reason: the dot beside them already blinks blue.
        for (const width of [320, 375, 393]) {
            expect(drawnAt(thinking, width).drawn.toolName, String(width)).toBeNull();
        }
        const frame = resolveFlexFrames(statusStripNode(thinking, 393), statusRowUsableWidth(393));
        expect(findFrame(frame, 'toolName')).toBeUndefined();
    });

    it('hands 44pt back to the left zone, which is what the word was costing', () => {
        // DROVE-244 pinned this row at 245pt with the word on it. Without it
        // the same row is 194, exactly what `busy` wants, because `3.4k` and
        // `Bash` happen to estimate the same.
        expect(statusStripZoneWidths(thinking, 393).left).toBe(194);
        expect(statusStripZoneWidths(busy, 393).left).toBe(194);
    });

    it('keeps the count Clay asked for at EVERY width, 320 included', () => {
        // The one thing DROVE-244 could not do. "When it's thinking instead of
        // bashing on the main thread show the thinking token count" — and at
        // 320 the word ate it. With the word gone it survives under a floor
        // that is stricter than the one 244 was measured against.
        for (const width of [320, 375, 393]) {
            expect(drawnAt(thinking, width).drawn.thinkingTokens, String(width)).toBe('3.4k');
        }
    });

    it('folds the clock and the badge, and nothing else, at every width', () => {
        for (const width of [320, 375, 393]) {
            expect(drawnAt(thinking, width).folds, String(width)).toEqual({
                ...noStatusStripFolds,
                elapsed: true,
                tasks: true,
            });
        }
    });

    it('keeps the account, the tally, the workers and the dot at every width', () => {
        for (const width of [320, 375, 393]) {
            const { drawn } = drawnAt(thinking, width);
            expect(drawn.account, String(width)).toBe('jamrizzi');
            expect(drawn.quotaPercent, String(width)).toBe('8%');
            expect(drawn.tokens, String(width)).toBe('51.6k');
            expect(drawn.workers, String(width)).toBe(6);
            expect(drawn.dot, String(width)).toBe(true);
        }
    });

    it('draws the count after the clock, which is the shape both readouts use', () => {
        // Claude Code's own status line is `Actualizing… (20s · ↓ 424 tokens)`
        // and the strip's tool state is `Bash 2m 58s`. Clock then tokens, in
        // both; the verb is what DROVE-250 took out of the strip's copy.
        const frame = resolveFlexFrames(statusStripNode(thinking, 393), statusRowUsableWidth(393));
        expect(findFrame(frame, 'elapsed').x).toBeLessThan(findFrame(frame, 'thinkingTokens').x);
    });

    it('has no thinking count on the line while a tool is running', () => {
        // The two never share the row: the caller only supplies a count in the
        // thinking state, and the layout must not reserve room for one.
        expect(statusStripZoneWidths(busy, 393).left)
            .toBe(statusStripZoneWidths({ ...busy, thinkingTokens: null }, 393).left);
    });
});

/**
 * THE ZONES DO NOT TOUCH (DROVE-250).
 *
 * Clay, on `● Bash 15m 23s ˄  17.1M  jam@codejam.ninja 78% ˄`: "Do u see the
 * issue here? They overlap".
 *
 * Measured, the tally and the account were not overlapping: they were 10pt
 * apart with 52pt of empty line on the other side of the centre. That reads as
 * a collision because the eye compares the two seams, and the layout had no
 * opinion about either — its fit test was `left <= share`, and a zone that is
 * exactly its share ends where the next one begins.
 *
 * So the floor is 16pt, `statusRowMetrics.separator`, and everything below is
 * that number surviving contact with the widest row the strip can be handed.
 * The geometry comes out of `resolveFlexFrames` placing the real tree, never
 * out of the sums that produced it — the gaps below are frame coordinates
 * subtracted from each other.
 */
describe('the 16pt floor between adjacent zones (DROVE-250)', () => {
    /**
     * THE WORST REALISTIC ROW, which is not the fixture.
     *
     * A long email, the widest total `formatTokens` can produce, a tool name,
     * a two-digit task badge, a two-digit agent count, and the ring. Everything
     * on it is something Clay has actually had on the line.
     */
    const worst: StatusStripContent = {
        dot: true,
        toolName: 'Bash',
        elapsed: '15m 23s',
        tokens: '999.9M',
        workers: 14,
        liveExpands: true,
        tasks: '3/12 tasks',
        account: 'clayrisser@gmail.com',
        quotaPercent: '78%',
        quotaExpands: true,
        contextGauge: true,
    };

    /** The row Clay photographed, with the ring his phone was drawing. */
    const photographed: StatusStripContent = {
        dot: true,
        toolName: 'Bash',
        elapsed: '15m 23s',
        tokens: '17.1M',
        liveExpands: true,
        account: 'jam@codejam.ninja',
        quotaPercent: '78%',
        quotaExpands: true,
        contextGauge: true,
    };

    /** The clear space either side of the centre, straight off the frames. */
    function gaps(content: StatusStripContent, width: number) {
        const { frame } = drawnAt(content, width);
        const left = findFrame(frame, 'leftContent');
        const centre = findFrame(frame, 'centre');
        const right = findFrame(frame, 'quota');
        return {
            left: centre.x - (left.x + left.width),
            right: right.x - (centre.x + centre.width),
        };
    }

    it('is the row separator, so no seam between zones is tighter than one inside a zone', () => {
        // The widest separation the strip already spends is the middot and its
        // 6pt margins, which is what holds two tappable clusters apart INSIDE
        // one zone. Two zones cannot be closer than that. Derived, not
        // written down again.
        expect(statusStripMetrics.zoneGap).toBe(statusStripMetrics.clusterGap);
        expect(statusStripMetrics.zoneGap).toBe(16);
        // And it is wider than any clear run inside a zone: 3pt between two
        // items, 5pt after the dot, 6pt either side of the middot.
        expect(statusStripMetrics.zoneGap).toBeGreaterThan(statusStripMetrics.gap);
        expect(statusStripMetrics.zoneGap).toBeGreaterThan(statusStripMetrics.dotGap);
    });

    it('takes the floor off the share, and the give-way order spends what is left', () => {
        for (const width of [320, 375, 393]) {
            const w = statusStripZoneWidths(worst, width);
            expect(w.gap, String(width)).toBe(16);
            expect(w.budget, String(width)).toBe(w.share - 16);
        }
        // The share itself is untouched, because it is a fact about where the
        // flex pass puts the boundary rather than a policy (DROVE-231,
        // DROVE-241).
        expect(statusStripZoneWidths(busy, 393).share).toBe(146);
    });

    it('holds 16pt or more between every pair of zones, at 320, 375 and 393', () => {
        // THE ACCEPTANCE CRITERION, measured off the resolved frames.
        for (const content of [worst, photographed, busy, idle]) {
            for (const width of [320, 375, 393]) {
                const gap = gaps(content, width);
                expect(gap.left, `left ${width}`).toBeGreaterThanOrEqual(16);
                expect(gap.right, `right ${width}`).toBeGreaterThanOrEqual(16);
            }
        }
    });

    it('measures the worst row at 320, 375 and 393, and writes the numbers down', () => {
        // usable, centre, share, budget, left after folds, right after folds.
        const rows = [320, 375, 393].map((width) => {
            const { drawn } = drawnAt(worst, width);
            const w = statusStripZoneWidths(drawn, width);
            return [w.usable, w.centre, w.share, w.budget, w.left, w.right];
        });
        expect(rows).toEqual([
            [266, 53, 106.5, 90.5, 51, 90.5],
            [321, 53, 134, 118, 51, 118],
            [339, 53, 143, 127, 51, 127],
        ]);
        // The right zone lands exactly on its budget at all three, because the
        // account truncates INTO it; the gap it leaves is the floor itself.
        for (const width of [320, 375, 393]) {
            expect(gaps(worst, width).right, String(width)).toBe(16);
        }
        // And the left zone has room to spare once the order has run.
        expect([320, 375, 393].map((width) => gaps(worst, width).left)).toEqual([55.5, 83, 92]);
    });

    it('gives way in DROVE-223s order and stops there: the name, the clock, the badge', () => {
        for (const width of [320, 375, 393]) {
            expect(drawnAt(worst, width).folds, String(width)).toEqual({
                ...noStatusStripFolds,
                toolName: true,
                elapsed: true,
                tasks: true,
            });
        }
        // Nothing later on the list moves: the tally is last and it is on the
        // line, and the account gives way as TEXT rather than dropping.
        for (const width of [320, 375, 393]) {
            const { drawn } = drawnAt(worst, width);
            expect(drawn.tokens, String(width)).toBe('999.9M');
            expect(drawn.account, String(width)).toBe('clayrisser@gmail.com');
            expect(drawn.quotaPercent, String(width)).toBe('78%');
        }
    });

    it('keeps a two-digit worker count at every width, because it is on no fold list', () => {
        // Clay: "with 14 agents running it is one of the most useful facts on
        // that line". It is not a step in `statusStripFolds` and
        // `statusStripDrawn` never nulls it, so nothing on the strip can take
        // it — a count missing from a real row is a snapshot reporting no
        // agents, not a fold.
        for (const width of [320, 375, 393]) {
            expect(drawnAt(worst, width).drawn.workers, String(width)).toBe(14);
            expect(findFrame(drawnAt(worst, width).frame, 'workersCount').width, String(width)).toBe(12);
        }
        expect(Object.keys(noStatusStripFolds)).not.toContain('workers');
    });

    it('cuts the account at the TAIL, so an email keeps the part that names it', () => {
        // `jam@codejam.ninja` becomes `jam@code…`, never `…jam.ninja`. The
        // local part and the `@` say which account this is; the domain is the
        // same on every account Clay owns. The cap leaves room for them at the
        // narrowest width the strip supports.
        expect(STATUS_ROW_MODEL_TRUNCATION.ellipsizeMode).toBe('tail');
        const caps = [320, 375, 393]
            .map((width) => statusStripAccountCap(drawnAt(photographed, width).drawn, width));
        expect(caps).toEqual([59.5, 87, 96]);
        // `jam@` is four characters, 24pt, and it survives the tightest cap.
        expect(Math.min(...caps as number[])).toBeGreaterThan(4 * 6);
    });

    it('truncates the account rather than dropping any other zones fact', () => {
        // DROVE-223 ranks `account` above `tokens` and `elapsed`, and this is
        // the right zone's only give-way: `quotaWindow` does nothing while an
        // account heads the quota, and the percentage never shrinks.
        const { drawn } = drawnAt(photographed, 393);
        expect(drawn.tokens).toBe('17.1M');
        expect(drawn.elapsed).toBe('15m 23s');
        expect(drawn.toolName).toBe('Bash');
        expect(drawn.account).toBe('jam@codejam.ninja');
        // The zone still lands inside its budget, because the model carries
        // the cap the renderer draws with.
        const w = statusStripZoneWidths(drawn, 393);
        expect(w.right).toBeLessThanOrEqual(w.budget);
    });

    it('lets a CENTRE fold relieve a starved side, because the centre funds both', () => {
        // Each side's share is half of what the centre leaves, so 6pt off the
        // centre hands 3pt to each side. The old loop only took a step while
        // the step's OWN zone was over, and the centre is never over — which
        // made the one step that can widen a starved side the one step that
        // could never fire.
        const wide = statusStripZoneWidths({ ...busy, tokens: '999.9k' }, 393);
        const narrow = statusStripZoneWidths({ ...busy, tokens: null }, 393);
        expect(narrow.budget - wide.budget).toBe((wide.centre - narrow.centre) / 2);
        expect(statusStripZoneOf.tokens).toBe('centre');
        // And it is still LAST, so it only runs once everything cheaper has.
        expect(STATUS_ROW_GIVE_WAY[STATUS_ROW_GIVE_WAY.length - 1]).toBe('tokens');
    });

    it('does not fold a reveal the reader asked for', () => {
        // A tap on the ring puts `84.0k of 200.0k context, compacts near
        // 184.0k` in the centre, which no phone has a zone wide enough for.
        // Folding it back would make the tap do nothing, so the step is
        // skipped and the sides give way around it instead.
        const tapped: StatusStripContent = {
            ...busy,
            contextPercent: '84.0k of 200.0k context, compacts near 184.0k',
            contextPrecise: true,
        };
        expect(drawnAt(tapped, 393).drawn.contextPercent)
            .toBe('84.0k of 200.0k context, compacts near 184.0k');
        // Without the tap the same string is the cheapest thing on the line
        // and rank 1 takes it.
        expect(drawnAt({ ...tapped, contextPrecise: false }, 393).drawn.contextPercent).toBeNull();
    });

    it('shares ONE gap when there is no centre to sit between the sides', () => {
        // One boundary costs 16pt whoever pays it. With a centre there are two
        // and the centre pays for neither, because it does not shrink; with no
        // centre the two sides face each other across a single boundary and
        // split it.
        const noCentre = statusStripZoneWidths({ ...idle, contextGauge: false }, 393);
        expect(noCentre.centre).toBe(0);
        expect(noCentre.gap).toBe(8);
        expect(noCentre.share * 2 - noCentre.gap * 2).toBe(statusRowUsableWidth(393) - 16);
    });
});
