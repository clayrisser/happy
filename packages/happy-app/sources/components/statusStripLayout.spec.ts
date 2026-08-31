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
