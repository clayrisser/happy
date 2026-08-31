/**
 * The phone's ANNOUNCE half of the haptic and audio channels (DROVE-72).
 *
 * Watches the store the way droverWatchFeed does, and for every gate that
 * was not there a moment ago reads `event.delivery.announce` off the card the
 * bridge mirrored: haptic means a taptic tap on the phone; audio means the
 * prompt's title and options spoken through drover-speech, DROVE-30's voice.
 * Visual needs nothing from here: the card, the inbox pill and the push
 * already are the visual announce.
 *
 * Fire and forget, both of them. An announcer that fails costs its own
 * announcement and never the session: nothing here can resolve, cancel or
 * delay a gate, and every failure lands in the log with its reason. That is
 * the rule the epic states and this file is one of the places it is kept.
 *
 * The ANSWER half of audio (a headphone click, a dictated pick) is not armed
 * here. DROVE-73 measured it: commands do not reach a backgrounded silent
 * app, so click-answer is a foreground session Clay starts by hand or a Siri
 * route, both their own lane. `plan.audioInput` is where that listener will
 * read what to arm.
 */

import { isDroverSpeechAvailable, speakUtterance } from 'drover-speech';

import { hapticsAnnounce } from '@/components/haptics';

import { storage } from './storage';
import { collectGateEntries } from './droverGates';
import { announceFor, newGateEntries, togglesFromSettings } from './droverChannels';

let started = false;

/**
 * Haptic for a prompt that wants a human: the "warning" pattern, two taps.
 *
 * This is THE notification haptic on the phone, and it is off unless Clay
 * turned `phoneHaptics` on (DROVE-190). The wrist still buzzes for the same
 * gate: that runs off `droverAnnounceHaptic`, which nothing here changes.
 */
function tap(): void {
    try {
        if (!hapticsAnnounce()) {
            console.log('[drover-announce] haptic skipped: phone haptics are off (DROVE-190)');
        }
    } catch (error) {
        // The web and a simulator have no taptic engine, and a device with
        // haptics off in Settings refuses too; none of these is news.
        console.log(`[drover-announce] haptic not delivered: ${String(error)}`);
    }
}

async function speak(text: string): Promise<void> {
    if (!isDroverSpeechAvailable()) {
        console.log('[drover-announce] audio announce skipped: this build has no speech module');
        return;
    }
    try {
        const finished = await speakUtterance(text);
        if (!finished) console.log('[drover-announce] audio announce was cut short');
    } catch (error) {
        console.log(`[drover-announce] audio announce failed: ${String(error)}`);
    }
}

/**
 * Start announcing. Idempotent. The first read after the store is ready
 * only seeds what is already there: a wall of gates that were waiting when
 * the app launched is not news, and the wrist filters the same way
 * (WristCueDiff.freshWindow).
 */
export function startDroverAnnounce(): () => void {
    if (started) return () => {};
    started = true;

    let known: Set<string> | null = null;

    const check = () => {
        const state = storage.getState();
        if (!state.isDataReady) return;
        const entries = collectGateEntries(state.sessions ?? {});
        const ids = new Set(entries.map((e) => e.gate.id));
        if (known === null) {
            known = ids;
            return;
        }
        const fresh = newGateEntries(known, entries);
        known = ids;
        if (!fresh.length) return;
        const local = togglesFromSettings(state.settings);
        // One tap and one sentence per batch, not per gate: three prompts
        // landing together are one interruption, and the sentence names the
        // first with a count for the rest.
        const plans = fresh.map((entry) => announceFor(entry, local));
        if (plans.some((p) => p.haptic)) tap();
        const spoken = plans.find((p) => p.speak);
        if (spoken?.speak) {
            const more = plans.filter((p) => p.speak).length - 1;
            void speak(more > 0 ? `${spoken.speak} And ${more} more.` : spoken.speak);
        }
        for (const plan of plans) {
            if (plan.audioInput) console.log(`[drover-announce] audio may answer by ${plan.audioInput}; no listener is armed for that yet (DROVE-73)`);
        }
    };

    const unsubscribe = storage.subscribe(check);
    check();
    return () => {
        unsubscribe();
        started = false;
        known = null;
    };
}
