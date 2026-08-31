/**
 * The app's permission-mode picker, mapped onto cursor-agent argv (DROVE-253).
 *
 * Before this the picker had nothing behind it: every turn ran `--force` and
 * the session admitted as much with `dangerouslySkipPermissions: true`. That
 * was true when it was written and is no longer, because cursor-agent 2026.08
 * carries four real controls on argv:
 *
 *   --mode plan     read-only planning: analyse and propose, no edits
 *   --mode ask      Q&A, read-only
 *   --force         run everything unless a hook explicitly denies
 *   --auto-review   a server classifier auto-runs the safe calls, prompts
 *                   for the rest
 *   --sandbox enabled|disabled
 *
 * TWO THINGS THAT ARE MEASURED AND SHAPE THIS.
 *
 * 1. The choice CANNOT be read back. The `system/init` frame hardcodes
 *    `permissionMode:"default"` — a literal in the bundle, not a value — so it
 *    reports `default` under `--force` and under `--mode ask` alike. Anything
 *    that trusted that field would show the wrong chip. So the session's own
 *    record of what it passed is the authority, and the init frame's
 *    permissionMode is ignored on purpose.
 *
 * 2. `--auto-review` prompts for the calls it does not auto-run, and under
 *    `--print` there is nowhere to prompt. A hook returning `ask` there was
 *    measured to stall ~20s and then run the command anyway. So `auto-review`
 *    is offered ONLY when a gate is registered to answer for it, and the
 *    caller says whether one is. Without a gate it is a slow yes.
 */

/** Mode codes this harness publishes. Kept to words the app already knows. */
export const cursorPermissionModes = {
    /** Everything runs. What every Cursor turn did before this existed. */
    bypassPermissions: 'bypassPermissions',
    /** Read-only planning. `--mode plan`. */
    plan: 'plan',
    /** Read-only Q&A. `--mode ask`. */
    readOnly: 'read-only',
    /** Classifier auto-runs the safe calls, the gate answers the rest. */
    default: 'default',
} as const;

export interface CursorPermissionOption {
    code: string;
    value: string;
    description?: string;
}

/**
 * The catalog for `metadata.operatingModes`.
 *
 * `default` is included only when a gate can answer, because without one it is
 * a twenty-second pause followed by yes, which is a worse promise than
 * `bypassPermissions` makes honestly.
 */
export function cursorPermissionCatalog(opts: { gated?: boolean } = {}): CursorPermissionOption[] {
    const modes: CursorPermissionOption[] = [
        {
            code: cursorPermissionModes.bypassPermissions,
            value: 'Full access',
            description: 'Every tool call runs. --force',
        },
        {
            code: cursorPermissionModes.plan,
            value: 'Plan',
            description: 'Read-only. Analyse and propose, no edits. --mode plan',
        },
        {
            code: cursorPermissionModes.readOnly,
            value: 'Read only',
            description: 'Questions and explanations, read-only. --mode ask',
        },
    ];
    if (opts.gated) {
        modes.push({
            code: cursorPermissionModes.default,
            value: 'Auto review',
            description: 'Safe calls auto-run, the rest go to the drover gate. --auto-review',
        });
    }
    return modes;
}

/**
 * The argv for a mode. An unknown code falls back to `--force`, deliberately:
 * this harness has always run that way, and a picker sending something this
 * build does not know should not silently turn the session read-only.
 */
export function cursorPermissionArgs(mode: string | null | undefined): string[] {
    switch (mode) {
        case cursorPermissionModes.plan:
            return ['--mode', 'plan'];
        case cursorPermissionModes.readOnly:
            return ['--mode', 'ask'];
        case cursorPermissionModes.default:
            return ['--auto-review'];
        case cursorPermissionModes.bypassPermissions:
        default:
            return ['--force'];
    }
}

/** Whether a mode still means "nothing will be asked". Drives the session row. */
export function cursorModeSkipsPermissions(mode: string | null | undefined): boolean {
    return cursorPermissionArgs(mode).includes('--force');
}
