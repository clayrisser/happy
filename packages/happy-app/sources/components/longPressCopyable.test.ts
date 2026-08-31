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
    it('hands the hold to the platform context menu instead of a menu we position', () => {
        const renderer = render(React.createElement(IosCopyable, {
            text: MESSAGE,
            children: React.createElement('Bubble'),
        }));

        // The trigger is the message itself, so UIKit lifts and blurs what was
        // pressed and anchors the menu at the finger.
        const trigger = renderer.root.findByType('ExpoContextMenuTrigger' as any);
        expect(trigger.findByType('Bubble' as any)).toBeDefined();
        // Nothing of ours is drawn or placed: no modal, no anchored popup.
        expect(renderer.root.findAllByType('RNModal' as any)).toHaveLength(0);
        expect(renderer.root.findAllByType('AnimatedPopup' as any)).toHaveLength(0);
        // No Preview: iOS lifts the pressed view when one is not given.
        expect(renderer.root.findAllByType('ExpoContextMenuPreview' as any)).toHaveLength(0);
    });

    it('copies the same text the pill copied, and offers the text reader', () => {
        const renderer = render(React.createElement(IosCopyable, {
            text: MESSAGE,
            children: React.createElement('Bubble'),
        }));

        const buttons = renderer.root.findAllByType('ExpoButton' as any);
        expect(buttons.map((button: any) => button.props.label)).toEqual(['Copy', 'Select Text']);

        act(() => buttons[0].props.onPress());
        expect(shared.setStringAsync).toHaveBeenCalledOnce();
        expect(shared.setStringAsync).toHaveBeenCalledWith(MESSAGE);

        act(() => buttons[1].props.onPress());
        expect(shared.push).toHaveBeenCalledWith(`/text-selection?textId=temp:${MESSAGE.length}`);
    });

    it('stretches a filling turn and lets a bubble size itself', () => {
        const agent = render(React.createElement(IosCopyable, {
            fill: true,
            text: MESSAGE,
            children: React.createElement('Bubble'),
        }));
        const agentHost = agent.root.findByType('ExpoHost' as any);
        expect(agentHost.props.matchContents).toEqual({ vertical: true });
        expect(agentHost.props.style).toEqual({ alignSelf: 'stretch' });

        const bubble = render(React.createElement(IosCopyable, {
            text: MESSAGE,
            children: React.createElement('Bubble'),
        }));
        const bubbleHost = bubble.root.findByType('ExpoHost' as any);
        expect(bubbleHost.props.matchContents).toBe(true);
        expect(bubbleHost.props.style).toBeUndefined();
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
