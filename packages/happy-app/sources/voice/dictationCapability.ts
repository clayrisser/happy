/**
 * Whether this binary may open the mic at all (DROVE-105).
 *
 * The native module is optional and it has grown over four TestFlight
 * builds. The dangerous middle state is a module that STARTS a recording and
 * then reports nothing back: the banner goes red, the waveform sits flat,
 * the composer stays empty, and three sentences go nowhere. That is worse
 * than no mic, because it is silent. So the composer asks first, and a
 * module that cannot report refuses the press and says which build fixes it,
 * rather than recording into nothing.
 *
 * Pure, so the refusal is a table in a spec rather than something to feel
 * for on a phone.
 */
export interface DictationCapability {
    /** The native speech module is present in this binary. */
    moduleAvailable: boolean;
    /** It can report partial transcripts and the recogniser ending on its own. */
    reportsProgress: boolean;
    /** CFBundleVersion as the OS reports it, for the message. Null off-device. */
    build: string | null;
}

export type DictationBlock =
    /** No speech module at all: Android, web, a build made before it existed. */
    | { kind: 'unsupported' }
    /** The module is there but predates the reporting events. */
    | { kind: 'stale-build'; build: string | null };

/**
 * Null when the mic may open. Otherwise why it may not, for the composer to
 * say out loud.
 */
export function dictationBlock(capability: DictationCapability): DictationBlock | null {
    if (!capability.moduleAvailable) return { kind: 'unsupported' };
    if (!capability.reportsProgress) return { kind: 'stale-build', build: capability.build };
    return null;
}

/** What the build number reads as in the message when the OS will not say. */
export const unknownBuild = '?';
