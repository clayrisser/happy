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
import { findFrame } from './flexFrames';
import { STATUS_ROW_GIVE_WAY, statusRowUsableWidth } from './statusRowLayout';
import {
    resolveStatusStrip,
    noStatusStripFolds,
    statusStripAccountCap,
    statusStripDrawn,
    statusStripFolds,
    statusStripNode,
    statusStripQuotaText,
    statusStripZoneOf,
    statusStripZoneWidths,
    type StatusStripContent,
} from './statusStripLayout';
import { resolveFlexFrames } from './flexFrames';
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
        const widest = { ...busy, tokens: '999.9k' };
        for (const width of [375, 393]) {
            expect(drawnAt(widest, width).folds, String(width)).toEqual({
                ...noStatusStripFolds,
                toolName: true,
                elapsed: true,
            });
        }
        expect(drawnAt(widest, 320).folds).toEqual({
            ...noStatusStripFolds,
            toolName: true,
            elapsed: true,
            tasks: true,
        });
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
