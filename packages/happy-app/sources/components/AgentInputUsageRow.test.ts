/**
 * The strip under the composer, mounted, for a session with no SDK usage
 * stream (DROVE-47).
 *
 * utils/droverUsage.spec.ts proves the mapping and agentInputUsage.spec.ts
 * the derivation; this is the render. A pane session's metadata goes through
 * resolveUsageStrip into the real AgentInputUsageRow and the week text and
 * the popup groups come out the other side — or nothing does, when there is
 * nothing to show, which is the shape the composer relies on to collapse the
 * row.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DroverUsageLike } from '@/utils/droverUsage';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Pressable: host('Pressable'),
        Text: host('Text'),
        View: host('View'),
    };
});

vi.mock('react-native-svg', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return { default: host('Svg'), Circle: host('Circle') };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { dark: false, colors: { textSecondary: 'secondary', divider: 'divider' } },
    }),
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

vi.mock('./NativeSettingsMenu', async () => {
    const ReactModule = await import('react');
    return {
        NativeSettingsMenu: (props: any) => ReactModule.createElement('NativeSettingsMenu', props, props.children),
    };
});

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

import { AgentInputUsageRow } from './AgentInputUsageRow';
import { resolveUsageStrip } from './agentInputUsage';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

const sep5 = Date.parse('2026-09-05T19:00:00Z');
const sep3 = Date.parse('2026-09-03T20:00:00Z');
const paneUsage: DroverUsageLike = {
    capturedAt: 1_000,
    accounts: [
        {
            name: 'main', current: false, loggedIn: true, fetchedAt: 900, headroom: 0,
            cooling: { until: sep3, reason: 'weekly limit at 100%' },
            limits: [{ kind: 'weekly_all', percent: 100, resetsAt: sep3, scope: null, family: null }],
        },
        {
            name: 'jamrizzi', current: true, loggedIn: true, fetchedAt: 950, headroom: 51,
            cooling: null,
            limits: [
                { kind: 'session', percent: 49, resetsAt: 1_200, scope: null, family: null },
                { kind: 'weekly_all', percent: 23, resetsAt: sep5, scope: null, family: null },
                { kind: 'weekly_scoped', percent: 39, resetsAt: sep5, scope: 'Fable', family: 'fable' },
            ],
        },
    ],
};

function mount(element: React.ReactElement) {
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(element);
    });
    return renderer!;
}

/** What SessionView hands AgentInput for a pane session: metadata, no agent-state windows, no context yet. */
function paneStrip(showRemaining = false) {
    return resolveUsageStrip({
        usageLimits: null,
        droverUsage: paneUsage,
        droverAccount: 'jamrizzi',
        showRemaining,
        contextShown: false,
    });
}

describe('AgentInputUsageRow on a pane session', () => {
    it('renders the week figure from drover\'s snapshot with no SDK stream and no context gauge', () => {
        const strip = paneStrip();
        const renderer = mount(React.createElement(AgentInputUsageRow, {
            contextStatus: null,
            weekPercent: strip.weekPercent,
            usageMenuGroups: strip.usageMenuGroups,
        }));
        const texts = renderer.root.findAllByType('Text' as any);
        expect(texts.map((node: any) => node.props.children)).toEqual(['23% week']);
    });

    it('puts the popup behind the figure with this account and the others folded under it', () => {
        const strip = paneStrip(true);
        const renderer = mount(React.createElement(AgentInputUsageRow, {
            contextStatus: null,
            weekPercent: strip.weekPercent,
            usageMenuGroups: strip.usageMenuGroups,
        }));
        const menu = renderer.root.findByType('NativeSettingsMenu' as any);
        expect(menu.props.anchor).toBe('bottom');
        expect(menu.props.groups.map((g: any) => [g.key, g.title])).toEqual([
            ['usage', 'jamrizzi · 51% left'],
            ['accounts', 'Other accounts'],
        ]);
        expect(menu.props.groups[0].options.map((o: any) => o.label.split('\n')[0])).toEqual([
            'Session · 51%',
            'Week · 77%',
            'Fable week · 61%',
        ]);
        expect(menu.props.groups[1].options.map((o: any) => o.label.split('\n')[0])).toEqual(['main · 0% left']);
        // The figure is the menu's trigger.
        expect(menu.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual(['77% week']);
    });

    it('keeps the context gauge beside the figure when the session has one', () => {
        const strip = paneStrip();
        const renderer = mount(React.createElement(AgentInputUsageRow, {
            contextStatus: { percent: 42, detailText: '84k / 200k context', color: 'ok' },
            weekPercent: strip.weekPercent,
            usageMenuGroups: strip.usageMenuGroups,
        }));
        const texts = renderer.root.findAllByType('Text' as any).map((node: any) => node.props.children);
        expect(texts).toEqual(['23% week', '42% context']);
        expect(renderer.root.findAllByType('Svg' as any)).toHaveLength(1);
    });
});

describe('AgentInputUsageRow with nothing to show', () => {
    it('renders nothing for a session with no stream, no snapshot and no context', () => {
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: null, showRemaining: false, contextShown: false });
        const renderer = mount(React.createElement(AgentInputUsageRow, {
            contextStatus: null,
            weekPercent: strip.weekPercent,
            usageMenuGroups: strip.usageMenuGroups,
        }));
        expect(renderer.toJSON()).toBeNull();
    });

    it('still hides a remote session\'s week figure until the context gauge shows, as before', () => {
        const strip = resolveUsageStrip({
            usageLimits: { capturedAt: 1, windows: [{ id: 'seven_day', utilization: 60, resetsAt: sep5 }] },
            droverUsage: null,
            showRemaining: false,
            contextShown: false,
        });
        const renderer = mount(React.createElement(AgentInputUsageRow, {
            contextStatus: null,
            weekPercent: strip.weekPercent,
            usageMenuGroups: strip.usageMenuGroups,
        }));
        expect(renderer.toJSON()).toBeNull();
    });
});
