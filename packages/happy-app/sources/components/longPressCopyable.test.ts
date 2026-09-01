import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    longPressHandlers: [] as (() => void)[],
    push: vi.fn(),
    setStringAsync: vi.fn((text: string) => Promise.resolve(Boolean(text))),
    theme: {
        colors: {
            divider: '#222',
            shadow: { color: '#000', opacity: 0.2 },
            surface: '#111',
            surfaceSelected: '#333',
            text: '#eee',
        },
    },
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Modal: host('RNModal'),
        Pressable: host('Pressable'),
        StyleSheet: {
            absoluteFillObject: { position: 'absolute', inset: 0 },
            hairlineWidth: 1,
            create: (styles: unknown) => styles,
        },
        Text: host('Text'),
        View: host('View'),
        useWindowDimensions: () => ({ height: 800, width: 400 }),
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        absoluteFillObject: { position: 'absolute', inset: 0 },
        hairlineWidth: 1,
        create: (styles: unknown) => (typeof styles === 'function' ? (styles as any)(shared.theme) : styles),
    },
    useUnistyles: () => ({ theme: shared.theme }),
}));

vi.mock('@expo/ui/swift-ui', async () => {
    const ReactModule = await import('react');
    const component = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    const ContextMenu = component('ExpoContextMenu') as any;
    ContextMenu.Items = component('ExpoContextMenuItems');
    ContextMenu.Trigger = component('ExpoContextMenuTrigger');
    ContextMenu.Preview = component('ExpoContextMenuPreview');
    return {
        Button: component('ExpoButton'),
        ContextMenu,
        Host: component('ExpoHost'),
    };
});

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});

vi.mock('react-native-gesture-handler', async () => {
    const ReactModule = await import('react');
    return {
        Gesture: {
            LongPress: () => {
                const gesture: any = {
                    minDuration: () => gesture,
                    onStart: (handler: () => void) => {
                        shared.longPressHandlers.push(handler);
                        return gesture;
                    },
                    runOnJS: () => gesture,
                };
                return gesture;
            },
        },
        GestureDetector: (props: any) => ReactModule.createElement('GestureDetector', props, props.children),
    };
});

vi.mock('./AnimatedOverlay', async () => {
    const ReactModule = await import('react');
    return { AnimatedPopup: (props: any) => ReactModule.createElement('AnimatedPopup', props, props.children) };
});

vi.mock('./haptics', () => ({ hapticsLight: () => {} }));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

vi.mock('@/text', () => ({
    t: (key: string) => ({ 'common.copy': 'Copy', 'textSelection.title': 'Select Text' }[key] ?? key),
}));

vi.mock('expo-clipboard', () => ({ setStringAsync: (text: string) => shared.setStringAsync(text) }));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: shared.push }) }));

vi.mock('@/sync/persistence', () => ({ storeTempText: (text: string) => `temp:${text.length}` }));

import { LongPressCopyable as IosCopyable } from './LongPressCopyable.ios';
import { LongPressCopyable as AndroidCopyable } from './LongPressCopyable.android';
import { LongPressCopyable as WebCopyable } from './LongPressCopyable.web';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
    shared.longPressHandlers.length = 0;
    shared.setStringAsync.mockClear();
    shared.push.mockClear();
});

function render(element: React.ReactElement): ReactTestRenderer {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = create(element, {
            createNodeMock: () => ({
                measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) =>
                    callback(40, 300, 240, 60),
            }),
        });
    });
    return renderer;
}

const MESSAGE = 'the exact text the pill used to copy';

describe('LongPressCopyable on iOS', () => {
    /**
     * iOS is parked on the anchored menu (see LongPressCopyable.ios.tsx).
     *
     * The SwiftUI ContextMenu anchored and lifted correctly, but a hosted
     * SwiftUI view does not take its height from React Native children, so a
     * long markdown body was measured short and the message rendered CLIPPED
     * mid-sentence. Clay could not read the transcript. Reading it beats the
     * menu being native, so this asserts the parked state ON PURPOSE, and it
     * fails the moment the native path is wired back in without the height
     * being solved.
     */
    it('is on the anchored menu, not a hosted SwiftUI view, until the host reports a real height', () => {
        const renderer = render(React.createElement(IosCopyable, {
            text: MESSAGE,
            children: React.createElement('Bubble'),
        }));
        expect(renderer.root.findAllByType('ExpoHost' as any)).toHaveLength(0);
        expect(renderer.root.findAllByType('ExpoContextMenuTrigger' as any)).toHaveLength(0);
        // The content is still rendered in full, which is the whole point.
        expect(renderer.root.findByType('Bubble' as any)).toBeDefined();
    });

    it('still copies the same text the pill copied', async () => {
        const renderer = render(React.createElement(IosCopyable, {
            text: MESSAGE,
            children: React.createElement('Bubble'),
        }));
        act(() => shared.longPressHandlers[0]());
        const copyRow = renderer.root.findAllByType('Pressable' as any)
            .find((row: any) => row.props.accessibilityLabel === 'Copy');
        await act(async () => { await copyRow.props.onPress(); });
        expect(shared.setStringAsync).toHaveBeenCalledWith(MESSAGE);
    });
});

describe('the hold offers both the coarse action and the fine one', () => {
    /**
     * DROVE-282. Until this landed the menu had one item, so the reader at
     * `/text-selection` — the only surface in the app where a word can be
     * selected with the platform's own handles — was unreachable from a
     * message. Copy stays FIRST: the fine action is added beside the coarse
     * one, never in place of it.
     */
    function openMenu() {
        const renderer = render(React.createElement(AndroidCopyable, {
            text: MESSAGE,
            children: React.createElement('Bubble'),
        }));
        act(() => shared.longPressHandlers[0]());
        return renderer;
    }

    function menuLabels(renderer: ReactTestRenderer): string[] {
        return renderer.root.findAllByType('Pressable' as any)
            .map((row: any) => row.props.accessibilityLabel)
            .filter((label: unknown): label is string => typeof label === 'string');
    }

    it('lists Copy first and Select Text second', () => {
        expect(menuLabels(openMenu())).toEqual(['Copy', 'Select Text']);
    });

    it('hands the reader exactly the text Copy would have put on the clipboard', () => {
        const renderer = openMenu();
        const selectRow = renderer.root.findAllByType('Pressable' as any)
            .find((row: any) => row.props.accessibilityLabel === 'Select Text');
        act(() => selectRow.props.onPress());
        expect(shared.push).toHaveBeenCalledWith(`/text-selection?textId=temp:${MESSAGE.length}`);
    });

    it('closes the menu before pushing, so the modal is not left over the reader', () => {
        const renderer = openMenu();
        const selectRow = renderer.root.findAllByType('Pressable' as any)
            .find((row: any) => row.props.accessibilityLabel === 'Select Text');
        act(() => selectRow.props.onPress());
        expect(renderer.root.findAllByType('RNModal' as any)).toHaveLength(0);
    });
});

describe('the taller menu still lands on screen', () => {
    /**
     * DROVE-282 gave the menu a second row, so the clamp that keeps it on
     * screen now has twice as much to hold back. The case that exercises it is
     * a reply TALLER than the window: there is no room above it, and its
     * bottom edge is off screen, so the "drop below" branch would put the menu
     * past the bottom if it were not clamped. The window is 800 tall here.
     *
     * The expected height is READ OFF the rendered rows rather than written
     * down, so adding a third item later is caught by this test instead of
     * quietly pushing the menu off the bottom.
     */
    function renderAt(y: number, height: number): ReactTestRenderer {
        let renderer!: ReactTestRenderer;
        act(() => {
            renderer = create(React.createElement(AndroidCopyable, {
                text: MESSAGE,
                children: React.createElement('Bubble'),
            }), {
                createNodeMock: () => ({
                    measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) =>
                        callback(40, y, 240, height),
                }),
            });
        });
        act(() => shared.longPressHandlers[0]());
        return renderer;
    }

    function flatten(style: unknown): Record<string, any> {
        const parts = (Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean);
        return Object.assign({}, ...parts as object[]);
    }

    function menuRows(renderer: ReactTestRenderer): any[] {
        return renderer.root.findAllByType('Pressable' as any)
            .filter((row: any) => typeof row.props.accessibilityLabel === 'string');
    }

    function menuTop(renderer: ReactTestRenderer): number {
        return flatten(renderer.root.findByType('AnimatedPopup' as any).props.style).top;
    }

    function menuHeight(renderer: ReactTestRenderer): number {
        const rows = menuRows(renderer);
        return rows.reduce((total: number, row: any) => total + flatten(row.props.style({ pressed: false })).height, 0);
    }

    it('sits above an ordinary message rather than covering it', () => {
        const renderer = renderAt(300, 60);
        expect(menuTop(renderer)).toBe(300 - menuHeight(renderer) - 8);
    });

    it('stays fully on screen when the message is taller than the window', () => {
        const renderer = renderAt(20, 900);
        const top = menuTop(renderer);
        expect(top).toBeGreaterThanOrEqual(12);
        expect(top + menuHeight(renderer)).toBeLessThanOrEqual(800 - 12);
    });
});

describe('LongPressCopyable fallbacks', () => {
    // Android has no context-menu primitive in @expo/ui, so the hold degrades
    // to the anchored menu it has today rather than to no copy at all.
    it('keeps the anchored menu on Android and copies the same text', async () => {
        const renderer = render(React.createElement(AndroidCopyable, {
            text: MESSAGE,
            children: React.createElement('Bubble'),
        }));

        expect(renderer.root.findAllByType('ExpoContextMenu' as any)).toHaveLength(0);
        expect(renderer.root.findAllByType('RNModal' as any)).toHaveLength(0);
        expect(shared.longPressHandlers).toHaveLength(1);

        act(() => shared.longPressHandlers[0]());
        expect(renderer.root.findByType('RNModal' as any)).toBeDefined();
        const copyRow = renderer.root.findAllByType('Pressable' as any)
            .find((row: any) => row.props.accessibilityLabel === 'Copy');
        await act(async () => { await copyRow.props.onPress(); });
        expect(shared.setStringAsync).toHaveBeenCalledWith(MESSAGE);
    });

    it('leaves web content untouched for plain mouse selection', () => {
        const renderer = render(React.createElement(WebCopyable, {
            text: MESSAGE,
            children: React.createElement('Bubble'),
        }));

        expect(renderer.root.findByType('Bubble' as any)).toBeDefined();
        expect(renderer.root.findAllByType('ExpoContextMenu' as any)).toHaveLength(0);
        expect(shared.longPressHandlers).toHaveLength(0);
    });
});
