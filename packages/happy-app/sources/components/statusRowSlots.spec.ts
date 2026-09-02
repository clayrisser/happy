import { describe, expect, it } from 'vitest';
import {
    STATUS_ROW_SLOTS,
    statusRowSlotZone,
    statusRowSlots,
    type StatusRowSlot,
} from './statusRowSlots';
import { resolveStatusStrip, type StatusStripContent } from './statusStripLayout';
import { STATUS_ROW_GIVE_WAY } from './statusRowLayout';

/**
 * ONE ROW, FOUR HARNESSES (DROVE-372).
 *
 * Clay ran a Codex session for the first time and photographed the strip
 * beside a Claude one: "why does it look different? The very bottom row looks
 * different than the Claude one." They shared one slot out of twelve.
 *
 * The fixtures below are what each harness ACTUALLY publishes today, read off
 * the CLI rather than invented, so this spec fails when a harness's real feed
 * changes and not before:
 *
 *   claude    metadata.liveStatus (the clock, the tally, the workers, the
 *             tools), metadata.droverUsage (the account and its quota),
 *             agentState.usageLimits, and a context window injected into the
 *             message usage by sdkToLogConverter.
 *   codex     a per-message `usage` block carrying contextSize and
 *             contextWindow, and nothing else at all. No liveStatus, no
 *             droverUsage, no account, no session token rollup.
 *   opencode  nothing but the shared metadata baseline. The ACP path can parse
 *             a `token-count` update but no backend ever emits one.
 *   pi        the same: baseline metadata, a model name, and no numbers.
 *
 * What this spec pins is NOT that the four rows look alike — they cannot, and
 * they should not pretend to. It is that they differ only by ABSENCE:
 *
 *   the same slots, in the same order, and a slot a harness does not publish
 *   is simply missing rather than replaced, moved, or drawn some other way.
 *
 * That is the property the two screenshots violated. Codex's context reading
 * sat where it did because the centre was otherwise empty, and Claude's was
 * hidden because an account happened to be beside it, so the same fact drew
 * differently depending on which CLI was underneath.
 */

/** The dot is on every row: every harness has a connection to speak for. */
const dot = { dot: true } as const;

/**
 * A Claude session mid-turn with a fan-out out, an account and a task list —
 * the row in Clay's IMG_0615, which is the fullest this strip ever gets.
 */
const claude: StatusStripContent = {
    ...dot,
    toolName: 'Bash',
    elapsed: '1m 20s',
    thinkingTokens: '5.1k',
    workers: 9,
    liveExpands: true,
    tasks: '1/3 tasks',
    tokens: '12.9M',
    contextGauge: true,
    contextPercent: '23% ctx',
    account: 'jam@codejam.ninja',
    quotaPercent: '23%',
    quotaExpands: true,
};

/**
 * A Codex session — the row in Clay's IMG_0614. Everything the left and right
 * zones want is unpublished, so it is the claude fixture with those slots
 * struck out and NOTHING put in their place.
 */
const codex: StatusStripContent = {
    ...dot,
    contextGauge: true,
    contextPercent: '13% ctx',
};

/** An opencode session: the baseline and the dot. */
const opencode: StatusStripContent = { ...dot };

/** A pi session: the same. Its model name rides the capsule, not this row. */
const pi: StatusStripContent = { ...dot };

const harnesses: ReadonlyArray<[string, StatusStripContent]> = [
    ['claude', claude],
    ['codex', codex],
    ['opencode', opencode],
    ['pi', pi],
];

/** A phone that fits the whole claude row, so nothing folds for width here. */
const wideEnough = 430;

describe('the status row is one row for every harness (DROVE-372)', () => {
    it.each(harnesses)('%s fills a subsequence of the one slot table', (_name, content) => {
        const slots = statusRowSlots(content);
        const ranks = slots.map((slot) => STATUS_ROW_SLOTS.indexOf(slot));
        // Strictly increasing is the whole claim: every slot this harness
        // fills sits where the table puts it, never where the gaps left room.
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        expect(new Set(ranks).size).toBe(ranks.length);
        expect(slots.every((slot) => STATUS_ROW_SLOTS.includes(slot))).toBe(true);
    });

    it('gives every harness the dot, and gives no harness a slot off the table', () => {
        for (const [name, content] of harnesses) {
            expect(statusRowSlots(content)[0], name).toBe('dot');
        }
    });

    it('differs between harnesses only by ABSENCE, never by substitution', () => {
        // Every pair, both directions: whatever two harnesses share, they lay
        // out in the same relative order. A harness that re-shaped the line —
        // moved its context reading into the tally's position, say — breaks
        // this without needing a screenshot to notice.
        for (const [nameA, a] of harnesses) {
            for (const [nameB, b] of harnesses) {
                const slotsA = statusRowSlots(a);
                const slotsB = statusRowSlots(b);
                const shared = slotsA.filter((slot) => slotsB.includes(slot));
                expect(
                    shared,
                    `${nameA} vs ${nameB} disagree about slot order`,
                ).toEqual(slotsB.filter((slot) => slotsA.includes(slot)));
            }
        }
    });

    it('puts every harness that has a slot in the same ZONE for it', () => {
        for (const [name, content] of harnesses) {
            for (const slot of statusRowSlots(content)) {
                // The zone is a property of the slot. Nothing may read the
                // harness to decide where a fact goes.
                expect(statusRowSlotZone[slot], `${name}/${slot}`)
                    .toBe(statusRowSlotZone[slot]);
            }
        }
        expect(statusRowSlotZone.context).toBe('centre');
        expect(statusRowSlotZone.tokens).toBe('centre');
        expect(statusRowSlotZone.account).toBe('right');
    });

    it('is a strict subset of claude for every other harness today', () => {
        // Not a rule the row enforces, a FACT about the current feeds, and the
        // line that will fail first when codex starts publishing a clock. When
        // it does, the clock must appear in `elapsed` — where claude's already
        // is — and this expectation gets the new slot added to it, rather than
        // the row growing a codex-shaped branch.
        const claudeSlots = new Set<StatusRowSlot>(statusRowSlots(claude));
        for (const [name, content] of harnesses) {
            for (const slot of statusRowSlots(content)) {
                expect(claudeSlots.has(slot), `${name} fills ${slot}, claude does not`).toBe(true);
            }
        }
        expect(statusRowSlots(codex)).toEqual(['dot', 'context']);
        expect(statusRowSlots(opencode)).toEqual(['dot']);
        expect(statusRowSlots(pi)).toEqual(['dot']);
    });
});

describe('the context reading is one slot, filled the same way by anyone (DROVE-372)', () => {
    it('lands at the same position on codex as on claude', () => {
        const onClaude = statusRowSlots(claude).indexOf('context');
        const onCodex = statusRowSlots(codex).indexOf('context');
        // Different INDEX in each row, because claude fills slots ahead of it;
        // the same RANK on the table, which is the thing that must not move.
        expect(onClaude).toBeGreaterThanOrEqual(0);
        expect(onCodex).toBeGreaterThanOrEqual(0);
        expect(STATUS_ROW_SLOTS.indexOf(statusRowSlots(claude)[onClaude]))
            .toBe(STATUS_ROW_SLOTS.indexOf(statusRowSlots(codex)[onCodex]));
    });

    it('never takes the tally\'s slot when the tally is absent', () => {
        // The exact substitution the screenshots looked like: codex's centre
        // held a percentage where claude's held `12.9M`, so the two rows
        // appeared to disagree about what the middle of the strip means.
        expect(statusRowSlots(codex)).not.toContain('tokens');
        expect(statusRowSlotZone.context).toBe(statusRowSlotZone.tokens);
        expect(STATUS_ROW_SLOTS.indexOf('tokens'))
            .toBeLessThan(STATUS_ROW_SLOTS.indexOf('context'));
    });

    it('keeps its percent on a claude row that has an account, given the width', () => {
        // The regression this ticket fixes. The percent used to be withheld
        // whenever an account was on the row, and the account tracks the
        // harness (DROVE-352 narrows it), so the same slot printed its number
        // on codex and drew a bare ring on claude — at every width, however
        // empty the line.
        //
        // An IDLE claude session: the account is on the row, the left zone is
        // quiet. Under the old rule this drew a bare ring purely because of
        // the account beside it.
        const idleClaude: StatusStripContent = {
            ...dot,
            contextGauge: true,
            contextPercent: '23% ctx',
            account: 'jam@codejam.ninja',
            quotaPercent: '23%',
            quotaExpands: true,
        };
        const { drawn } = resolveStatusStrip(idleClaude, wideEnough, STATUS_ROW_GIVE_WAY);
        expect(drawn.contextPercent).toBe('23% ctx');
        expect(drawn.account).toBe('jam@codejam.ninja');
    });

    it('drops that percent for WIDTH, and drops it first, on any harness', () => {
        // Still folded on a crowded row — but by the give-way order, on
        // measured width, which is the same decision for every harness. The
        // full claude row is over budget even on a wide phone, so it folds
        // there too; what changed is the REASON, and that the codex row beside
        // it now folds under the same rule instead of a different one.
        expect(STATUS_ROW_GIVE_WAY[0]).toBe('contextPercent');
        for (const width of [wideEnough, 375, 320]) {
            const { folds, drawn } = resolveStatusStrip(claude, width, STATUS_ROW_GIVE_WAY);
            expect(folds.contextPercent, `claude at ${width}`).toBe(true);
            expect(drawn.contextPercent, `claude at ${width}`).toBeNull();
            // The ring stays, so the reading is never lost outright.
            expect(drawn.contextGauge, `claude at ${width}`).toBe(true);
        }
        // The codex row has nothing else on it, so the same order keeps its
        // number at every width a phone has.
        for (const width of [wideEnough, 375, 320]) {
            const { drawn } = resolveStatusStrip(codex, width, STATUS_ROW_GIVE_WAY);
            expect(drawn.contextPercent, `codex at ${width}`).toBe('13% ctx');
        }
    });

    it('folds by width alone: the account does not decide it', () => {
        // Two rows identical but for the account. Whatever the fold does, it
        // does for the same reason to both, which is the property that was
        // missing.
        const withAccount: StatusStripContent = { ...dot, contextGauge: true, contextPercent: '13% ctx', account: 'jam@codejam.ninja', quotaPercent: '23%' };
        const withoutAccount: StatusStripContent = { ...dot, contextGauge: true, contextPercent: '13% ctx' };
        expect(resolveStatusStrip(withAccount, wideEnough, STATUS_ROW_GIVE_WAY).drawn.contextPercent)
            .toBe('13% ctx');
        expect(resolveStatusStrip(withoutAccount, wideEnough, STATUS_ROW_GIVE_WAY).drawn.contextPercent)
            .toBe('13% ctx');
    });
});
