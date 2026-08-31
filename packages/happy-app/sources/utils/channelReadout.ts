/**
 * The live readout of the announce channels and the mode (DROVE-75), read off
 * whatever DROVE-72 has landed so far.
 *
 * DROVE-72 puts five flat keys on the bus's machine defaults: announceVisual,
 * announceHaptic, announceAudio, answerAudio and mode. Two things on the phone
 * will carry them once the lanes merge: the `drover-policy get` reply's
 * `effective` block (PolicyValuesSchema is passthrough, so the app keeps keys
 * the CLI forwards) and the bridge session's `agentState.droverSettings`
 * mirror of the bus's settings frame. Neither exists on today's tip, and this
 * screen must not wait for them, so the reader takes ANY number of sources,
 * each of unknown shape, and says "not set" for a key none of them has.
 *
 * Pure, so the demo screen's readout is tested without React or the store.
 */

export type ChannelState = 'on' | 'off' | 'not set';

export interface ChannelReadout {
    visual: ChannelState;
    haptic: ChannelState;
    audio: ChannelState;
    /** `off` | `click` | `speech` | `both` once set; otherwise not set. */
    answerAudio: string;
    /** The saved combination's name, `none` when explicitly null, else not set. */
    mode: string;
}

export const channelKeys = {
    visual: 'announceVisual',
    haptic: 'announceHaptic',
    audio: 'announceAudio',
    answerAudio: 'answerAudio',
    mode: 'mode',
} as const;

function firstDefined(sources: unknown[], key: string): unknown {
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        const value = (source as Record<string, unknown>)[key];
        if (value !== undefined) return value;
    }
    return undefined;
}

function toggle(value: unknown): ChannelState {
    if (value === true || value === 'true') return 'on';
    if (value === false || value === 'false') return 'off';
    return 'not set';
}

/**
 * Read the channel toggles out of the first source that has each key. Earlier
 * sources win, so pass the freshest first (the RPC reply before the store).
 */
export function channelReadout(...sources: unknown[]): ChannelReadout {
    const answerAudio = firstDefined(sources, channelKeys.answerAudio);
    const mode = firstDefined(sources, channelKeys.mode);
    return {
        visual: toggle(firstDefined(sources, channelKeys.visual)),
        haptic: toggle(firstDefined(sources, channelKeys.haptic)),
        audio: toggle(firstDefined(sources, channelKeys.audio)),
        answerAudio: typeof answerAudio === 'string' && answerAudio ? answerAudio : 'not set',
        mode: mode === null ? 'none' : typeof mode === 'string' && mode ? mode : 'not set',
    };
}

/** True when nothing DROVE-72 defines has been read from anywhere. */
export function readoutIsEmpty(readout: ChannelReadout): boolean {
    return readout.visual === 'not set'
        && readout.haptic === 'not set'
        && readout.audio === 'not set'
        && readout.answerAudio === 'not set'
        && readout.mode === 'not set';
}

/**
 * The `droverSettings` mirror DROVE-72 hangs off the bridge session's agent
 * state, found without knowing which session is the bridge: the first session
 * whose agentState carries an object under that key. Undefined until the lane
 * that writes it merges, which the readout reads as "not set".
 */
export function findDroverSettings(sessions: Record<string, unknown> | readonly unknown[] | undefined | null): unknown {
    if (!sessions) return undefined;
    for (const session of Object.values(sessions)) {
        if (!session || typeof session !== 'object') continue;
        const agentState = (session as { agentState?: unknown }).agentState;
        if (!agentState || typeof agentState !== 'object') continue;
        const settings = (agentState as { droverSettings?: unknown }).droverSettings;
        if (settings && typeof settings === 'object') return settings;
    }
    return undefined;
}
