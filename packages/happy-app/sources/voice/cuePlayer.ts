import { Platform } from 'react-native';
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
 *   1. It never touches the audio SESSION, and — since DROVE-174 — it does not
 *      let expo-audio touch it either. No setAudioModeAsync, no
 *      setIsAudioActiveAsync, and every player built with
 *      `keepAudioSessionActive: true`. See the note on that constant: the
 *      library's own default was what stopped the voice.
 *   2. It never throws and never rejects. Everything is swallowed. A cue that
 *      cannot be made or cannot be played is a cue nobody hears, which is
 *      exactly what the volume slider at zero already means.
 *
 * Loudness is quantised to ten steps so that dragging the volume slider does
 * not render a new file per pixel; expo-audio's own `volume` then does the
 * fine adjustment on top.
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

/** Ten steps is finer than an ear notices and coarse enough to cache. */
function volumeStep(volume: number): number {
    return Math.max(0, Math.min(10, Math.round(volume * 10)));
}

function keyFor(id: AudioCueId, volume: number): string {
    return `${id}@${volumeStep(volume)}`;
}

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
 * Play one cue at one loudness. Returns nothing and settles nothing: the mixer
 * times the sound from the table rather than waiting on the device, so a
 * player that never answers cannot wedge the queue.
 */
export function playCue(id: AudioCueId, volume: number): void {
    if (volume <= 0) return;
    const native = loaded();
    if (native === null) return;
    const key = keyFor(id, volume);
    const existing = players.get(key);
    if (existing?.handle) {
        try {
            existing.handle.volume = Math.max(0, Math.min(1, volume));
            existing.handle.seekTo(0);
            existing.handle.play();
        } catch {
            // A player the OS tore down. Drop it; the next ask rebuilds it.
            players.delete(key);
        }
        return;
    }
    if (existing?.loading) return;
    players.set(key, { handle: null, loading: true });
    void (async () => {
        try {
            const wav = renderCueWav(cueSpec(id), volumeStep(volume) / 10);
            const uri = `${native.cacheDir}drover-cue-${key.replace('@', '-')}.wav`;
            await native.write(uri, base64Encode(wav));
            const handle = native.create(uri);
            handle.volume = Math.max(0, Math.min(1, volume));
            players.set(key, { handle, loading: false });
            handle.play();
        } catch {
            // No sound this time. Clearing the entry rather than leaving it
            // marked loading means a later attempt can still succeed.
            players.delete(key);
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
    if (volume <= 0) return;
    const native = loaded();
    if (native === null) return;
    for (const id of ids) {
        const key = keyFor(id, volume);
        if (players.has(key)) continue;
        players.set(key, { handle: null, loading: true });
        void (async () => {
            try {
                const wav = renderCueWav(cueSpec(id), volumeStep(volume) / 10);
                const uri = `${native.cacheDir}drover-cue-${key.replace('@', '-')}.wav`;
                await native.write(uri, base64Encode(wav));
                const handle = native.create(uri);
                handle.volume = Math.max(0, Math.min(1, volume));
                players.set(key, { handle, loading: false });
            } catch {
                players.delete(key);
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
