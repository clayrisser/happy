import { Platform } from 'react-native';
import { ensureCueSession } from 'drover-speech';
import { cueSpec, type AudioCueId } from './audioCues';
import { base64Encode, renderCueWav } from './cueTone';

/**
 * The only file in the cue system that touches the device (DROVE-112).
 *
 * A cue is rendered once per launch per loudness step, written into the cache
 * directory and handed to an expo-audio player that is kept and replayed. The
 * rendering is the expensive part and it happens off the sound: the first play
 * of a cue is a shade late, every later one is instant.
 *
 * TWO THINGS THIS FILE MUST NEVER DO, both for the same reason — read-aloud
 * going silent is the worst outcome this feature can have, and DROVE-146 is a
 * live example of how quietly that happens:
 *
 *   1. It never ACTIVATES or deactivates the audio session, and — since
 *      DROVE-174 — it does not let expo-audio do it either. No
 *      setAudioModeAsync, no setIsAudioActiveAsync, and every player built with
 *      `keepAudioSessionActive: true`. See the note on that constant: the
 *      library's own default was what stopped the voice.
 *
 *      Since DROVE-341 it does set the CATEGORY, once, through
 *      `ensureCueSession`, and the distinction is the whole safety argument.
 *      Activation is what ducks and interrupts and tears down; a category on a
 *      session nobody has activated changes nothing audible. And it is a no-op
 *      whenever the session already belongs to read-aloud or to dictation, so
 *      the only case it touches is the one where a cue would otherwise play on
 *      `.soloAmbient` and be muted by the Ring/Silent switch.
 *   2. It never throws and never rejects. Everything is swallowed. A cue that
 *      cannot be made or cannot be played is a cue nobody hears, which is
 *      exactly what the volume slider at zero already means.
 *
 * THE LEVEL IS APPLIED EXACTLY ONCE (DROVE-341). The file is rendered at the
 * cue's own calibrated amplitude, which is fixed and has nothing to do with the
 * volume setting, and the setting is then the player's `volume` and nothing
 * else. It used to be both -- the caller multiplied the setting into the gain
 * it asked for, this file rendered AT that gain and ALSO set the player to it
 * -- so every cue played at the square of its intended level. The error is
 * 20*log10(level), which is worst exactly where it hurts: at the shipped
 * default of 0.35 the heartbeat came out sixteen dB under the voice, which is
 * what Clay heard.
 *
 * Rendering at a fixed amplitude also deletes two smaller faults the
 * quantisation carried. A cue whose effective level rounded below 0.05 rendered
 * an ALL-ZERO wav and cached it, silently, forever; and `warmCuePlayers` keyed
 * on the raw setting while `playCue` keyed on the setting times the gain, so
 * every cue with a gain under 1 was warmed under a key nothing ever played.
 * One file per cue, keyed by id, and both of those stop existing.
 */

interface CuePlayerHandle {
    play: () => void;
    seekTo: (seconds: number) => void;
    volume: number;
    remove?: () => void;
}

type CreatePlayer = (uri: string) => CuePlayerHandle;

/**
 * THE FIX FOR "the sound effects stop the talking" (DROVE-174).
 *
 * `cuePlayer.ts` never called into the audio session, and that was true and
 * beside the point: expo-audio does it for us. In AudioModule.swift every
 * player is built with `keepAudioSessionActive` defaulting to FALSE, which
 * wires `player.onPlaybackComplete = { self.deactivateSession() }`, and
 * `deactivateSession` waits 100ms and then calls
 *
 *     AVAudioSession.sharedInstance().setActive(false, [.notifyOthersOnDeactivation])
 *
 * as long as no EXPO-AUDIO player is playing. It never asks whether
 * AVSpeechSynthesizer is speaking, because it has no idea the synthesiser
 * exists. `Function("pause")` does the same thing.
 *
 * So every cue armed a teardown of the shared session 100ms after it finished,
 * and any utterance that started inside that window was cut or wedged. That is
 * DROVE-146's bug exactly — an audio-session change under a running utterance
 * — arriving from a library rather than from our own code, which is why the
 * comment above swore it could not happen.
 *
 * `keepAudioSessionActive: true` deletes both call sites. The session then
 * belongs to DroverSpeechModule alone, which is the only thing that should
 * ever have owned it.
 */
const keepAudioSessionActive = true;

interface Entry {
    handle: CuePlayerHandle | null;
    /** A render is in flight; a second ask must not start another. */
    loading: boolean;
}

const players = new Map<string, Entry>();

/**
 * Load the modules by hand rather than at the top of the file.
 *
 * This module is imported by the cue service, which is imported by the reader,
 * which is imported by sync. On web and under vitest there is no expo-audio
 * native side at all, and a module-level import would take those down on a
 * feature that is meant to be additive.
 */
function nativeModules(): { create: CreatePlayer; write: (uri: string, base64: string) => Promise<void>; cacheDir: string } | null {
    if (Platform.OS === 'web') return null;
    try {
        const audio = require('expo-audio') as {
            createAudioPlayer: (source: { uri: string }, options?: { keepAudioSessionActive?: boolean }) => CuePlayerHandle;
        };
        const fs = require('expo-file-system/legacy') as {
            writeAsStringAsync: (uri: string, contents: string, options: { encoding: string }) => Promise<void>;
            cacheDirectory: string | null;
            EncodingType: { Base64: string };
        };
        if (!fs.cacheDirectory) return null;
        return {
            create: (uri: string) => audio.createAudioPlayer({ uri }, { keepAudioSessionActive }),
            write: (uri, base64) => fs.writeAsStringAsync(uri, base64, { encoding: fs.EncodingType.Base64 }),
            cacheDir: fs.cacheDirectory,
        };
    } catch {
        return null;
    }
}

let modules: ReturnType<typeof nativeModules> | undefined;

function loaded() {
    if (modules === undefined) modules = nativeModules();
    return modules;
}

/**
 * Render one cue to the cache and hand back a player for it.
 *
 * The amplitude comes from the cue table and nowhere else, so the file on disk
 * is the same file whatever the volume setting is doing. That is what makes one
 * cache entry per cue correct, and what keeps `warmCuePlayers` and `playCue`
 * looking at the same one.
 */
async function build(
    native: NonNullable<ReturnType<typeof nativeModules>>,
    id: AudioCueId,
): Promise<CuePlayerHandle> {
    const spec = cueSpec(id);
    const wav = renderCueWav(spec, spec.amplitude);
    const uri = `${native.cacheDir}drover-cue-${encodeURIComponent(id)}.wav`;
    await native.write(uri, base64Encode(wav));
    return native.create(uri);
}

/**
 * Play one cue at one loudness. Returns nothing and settles nothing: the mixer
 * times the sound from the table rather than waiting on the device, so a
 * player that never answers cannot wedge the queue.
 */
export function playCue(id: AudioCueId, volume: number): void {
    const level = Math.max(0, Math.min(1, volume));
    if (level <= 0) return;
    const native = loaded();
    if (native === null) return;
    // The voice's category, or nothing at all on a binary without the native
    // function — which is every build before this one, and where the cue plays
    // exactly where it played before (DROVE-341).
    try {
        ensureCueSession();
    } catch {
        // Never let routing take a sound, let alone the reader, down.
    }
    const existing = players.get(id);
    if (existing?.handle) {
        try {
            existing.handle.volume = level;
            existing.handle.seekTo(0);
            existing.handle.play();
        } catch {
            // A player the OS tore down. Drop it; the next ask rebuilds it.
            players.delete(id);
        }
        return;
    }
    if (existing?.loading) return;
    players.set(id, { handle: null, loading: true });
    void (async () => {
        try {
            const handle = await build(native, id);
            handle.volume = level;
            players.set(id, { handle, loading: false });
            handle.play();
        } catch {
            // No sound this time. Clearing the entry rather than leaving it
            // marked loading means a later attempt can still succeed.
            players.delete(id);
        }
    })();
}

/**
 * Render and hold every cue at one loudness, without playing any of them.
 *
 * `createAudioPlayer` has to read the file before it can make a sound, so the
 * FIRST play of a cue can be swallowed while that happens. A heartbeat that is
 * missing its first beat every time read-aloud is switched on is exactly the
 * kind of small wrongness that makes a sound untrustworthy, so the work is
 * done when reading starts rather than when the first pulse is due.
 */
export function warmCuePlayers(ids: readonly AudioCueId[], volume: number): void {
    const level = Math.max(0, Math.min(1, volume));
    if (level <= 0) return;
    const native = loaded();
    if (native === null) return;
    for (const id of ids) {
        if (players.has(id)) continue;
        players.set(id, { handle: null, loading: true });
        void (async () => {
            try {
                const handle = await build(native, id);
                handle.volume = level;
                players.set(id, { handle, loading: false });
            } catch {
                players.delete(id);
            }
        })();
    }
}

/** Drop every cached player. Used when the cue system is switched off. */
export function releaseCuePlayers(): void {
    for (const entry of players.values()) {
        try {
            entry.handle?.remove?.();
        } catch {
            // Already gone.
        }
    }
    players.clear();
}
