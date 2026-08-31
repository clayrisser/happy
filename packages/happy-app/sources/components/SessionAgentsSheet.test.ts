/**
 * The agents sheet, and what a tap on a row does (DROVE-183).
 *
 * Clay, twice: "when I open a subagent it should close the sheet", then "when
 * I click on a background work item or whatever from the sheet, the sheet
 * doesn't close". This is that case end to end: the real sheet content, the
 * real live status rows, the real exit, and the push asserted to land AFTER
 * the Modal has gone rather than over a sheet still sliding down.
 *
 * Nested agents (DROVE-185) need nothing here: a child row is the same
 * LiveStatusTreeRow rendered deeper in the same tree, so it inherits the rule
 * from the context rather than from a second call site.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { host, pushed, theme } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
    pushed: [] as unknown[],
    theme: {
        dark: false,
        colors: { text: 'text', textSecondary: 'secondary', divider: 'divider' },
    },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
}));

vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));

vi.mock('@expo/vector-icons', () => ({ Octicons: host('Octicons') }));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: (target: unknown) => pushed.push(target) }),
}));

// The tool rows read the reducer's tool -> message index. Everything in this
// spec is an AGENT row, which does not use it, so an empty store is enough.
vi.mock('@/sync/storage', () => ({ storage: (select: any) => select({ sessionMessages: {} }) }));
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: any) => fn }));

// The shell pulls in gesture-handler and reanimated, neither of which vitest
// can transform. This double is the part the rows depend on: the REAL exit
// (DROVE-183) on the real context, with its onClosed on the host element so a
// test can say "and now the Modal has gone".
vi.mock('./ComposerSheet', async () => {
    const react = await import('react');
    const { ComposerSheetContext, useComposerSheetExit } = await import('./composerSheetNavigation');
    return {
        ComposerSheet: (props: any) => {
            const exit = useComposerSheetExit({
                open: props.open,
                onClose: props.onClose,
                onClosed: props.onClosed,
            });
            return react.createElement(
                'ComposerSheet',
                { ...props, onClosed: exit.onClosed },
                react.createElement(
                    ComposerSheetContext.Provider,
                    { value: exit.shell },
                    props.children,
                ),
            );
        },
    };
});

import { SessionAgentsSheet } from './SessionAgentsSheet';
import type { LiveStatusSummary } from '@/utils/liveStatus';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

const summary = {
    headline: '2 agents',
    main: null,
    sideCount: 2,
    rows: [
        { key: 'a', kind: 'agent', title: 'DROVE-183', detail: null, elapsed: '1m 2s', tokens: '12k', progress: null, agentId: 'agent-1' },
        { key: 'b', kind: 'agent', title: 'DROVE-185', detail: null, elapsed: '4s', tokens: null, progress: null, agentId: 'agent-2' },
    ],
} as unknown as LiveStatusSummary;

function mount(onClose: () => void, override: Partial<LiveStatusSummary> = {}) {
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(React.createElement(SessionAgentsSheet, {
            sessionId: 'session-1',
            summary: { ...summary, ...override },
            open: true,
            onClose,
        }));
    });
    return {
        rows: () => renderer!.root.findAllByType('Pressable' as any),
        shell: () => renderer!.root.findByType('ComposerSheet' as any),
        text: () => renderer!.root.findAllByType('Text' as any).map((node: any) => String(node.props.children)),
    };
}

describe('tapping an agent in the agents sheet (DROVE-183)', () => {
    it('closes the sheet, and pushes the agent screen only once it has gone', () => {
        pushed.length = 0;
        const order: string[] = [];
        const sheet = mount(() => order.push('close'));
        act(() => sheet.rows()[0].props.onPress());
        // The close is on the press. The push is NOT.
        expect(order).toEqual(['close']);
        expect(pushed).toEqual([]);
        act(() => sheet.shell().props.onClosed());
        expect(pushed).toEqual([{
            pathname: '/session/[id]/agent/[agentId]',
            params: { id: 'session-1', agentId: 'agent-1', label: 'DROVE-183' },
        }]);
    });

    it('carries the row that was actually tapped, not the first one', () => {
        pushed.length = 0;
        const sheet = mount(() => {});
        act(() => sheet.rows()[1].props.onPress());
        act(() => sheet.shell().props.onClosed());
        expect(pushed).toEqual([{
            pathname: '/session/[id]/agent/[agentId]',
            params: { id: 'session-1', agentId: 'agent-2', label: 'DROVE-185' },
        }]);
    });

    it('pushes nothing when the sheet was dismissed without a tap', () => {
        pushed.length = 0;
        const sheet = mount(() => {});
        act(() => sheet.shell().props.onClosed());
        expect(pushed).toEqual([]);
    });
});

describe('the session tally in the agents sheet (DROVE-184)', () => {
    /**
     * The row has room for one number and spends it on the TURN. The two facts
     * it cannot carry are what the whole session has cost and how much of that
     * was the main thread rather than the fan-out, so both live here, one tap
     * away. The session line is the one that keeps FINISHED agents: a finished
     * agent leaves the tree 90s after its last write, and its tokens are still
     * spent.
     */
    const tally = {
        turn: '312.0k',
        turnMain: '51.6k',
        session: '1.9M',
        sessionMain: '210.0k',
        sessionAgents: '1.6M',
        raw: { turn: 312_000, turnMain: 51_600, session: 1_851_600, sessionMain: 210_000 },
    };

    it('spells out the session total, the split and the turn', () => {
        const sheet = mount(() => {}, { tally });
        expect(sheet.text()).toContain('Session 1.9M · main 210.0k · agents 1.6M · this turn 312.0k');
    });

    it('says nothing at all on a CLI too old to publish a tally', () => {
        const sheet = mount(() => {}, { tally: null });
        expect(sheet.text().join(' ')).not.toContain('Session');
    });
});
