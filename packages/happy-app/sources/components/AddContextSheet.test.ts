/**
 * The Add context sheet (DROVE-128), mounted.
 *
 * Clay asked for the Claude iOS app's sheet minus two of its rows, so the
 * assertions are as much about what is NOT there as what is: three tiles,
 * Camera, Photos, Files, and no recent-photos strip and no connectors row.
 * The rest is the contract with AgentInput: a tile with no handler behind it
 * is not drawn, and choosing one closes the sheet before the system picker
 * comes up over it.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

vi.mock('./BubblePressable', () => ({ BubblePressable: host('Pressable') }));

// The shell pulls in gesture-handler and reanimated, neither of which vitest
// can transform. What this sheet owes it is the open flag and the children.
vi.mock('./ComposerAnchoredSheet', () => ({ ComposerAnchoredSheet: host('ComposerAnchoredSheet') }));

vi.mock('@/text', async () => {
    const { en } = await import('@/text/_default');
    return {
        t: (key: string) => key.split('.').reduce<any>((node, part) => node?.[part], en),
    };
});

import { AddContextSheet, type AddContextSource } from './AddContextSheet';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

const allAvailable = { camera: true, photos: true, files: true };

function mount(props: Partial<React.ComponentProps<typeof AddContextSheet>> = {}) {
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(React.createElement(AddContextSheet, {
            open: true,
            onClose: () => {},
            onSelect: () => {},
            available: allAvailable,
            ...props,
        }));
    });
    return renderer!;
}

const labels = (renderer: ReturnType<typeof create>): string[] => renderer.root
    .findAllByType('Text' as any)
    .map((node: any) => String(node.props.children));

describe('AddContextSheet', () => {
    it('is a heading and exactly three tiles, and nothing the reference sheet had beyond them', () => {
        const renderer = mount();
        expect(labels(renderer)).toEqual(['Add context', 'Camera', 'Photos', 'Files']);
        expect(renderer.root.findAllByType('Pressable' as any)).toHaveLength(3);
        // The two rows Clay struck off the reference by name.
        const flat = labels(renderer).join(' ').toLowerCase();
        expect(flat).not.toContain('recent');
        expect(flat).not.toContain('connector');
    });

    it('rides the shared shell rather than drawing its own backdrop (DROVE-117 mechanism)', () => {
        const renderer = mount();
        const shell = renderer.root.findByType('ComposerAnchoredSheet' as any);
        expect(shell.props.open).toBe(true);
        expect(typeof shell.props.onClose).toBe('function');
    });

    it('closes itself before the system picker comes up over it', () => {
        const order: string[] = [];
        const renderer = mount({
            onClose: () => order.push('close'),
            onSelect: (source: AddContextSource) => order.push(source),
        });
        act(() => {
            renderer.root.findAllByType('Pressable' as any)[0].props.onPress();
        });
        expect(order).toEqual(['close', 'camera']);
    });

    it('reports which tile was chosen, in the order Clay drew them', () => {
        const chosen: AddContextSource[] = [];
        const renderer = mount({ onSelect: (source: AddContextSource) => chosen.push(source) });
        const tiles = renderer.root.findAllByType('Pressable' as any);
        act(() => {
            tiles[0].props.onPress();
            tiles[1].props.onPress();
            tiles[2].props.onPress();
        });
        expect(chosen).toEqual(['camera', 'photos', 'files']);
    });

    it('does not draw a tile with nothing behind it', () => {
        const renderer = mount({ available: { camera: false, photos: true, files: true } });
        expect(labels(renderer)).toEqual(['Add context', 'Photos', 'Files']);
    });

    it('stays shut when no source is available at all', () => {
        const renderer = mount({ available: { camera: false, photos: false, files: false } });
        expect(renderer.root.findByType('ComposerAnchoredSheet' as any).props.open).toBe(false);
    });

    it('stays shut when it is not asked to open', () => {
        const renderer = mount({ open: false });
        expect(renderer.root.findByType('ComposerAnchoredSheet' as any).props.open).toBe(false);
    });
});
