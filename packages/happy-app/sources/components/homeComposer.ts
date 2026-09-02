import type { NewSessionAgentType } from '@/sync/persistence';
import {
    machineChoiceAgentAvailable,
    machineChoiceAgentVisible,
    type MachineChoice,
} from '@/sync/machineChoices';
import { HARNESS_ORDER, getHarnessName } from '@/utils/harnessCatalog';
import { getPermissionModeShortLabel } from '@/utils/permissionModeLabels';
import type { ModeOption } from './modelModeOptions';
import type { SessionPillLabel } from './sessionPillLabel';
import type { ComposerSessionPicker } from './ComposerSessionControls';

/**
 * WHAT HOME'S COMPOSER DRAWS, decided once for both places it is drawn
 * (DROVE-394).
 *
 * The sessions-list entry and the new-session sheet mount the same
 * `ComposerBubble` with the same capsule; the entry is the sheet's composer
 * rendered disabled. Both read their capsule props from `homeComposerCapsule`
 * so they cannot disagree, and `homeDockHarnessPick.test.ts` mounts the capsule
 * from the same catalog a harness pick reads.
 */

/** Why a harness is on the list but cannot be picked here. */
export function harnessUnavailableReason(key: NewSessionAgentType): string {
    return key === 'rig'
        ? 'Drover Agent is not running on this computer'
        : 'Not installed on this machine';
}

/**
 * The harness rows Home offers for this computer.
 *
 * Common harnesses stay listed but disabled when unavailable, so the picker
 * still reads as a choice. Antigravity, Cursor, Gemini and Pi stay absent until
 * this computer explicitly reports them installed (`machineChoiceAgentVisible`).
 */
export function homeHarnessOptions(
    choice: MachineChoice | null,
    agentType: NewSessionAgentType,
): ModeOption[] {
    const keys = (HARNESS_ORDER.includes(agentType) ? [...HARNESS_ORDER] : [agentType, ...HARNESS_ORDER])
        .filter((key) => machineChoiceAgentVisible(choice, key));
    return keys.map((key) => {
        const agent = { key, name: getHarnessName(key) };
        return machineChoiceAgentAvailable(choice, key)
            ? agent
            : { ...agent, disabled: true, description: harnessUnavailableReason(key) };
    });
}

/**
 * THE PICK, OR A REFUSAL (DROVE-394).
 *
 * Clay tapped Claude Code on the harness menu and Codex stayed ticked. The
 * row was `disabled` in the list Home built, the native menu drew it as any
 * other row, the pick was written to the draft, and the availability effect
 * (`resolveChoiceAgent`) wrote the first installed harness straight back.
 * Nothing on screen said why.
 *
 * So the pick is decided here, off the same rows the sheet draws: a key that
 * is not offered, or is offered disabled, is `null` and the caller refuses it
 * visibly rather than writing a value it is about to undo.
 */
export function resolveHarnessPick(
    options: readonly ModeOption[],
    key: string,
): NewSessionAgentType | null {
    const option = options.find((candidate) => candidate.key === key);
    if (!option || option.disabled) return null;
    return option.key as NewSessionAgentType;
}

export interface HomeComposerCapsuleInput {
    agent: { key: NewSessionAgentType; name: string };
    permission: ModeOption | null;
    permissionOptions: readonly ModeOption[];
    model: ModeOption | null;
    modelOptions: readonly ModeOption[];
    effort: ModeOption | null;
    effortOptions: readonly ModeOption[];
    /** The sheet's list, one row more than the model can run (DROVE-101). */
    effortPickerOptions: readonly ModeOption[];
}

export interface HomeComposerCapsule {
    label: SessionPillLabel;
    modeKey: string | undefined;
    effortIndex: number;
    effortCount: number;
    canOpen: Record<ComposerSessionPicker, boolean>;
}

/**
 * The capsule's props for a harness, from the options its pickers list.
 *
 * The same three values the three word-triggers carried before DROVE-345,
 * handed to the component the chat uses. `ComposerSessionControls` draws the
 * dial only where `effortCount` is above zero, which is how a harness with no
 * levels (Cursor) gets lock, speaker and its name and nothing else.
 */
export function homeComposerCapsule(input: HomeComposerCapsuleInput): HomeComposerCapsule {
    const permissionLabel = getPermissionModeShortLabel(input.permission);
    return {
        label: {
            mode: permissionLabel ?? input.permission?.name ?? null,
            model: input.model?.name ?? input.agent.name,
            effort: input.effort?.name ?? null,
            // The joined form is the status chip's, and Home has no chip.
            text: '',
        },
        modeKey: input.permission?.key,
        effortIndex: input.effortOptions.findIndex((option) => option.key === input.effort?.key),
        effortCount: input.effortOptions.length,
        canOpen: {
            permission: input.permissionOptions.length > 0,
            model: input.modelOptions.length > 0,
            effort: input.effortPickerOptions.length > 0,
        },
    };
}
