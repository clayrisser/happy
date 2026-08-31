/**
 * The quota popup's columns, measured (DROVE-117).
 *
 * The bars are only worth drawing if two rows at the same headroom draw the
 * same length. DROVE-107's first cut let the track take whatever the trailing
 * reset text did not use, so on Clay's screenshot `jamrizzi` (no reset time)
 * had a visibly wider bar than `bitspur.com` at a similar figure, and `main`
 * (no percentage) left a hole where the number column should be. Bar length
 * then meant headroom OR how much trailing text the row happened to carry,
 * which is the one thing a column of bars must never mean.
 *
 * So these pin the arithmetic and, more to the point, the four ways a field
 * can be absent: no percentage, no trailing time, neither, and a name long
 * enough to truncate. In every one of them the track keeps the same width and
 * the same x, and the missing figure renders a dash rather than nothing.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { host } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Text: host('Text'),
    View: host('View'),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                text: 'text',
                textSecondary: 'secondary',
                divider: 'divider',
                success: 'green',
                warningCritical: 'critical',
            },
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));

// The real English strings, without expo-localization behind them.
vi.mock('@/text', async () => {
    const { en } = await import('@/text/_default');
    return {
        t: (key: string, params?: Record<string, unknown>) => {
            const value = key.split('.').reduce<any>((node, part) => node?.[part], en);
            if (typeof value === 'function') return value(params);
            if (typeof value === 'string') return value;
            throw new Error(`no translation for ${key}`);
        },
    };
});

import {
    truncateUsageName,
    usageBarColumns,
    usageBarFixedWidth,
    usageBarMissingPercent,
    usageBarNameLimit,
    usageBarPercentLabel,
    usageBarTrackWidth,
    type UsageBarRow,
} from './agentInputUsage';
import { UsageAccountBarRow, UsageAccountBars, usageBarFallbackWidth } from './UsageAccountBars';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

function mount(element: React.ReactElement) {
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(element);
    });
    return renderer!;
}

function bar(overrides: Partial<UsageBarRow> = {}): UsageBarRow {
    return {
        key: 'account:bitspur.com',
        name: 'bitspur.com',
        fullName: 'bitspur.com',
        nameTruncated: false,
        fraction: 0.43,
        percentText: '43%',
        trailing: 'Fable back Sep 2',
        tone: 'ample',
        disabled: false,
        ...overrides,
    };
}

/** Name, track, percent and trailing widths, in render order, for one row. */
function widths(renderer: ReturnType<typeof create>): number[] {
    const row = renderer.root.findAll(
        (node: any) => node.type === 'View' && node.props.accessible === true,
    )[0];
    return row.children
        .filter((child: any) => typeof child !== 'string')
        .map((child: any) => child.props.style.width);
}

function texts(renderer: ReturnType<typeof create>): string[] {
    return renderer.root.findAllByType('Text' as any).map((node: any) => String(node.props.children));
}

describe('usage bar column arithmetic', () => {
    it('spends the row on four columns and three gaps, and gives the rest to the track', () => {
        expect(usageBarFixedWidth).toBe(
            usageBarColumns.horizontalPadding * 2
            + usageBarColumns.name
            + usageBarColumns.percent
            + usageBarColumns.trailing
            + usageBarColumns.gap * 3,
        );
        // 32 padding + 80 name + 34 percent + 88 trailing + 24 gaps.
        expect(usageBarFixedWidth).toBe(258);
    });

    it('leaves a readable track on the 393pt phone DROVE-107 sized this for', () => {
        expect(usageBarTrackWidth(393)).toBe(393 - usageBarFixedWidth);
        expect(usageBarTrackWidth(393)).toBeGreaterThan(usageBarColumns.minTrack);
        // The sheet is inset from the screen; still a track, not a stub.
        expect(usageBarTrackWidth(usageBarFallbackWidth)).toBeGreaterThan(usageBarColumns.minTrack);
    });

    it('never collapses the track, however narrow the container or bad the measurement', () => {
        expect(usageBarTrackWidth(120)).toBe(usageBarColumns.minTrack);
        expect(usageBarTrackWidth(0)).toBe(usageBarColumns.minTrack);
        expect(usageBarTrackWidth(Number.NaN)).toBe(usageBarColumns.minTrack);
    });

    it('prints a dash for a figure that was never measured', () => {
        expect(usageBarPercentLabel('43%')).toBe('43%');
        expect(usageBarPercentLabel(null)).toBe(usageBarMissingPercent);
        expect(usageBarPercentLabel('')).toBe(usageBarMissingPercent);
    });
});

describe('UsageAccountBarRow holds its columns when a field is absent', () => {
    const track = usageBarTrackWidth(393);
    const full = mount(React.createElement(UsageAccountBarRow, { row: bar(), trackWidth: track }));
    const expected = [
        usageBarColumns.name,
        track,
        usageBarColumns.percent,
        usageBarColumns.trailing,
    ];

    it('lays a complete row out as name, track, percent, trailing', () => {
        expect(widths(full)).toEqual(expected);
        expect(texts(full)).toEqual(['bitspur.com', '43%', 'Fable back Sep 2']);
    });

    it('keeps the track and shows a dash when the row has no percentage', () => {
        // `main` on the screenshot: a bar and no figure at all.
        const renderer = mount(React.createElement(UsageAccountBarRow, {
            row: bar({ name: 'main', fullName: 'main', percentText: null, fraction: 0, tone: 'critical' }),
            trackWidth: track,
        }));
        expect(widths(renderer)).toEqual(expected);
        expect(texts(renderer)).toEqual(['main', usageBarMissingPercent, 'Fable back Sep 2']);
    });

    it('keeps the track when the row has no trailing time', () => {
        // `jamrizzi` on the screenshot: the row whose bar ran long because the
        // trailing slot was empty and the track took the space.
        const renderer = mount(React.createElement(UsageAccountBarRow, {
            row: bar({ name: 'jamrizzi', fullName: 'jamrizzi', trailing: '' }),
            trackWidth: track,
        }));
        expect(widths(renderer)).toEqual(expected);
        expect(texts(renderer)).toEqual(['jamrizzi', '43%', '']);
    });

    it('keeps the track when the row has neither', () => {
        const renderer = mount(React.createElement(UsageAccountBarRow, {
            row: bar({ percentText: null, trailing: '', fraction: 0, tone: 'unknown' }),
            trackWidth: track,
        }));
        expect(widths(renderer)).toEqual(expected);
        expect(texts(renderer)).toEqual(['bitspur.com', usageBarMissingPercent, '']);
    });

    it('truncates a long name inside its column instead of moving the track', () => {
        const long = 'risserproperties';
        const cut = truncateUsageName(long);
        expect(cut.truncated).toBe(true);
        expect(cut.name).toHaveLength(usageBarNameLimit);
        const renderer = mount(React.createElement(UsageAccountBarRow, {
            row: bar({ key: 'account:risserproperties', name: cut.name, fullName: long, nameTruncated: true }),
            trackWidth: track,
        }));
        expect(widths(renderer)).toEqual(expected);
        expect(texts(renderer)[0]).toBe(cut.name);
        // The whole name survives for VoiceOver even though the column cut it.
        expect(renderer.root.findByProps({ accessible: true }).props.accessibilityLabel)
            .toBe('risserproperties, 43%, Fable back Sep 2');
    });

    it('gives every row in a sheet the same track, measured once for all of them', () => {
        const renderer = mount(React.createElement(UsageAccountBars, {
            width: 393,
            groups: [
                {
                    key: 'account:jamrizzi',
                    title: 'jamrizzi · 51% left',
                    active: true,
                    rows: [bar({ key: 'jamrizzi:five_hour', name: 'Session' })],
                },
                {
                    key: 'account:main',
                    title: 'main · 0% left',
                    rows: [
                        bar({ key: 'main:five_hour', name: 'Session', percentText: null, trailing: 'Back Sep 3' }),
                        bar({ key: 'main:seven_day', name: 'Week', trailing: '' }),
                    ],
                },
            ],
        }));
        const rows = renderer.root.findAllByType(UsageAccountBarRow as any);
        expect(rows).toHaveLength(3);
        expect(rows.map((node: any) => node.props.trackWidth)).toEqual([track, track, track]);
        // Each block is headed by its own account (DROVE-148); nothing heads
        // the list itself (DROVE-117).
        expect(texts(renderer)).toContain('jamrizzi · 51% left');
        expect(texts(renderer)).toContain('main · 0% left');
        expect(texts(renderer)).not.toContain('Other accounts');
    });
});

/**
 * Five accounts times three bars, the shape DROVE-148 asks the sheet to hold.
 * The risk in giving every account all three measures is that the sheet stops
 * being a column: one block drops a row it has no figure for, the next one's
 * Week lines up with someone's Fable week, and comparing down it stops meaning
 * anything. So these count the rows, pin the track and the columns across all
 * fifteen, and check that the only difference for the current account is a dot.
 */
describe('the sheet at five accounts times three bars (DROVE-148)', () => {
    const track = usageBarTrackWidth(393);
    const names = ['promanagerdevteam@gmail.com', 'main', 'jamrizzi', 'bitspur.com', 'risserproperties'];
    const measures = ['Session', 'Week', 'Fable week'];
    const groups = names.map((name, index) => ({
        key: `account:${name}`,
        title: `${name} · ${index * 20}% left`,
        active: index === 0,
        rows: measures.map((measure, m) => bar({
            key: `${name}:${m}`,
            name: measure,
            fullName: measure,
            // The middle account has no Fable limit, the case that used to
            // tempt a dropped row.
            percentText: index === 1 && m === 2 ? null : '43%',
            trailing: index === 1 && m === 2 ? '' : 'Resets Sep 5',
        })),
    }));
    const renderer = mount(React.createElement(UsageAccountBars, { width: 393, groups }));

    it('draws all fifteen rows on one track width', () => {
        const rows = renderer.root.findAllByType(UsageAccountBarRow as any);
        expect(rows).toHaveLength(15);
        expect(new Set(rows.map((node: any) => node.props.trackWidth))).toEqual(new Set([track]));
        // Every column keeps its width in all fifteen, missing figure or not.
        expect(widths(renderer)).toEqual([usageBarColumns.name, track, usageBarColumns.percent, usageBarColumns.trailing]);
    });

    it('marks the account the session is on rather than reshaping its rows', () => {
        // One dot, on the first block. It is the only difference between the
        // current account's block and anyone else's.
        const dots = renderer.root.findAll((node: any) => node.type === 'View'
            && node.props.style?.width === 5
            && node.props.style?.backgroundColor === 'text');
        expect(dots).toHaveLength(1);
        const heads = renderer.root.findAllByType('Text' as any)
            .filter((node: any) => String(node.props.children).includes('%')
                && String(node.props.children).includes('·'));
        expect(heads.map((node: any) => node.props.style.color))
            .toEqual(['text', 'secondary', 'secondary', 'secondary', 'secondary']);
    });

    it('holds a long account name on one line so it cannot push the bars around', () => {
        const head = renderer.root.findAllByType('Text' as any)
            .find((node: any) => String(node.props.children).startsWith('promanagerdevteam'));
        expect(head.props.numberOfLines).toBe(1);
        expect(head.props.ellipsizeMode).toBe('tail');
        // Shrinks inside the heading row instead of widening it.
        expect(head.props.style.flexShrink).toBe(1);
    });
});
