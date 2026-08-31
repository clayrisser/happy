/**
 * One hook behind the channel sheet and the Channels settings screen
 * (DROVE-72), so the two never disagree about what a switch means.
 *
 * Reads the phone's four switches out of the synced settings; on mount asks
 * the first Mac that answers for its own and adopts them; then keeps an eye
 * on the bridge session's mirrored `droverSettings` so a switch moved in a
 * terminal shows here without polling. Every write goes local first, then to
 * each connected Mac, and a refusal comes back as the bus's own sentence.
 */

import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { storage, useSettings } from '@/sync/storage';
import {
    listModes,
    modeFor,
    modesFromPolicy,
    togglesFromPolicy,
    togglesFromSettings,
    type ChannelToggleKey,
    type ChannelToggles,
} from '@/sync/droverChannels';
import { adoptFromBus, readBusChannels, switchMode, writeChannels, type BusChannels } from '@/sync/droverChannelsSync';

export interface DroverChannelsModel {
    toggles: ChannelToggles;
    /** The saved mode the switches spell, or null for a hand-set combination. */
    mode: string | null;
    modes: { name: string; toggles: ChannelToggles }[];
    setToggle: (key: ChannelToggleKey, value: ChannelToggles[ChannelToggleKey]) => Promise<void>;
    pickMode: (name: string) => Promise<void>;
    /** The bus's refusal sentence for the last write, or null. */
    error: string | null;
    /** "mirrored to 2 Macs" or null when no Mac is online. */
    mirroredTo: string | null;
    busy: boolean;
}

/**
 * The newest `droverSettings` block any session carries. The drover bridge
 * mirrors the bus's `settings` frame into its own session's agentState after
 * every write, so this is the live view of a Mac's switches.
 */
function useMirroredBusSettings(): Record<string, unknown> | null {
    return storage(useShallow((state) => {
        let newest: { capturedAt: number } & Record<string, unknown> | null = null;
        for (const session of Object.values(state.sessions ?? {})) {
            const block = session?.agentState?.droverSettings as ({ capturedAt: number } & Record<string, unknown>) | null | undefined;
            if (block && (!newest || block.capturedAt > newest.capturedAt)) newest = block;
        }
        return newest;
    }));
}

function useOnlineMachineCount(): number {
    return storage(useShallow((state) => Object.values(state.machines ?? {}).filter((m) => m.active).length));
}

export function useDroverChannels(): DroverChannelsModel {
    const settings = useSettings();
    const toggles = React.useMemo(() => togglesFromSettings(settings), [
        settings.droverAnnounceVisual,
        settings.droverAnnounceHaptic,
        settings.droverAnnounceAudio,
        settings.droverAnswerAudio,
    ]);
    const mirrored = useMirroredBusSettings();
    const online = useOnlineMachineCount();
    const [bus, setBus] = React.useState<BusChannels | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    // On open: the Mac's switches win over the phone's memory of them.
    React.useEffect(() => {
        let cancelled = false;
        void readBusChannels().then((result) => {
            if (cancelled) return;
            setBus(result);
            adoptFromBus(result);
        });
        return () => { cancelled = true; };
    }, []);

    // Live: a `settings` frame the bridge mirrored after a write anywhere.
    const lastMirroredAt = React.useRef<number>(0);
    React.useEffect(() => {
        if (!mirrored) return;
        const at = typeof mirrored.capturedAt === 'number' ? mirrored.capturedAt : 0;
        if (at <= lastMirroredAt.current) return;
        lastMirroredAt.current = at;
        const fromBus: BusChannels = {
            machineId: bus?.machineId ?? 'bridge',
            toggles: togglesFromPolicy(mirrored),
            modes: modesFromPolicy(mirrored),
            mode: typeof mirrored.mode === 'string' ? mirrored.mode : null,
        };
        setBus((prev) => ({ ...fromBus, modes: fromBus.modes ?? prev?.modes ?? null }));
        adoptFromBus(fromBus);
    }, [mirrored, bus?.machineId]);

    const modes = React.useMemo(() => listModes(bus?.modes), [bus?.modes]);
    const modeMap = React.useMemo(() => Object.fromEntries(modes.map((m) => [m.name, m.toggles])), [modes]);
    const mode = React.useMemo(() => modeFor(toggles, modeMap), [toggles, modeMap]);

    const setToggle = React.useCallback(async (key: ChannelToggleKey, value: ChannelToggles[ChannelToggleKey]) => {
        setBusy(true);
        setError(null);
        const refused = await writeChannels({ [key]: value } as Partial<ChannelToggles>);
        setBusy(false);
        setError(refused);
    }, []);

    const pickMode = React.useCallback(async (name: string) => {
        setBusy(true);
        setError(null);
        const refused = await switchMode(name, bus?.modes ?? null);
        setBusy(false);
        setError(refused);
    }, [bus?.modes]);

    const mirroredTo = online === 0 ? null : online === 1 ? 'mirrored to this Mac' : `mirrored to ${online} Macs`;

    return { toggles, mode, modes, setToggle, pickMode, error, mirroredTo, busy };
}
