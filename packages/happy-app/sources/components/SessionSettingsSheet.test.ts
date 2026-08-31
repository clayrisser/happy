/**
 * What the avatar opens (DROVE-205), mounted.
 *
 * Clay: "If you want to go to the settings you use the right hand profile
 * icon, not the name of your session." So the assertions are about where each
 * row goes and, as much, about WHEN: the push waits for the sheet to be off
 * the screen (DROVE-183), because the sheet is a Modal that holds the
 * presentation context for the length of its slide down.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { host, theme } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
    theme: { dark: false, colors: { text: 'text', textSecondary: 'secondary', surfaceHigh: 'high' } },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Text: host('Text'),
    View: host('View'),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme }),
    StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input) },
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

// The shell pulls in gesture-handler and reanimated, neither of which vitest
// can transform. What this sheet owes it is the open flag and the children.
vi.mock('./ComposerSheet', () => ({ ComposerSheet: host('ComposerSheet') }));
vi.mock('./ComposerSheetRow', () => ({ ComposerSheetRow: host('Row') }));

import { SessionSettingsSheet } from './SessionSettingsSheet';

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function mount(over: Partial<React.ComponentProps<typeof SessionSettingsSheet>> = {}) {
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(React.createElement(SessionSettingsSheet, {
            sessionId: 's1',
            sessionName: 'cattle-drover',
            open: true,
            onClose: () => {},
            onNavigate: () => {},
            ...over,
        }));
    });
    return renderer!;
}

const rows = (renderer: ReturnType<typeof create>) => renderer.root.findAllByType('Row' as any);

describe('SessionSettingsSheet', () => {
    it('offers session settings, app settings and Accounts, and nothing else', () => {
        const renderer = mount();
        expect(rows(renderer).map((row: any) => row.props.title))
            .toEqual(['Session settings', 'App settings', 'Accounts']);
    });

    it('rides the shared shell rather than drawing its own card', () => {
        const shell = mount().root.findByType('ComposerSheet' as any);
        expect(shell.props.open).toBe(true);
        expect(typeof shell.props.onClose).toBe('function');
        expect(typeof shell.props.onClosed).toBe('function');
    });

    it('closes before it navigates, and pushes only once the sheet is gone', () => {
        const order: string[] = [];
        const renderer = mount({
            onClose: () => order.push('close'),
            onNavigate: (route: string) => order.push(route),
        });
        const shell = renderer.root.findByType('ComposerSheet' as any);
        act(() => rows(renderer)[0].props.onPress());
        expect(order).toEqual(['close']);
        act(() => shell.props.onClosed());
        expect(order).toEqual(['close', '/session/s1/info']);
    });

    it('sends each row where sessionHeaderRouting says, Accounts to DROVE-165s screen', () => {
        const routes: string[] = [];
        const renderer = mount({ onNavigate: (route: string) => routes.push(route) });
        const shell = renderer.root.findByType('ComposerSheet' as any);
        for (const row of rows(renderer)) {
            act(() => row.props.onPress());
            act(() => shell.props.onClosed());
        }
        expect(routes).toEqual(['/session/s1/info', '/settings', '/settings/accounts']);
    });

    it('drops the banked row when the sheet is reopened before it fired', () => {
        const routes: string[] = [];
        const props = {
            sessionId: 's1',
            onClose: () => {},
            onNavigate: (route: string) => routes.push(route),
        };
        let renderer: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(SessionSettingsSheet, { ...props, open: true }));
        });
        const shell = renderer!.root.findByType('ComposerSheet' as any);
        act(() => renderer!.root.findAllByType('Row' as any)[1].props.onPress());
        act(() => renderer!.update(React.createElement(SessionSettingsSheet, { ...props, open: false })));
        act(() => renderer!.update(React.createElement(SessionSettingsSheet, { ...props, open: true })));
        act(() => shell.props.onClosed());
        expect(routes).toEqual([]);
    });

    it('stays shut when it is not asked to open', () => {
        expect(mount({ open: false }).root.findByType('ComposerSheet' as any).props.open).toBe(false);
    });
});
