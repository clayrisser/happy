import { describe, expect, it, vi } from 'vitest';
import type { SpeechEngine } from './readAloud';
import { createRoutedSpeechEngine } from './routedSpeechEngine';
import type { Speaker } from './speaker';

function fake(): SpeechEngine & { spoken: string[]; stops: number } {
    const engine = {
        spoken: [] as string[],
        stops: 0,
        speak(text: string) {
            engine.spoken.push(text);
            return Promise.resolve(true);
        },
        stop() {
            engine.stops += 1;
            return Promise.resolve();
        },
    };
    return engine;
}

/**
 * AC: "Speaking never happens on both devices for one reply." The pick is
 * per sentence, the loser is stopped before the winner starts, and a reply
 * begins exactly once (DROVE-92).
 */
describe('createRoutedSpeechEngine', () => {
    it('speaks on the picked device and nowhere else', async () => {
        const phone = fake();
        const watch = fake();
        const engine = createRoutedSpeechEngine({ phone, watch, pick: () => 'watch' });
        await engine.speak('One.');
        await engine.speak('Two.');
        expect(watch.spoken).toEqual(['One.', 'Two.']);
        expect(phone.spoken).toEqual([]);
    });

    it('stops the device that was speaking before the other one starts', async () => {
        const phone = fake();
        const watch = fake();
        let who: Speaker = 'phone';
        const engine = createRoutedSpeechEngine({ phone, watch, pick: () => who });
        await engine.speak('On the phone.');
        who = 'watch';
        await engine.speak('Now the watch.');
        expect(phone.spoken).toEqual(['On the phone.']);
        expect(phone.stops).toBe(1);
        expect(watch.spoken).toEqual(['Now the watch.']);
        expect(watch.stops).toBe(0);
    });

    it('cues the wrist once per reply, with the device about to speak', async () => {
        const phone = fake();
        const watch = fake();
        const starts = vi.fn();
        const engine = createRoutedSpeechEngine({ phone, watch, pick: () => 'phone', onReplyStart: starts });
        await engine.speak('First sentence.');
        await engine.speak('Second sentence.');
        expect(starts).toHaveBeenCalledTimes(1);
        expect(starts).toHaveBeenCalledWith('phone');
        await engine.stop();
        await engine.speak('A new reply.');
        expect(starts).toHaveBeenCalledTimes(2);
    });

    it('stops only the device that spoke, and nothing when idle', async () => {
        const phone = fake();
        const watch = fake();
        const engine = createRoutedSpeechEngine({ phone, watch, pick: () => 'watch' });
        await engine.stop();
        expect(phone.stops + watch.stops).toBe(0);
        await engine.speak('Wrist.');
        await engine.stop();
        expect(watch.stops).toBe(1);
        expect(phone.stops).toBe(0);
    });
});
