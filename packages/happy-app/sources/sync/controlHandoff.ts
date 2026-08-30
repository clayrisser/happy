export type ControlMode = 'desktop' | 'mobile';
export type ControlHandoffDirection = 'desktop-to-mobile' | 'mobile-to-desktop';

export interface ControlModeOptions {
    /**
     * The session is a live Claude in a tmux pane (metadata.hasPane).
     *
     * There is no handoff to model for one of these: a typed message goes
     * straight into the pane, so the phone can always send and the composer
     * must never hint that control has to be taken first (BASED-113).
     */
    hasPane?: boolean | null;
}

export function resolveControlMode(
    controlledByUser: boolean | null | undefined,
    options?: ControlModeOptions,
): ControlMode {
    if (options?.hasPane === true) {
        return 'mobile';
    }
    return controlledByUser === true ? 'mobile' : 'desktop';
}

export function resolveControlHandoffDirection(
    previousControlledByUser: boolean | null | undefined,
    nextControlledByUser: boolean | null | undefined,
): ControlHandoffDirection | null {
    if (nextControlledByUser === true && previousControlledByUser !== true) {
        return 'desktop-to-mobile';
    }
    if (previousControlledByUser === true && nextControlledByUser === false) {
        return 'mobile-to-desktop';
    }
    return null;
}
