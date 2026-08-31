/**
 * The shell's exit, and the ORDER it happens in (DROVE-183).
 *
 * The whole ticket is one sequencing claim: a tap inside a sheet closes it,
 * and whatever the tap was for runs after the Modal is off the screen, never
 * before and never instead. So these are ordering assertions on one array, not
 * "was it called" assertions on two spies.
 *
 * Pure React, no react-native: the helper is a context and a ref, and mounting
 * it through the real shell would only drag reanimated in.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    ComposerSheetContext,
    useComposerSheetExit,
    useComposerSheetNavigate,
} from './composerSheetNavigation';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

/** A row inside the sheet: it never runs the action, it hands it over. */
function Row(props: { go: () => void }) {
    const leave = useComposerSheetNavigate();
    return React.createElement('Row', { onPress: () => leave(props.go) });
}

/** Stands in for ComposerSheet: same wiring, none of the animation. */
function Shell(props: {
    open: boolean;
    onClose: () => void;
    onClosed?: () => void;
    children?: React.ReactNode;
}) {
    const exit = useComposerSheetExit({
        open: props.open,
        onClose: props.onClose,
        onClosed: props.onClosed,
    });
    return React.createElement(
        'Shell',
        { onClosed: exit.onClosed },
        React.createElement(ComposerSheetContext.Provider, { value: exit.shell }, props.children),
    );
}

function mount(props: {
    open?: boolean;
    onClose: () => void;
    onClosed?: () => void;
    go: () => void;
}) {
    const element = (open: boolean) => React.createElement(
        Shell,
        { open, onClose: props.onClose, onClosed: props.onClosed },
        React.createElement(Row, { go: props.go }),
    );
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(element(props.open ?? true));
    });
    return {
        press: () => act(() => renderer!.root.findByType('Row' as any).props.onPress()),
        closed: () => act(() => renderer!.root.findByType('Shell' as any).props.onClosed()),
        setOpen: (open: boolean) => act(() => renderer!.update(element(open))),
    };
}

describe('useComposerSheetExit', () => {
    it('closes first and goes only once the Modal has gone', () => {
        // The bug Clay reported twice: tapping an agent pushed the screen with
        // the sheet still open under it. Close is on the press; the push waits.
        const order: string[] = [];
        const sheet = mount({
            onClose: () => order.push('close'),
            go: () => order.push('go'),
        });
        sheet.press();
        expect(order).toEqual(['close']);
        sheet.closed();
        expect(order).toEqual(['close', 'go']);
    });

    it('does not go twice when onClosed fires again', () => {
        const order: string[] = [];
        const sheet = mount({
            onClose: () => order.push('close'),
            go: () => order.push('go'),
        });
        sheet.press();
        sheet.closed();
        sheet.closed();
        expect(order).toEqual(['close', 'go']);
    });

    it('runs the owner\'s own onClosed before the action it banked', () => {
        // A sheet owner with tail work of its own still gets it, and gets it
        // while the action is still pending rather than after a push has
        // already changed the screen.
        const order: string[] = [];
        const sheet = mount({
            onClose: () => order.push('close'),
            onClosed: () => order.push('owner'),
            go: () => order.push('go'),
        });
        sheet.press();
        sheet.closed();
        expect(order).toEqual(['close', 'owner', 'go']);
    });

    it('still runs the owner\'s onClosed when nothing was tapped', () => {
        // Dismissed by the backdrop or a drag: no action banked, and the
        // owner's callback must not be swallowed by the helper sitting in
        // front of it.
        const order: string[] = [];
        const sheet = mount({
            onClose: () => order.push('close'),
            onClosed: () => order.push('owner'),
            go: () => order.push('go'),
        });
        sheet.closed();
        expect(order).toEqual(['owner']);
    });

    it('drops the banked action when the sheet is reopened before it fired', () => {
        // He tapped, changed his mind, and opened the sheet again inside the
        // 180ms slide. The row he touched must not fire under the new sheet.
        const order: string[] = [];
        const sheet = mount({
            onClose: () => order.push('close'),
            go: () => order.push('go'),
        });
        sheet.press();
        sheet.setOpen(false);
        sheet.setOpen(true);
        sheet.closed();
        expect(order).toEqual(['close']);
    });
});

describe('useComposerSheetNavigate outside a sheet', () => {
    it('runs the action at once, so a shared row needs no second version', () => {
        // The usage block is drawn in the quota sheet AND on the session info
        // screen; the live status tree could be too. Outside a sheet there is
        // nothing to close and nothing to wait for.
        const order: string[] = [];
        let renderer: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(Row, { go: () => order.push('go') }));
        });
        act(() => renderer!.root.findByType('Row' as any).props.onPress());
        expect(order).toEqual(['go']);
    });
});
