import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveSessionState } from './sessionState';
import type { SessionState } from './sessionState';

/**
 * The wrist draws the state the PHONE resolved, and this pins the two ends of
 * that (DROVE-129).
 *
 * `resolveSessionState` is the phone's one precedence order and the watch
 * cannot import it, so droverWatchFeed sends the answer and `SessionState` in
 * DroverSnapshot.swift renders it. That leaves exactly one way to drift:
 * adding a sixth state on this side, or renaming one, and shipping a watch
 * binary that has never heard of it. The wrist would fall back to `active` for
 * that state — green or grey, silently, on Clay's wrist — which is the
 * DROVE-127 failure again with a different field.
 *
 * So the Swift enum is read here and checked against the union. Edit the
 * union, and this says which case to add to the Swift. Same arrangement
 * wristCues.spec.ts has with WristCue.swift, for the same reason.
 */
const swift = readFileSync(
    resolve(__dirname, '../../watch/DroverWatch/Shared/DroverSnapshot.swift'),
    'utf8',
);

/** The `enum SessionState: String` body, and nothing else in the file. */
function sessionStateBody(source: string): string {
    const start = source.indexOf('enum SessionState: String');
    expect(start, 'DroverSnapshot.swift declares enum SessionState').toBeGreaterThan(-1);
    const rest = source.slice(start);
    // Up to the closing brace of the enum: the first line that is a lone `}`
    // at column zero after the declaration.
    const end = rest.search(/\n\}/);
    return rest.slice(0, end === -1 ? undefined : end);
}

/** Every wire value the Swift enum accepts, `case waiting` included. */
function swiftStates(body: string): string[] {
    const out: string[] = [];
    for (const line of body.split('\n')) {
        const withRaw = /^\s*case (\w+) = "(\w+)"\s*$/.exec(line);
        if (withRaw) {
            out.push(withRaw[2]);
            continue;
        }
        const bare = /^\s*case (\w+)\s*$/.exec(line);
        if (bare) out.push(bare[1]);
    }
    return out;
}

/** `case .thinking: return "working"` and its siblings, per `var`. */
function swiftLabels(body: string, variable: string): Record<string, string> {
    const start = body.indexOf(`var ${variable}: String {`);
    expect(start, `DroverSnapshot.swift declares SessionState.${variable}`).toBeGreaterThan(-1);
    const block = body.slice(start, body.indexOf('\n    }', start));
    const out: Record<string, string> = {};
    for (const match of block.matchAll(/case ([^:]+): return "([^"]*)"/g)) {
        for (const name of match[1].split(',')) out[name.trim().replace(/^\./, '')] = match[2];
    }
    return out;
}

const body = sessionStateBody(swift);

/**
 * The union, spelled out. A new member of SessionState fails to compile here
 * until it is added, which is the point: the list is the checklist.
 */
const states: SessionState[] = [
    'disconnected',
    'waiting',
    'thinking',
    'permission_required',
    'input_required',
];

describe('the session state the wrist draws', () => {
    it('is exactly the phone SessionState union, no more and no fewer', () => {
        expect(swiftStates(body).sort()).toEqual([...states].sort());
    });

    it('gives every state a word, so none falls through to a blank line', () => {
        const labels = swiftLabels(body, 'label');
        expect(Object.keys(labels).length).toBe(states.length);
        for (const label of Object.values(labels)) expect(label).not.toBe('');
    });

    /**
     * The words are the phone's own, not a paraphrase. Clay's rule is that the
     * wrist may show LESS than the phone and must not show something
     * DIFFERENT, and two names for one state is what DROVE-129 exists to stop.
     */
    it('uses the phone status strings, not a wrist vocabulary', () => {
        const labels = swiftLabels(body, 'label');
        expect(labels.disconnected).toBe('offline');
        expect(labels.waiting).toBe('online');
        expect(labels.permissionRequired).toBe('permission required');
        expect(labels.inputRequired).toBe('waiting for your answer');
        // The phone's chat header picks a random verb for a busy turn, which
        // cannot go on a wire; `working` is what its live-status line calls a
        // turn it cannot name, and that is the phone string this borrows.
        expect(labels.thinking).toBe('working');
    });

    it('draws each state in the phone dot colour', () => {
        const tints = swiftLabels(body, 'tintHex');
        expect(tints.disconnected).toBe('999999');
        expect(tints.waiting).toBe('34C759');
        expect(tints.thinking).toBe('007AFF');
        expect(tints.permissionRequired).toBe('FF9500');
        expect(tints.inputRequired).toBe('FF9500');
    });

    /**
     * And the values the feed can actually produce are inside that set. This
     * is the half a hand-written list cannot fake: it runs the real resolver.
     */
    it('covers every state resolveSessionState can return', () => {
        const produced = new Set<string>([
            resolveSessionState({ agentState: null, thinking: false, isOnline: false }),
            resolveSessionState({ agentState: null, thinking: false, isOnline: true }),
            resolveSessionState({ agentState: null, thinking: true, isOnline: true }),
            resolveSessionState({
                agentState: { requests: { r1: {} } } as never,
                thinking: false,
                isOnline: true,
            }),
        ]);
        expect(produced.size).toBe(4);
        for (const state of produced) expect(swiftStates(body)).toContain(state);
    });
});
