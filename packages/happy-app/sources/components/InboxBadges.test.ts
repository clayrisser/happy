import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return { Text: host('Text'), View: host('View') };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => typeof factory === 'function' ? factory({
            colors: {
                box: { warning: { text: 'warning', background: 'warning-bg' } },
                groupped: { background: 'background' },
                header: { tint: 'tint' },
            },
        }) : factory,
    },
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

import { InboxBadges, inboxAccessibilityLabel } from './InboxBadges';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

function render(prompts: number, todos: number) {
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(React.createElement(InboxBadges, { prompts, todos }));
    });
    return renderer!;
}

function labels(prompts: number, todos: number) {
    return render(prompts, todos).root.findAllByType('Text' as any).map((node: any) => node.props.children);
}

/**
 * DROVE-71, with Clay's correction: "it should have indicators both for todo
 * and for prompts". Separate, not combined — a prompt is blocking a session
 * right now and can time out, a to-do stalls nothing and never expires.
 */
describe('InboxBadges', () => {
    it('draws nothing at all when both are empty', () => {
        // A badge that is always there is a badge nobody reads.
        expect(render(0, 0).toJSON()).toBeNull();
    });

    it('counts the two separately, never as one number', () => {
        // Two prompts and three to-dos must never read as "5": a sum lets the
        // to-dos hide the prompt that is holding work up.
        expect(labels(2, 3)).toEqual(['2', '3']);
    });

    it('shows only the half that is non-zero', () => {
        expect(labels(0, 1)).toEqual(['1']);
        expect(labels(4, 0)).toEqual(['4']);
    });

    it('draws the prompt indicator louder than the to-do one', () => {
        // Filled in the warning colour against outlined and neutral. The
        // prompt is the one with a session stopped behind it.
        const styles = render(1, 1).root
            .findAllByType('View' as any)
            .slice(1)
            .map((node: any) => node.props.style[1]);
        expect(styles[0].backgroundColor).toBe('warning');
        expect(styles[1].borderColor).toBe('tint');
        expect(styles[1].backgroundColor).toBe('background');
    });

    it('caps a count that would not fit the pill', () => {
        expect(labels(140, 0)).toEqual(['99+']);
    });
});

describe('inboxAccessibilityLabel', () => {
    it('spells both counts out, because a screen reader cannot see a badge', () => {
        expect(inboxAccessibilityLabel(1, 2)).toBe('Drover inbox, 1 prompt waiting and 2 to-dos');
        expect(inboxAccessibilityLabel(3, 0)).toBe('Drover inbox, 3 prompts waiting');
        expect(inboxAccessibilityLabel(0, 1)).toBe('Drover inbox, 1 to-do');
        expect(inboxAccessibilityLabel(0, 0)).toBe('Drover inbox, nothing waiting');
    });
});
