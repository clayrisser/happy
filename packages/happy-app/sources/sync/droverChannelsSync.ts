/**
 * Keeping this phone's channel switches and the bus's in step (DROVE-72).
 *
 * The phone's switches live in the synced settings (settings.ts, the
 * `droverAnnounce*` keys) so the sheet renders at once and works with no Mac
 * in reach. The bus's live in `~/.local/state/cattle-drover/session-settings.json`
 * on each Mac, and that is where an event's `delivery` is stamped for the
 * terminal, the push and the wrist. Two stores, one rule: a write here goes
 * to both, and a read from the bus wins on open, because a terminal may have
 * moved a switch (`drover settings mode silent-haptic`) since the phone last
 * looked.
 *
 * Every Mac, not one. Clay described the toggles as global; the store is per
 * machine, so "global" is spelled by writing the same patch to each connected
 * daemon. A Mac that does not answer costs nothing but that Mac: the local
 * switch has already moved and the next sitting at that Mac will re-mirror.
 */

import { storage } from './storage';
import { sync } from './sync';
import { machineDroverPolicy } from './droverPolicy';
import type { PolicyPatch } from '@/utils/droverPolicyLayers';
import {
    BUILT_IN_MODES,
    modesFromPolicy,
    settingsPatchFor,
    togglesForMode,
    togglesFromPolicy,
    togglesFromSettings,
    type ChannelToggles,
} from './droverChannels';

export interface BusChannels {
    machineId: string;
    toggles: Partial<ChannelToggles>;
    modes: Record<string, ChannelToggles> | null;
    mode: string | null;
}

function onlineMachineIds(): string[] {
    const state = storage.getState();
    return Object.values(state.machines ?? {})
        .filter((m) => m.active)
        .sort((a, b) => b.activeAt - a.activeAt)
        .map((m) => m.id);
}

/**
 * Write a patch of the four switches: locally first, then to every online
 * Mac. Resolves with the first refusal sentence, or null when every Mac that
 * answered took it. A Mac that did not answer is logged, not surfaced: the
 * switch in Clay's hand has moved, which is the part he can see.
 */
export async function writeChannels(patch: Partial<ChannelToggles>): Promise<string | null> {
    const local = settingsPatchFor(patch);
    if (Object.keys(local).length) sync.applySettings(local);
    return mirrorToMachines(patch as PolicyPatch);
}

/**
 * Switch onto a saved mode. The bus expands `mode` into the four keys in one
 * write and keeps the label; the phone sets the four keys it knows for that
 * name so the sheet agrees before the bus has answered.
 */
export async function switchMode(
    name: string,
    modes: Record<string, ChannelToggles> | null,
): Promise<string | null> {
    const row = togglesForMode(name, modes ?? BUILT_IN_MODES) ?? togglesForMode(name);
    if (row) sync.applySettings(settingsPatchFor(row));
    return mirrorToMachines({ mode: name } as PolicyPatch);
}

async function mirrorToMachines(patch: PolicyPatch): Promise<string | null> {
    const ids = onlineMachineIds();
    if (!ids.length) return null;
    const results = await Promise.all(ids.map(async (machineId) => {
        const result = await machineDroverPolicy(machineId, { scope: 'defaults', action: 'set', patch, by: 'phone' });
        if (!result.ok) {
            console.log(`[drover-channels] ${machineId.slice(0, 8)} refused ${JSON.stringify(patch)}: ${result.error ?? 'no reason given'}`);
        }
        return result;
    }));
    // A refusal names the bus's own sentence (an unknown mode, a key that is
    // not a switch). "did not answer" is a Mac asleep or a CLI older than the
    // keys, which is not a refusal of the change and stays in the log.
    const refused = results.find((r) => !r.ok && r.error && !/did not answer/i.test(r.error));
    return refused?.error ?? null;
}

/**
 * Read the switches and the saved modes off the first Mac that answers.
 * Null when none does, in which case the phone's own switches stand.
 */
export async function readBusChannels(): Promise<BusChannels | null> {
    for (const machineId of onlineMachineIds()) {
        const result = await machineDroverPolicy(machineId, { scope: 'defaults', action: 'get' });
        const defaults = result.policy?.defaults as Record<string, unknown> | undefined;
        if (!result.ok || !defaults) continue;
        const toggles = togglesFromPolicy(defaults);
        // A CLI older than the keys answers with the five flip keys and none
        // of these; that is not a bus saying "all off", it is a bus that does
        // not know, and the phone's own switches stand.
        if (!Object.keys(toggles).length) continue;
        return {
            machineId,
            toggles,
            modes: modesFromPolicy(defaults),
            mode: typeof defaults.mode === 'string' ? defaults.mode : null,
        };
    }
    return null;
}

/**
 * Adopt the bus's switches into the phone's when they differ. The bus is
 * the source of truth for what the next event will be stamped with, and a
 * sheet that shows the phone's memory of last week over the Mac's setting
 * from this morning is a sheet Clay cannot trust.
 */
export function adoptFromBus(bus: BusChannels | null): void {
    if (!bus) return;
    const local = togglesFromSettings(storage.getState().settings);
    const patch: Partial<ChannelToggles> = {};
    for (const key of Object.keys(bus.toggles) as (keyof ChannelToggles)[]) {
        const value = bus.toggles[key];
        if (value !== undefined && value !== local[key]) (patch as Record<string, unknown>)[key] = value;
    }
    const settingsPatch = settingsPatchFor(patch);
    if (Object.keys(settingsPatch).length) sync.applySettings(settingsPatch);
}
