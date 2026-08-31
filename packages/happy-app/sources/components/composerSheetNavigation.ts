/**
 * How a tap inside a sheet leaves it (DROVE-183).
 *
 * Clay, twice: "when I open a subagent it should close the sheet", then "when
 * I click on a background work item or whatever from the sheet, the sheet
 * doesn't close". Tapping an agent in the agents sheet pushed the agent screen
 * with the sheet still open under it, so back landed him on a sheet he had
 * already finished with.
 *
 * That is not one caller's bug. Every sheet with somewhere to go has it, and
 * DROVE-158 had already met the same thing from the other side: a system
 * picker launched from the Add context sheet came up behind the Modal, because
 * the Modal owns the presentation context for the whole 180ms of its slide
 * down. Push, alert and picker are one problem with one answer: close, wait
 * for the Modal to be gone, then go.
 *
 * So the rule lives in the shell where a caller cannot forget it. ComposerSheet
 * calls `useComposerSheetExit` and publishes the result on this context; any
 * row inside it asks for `useComposerSheetNavigate()` and hands over the action
 * instead of running it. A component rendered OUTSIDE a sheet (the usage bars
 * on the session info screen) gets a navigate that just runs the action, so
 * nothing has to know where it is.
 */
import * as React from 'react';

/** What a sheet's contents may ask of the shell around them. */
export interface ComposerSheetShell {
    /** Close the sheet, and run `go` once the Modal is off the screen. */
    navigate: (go: () => void) => void;
}

export const ComposerSheetContext = React.createContext<ComposerSheetShell | null>(null);

/**
 * The way out of whichever sheet this component is in.
 *
 * Outside a sheet the action runs at once, which is what a screen that is not
 * a sheet wants and what keeps a shared row component (a usage block, a live
 * status row) from needing two versions of itself.
 */
export function useComposerSheetNavigate(): (go: () => void) => void {
    const shell = React.useContext(ComposerSheetContext);
    return React.useCallback((go: () => void) => {
        if (shell) shell.navigate(go);
        else go();
    }, [shell]);
}

/**
 * The shell half: bank the action, close, fire it after the Modal unmounts.
 *
 * `onClosed` is the sheet's existing "and now I am actually gone" callback and
 * is the ONLY safe moment. `onClose` is far too early; it is where the slide
 * down starts, not where it ends.
 *
 * A reopen inside that slide drops the banked action. He tapped, changed his
 * mind, and opened the sheet again; the row he touched a moment ago must not
 * fire under the sheet now in front of him.
 */
export function useComposerSheetExit(input: {
    open: boolean;
    onClose: () => void;
    /** The sheet owner's own onClosed, which still runs, and runs first. */
    onClosed?: () => void;
}): { shell: ComposerSheetShell; onClosed: () => void } {
    const { open, onClose, onClosed } = input;
    const pending = React.useRef<(() => void) | null>(null);
    const navigate = React.useCallback((go: () => void) => {
        pending.current = go;
        onClose();
    }, [onClose]);
    React.useEffect(() => {
        if (open) pending.current = null;
    }, [open]);
    const handleClosed = React.useCallback(() => {
        const go = pending.current;
        pending.current = null;
        onClosed?.();
        go?.();
    }, [onClosed]);
    const shell = React.useMemo<ComposerSheetShell>(() => ({ navigate }), [navigate]);
    return { shell, onClosed: handleClosed };
}
