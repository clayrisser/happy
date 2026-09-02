/**
 * DROVE-393. Clay, across the empty middle of each project-card row: "put an
 * icon of the harness for each session." And on the flat list: "where's the
 * little status."
 *
 * What a spec can hold: the glyph resolves for every harness the real catalog
 * names, the indicator rule is DROVE-243's and nothing else, and both session
 * rows draw the end of the row through the one component, glyph first.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_NAMES, HARNESS_ORDER, NON_SPAWNABLE_HARNESS_NAMES, RETIRED_HARNESSES } from '@/utils/harnessCatalog';
import {
    SESSION_ROW_GLYPH_SIZE,
    SESSION_ROW_INDICATOR_SLOT,
    resolveSessionRowTrailing,
} from './sessionRowTrailingLayout';

const connected = { dotState: 'connected' as const, hasDraft: false };

describe('the glyph on a session row', () => {
    it('resolves for every harness the picker can start, from the real catalog', () => {
        for (const key of HARNESS_ORDER) {
            const trailing = resolveSessionRowTrailing({
                flavor: key,
                clientId: key === 'rig' ? 'rig' : null,
                ...connected,
            });
            expect(trailing.harness, key).toBe(key);
        }
    });

    // Retirement is about STARTING a session (harnessCatalog.ts). A session
    // that exists still says what it is, on the row as in the avatar badge.
    it('resolves for a retired harness too', () => {
        for (const key of RETIRED_HARNESSES) {
            expect(resolveSessionRowTrailing({ flavor: key, clientId: null, ...connected }).harness, key).toBe(key);
        }
    });

    it('leaves no catalog entry without a glyph, spawnable or not', () => {
        for (const key of [...Object.keys(HARNESS_NAMES), ...Object.keys(NON_SPAWNABLE_HARNESS_NAMES)]) {
            const trailing = resolveSessionRowTrailing({
                flavor: key,
                clientId: key === 'rig' ? 'rig' : null,
                ...connected,
            });
            expect(trailing.harness, key).not.toBeNull();
        }
    });

    // The promanager session Clay pointed at was a `drover cursor` pane, and
    // a `drover opencode` pane is the other harness that had no mark at all.
    it('draws cursor, openclaw and opencode, which had none before', () => {
        expect(resolveSessionRowTrailing({ flavor: 'cursor', clientId: null, ...connected }).harness).toBe('cursor');
        expect(resolveSessionRowTrailing({ flavor: 'openclaw', clientId: null, ...connected }).harness).toBe('openclaw');
        expect(resolveSessionRowTrailing({ flavor: 'opencode', clientId: null, ...connected }).harness).toBe('opencode');
    });

    it('is Cattle Drover for a Rig client whatever provider it runs', () => {
        expect(resolveSessionRowTrailing({ flavor: 'codex', clientId: 'rig', ...connected }).harness).toBe('rig');
    });

    it('draws nothing for a flavor with no mark, rather than guessing', () => {
        expect(resolveSessionRowTrailing({ flavor: 'acp', clientId: null, ...connected }).harness).toBeNull();
        expect(resolveSessionRowTrailing({ flavor: null, clientId: null, ...connected }).harness).toBeNull();
    });
});

describe('the indicator beside it', () => {
    it('is the pencil only on an idle, connected session with a draft (DROVE-243)', () => {
        expect(resolveSessionRowTrailing({ flavor: 'claude', clientId: null, dotState: 'connected', hasDraft: true }).indicator).toBe('draft');
        expect(resolveSessionRowTrailing({ flavor: 'claude', clientId: null, dotState: 'connected', hasDraft: false }).indicator).toBe('dot');
    });

    it('is the dot everywhere else, because the dot is what says the session dropped', () => {
        for (const dotState of ['working', 'compacting', 'waiting', 'recentlyDisconnected', 'disconnected'] as const) {
            expect(resolveSessionRowTrailing({ flavor: 'claude', clientId: null, dotState, hasDraft: true }).indicator, dotState).toBe('dot');
        }
    });

    // The flat list shows archived sessions; a dot there could only ever be
    // red, on every one. The glyph stays: what the session was is still true.
    it('is nothing on retired work, and the glyph is still drawn', () => {
        const retired = resolveSessionRowTrailing({ flavor: 'cursor', clientId: null, dotState: null, hasDraft: true });
        expect(retired.indicator).toBe('none');
        expect(retired.harness).toBe('cursor');
    });
});

describe('both session rows draw the trailing cluster through one component', () => {
    const cardRow = readFileSync(join(__dirname, 'ActiveSessionsGroupCompact.tsx'), 'utf8');
    const flatRow = readFileSync(join(__dirname, 'FlatSessionRow.tsx'), 'utf8');
    const shared = readFileSync(join(__dirname, 'SessionRowTrailing.tsx'), 'utf8');

    it('the card row and the flat row both render SessionRowTrailing', () => {
        expect(cardRow).toContain('<SessionRowTrailing');
        expect(flatRow).toContain('<SessionRowTrailing');
    });

    it('the flat row withholds the dot from retired work and never swaps it for the pencil it draws elsewhere', () => {
        expect(flatRow).toContain('dot={archived ? null : session.dot}');
        expect(flatRow).toContain('hasDraft={false}');
    });

    it('the card row hands the slot its draft, so the DROVE-243 pencil survives the move', () => {
        expect(cardRow).toContain('dot={session.dot}');
        expect(cardRow).toContain('hasDraft={session.hasDraft}');
    });

    it('neither row resolves its own dot', () => {
        expect(cardRow).not.toContain('useSessionRowDot');
        expect(flatRow).not.toContain('useSessionRowDot');
        expect(shared).toContain('useSessionRowDot(');
    });

    it('draws the glyph before the indicator slot, so a row reads title, glyph, dot', () => {
        const glyph = shared.indexOf('<HarnessGlyph');
        const slot = shared.indexOf('<SessionRowIndicatorSlot');
        expect(glyph).toBeGreaterThan(-1);
        expect(slot).toBeGreaterThan(glyph);
    });

    it('draws the badge from the same marks as the row, so the two cannot disagree', () => {
        const avatar = readFileSync(join(__dirname, 'Avatar.tsx'), 'utf8');
        expect(avatar).toContain('<HarnessGlyph');
        expect(avatar).not.toContain("require('@/assets/images/icon-");
    });

    it('keeps the card row slot geometry and fits the glyph inside it', () => {
        expect(SESSION_ROW_INDICATOR_SLOT).toBe(18);
        expect(SESSION_ROW_GLYPH_SIZE).toBeLessThan(SESSION_ROW_INDICATOR_SLOT);
    });
});
