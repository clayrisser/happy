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

function mount(onClose: () => void) {
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(React.createElement(SessionAgentsSheet, {
            sessionId: 'session-1',
            summary,
            open: true,
            onClose,
        }));
    });
    return {
        rows: () => renderer!.root.findAllByType('Pressable' as any),
        shell: () => renderer!.root.findByType('ComposerSheet' as any),
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
