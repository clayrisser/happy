import * as React from 'react';
import { storage, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { CodeWrapKind, isCodeWrapOn, toggleCodeWrap } from '@/sync/settings';
import { hapticsSelection } from './haptics';

/**
 * Whether monospace text of one kind soft-wraps, and the toggle (DROVE-95,
 * default flipped to wrapped in DROVE-149).
 *
 * One synced setting, so a double-tap on any terminal card flips every
 * terminal card, on this phone and the next one that syncs. That is also what
 * makes a consolidated run of shell calls behave as one block: every card
 * inside the merged card reads the same value, so a double-tap on any of them
 * moves all of them. The toggle reads the live store rather than the rendered
 * value: two quick double-taps must not both compute from the same stale
 * snapshot and cancel out.
 */
export function useCodeWrap(kind: CodeWrapKind): [boolean, () => void] {
    const codeScroll = useSetting('codeScroll');
    const on = isCodeWrapOn({ codeScroll }, kind);
    const toggle = React.useCallback(() => {
        hapticsSelection();
        sync.applySettings(toggleCodeWrap({ codeScroll: storage.getState().settings.codeScroll }, kind));
    }, [kind]);
    return [on, toggle];
}
