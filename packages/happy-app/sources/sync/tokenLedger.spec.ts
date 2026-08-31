/**
 * THE ALL-TIME LEDGER, AND THE ACCOUNT FLIP IT HAS TO SURVIVE (DROVE-241).
 *
 * The one property worth more than the rest: the number on the home page goes
 * UP or stays where it is, and never anywhere else, however the strip's
 * session figure behaves. Clay flipped accounts twice in one evening and the
 * live figure fell twice; a total that fell with it would read as the same
 * reset he opened this ticket about.
 */
import { describe, expect, it } from 'vitest';
import {
    creditTokenLedger,
    emptyTokenLedger,
    markCap,
    resetTokenLedger,
    tokenLedgerRows,
    tokenLedgerTotal,
    type TokenLedger,
} from './tokenLedger';

const now = 1_700_000_000_000;
const credit = (ledger: TokenLedger, sightings: Parameters<typeof creditTokenLedger>[1], at = now) =>
    creditTokenLedger(ledger, sightings, at);

describe('banking what a session has spent', () => {
    it('credits the first sighting whole and the next one only its growth', () => {
        const one = credit(emptyTokenLedger, [{
            sessionId: 's1',
            session: 1_000,
            byModel: { 'claude-opus-5': 800, 'claude-fable-5': 200 },
        }]);
        expect(tokenLedgerTotal(one)).toBe(1_000);
        const two = credit(one, [{
            sessionId: 's1',
            session: 1_500,
            byModel: { 'claude-opus-5': 1_100, 'claude-fable-5': 400 },
        }]);
        expect(tokenLedgerTotal(two)).toBe(1_500);
        expect(two.byModel).toEqual({ 'claude-opus-5': 1_100, 'claude-fable-5': 400 });
    });

    it('credits nothing at all for a sighting it has already banked', () => {
        // `applySessions` runs on every socket frame and most frames carry the
        // same numbers. Crediting on each would multiply the evening.
        const sighting = { sessionId: 's1', session: 1_000, byModel: { 'claude-opus-5': 1_000 } };
        let ledger = credit(emptyTokenLedger, [sighting]);
        for (let i = 0; i < 20; i++) ledger = credit(ledger, [sighting]);
        expect(tokenLedgerTotal(ledger)).toBe(1_000);
    });

    it('adds sessions together, which is what "all time" means', () => {
        const ledger = credit(emptyTokenLedger, [
            { sessionId: 's1', session: 1_000, byModel: { 'claude-opus-5': 1_000 } },
            { sessionId: 's2', session: 2_000, byModel: { 'claude-opus-5': 1_500, 'claude-sonnet-5': 500 } },
        ]);
        expect(tokenLedgerTotal(ledger)).toBe(3_000);
        expect(ledger.byModel).toEqual({ 'claude-opus-5': 2_500, 'claude-sonnet-5': 500 });
    });

    it('keeps the parts adding to the whole when the split is short of it', () => {
        // Claude Code's `<synthetic>` records name no model and the CLI leaves
        // them out of the split on purpose, so the leftover has to have a home
        // or the breakdown would not add up to the headline.
        const ledger = credit(emptyTokenLedger, [{
            sessionId: 's1',
            session: 1_018,
            byModel: { 'claude-opus-5': 1_000 },
        }]);
        expect(ledger.unattributed).toBe(18);
        expect(tokenLedgerTotal(ledger)).toBe(1_018);
    });

    it('banks the whole figure as unattributed on a CLI that publishes no split', () => {
        // DROVE-220: a session running now will not have the split until it
        // relaunches. Its spend still counts.
        const ledger = credit(emptyTokenLedger, [{ sessionId: 's1', session: 4_012_000 }]);
        expect(tokenLedgerTotal(ledger)).toBe(4_012_000);
        expect(ledger.byModel).toEqual({});
        expect(ledger.unattributed).toBe(4_012_000);
    });

    it('never lets the split exceed the total it came from', () => {
        const ledger = credit(emptyTokenLedger, [{
            sessionId: 's1',
            session: 500,
            byModel: { 'claude-opus-5': 900 },
        }]);
        expect(ledger.unattributed).toBe(0);
    });
});

describe('the account flip, which is the thing this must survive', () => {
    /**
     * Clay's evening: `main` -> `jamrizzi` -> `account-2`, one drover session
     * throughout. A flip carries the transcript into another account's config
     * dir, Claude Code rewrites its tail and the CLI re-seeds from the last
     * 2MB, so `liveStatus.tokens.session` FALLS. It is the same drover
     * session id the whole way: a flip changes `metadata.droverAccount`, not
     * `session.id`.
     */
    it('does not fall when the live figure falls, and does not re-count the tail', () => {
        let ledger = credit(emptyTokenLedger, [{
            sessionId: 'drove',
            session: 1_300_000,
            byModel: { 'claude-opus-5': 1_000_000, 'claude-fable-5': 300_000 },
        }]);
        expect(tokenLedgerTotal(ledger)).toBe(1_300_000);

        // FLIP ONE. The reader re-seeds; the figure comes back a fraction of
        // what it was, out of the same file.
        ledger = credit(ledger, [{
            sessionId: 'drove',
            session: 400_000,
            byModel: { 'claude-opus-5': 300_000, 'claude-fable-5': 100_000 },
        }]);
        expect(tokenLedgerTotal(ledger)).toBe(1_300_000);

        // It grows again on the new account, and only the growth is banked.
        ledger = credit(ledger, [{
            sessionId: 'drove',
            session: 600_000,
            byModel: { 'claude-opus-5': 450_000, 'claude-fable-5': 150_000 },
        }]);
        expect(tokenLedgerTotal(ledger)).toBe(1_500_000);

        // FLIP TWO, same shape. Still no fall and still no double count.
        ledger = credit(ledger, [{
            sessionId: 'drove',
            session: 50_000,
            byModel: { 'claude-opus-5': 50_000 },
        }]);
        expect(tokenLedgerTotal(ledger)).toBe(1_500_000);
        ledger = credit(ledger, [{
            sessionId: 'drove',
            session: 90_000,
            byModel: { 'claude-opus-5': 90_000 },
        }]);
        expect(tokenLedgerTotal(ledger)).toBe(1_540_000);
        // Opus all time: the first million, then the 150k it grew by on the
        // second account, then the 40k on the third. The two re-seeds in
        // between contributed nothing, which is the whole property.
        expect(ledger.byModel['claude-opus-5']).toBe(1_190_000);
        expect(ledger.byModel['claude-fable-5']).toBe(350_000);
    });

    it('only ever goes up, over a run of arbitrary sightings', () => {
        let ledger = emptyTokenLedger;
        let last = 0;
        const figures = [10, 40, 40, 5, 9, 200, 3, 3, 1_000, 999, 1_001];
        for (const session of figures) {
            ledger = credit(ledger, [{ sessionId: 'drove', session }]);
            const total = tokenLedgerTotal(ledger);
            expect(total, String(session)).toBeGreaterThanOrEqual(last);
            last = total;
        }
    });

    it('does not care which account the session is on, because it never asks', () => {
        // There is no account in the sighting. That is the design, not an
        // omission: the account is the one thing here that moves.
        const sighting = { sessionId: 'drove', session: 1_000 };
        expect(Object.keys(sighting)).not.toContain('account');
        expect(tokenLedgerTotal(credit(emptyTokenLedger, [sighting]))).toBe(1_000);
    });

    it('does not turn a model that vanishes from the split into leftover', () => {
        // A re-seeded tail can carry Opus and not name Fable at all. Fable's
        // 400 was banked under Fable and must stay there: counting only the
        // models in common would read the total as 300 short of its split and
        // credit that gap a second time under `unattributed`.
        let ledger = credit(emptyTokenLedger, [{
            sessionId: 'drove',
            session: 1_000,
            byModel: { 'claude-opus-5': 600, 'claude-fable-5': 400 },
        }]);
        ledger = credit(ledger, [{
            sessionId: 'drove',
            session: 700,
            byModel: { 'claude-opus-5': 700 },
        }]);
        expect(ledger.unattributed).toBe(0);
        expect(ledger.byModel).toEqual({ 'claude-opus-5': 700, 'claude-fable-5': 400 });
        // And the breakdown still adds to the headline.
        expect(tokenLedgerRows(ledger, 'Other').reduce((sum, r) => sum + r.tokens, 0))
            .toBe(tokenLedgerTotal(ledger));
    });
});

describe('the long press', () => {
    it('zeroes the number and stamps when', () => {
        const banked = credit(emptyTokenLedger, [{
            sessionId: 's1', session: 1_000, byModel: { 'claude-opus-5': 1_000 },
        }]);
        const reset = resetTokenLedger(banked, now);
        expect(tokenLedgerTotal(reset)).toBe(0);
        expect(reset.resetAt).toBe(now);
    });

    it('KEEPS THE MARKS, so the number does not bounce straight back', () => {
        // The failure this prevents: zero the marks too and the next socket
        // frame re-credits every live session's whole running total, so a
        // reset reads as not having worked at all.
        const banked = credit(emptyTokenLedger, [{
            sessionId: 's1', session: 1_000, byModel: { 'claude-opus-5': 1_000 },
        }]);
        const reset = resetTokenLedger(banked, now);
        const after = credit(reset, [{
            sessionId: 's1', session: 1_000, byModel: { 'claude-opus-5': 1_000 },
        }]);
        expect(tokenLedgerTotal(after)).toBe(0);
        // And it counts from here: the next 250 spent are the first 250.
        const grown = credit(after, [{
            sessionId: 's1', session: 1_250, byModel: { 'claude-opus-5': 1_250 },
        }]);
        expect(tokenLedgerTotal(grown)).toBe(250);
    });
});

describe('the breakdown a single press opens', () => {
    const ledger = credit(emptyTokenLedger, [{
        sessionId: 's1',
        session: 1_100,
        byModel: {
            'claude-opus-5': 600,
            'claude-fable-5': 300,
            'claude-haiku-4-5-20251001': 100,
        },
    }]);

    it('names models the way the composer pill does, dated ids included', () => {
        const rows = tokenLedgerRows(ledger, 'Other');
        expect(rows.map((r) => r.label)).toEqual(['Opus 5', 'Fable 5', 'Haiku 4.5', 'Other']);
    });

    it('is biggest first, with what named no model last', () => {
        const rows = tokenLedgerRows(ledger, 'Other');
        expect(rows.map((r) => r.tokens)).toEqual([600, 300, 100, 100]);
        expect(rows[rows.length - 1].model).toBe('');
    });

    it('adds up to the headline, which is the point of drawing it', () => {
        const rows = tokenLedgerRows(ledger, 'Other');
        expect(rows.reduce((sum, r) => sum + r.tokens, 0)).toBe(tokenLedgerTotal(ledger));
    });

    it('keeps an id this build cannot name rather than guessing at it', () => {
        const odd = credit(emptyTokenLedger, [{
            sessionId: 's1', session: 5, byModel: { 'claude-mythos-9': 5 },
        }]);
        expect(tokenLedgerRows(odd, 'Other')[0].label).toBe('claude-mythos-9');
    });

    it('draws no row for a model with nothing on it', () => {
        expect(tokenLedgerRows(emptyTokenLedger, 'Other')).toEqual([]);
    });
});

describe('the marks stay bounded', () => {
    it('evicts the oldest once past the cap, and keeps the newest', () => {
        let ledger = emptyTokenLedger;
        for (let i = 0; i < markCap + 40; i++) {
            ledger = credit(ledger, [{ sessionId: `s${i}`, session: 10 }], now + i);
        }
        expect(Object.keys(ledger.marks).length).toBe(markCap);
        expect(ledger.marks[`s${markCap + 39}`]).toBeDefined();
        expect(ledger.marks.s0).toBeUndefined();
        // Eviction is a mark, never a token: the total is untouched.
        expect(tokenLedgerTotal(ledger)).toBe((markCap + 40) * 10);
    });
});

describe('rubbish in', () => {
    it('ignores a sighting with no session id, a negative or a NaN', () => {
        const ledger = credit(emptyTokenLedger, [
            { sessionId: '', session: 100 },
            { sessionId: 's1', session: -5 },
            { sessionId: 's2', session: Number.NaN },
        ]);
        expect(tokenLedgerTotal(ledger)).toBe(0);
    });

    it('returns the SAME object when nothing moved, so React does not re-render', () => {
        const ledger = credit(emptyTokenLedger, [{ sessionId: 's1', session: 100 }]);
        expect(credit(ledger, [{ sessionId: 's1', session: 100 }])).toBe(ledger);
        expect(credit(ledger, [])).toBe(ledger);
    });
});
