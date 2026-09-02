/**
 * DROVE-393. Clay, across the empty middle of each project-card row: "put an
 * icon of the harness for each session." And on the flat list: "where's the
 * little status."
 *
 * DROVE-398, zoomed on four flat rows: "why are the times getting cut off",
 * "why the fuck did the dot get so big", "have the status and the other
 * symbols all on the same row."
 *
 * What a spec can hold: the glyph resolves for every harness the real catalog
 * names, the indicator rule is DROVE-243's and nothing else, the time is
 * drawn verbatim at its own width or not at all, and both session rows draw
 * the whole trailing end on the title line through the one component, glyph
 * then slot then time. FlatSessionRow.test.ts mounts the flat row and holds
 * the rendered tree to the same.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_NAMES, HARNESS_ORDER, NON_SPAWNABLE_HARNESS_NAMES, RETIRED_HARNESSES } from '@/utils/harnessCatalog';
import { formatSessionListTimestamp, widestSessionListTimestamp } from '@/utils/sessionListTimestamp';
import {
    SESSION_ROW_GLYPH_SIZE,
    SESSION_ROW_INDICATOR_SLOT,
    SESSION_ROW_TIME_STYLE,
    resolveSessionRowTrailing,
    sessionRowTime,
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

describe('the time at the edge (DROVE-398)', () => {
    const now = new Date(2026, 8, 2, 12, 40).getTime();
    const stamp = formatSessionListTimestamp(now - 15 * 60_000, now)!;

    // Clay's third row: a session with something to say and, as the layout
    // had it, no time on its title line. There is exactly one place on the
    // row for a mark and it is the slot; the edge is the time's or empty.
    it('a row with no timestamp draws one dot in the slot and nothing at the edge', () => {
        const layout = resolveSessionRowTrailing({ flavor: 'claude', clientId: null, dotState: 'connected', hasDraft: false, timestamp: null });
        expect(layout).toEqual({ harness: 'claude', indicator: 'dot', time: null });
        expect(Object.keys(layout)).toEqual(['harness', 'indicator', 'time']);
        expect(SESSION_ROW_INDICATOR_SLOT).toBe(18);
    });

    it('a row whose stamp is missing altogether reads the same as one handed null', () => {
        expect(resolveSessionRowTrailing({ flavor: 'claude', clientId: null, ...connected }).time).toBeNull();
        expect(sessionRowTime(undefined)).toBeNull();
        expect(sessionRowTime('')).toBeNull();
    });

    it('a row with a timestamp draws it verbatim after the slot', () => {
        const layout = resolveSessionRowTrailing({ flavor: 'claude', clientId: null, dotState: 'connected', hasDraft: false, timestamp: stamp });
        expect(layout.time).toBe(stamp);
        expect(layout.indicator).toBe('dot');
    });

    it('a gated row is one amber dot and the time, not a second mark', () => {
        const layout = resolveSessionRowTrailing({ flavor: 'claude', clientId: null, dotState: 'waiting', hasDraft: false, timestamp: stamp });
        expect(layout).toEqual({ harness: 'claude', indicator: 'dot', time: stamp });
    });

    // "why are the times getting cut off": 12:25 PM was living in a 56pt
    // column and losing its suffix. The widest stamp the formatter makes
    // goes through untouched, and the label's layout gives it nowhere to be
    // clipped: no width, no maxWidth, no flex, and it never shrinks.
    it('the widest stamp the formatter produces reaches the label whole', () => {
        const widest = widestSessionListTimestamp(now);
        expect(widest.text.length).toBeGreaterThanOrEqual(stamp.length);
        const layout = resolveSessionRowTrailing({ flavor: 'claude', clientId: null, dotState: 'connected', hasDraft: false, timestamp: widest.text });
        expect(layout.time).toBe(widest.text);
    });

    it('the label has its own width and no box to be cut to', () => {
        expect(SESSION_ROW_TIME_STYLE.flexShrink).toBe(0);
        expect(SESSION_ROW_TIME_STYLE).not.toHaveProperty('width');
        expect(SESSION_ROW_TIME_STYLE).not.toHaveProperty('maxWidth');
        expect(SESSION_ROW_TIME_STYLE).not.toHaveProperty('flex');
        expect(SESSION_ROW_TIME_STYLE).not.toHaveProperty('flexBasis');
        expect(SESSION_ROW_TIME_STYLE.fontVariant).toEqual(['tabular-nums']);
    });
});

describe('both session rows draw the trailing end through one component, on the title line', () => {
    const cardRow = readFileSync(join(__dirname, 'ActiveSessionsGroupCompact.tsx'), 'utf8');
    const flatRow = readFileSync(join(__dirname, 'FlatSessionRow.tsx'), 'utf8');
    const shared = readFileSync(join(__dirname, 'SessionRowTrailing.tsx'), 'utf8');
    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    it('the card row and the flat row each render SessionRowTrailing exactly once', () => {
        expect(occurrences(cardRow, '<SessionRowTrailing')).toBe(1);
        expect(occurrences(flatRow, '<SessionRowTrailing')).toBe(1);
    });

    // "have the status and the other symbols all on the same row": from the
    // inside out, the bolt, the reading speaker, then the shared cluster, all
    // before the project line is reached.
    it('the flat row puts it on the title line after the bolt and the reading mark, and nothing trails on the project line', () => {
        const bolt = flatRow.indexOf('name={AUTO_ACCEPT_GLYPH_ON}');
        const reading = flatRow.indexOf('{readingMark && (');
        const trailing = flatRow.indexOf('<SessionRowTrailing');
        const project = flatRow.indexOf('{projectName}');
        expect(bolt).toBeGreaterThan(-1);
        expect(reading).toBeGreaterThan(bolt);
        expect(trailing).toBeGreaterThan(reading);
        expect(project).toBeGreaterThan(trailing);
        expect(flatRow).not.toContain('projectRow');
    });

    it('the flat row hands the cluster its time and never draws a dot or a time column of its own', () => {
        expect(flatRow).toContain('time={time}');
        expect(flatRow).not.toContain('<StatusDot');
        expect(flatRow).not.toContain('TOP_RIGHT');
        expect(flatRow).not.toContain('topRight');
        expect(flatRow).not.toContain('timestamp:');
    });

    it('the flat row withholds the dot from retired work and never swaps it for the pencil it draws elsewhere', () => {
        expect(flatRow).toContain('dot={archived ? null : session.dot}');
        expect(flatRow).toContain('hasDraft={false}');
    });

    it('the card row hands the slot its draft, so the DROVE-243 pencil survives the move', () => {
        expect(cardRow).toContain('dot={session.dot}');
        expect(cardRow).toContain('hasDraft={session.hasDraft}');
        expect(cardRow).not.toContain('<StatusDot');
    });

    it('neither row resolves its own dot', () => {
        expect(cardRow).not.toContain('useSessionRowDot');
        expect(flatRow).not.toContain('useSessionRowDot');
        expect(shared).toContain('useSessionRowDot(');
    });

    it('draws the glyph, then the indicator slot, then the time, so a row reads title, glyph, dot, time', () => {
        const glyph = shared.indexOf('<HarnessGlyph');
        const slot = shared.indexOf('<SessionRowIndicatorSlot');
        const time = shared.indexOf('{stamp}');
        expect(glyph).toBeGreaterThan(-1);
        expect(slot).toBeGreaterThan(glyph);
        expect(time).toBeGreaterThan(slot);
        expect(occurrences(shared, '<StatusDot')).toBe(1);
    });

    it('draws the time with the layout module\'s style and no other width', () => {
        expect(shared).toContain('...SESSION_ROW_TIME_STYLE');
        expect(shared).not.toMatch(/time:\s*\{[^}]*\bwidth\b/);
        expect(shared).not.toMatch(/time:\s*\{[^}]*\bmaxWidth\b/);
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
