/**
 * The wrist's haptic vocabulary, mirrored for the phone (DROVE-75).
 *
 * WristCue.swift is the source of truth: it is what the watch plays when a
 * gate lands, and the whole point of the demo screen is to let Clay feel THOSE
 * patterns without waiting for a gate. A phone cannot run the Swift, so the
 * table is copied here, and wristCues.spec.ts parses the Swift file and fails
 * the moment the two disagree. Edit the Swift; the spec says what to copy.
 *
 * The phone's taptic engine is not the watch's. WKHapticType has textures
 * (`retry`, `directionUp`) that UIKit's feedback generators do not, so each
 * beat is mapped to the nearest phone feedback in haptics.ts. Count and gap
 * carry over exactly, and count is what a sleeve leaves you with anyway.
 */

/** Mirrors `WristBeat` in WristCue.swift. */
export type WristBeat = 'notification' | 'directionUp' | 'retry' | 'success' | 'failure';

/** Mirrors `WristCue`. `wire` is the Swift raw value, the bus `kind`. */
export interface WristCueSpec {
    cue: 'needsYou' | 'question' | 'permission' | 'expiry' | 'finished';
    wire: string;
    /** `headline` in the Swift, the notification title. */
    headline: string;
    /** Most urgent first; mirrors `rank`. */
    rank: number;
    beats: WristBeat[];
    /** What the pattern is for, on the demo row. */
    meaning: string;
}

/** Mirrors `beatGap` in the Swift: seconds between beats. */
export const wristBeatGap = 0.35;

/**
 * Most urgent first, the order the wrist ranks them and the order the demo
 * plays them back to back.
 */
export const wristCues: readonly WristCueSpec[] = [
    {
        cue: 'needsYou',
        wire: 'todo',
        headline: 'Do something',
        rank: 4,
        beats: ['notification', 'retry', 'retry'],
        meaning: 'An agent asked you to do something. Three taps.',
    },
    {
        cue: 'question',
        wire: 'question',
        headline: 'Question',
        rank: 3,
        beats: ['notification', 'directionUp'],
        meaning: 'A session is blocked on an answer. Two taps, the second lighter.',
    },
    {
        cue: 'permission',
        wire: 'permission',
        headline: 'Permission',
        rank: 2,
        beats: ['notification'],
        meaning: 'A yes/no gate on an action. One tap.',
    },
    {
        cue: 'expiry',
        wire: 'expiry',
        headline: 'Account limit',
        rank: 1,
        beats: ['failure'],
        meaning: 'An account is running out of usage or auth. One rough tap.',
    },
    {
        cue: 'finished',
        wire: 'finished',
        headline: 'Session finished',
        rank: 0,
        beats: ['success'],
        meaning: 'A session stopped running. One soft tap; never breaks a Focus.',
    },
];

/** How long a pattern takes to play, so back-to-back playback can wait it out. */
export function wristCueDurationMs(spec: WristCueSpec): number {
    return Math.max(0, spec.beats.length - 1) * wristBeatGap * 1000;
}

/**
 * Pull the cue table out of WristCue.swift's source, for the spec that pins
 * this file to it. A small hand parser rather than a Swift toolchain: the
 * lines it reads are `case .needsYou: return [.notification, .retry, .retry]`
 * and their siblings, which is regular enough to match and specific enough to
 * break loudly if the Swift is restructured.
 */
export function parseWristCueSwift(source: string): {
    beats: Record<string, WristBeat[]>;
    ranks: Record<string, number>;
    headlines: Record<string, string>;
    rawValues: Record<string, string>;
    beatGap: number | null;
} {
    const beats: Record<string, WristBeat[]> = {};
    const ranks: Record<string, number> = {};
    const headlines: Record<string, string> = {};
    const rawValues: Record<string, string> = {};
    for (const line of source.split('\n')) {
        const beat = /case \.(\w+): return \[([^\]]*)\]/.exec(line);
        if (beat) {
            beats[beat[1]] = beat[2]
                .split(',')
                .map((b) => b.trim().replace(/^\./, ''))
                .filter(Boolean) as WristBeat[];
            continue;
        }
        const rank = /case \.(\w+): return (\d+)$/.exec(line.trim());
        if (rank) {
            ranks[rank[1]] = Number(rank[2]);
            continue;
        }
        const headline = /case \.(\w+): return "([^"]*)"/.exec(line);
        if (headline) {
            headlines[headline[1]] = headline[2];
            continue;
        }
        const raw = /^\s*case (\w+) = "(\w+)"/.exec(line);
        if (raw) {
            rawValues[raw[1]] = raw[2];
            continue;
        }
        const bare = /^\s*case (\w+)\s*$/.exec(line);
        if (bare && !(bare[1] in rawValues)) {
            rawValues[bare[1]] = bare[1];
        }
    }
    const gap = /var beatGap: TimeInterval \{ ([\d.]+) \}/.exec(source);
    return { beats, ranks, headlines, rawValues, beatGap: gap ? Number(gap[1]) : null };
}

/**
 * A gate the phone publishes to make the WRIST play `spec` on demand
 * (DROVE-75), through the real path: it lands in a snapshot, WristCueDiff
 * sees a fresh gate of this kind, and WristBuzzer plays the pattern. No
 * native change is needed for that, which is why the phone's demo uses it.
 *
 * The id is in the demo namespace with a stamp, so the watch's dedupe treats
 * every tap as a new arrival, and every refusal on the phone (droverWatchFeed
 * drops a `demo:` answer) and the Mac (droverBridge refuses one) applies if
 * the wrist answers it. `finished` is not a gate kind and cannot be summoned
 * this way; the caller checks `canBuzzWatch` first.
 */
export function canBuzzWatch(spec: WristCueSpec): boolean {
    return spec.cue !== 'finished';
}

export interface DemoBuzzGate {
    id: string;
    title: string;
    reason: string;
    preview: string;
    kind: string;
    createdAt: string;
    account: string;
}

export function demoBuzzGate(spec: WristCueSpec, now: number = Date.now()): DemoBuzzGate {
    return {
        id: `demo:buzz-${spec.cue}-${now}`,
        title: `Demo · ${spec.headline}`,
        reason: 'the phone\'s channel demo',
        preview: `${spec.beats.length} ${spec.beats.length === 1 ? 'beat' : 'beats'}: ${spec.meaning}`,
        kind: spec.wire,
        createdAt: new Date(now).toISOString(),
        account: 'demo',
    };
}

/**
 * WHAT THE WRIST WILL ACTUALLY FEEL, said on the phone (DROVE-124).
 *
 * The patterns above are only ever played by `WKInterfaceDevice.play`, and
 * watchOS runs that only while the watch app is FRONTMOST. Closed, the wrist
 * gets a watch-local notification instead and watchOS picks the haptic, so
 * every kind feels identical and only the card differs. Closed with no wake
 * budget, it gets nothing until it is raised.
 *
 * Three very different outcomes that are indistinguishable from the wrist, so
 * the phone has to be the one to say which is live. Mirrors `WristReach` in
 * Swift: that file decides it on the watch, this one reports it on the phone.
 */
export type WristFidelity = 'pattern' | 'systemTap' | 'silent' | 'none';

export interface WristFidelityVerdict {
    fidelity: WristFidelity;
    /** Short enough for a row title. */
    headline: string;
    /** What is really happening and, when it is bad news, what to do. */
    detail: string;
}

/**
 * `reachable` is WatchConnectivity's own answer to "is the watch app
 * frontmost": on iOS it is true exactly when the paired watch is in range and
 * the counterpart app is running in the foreground. So it is not a guess at
 * the state the Swift branches on, it IS that state, read from the other end.
 */
export function describeWristFidelity(status: {
    paired: boolean;
    installed: boolean;
    reachable: boolean;
    wakes?: number;
} | null | undefined): WristFidelityVerdict {
    if (!status || !status.paired || !status.installed) {
        return {
            fidelity: 'none',
            headline: 'No wrist to reach',
            detail: 'No paired watch with Cattle Drover installed, so nothing here reaches a wrist.',
        };
    }
    if (status.reachable) {
        return {
            fidelity: 'pattern',
            headline: 'Full pattern',
            detail: 'The watch app is open, so the wrist plays Drover\'s own pattern and each kind feels different.',
        };
    }
    // An absent budget is an older native module that never reported one.
    // Read as a wake being possible, because calling the wrist dead on a build
    // that simply cannot count is the worse error.
    if (status.wakes === 0) {
        return {
            fidelity: 'silent',
            headline: 'Quiet until you raise it',
            detail: 'The watch app is closed and this phone has no background wakes left. Put the Drover complication on a watch face; with it on none, the budget is zero all day.',
        };
    }
    return {
        fidelity: 'systemTap',
        headline: 'One tap, watchOS picks it',
        detail: 'The watch app is closed, so it taps once with watchOS\'s own haptic and shows the card. The per-kind patterns need the app on screen.',
    };
}
