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
    Pressable: host('Pressable'),
    StyleSheet: { hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                text: 'text',
                textSecondary: 'secondary',
                divider: 'divider',
                success: 'green',
                textLink: 'link',
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
import { ComposerSheetContext, useComposerSheetExit } from './composerSheetNavigation';

/**
 * ComposerSheet's wiring without its animation, so the bars can be pressed in
 * the place they are actually drawn (DROVE-183). The real shell would drag
 * reanimated and gesture-handler in, and neither survives vitest.
 */
function SheetShell(props: { onClose: () => void; children: React.ReactNode }) {
    const exit = useComposerSheetExit({ open: true, onClose: props.onClose });
    return React.createElement(
        'Shell',
        { onClosed: exit.onClosed },
        React.createElement(ComposerSheetContext.Provider, { value: exit.shell }, props.children),
    );
}

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
                    rows: [bar({ key: 'jamrizzi:five_hour', name: 'Session', fullName: 'Session' })],
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

/**
 * The blocks as the control, not only the readout (DROVE-160).
 *
 * Clay: "So this should let me change the account, flip the account, from
 * here." Tapping a block sends the session to that account, which puts a
 * one-tap teardown next to four other blocks in a column being read for
 * numbers. So these pin the three things that keep a mis-tap from happening:
 * the block in use is not a target, an account with no login is not a target,
 * and every block that IS one says so on its heading. The confirm that catches
 * the mis-tap anyway is in AgentInputStatusRow.
 */
describe('switching account from a block (DROVE-160)', () => {
    const groups = [
        {
            key: 'account:jamrizzi',
            title: 'jamrizzi · 51% left',
            active: true,
            account: 'jamrizzi',
            switchable: false,
            rows: [bar({ key: 'jamrizzi:five_hour', name: 'Session', fullName: 'Session' })],
        },
        {
            key: 'account:main',
            title: 'main · 20% left',
            account: 'main',
            switchable: true,
            rows: [bar({ key: 'main:five_hour', name: 'Session', fullName: 'Session' })],
        },
        {
            key: 'account:bitspur.com',
            title: 'bitspur.com · no login',
            account: 'bitspur.com',
            switchable: false,
            rows: [bar({ key: 'bitspur.com:five_hour', name: 'Session', fullName: 'Session', disabled: true })],
        },
    ];

    it('makes only the accounts that can take the session pressable', () => {
        const onSwitchAccount = vi.fn();
        const renderer = mount(React.createElement(UsageAccountBars, { width: 393, groups, onSwitchAccount }));
        const pressables = renderer.root.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(1);
        // One focusable element carrying what its three rows said, so a
        // screen reader is not left stepping past bars it cannot press.
        expect(pressables[0].props.accessible).toBe(true);
        expect(pressables[0].props.accessibilityRole).toBe('button');
        expect(pressables[0].props.accessibilityLabel)
            .toBe('Switch to main. main · 20% left. Session, 43%, Fable back Sep 2');
        act(() => {
            pressables[0].props.onPress();
        });
        expect(onSwitchAccount).toHaveBeenCalledWith('main');
    });

    it('says which block you are on and which will take you', () => {
        const renderer = mount(React.createElement(UsageAccountBars, {
            width: 393,
            groups,
            onSwitchAccount: () => {},
        }));
        const words = renderer.root.findAllByType('Text' as any)
            .map((node: any) => node.props.children)
            .filter((text: unknown) => text === 'current' || text === 'Switch ›');
        // One word per block, never both, and nothing at all on the account
        // that cannot take the session.
        expect(words).toEqual(['current', 'Switch ›']);
    });

    it('draws no affordance at all when nothing can be switched to', () => {
        const renderer = mount(React.createElement(UsageAccountBars, { width: 393, groups }));
        expect(renderer.root.findAllByType('Pressable' as any)).toHaveLength(0);
        const words = renderer.root.findAllByType('Text' as any)
            .map((node: any) => node.props.children)
            .filter((text: unknown) => text === 'Switch ›');
        expect(words).toEqual([]);
    });

    it('inside a sheet, closes it and confirms only once it has gone (DROVE-183)', () => {
        // The confirm is a system alert and cannot present over the sheet's
        // Modal while it is still sliding down, which is the same thing that
        // bit the Add context picker (DROVE-158). Note the test above: OUTSIDE
        // a sheet the very same block fires straight away.
        const order: string[] = [];
        let renderer: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(SheetShell, {
                onClose: () => order.push('close'),
                children: React.createElement(UsageAccountBars, {
                    width: 393,
                    groups,
                    onSwitchAccount: (account: string) => order.push(`switch:${account}`),
                }),
            }));
        });
        act(() => renderer!.root.findAllByType('Pressable' as any)[0].props.onPress());
        expect(order).toEqual(['close']);
        act(() => renderer!.root.findByType('Shell' as any).props.onClosed());
        expect(order).toEqual(['close', 'switch:main']);
    });
});

/**
 * The add row that ends the list (DROVE-208).
 *
 * Clay, on this exact sheet: "Where is the button for me to add an account."
 * The risk in answering it here is that the answer becomes a sixth account
 * with an empty bar, in a column whose whole job is that bar lengths are
 * comparable. So these pin the two halves: the row is present and says which
 * machine it adds to, and it is NOT a bar: no track, no number column, a rule
 * above it, and it does not change how many bars the sheet drew. Plus the
 * ordering, because it navigates and everything that navigates from a sheet
 * closes first (DROVE-183).
 */
describe('adding an account from the quota sheet (DROVE-208)', () => {
    const groups = [
        {
            key: 'account:jamrizzi',
            title: 'jamrizzi · 51% left',
            active: true,
            account: 'jamrizzi',
            rows: [bar({ key: 'jamrizzi:five_hour', name: 'Session', fullName: 'Session' })],
        },
        {
            key: 'account:main',
            title: 'main · 20% left',
            account: 'main',
            rows: [bar({ key: 'main:five_hour', name: 'Session', fullName: 'Session' })],
        },
    ];
    const addAccount = { machineName: 'drogon', onPress: () => {} };

    it('ends the list with one row that names the machine it adds to', () => {
        const renderer = mount(React.createElement(UsageAccountBars, {
            width: 393,
            groups,
            footer: 'Times in BST · headroom for Opus',
            addAccount,
        }));
        const words = texts(renderer);
        expect(words).toContain('Add an account');
        expect(words).toContain('on drogon ›');
        // Last, after the accounts and after the caption that explains their
        // numbers. The end of the list is where an add row belongs.
        expect(words.indexOf('Add an account')).toBeGreaterThan(words.indexOf('main · 20% left'));
        expect(words.indexOf('Add an account')).toBeGreaterThan(words.indexOf('Times in BST · headroom for Opus'));
    });

    it('sends a different machine to Settings → Accounts rather than growing a picker', () => {
        // A quota sheet is one session on one machine. The screen that lists
        // every machine already exists, and it is where this row goes anyway.
        const renderer = mount(React.createElement(UsageAccountBars, { width: 393, groups, addAccount }));
        expect(texts(renderer)).toContain('Other machines in Settings → Accounts');
    });

    it('is a row and not a sixth account: no track, no number, a rule above it', () => {
        const without = mount(React.createElement(UsageAccountBars, { width: 393, groups }));
        const with_ = mount(React.createElement(UsageAccountBars, { width: 393, groups, addAccount }));
        // The count of BARS is unchanged, so nothing was added to the column
        // being compared.
        expect(with_.root.findAllByType(UsageAccountBarRow as any))
            .toHaveLength(without.root.findAllByType(UsageAccountBarRow as any).length);
        const press = with_.root.findAllByType('Pressable' as any);
        expect(press).toHaveLength(1);
        const style = press[0].props.style({ pressed: false });
        expect(style.borderTopWidth).toBeGreaterThan(0);
        // One focusable element that says the whole thing, target included.
        expect(press[0].props.accessibilityRole).toBe('button');
        expect(press[0].props.accessibilityLabel)
            .toBe('Add a Claude account on drogon. Other machines in Settings, Accounts.');
    });

    it('draws nothing where there is no session behind the bars', () => {
        // The session info screen renders one account with no machine to name,
        // so it stays a readout.
        const renderer = mount(React.createElement(UsageAccountBars, { width: 393, groups }));
        expect(texts(renderer)).not.toContain('Add an account');
        expect(renderer.root.findAllByType('Pressable' as any)).toHaveLength(0);
    });

    it('closes the sheet and only then navigates (DROVE-183)', () => {
        const order: string[] = [];
        let renderer: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(SheetShell, {
                onClose: () => order.push('close'),
                children: React.createElement(UsageAccountBars, {
                    width: 393,
                    groups,
                    addAccount: { machineName: 'drogon', onPress: () => order.push('push') },
                }),
            }));
        });
        act(() => renderer!.root.findAllByType('Pressable' as any)[0].props.onPress());
        expect(order).toEqual(['close']);
        act(() => renderer!.root.findByType('Shell' as any).props.onClosed());
        expect(order).toEqual(['close', 'push']);
    });
});
