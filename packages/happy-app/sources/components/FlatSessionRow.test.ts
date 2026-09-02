/**
 * The flat session row, mounted (DROVE-398).
 *
 * sessionRowTrailingLayout.spec.ts holds the pure rule and the source; this
 * is the render. Clay's screenshot had two dots on one row, one of them 20pt
 * in the time's place, and "12:25 PM" cut to "12:25…" on the rows beside
 * it. So the assertions are counted, not described: exactly one dot in the
 * tree, its size, the slot it sits in, the stamp whole at the edge or the
 * edge empty, and the title line's order from the inside out.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionRowData } from '@/sync/storage';
import type { FlatSessionRowData } from '@/utils/flatSessionList';

const { host, theme, marks } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
    theme: {
        dark: false,
        colors: {
            text: 'text',
            textSecondary: 'secondary',
            divider: 'divider',
            surfaceSelected: 'selected',
            groupped: { background: 'page' },
            status: { error: 'error' },
        },
    },
    marks: { autoAccept: false, reading: 'off' as 'off' | 'reading' | 'yielded' | 'paused' },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: ({ ref: _ref, children, ...props }: any) => React.createElement('Swipeable', props, children),
}));

// The real StatusDot, so the dot in the tree is the dot the phone draws and
// its size is the one it declares. Only the animation is stubbed.
vi.mock('react-native-reanimated', () => ({
    default: { View: host('AnimatedView') },
    ReduceMotion: { System: 'system' },
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (build: () => unknown) => build(),
    useReducedMotion: () => false,
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme }),
    StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input), hairlineWidth: 1 },
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./Avatar', () => ({ Avatar: host('Avatar') }));
vi.mock('./HarnessGlyph', () => ({ HarnessGlyph: host('HarnessGlyph') }));
vi.mock('./SessionActionsPopover', () => ({ SessionActionsPopover: () => null }));
vi.mock('./ShortcutHints', () => ({ SessionShortcutHintBadge: () => null }));
vi.mock('./ShimmerText', () => ({ ShimmerText: host('ShimmerText') }));
vi.mock('./RigGitLineChanges', () => ({ RigGitLineChanges: () => null }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => () => {} }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionActionAlert: () => () => {} }));
vi.mock('@/hooks/useHappyAction', () => ({ useHappyAction: (action: () => Promise<void>) => [false, action] }));
vi.mock('@/hooks/useAutoAccept', () => ({ useAutoAccept: () => marks.autoAccept }));
vi.mock('@/hooks/useReadingState', () => ({ useReadingState: () => marks.reading }));
vi.mock('@/sync/ops', () => ({ sessionKill: async () => ({ success: true }) }));

import { FlatSessionRow } from './FlatSessionRow';
import { idleSessionDotFacts } from './sessionDot';
import { SESSION_ROW_INDICATOR_SLOT } from './sessionRowTrailingLayout';
import { statusDotColors } from './statusDotState';
import { SESSION_BLOCKED_ACCENT, SESSION_UNREAD_ACCENT } from '@/utils/flatSessionRowPresentation';
import { formatSessionListTimestamp, widestSessionListTimestamp } from '@/utils/sessionListTimestamp';

/** StatusDot's default: the size the strip and the card row draw. The badge was 20. */
const STANDARD_DOT = 6;
const NOW = new Date(2026, 8, 2, 12, 40).getTime();
const AN_HOUR_AGO = NOW - 60 * 60_000;
const PROJECT = 'cloud.corp.bitspur.com';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

afterEach(() => {
    marks.autoAccept = false;
    marks.reading = 'off';
});

function row(over: Partial<SessionRowData> = {}): FlatSessionRowData {
    return {
        session: {
            id: 'session-1',
            // Clay's third row: a title written by /rename or change_title.
            name: '[clayrisser24@gmail.com] cloud',
            subtitle: '',
            avatarId: 'avatar',
            flavor: 'claude',
            clientId: null,
            identityLine: null,
            providerKind: null,
            modelName: null,
            activitySummary: null,
            gitChangedFiles: null,
            gitCountsExact: false,
            gitDeletions: null,
            gitInsertions: null,
            state: 'waiting',
            dot: idleSessionDotFacts,
            createdAt: AN_HOUR_AGO,
            lastActivityAt: AN_HOUR_AGO,
            hasDraft: false,
            active: true,
            archived: false,
            machineId: 'machine',
            machineOffline: false,
            path: '/Users/clay/Projects/cloud',
            homeDir: '/Users/clay',
            completedTodosCount: 0,
            totalTodosCount: 0,
            hasUnread: false,
            projectId: null,
            projectName: null,
            workspaceId: null,
            workspaceName: null,
            ...over,
        },
        projectName: PROJECT,
        workspaceName: null,
    };
}

function mount(data: FlatSessionRowData, archived = false): any {
    let tree: any;
    act(() => {
        tree = create(React.createElement(FlatSessionRow, { row: data, archived }));
    });
    return tree.root;
}

function flat(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
    return style;
}

const isHost = (node: any) => typeof node.type === 'string';

/** The host-level children in render order, looking through component instances. */
function hostChildren(node: any): any[] {
    const out: any[] = [];
    for (const child of node.children) {
        if (typeof child === 'string') continue;
        if (isHost(child)) out.push(child);
        else out.push(...hostChildren(child));
    }
    return out;
}

function hostParent(node: any): any {
    let parent = node.parent;
    while (parent && !isHost(parent)) parent = parent.parent;
    return parent;
}

const dots = (root: any) => root.findAll((node: any) => node.type === 'AnimatedView');
const glyphs = (root: any) => root.findAll((node: any) => node.type === 'HarnessGlyph');
const cluster = (root: any) => {
    const found = glyphs(root);
    expect(found).toHaveLength(1);
    return hostParent(found[0]);
};
const titleRow = (root: any) => hostParent(cluster(root));
const strings = (node: any): string[] => node.children.flatMap((child: any) => (typeof child === 'string' ? [child] : strings(child)));

function expectOneStandardDot(root: any) {
    const found = dots(root);
    expect(found).toHaveLength(1);
    const style = flat(found[0].props.style);
    expect(style.width).toBe(STANDARD_DOT);
    expect(style.height).toBe(STANDARD_DOT);
    expect(style.width).toBeLessThan(SESSION_ROW_INDICATOR_SLOT);
    const slot = hostParent(found[0]);
    expect(flat(slot.props.style).width).toBe(SESSION_ROW_INDICATOR_SLOT);
    expect(flat(slot.props.style).height).toBe(SESSION_ROW_INDICATOR_SLOT);
    expect(hostParent(slot)).toBe(cluster(root));
    return found[0];
}

describe('the trailing end of a flat session row', () => {
    const stamp = formatSessionListTimestamp(AN_HOUR_AGO, NOW)!;

    it('draws glyph, one dot in the 18pt slot, then the time, and nothing after it', () => {
        const root = mount(row());
        expectOneStandardDot(root);
        const kids = hostChildren(cluster(root));
        expect(kids.map((kid) => kid.type)).toEqual(['HarnessGlyph', 'View', 'Text']);
        const time = kids[2];
        expect(strings(time)).toEqual([stamp]);
        expect(time.props.numberOfLines).toBe(1);
        expect(flat(time.props.style).color).toBe('secondary');
        expect(hostChildren(titleRow(root)).at(-1)).toBe(cluster(root));
    });

    // The no-timestamp row from the brief: one dot, the standard size, in
    // the slot, and the edge empty. Nothing is drawn in the time's place.
    it('a row with no time draws one dot in the slot and leaves the edge empty', () => {
        const root = mount(row({ lastActivityAt: 0 }));
        expectOneStandardDot(root);
        expect(hostChildren(cluster(root)).map((kid) => kid.type)).toEqual(['HarnessGlyph', 'View']);
        expect(hostChildren(titleRow(root)).at(-1)).toBe(cluster(root));
        expect(strings(titleRow(root))).toEqual(['[clayrisser24@gmail.com] cloud']);
    });

    // Clay's third row. Unread used to be a 20pt disc in the time's column.
    it('unread tints the time blue and grows no second mark', () => {
        const root = mount(row({ hasUnread: true }));
        expectOneStandardDot(root);
        expect(dots(root).map((dot: any) => flat(dot.props.style).width)).toEqual([STANDARD_DOT]);
        const kids = hostChildren(cluster(root));
        expect(kids.map((kid) => kid.type)).toEqual(['HarnessGlyph', 'View', 'Text']);
        expect(strings(kids[2])).toEqual([stamp]);
        expect(flat(kids[2].props.style).color).toBe(SESSION_UNREAD_ACCENT);
        expect(kids[2].props.accessibilityLabel).toBe('status.unread');
    });

    it('a gate tints the time amber, and the one dot is the strip\'s amber too', () => {
        const root = mount(row({ state: 'permission_required', dot: { ...idleSessionDotFacts, waiting: true } }));
        const dot = expectOneStandardDot(root);
        expect(flat(dot.props.style).backgroundColor).toBe(statusDotColors.waiting);
        const time = hostChildren(cluster(root))[2];
        expect(strings(time)).toEqual([stamp]);
        expect(flat(time.props.style).color).toBe(SESSION_BLOCKED_ACCENT);
        expect(time.props.accessibilityLabel).toBe('status.permissionRequired');
    });

    it('unread with no time grows nothing at all', () => {
        const root = mount(row({ hasUnread: true, lastActivityAt: 0 }));
        expectOneStandardDot(root);
        expect(hostChildren(cluster(root)).map((kid) => kid.type)).toEqual(['HarnessGlyph', 'View']);
        const accented = root.findAll((node: any) => node.type === 'Text' && flat(node.props.style).color === SESSION_UNREAD_ACCENT);
        expect(accented).toHaveLength(0);
    });

    // "why are the times getting cut off": the widest stamp reaches its label
    // whole, the label cannot shrink or be boxed, nothing between it and the
    // title line can either, and the title is the only child that gives.
    it('the widest stamp reaches the label whole, and nothing between it and the row can clip it', () => {
        const widest = widestSessionListTimestamp(NOW);
        const root = mount(row({ lastActivityAt: widest.at }));
        const time = hostChildren(cluster(root))[2];
        expect(strings(time)).toEqual([widest.text]);
        expect(time.props.numberOfLines).toBe(1);

        const line = titleRow(root);
        for (let node = time; node !== line; node = hostParent(node)) {
            const style = flat(node.props.style);
            expect(style, node.type).not.toHaveProperty('width');
            expect(style, node.type).not.toHaveProperty('maxWidth');
            expect(style, node.type).not.toHaveProperty('flex');
            expect(style.flexShrink ?? 0, node.type).toBe(0);
        }
        expect(flat(line.props.style)).not.toHaveProperty('width');

        const kids = hostChildren(line);
        const giving = kids.filter((kid) => {
            const style = flat(kid.props.style);
            return (style.flex ?? 0) > 0 || (style.flexShrink ?? 0) > 0;
        });
        expect(giving).toHaveLength(1);
        expect(giving[0]).toBe(kids[0]);
        expect(flat(kids[0].props.style).minWidth).toBe(0);
        expect(strings(kids[0])).toEqual(['[clayrisser24@gmail.com] cloud']);
    });

    // "have the status and the other symbols all on the same row", inside out.
    it('with the bolt and the speaker up, the title line reads title, bolt, speaker, glyph, dot, time', () => {
        marks.autoAccept = true;
        marks.reading = 'reading';
        const root = mount(row());
        const kids = hostChildren(titleRow(root));
        expect(kids.map((kid) => kid.type)).toEqual(['View', 'Ionicons', 'View', 'View']);
        expect(kids[1].props.name).toBe('flash');
        expect(hostChildren(kids[2]).map((kid) => kid.props.name)).toEqual(['volume-high']);
        expect(kids[3]).toBe(cluster(root));
        expect(hostChildren(cluster(root)).map((kid) => kid.type)).toEqual(['HarnessGlyph', 'View', 'Text']);
    });

    it('the project line carries the project name and nothing trailing', () => {
        const root = mount(row());
        const project = root.findAll((node: any) => node.type === 'Text' && strings(node).join('') === PROJECT);
        expect(project).toHaveLength(1);
        const column = hostParent(project[0]);
        expect(flat(column.props.style).flexDirection).toBeUndefined();
        expect(column).toBe(hostParent(titleRow(root)));
        expect(glyphs(root)).toHaveLength(1);
        expect(dots(root)).toHaveLength(1);
    });

    it('retired work draws the glyph and the time and no dot', () => {
        const root = mount(row({ archived: true }), true);
        expect(dots(root)).toHaveLength(0);
        const kids = hostChildren(cluster(root));
        expect(kids.map((kid) => kid.type)).toEqual(['HarnessGlyph', 'Text']);
        expect(strings(kids[1])).toEqual([stamp]);
    });
});
