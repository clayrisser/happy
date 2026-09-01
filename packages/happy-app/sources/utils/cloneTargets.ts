import { getHarnessName, isHarnessAvailable, type HarnessAvailability } from '@/utils/harnessCatalog';
import type { CloneTargetHarness } from '@/sync/ops';

/**
 * Where a clone STARTED FROM THE PHONE can land, and why it sometimes cannot
 * (DROVE-337).
 *
 * The rule this file exists to keep: a harness is offered only when the whole
 * path behind it exists. Three things have to be true, and each has its own
 * answer rather than a shared "unavailable":
 *
 *   1. `drover clone --to <harness>` has a lane. cursor got one in DROVE-337,
 *      opencode in DROVE-56, pi in DROVE-295.
 *   2. The daemon can SPAWN that harness, so the phone gets a session back
 *      rather than a tmux window and a wait. That is what leaves opencode off
 *      this list even though its clone lane works from a terminal.
 *   3. This particular machine reports the binary installed. The daemon
 *      publishes `cliAvailability`; a machine that predates the report says
 *      nothing for cursor and pi, and nothing means no.
 *
 * Refusals are returned as CODES, not sentences, so this module stays free of
 * `@/text` and therefore testable: that import reaches expo-localization and
 * through it react-native, which vitest cannot parse. The screen maps the
 * code to the string.
 */

/**
 * In pick order, which is the harness picker's own order narrowed to the
 * clone targets. Claude is first and is NOT dropped for a Claude source: a
 * Claude-to-Claude clone is a fresh context seeded with a summary, which is
 * the cheapest way out of a session that has compacted itself into a corner.
 */
export const CLONE_TARGET_ORDER: readonly CloneTargetHarness[] = ['claude', 'cursor', 'pi'];

export interface CloneTargetOption {
    key: CloneTargetHarness;
    name: string;
    available: boolean;
}

export function cloneTargetOptions(
    availability: HarnessAvailability | null | undefined,
): CloneTargetOption[] {
    return CLONE_TARGET_ORDER.map((key) => ({
        key,
        name: getHarnessName(key),
        available: isHarnessAvailable({
            availability,
            // No clone target is Happy's own agent, so the rig question never
            // arises here and answering it false cannot hide anything.
            happyAgentAvailable: false,
            key,
        }),
    }));
}

/**
 * Why this session cannot be cloned, or null when it can.
 *
 * Deliberately NOT folded into `canFork`. They fail for different reasons and
 * a shared boolean would make the menu offer one because the other happened
 * to be possible. A clone needs a CLAUDE conversation to export, because
 * `drover clone` reads a Claude transcript and nothing else; a fork needs a
 * transcript the target can resume.
 */
export type CloneRefusal = 'not-claude' | 'no-conversation' | 'machine-offline';

export function cloneRefusal(input: {
    flavor: string | null | undefined;
    claudeSessionId: string | null | undefined;
    machineOnline: boolean;
}): CloneRefusal | null {
    if (input.flavor && input.flavor !== 'claude') return 'not-claude';
    if (!input.claudeSessionId || input.claudeSessionId.trim().length === 0) return 'no-conversation';
    if (!input.machineOnline) return 'machine-offline';
    return null;
}
