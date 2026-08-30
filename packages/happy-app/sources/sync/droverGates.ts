/**
 * Pending gates, collected once for every surface that shows them (BASED-98).
 *
 * Lives apart from droverWatchFeed so a SCREEN can read the same list the
 * wrist reads. Importing the feed from a component would pull in the
 * WatchConnectivity native module and trip the feed's module-level `started`
 * flag as a side effect of rendering, which is how a second feed would start
 * publishing snapshots nobody asked for.
 *
 * `DroverGate` is a TYPE-ONLY import for the same reason: the value side of
 * 'drover-watch' calls requireOptionalNativeModule at module load.
 *
 * Answering a gate is NOT this file's job. Every surface answers through the
 * app's own sessionAllow / sessionDeny, so there is no second decision path to
 * keep in sync.
 */

import { storage } from './storage';
import type { DroverGate, DroverGateOption } from 'drover-watch';

const PREVIEW_LIMIT = 240;

interface QuestionCard {
    question?: string;
    header?: string;
    options?: unknown;
}

/** The first question on an AskUserQuestion card, drover-mirrored or Claude's own. */
function firstQuestion(args: unknown): QuestionCard | null {
    const questions = (args as { questions?: unknown } | undefined)?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return null;
    const first = questions[0] as QuestionCard;
    return first && typeof first === 'object' ? first : null;
}

export function previewFor(tool: string, args: unknown): string {
    const input = (args ?? {}) as Record<string, unknown>;
    // A question card carries no `command`: its body lives in
    // questions[0].question. Without this the wrist showed the raw JSON of the
    // whole card, which is unreadable at that size and buries the actual ask.
    const question = firstQuestion(args)?.question;
    const raw =
        typeof question === 'string' ? question
        : typeof input.command === 'string' ? input.command
        : typeof input.file_path === 'string' ? input.file_path
        : typeof input.description === 'string' ? input.description
        : JSON.stringify(input);
    const text = raw ?? '';
    return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

/**
 * What a question can be answered WITH, as the wrist needs them.
 *
 * Without this the watch could only ever send a bare allow, which the bus
 * refuses on a question ("a question needs an option or text", 409) or, on an
 * older bus, takes with no answer at all — every surface dismisses and the
 * waiting hook gets nothing to inject. Bus event "Step 1 order" (2026-08-29)
 * was that second one: a wrist tap that travelled the whole way and still lost
 * the answer.
 *
 * The card's own shape is `{label, description?}` — happy-cli drops the bus's
 * option ids when it mirrors a question through the phone's AskUserQuestion
 * card, and Claude's native cards never had them — so `id` is carried only
 * when it is actually there. A label answers just as well; the CLI matches on
 * either.
 */
export function optionsFor(args: unknown): DroverGateOption[] {
    const raw = firstQuestion(args)?.options;
    if (!Array.isArray(raw)) return [];
    const out: DroverGateOption[] = [];
    for (const entry of raw) {
        const option = entry as { id?: unknown; label?: unknown; description?: unknown };
        if (!option || typeof option !== 'object') continue;
        if (typeof option.label !== 'string' || !option.label) continue;
        out.push({
            label: option.label,
            // Omitted, never null: WatchConnectivity payloads take
            // property-list types only and JSON null becomes NSNull, which
            // fails the WHOLE publish — one null here and the wrist loses
            // every gate, not just this option.
            ...(typeof option.id === 'string' && option.id ? { id: option.id } : {}),
            ...(typeof option.description === 'string' && option.description
                ? { description: option.description }
                : {}),
        });
    }
    return out;
}

/** Wrist-sized title: the question's own header beats a generic "Question". */
export function titleFor(tool: string, args: unknown): string {
    if (tool !== 'AskUserQuestion') return `Run ${tool}`;
    const header = firstQuestion(args)?.header;
    return typeof header === 'string' && header.trim() ? header : 'Question';
}

/**
 * A gate plus the keys an answer needs.
 *
 * The wrist only ever needed the gate, because it routes on the packed
 * `${sessionId}:${requestId}` id. A screen calls sessionAllow / sessionDeny
 * directly, so it needs both halves unpacked, and it needs `args` to render
 * the question's own options rather than a preview of them.
 */
export interface DroverGateEntry {
    gate: DroverGate;
    sessionId: string;
    requestId: string;
    tool: string;
    args: unknown;
}

/**
 * Only the fields a gate is built from. Narrower than storageTypes' `Session`
 * on purpose, so a test can hand in three keys instead of a whole session; the
 * default argument below is what proves the real shape still fits.
 */
export interface GateSession {
    agentState?: { requests?: Record<string, unknown> | null } | null;
    metadata?: {
        path?: string;
        summary?: { text: string } | null;
        droverAccount?: string;
    } | null;
}

/**
 * When a gate that never stamped its own `createdAt` was first seen here.
 *
 * The feed took `Date.now()` inline, and that was safe for the wrist because
 * the wrist compares gates by id alone. A SCREEN reads this through
 * `useDeepEqual`, and a timestamp that moves every millisecond never compares
 * equal: render, re-read, differ, render, until React gives up with "Maximum
 * update depth exceeded". `createdAt` is nullish in AgentStateSchema, so this
 * is not hypothetical — one request from a CLI that did not stamp it would
 * take the home screen down. First sighting is stable and still honest about
 * what the field means.
 */
const firstSeenAt = new Map<string, number>();

function createdAtFor(gateId: string, createdAt: number | undefined | null): number {
    if (typeof createdAt === 'number') return createdAt;
    const seen = firstSeenAt.get(gateId);
    if (seen !== undefined) return seen;
    const now = Date.now();
    firstSeenAt.set(gateId, now);
    return now;
}

/** Every pending request in storage, flattened into gates with their routing keys. */
export function collectGateEntries(
    sessions: Record<string, GateSession | undefined> = storage.getState().sessions ?? {},
): DroverGateEntry[] {
    const entries: DroverGateEntry[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
        const requests = session?.agentState?.requests;
        if (!requests) continue;
        for (const [requestId, request] of Object.entries(requests)) {
            const tool = (request as { tool?: string }).tool ?? 'Tool';
            const args = (request as { arguments?: unknown }).arguments;
            const createdAt = createdAtFor(
                `${sessionId}:${requestId}`,
                (request as { createdAt?: number | null }).createdAt,
            );
            const account = session?.metadata?.droverAccount;
            const options = optionsFor(args);
            entries.push({
                sessionId,
                requestId,
                tool,
                args,
                gate: {
                    id: `${sessionId}:${requestId}`,
                    title: titleFor(tool, args),
                    reason: session?.metadata?.summary?.text ?? session?.metadata?.path ?? '',
                    preview: previewFor(tool, args),
                    kind: tool === 'AskUserQuestion' ? 'question' : 'permission',
                    createdAt: new Date(createdAt).toISOString(),
                    // Omitted, never null: WatchConnectivity payloads take
                    // property-list types only and JSON null becomes NSNull,
                    // which fails the whole publish. Swift sanitizes too, but
                    // not emitting it is the honest fix.
                    ...(account ? { account } : {}),
                    // Same rule, and the same reason an empty array is dropped
                    // rather than sent: the watch reads a missing key as "this
                    // one is not answerable here" and says so, which is the
                    // truth.
                    ...(options.length ? { options } : {}),
                },
            });
        }
    }
    // Answered gates never come back, so their first-sighting entry is dead
    // weight; a long-running app would otherwise grow this map for the life of
    // the process.
    if (firstSeenAt.size > entries.length) {
        const live = new Set(entries.map((entry) => entry.gate.id));
        for (const id of firstSeenAt.keys()) {
            if (!live.has(id)) firstSeenAt.delete(id);
        }
    }
    return entries;
}

/** Every pending request in storage, flattened into wrist-sized gates. */
export function collectGates(
    sessions: Record<string, GateSession | undefined> = storage.getState().sessions ?? {},
): DroverGate[] {
    return collectGateEntries(sessions).map((entry) => entry.gate);
}

/**
 * The gates raised by ONE session, oldest first (BASED-113).
 *
 * The session view presents its own gates in place, so it must never be handed
 * another session's. Narrowing the map to a single entry BEFORE collecting is
 * what makes that structural rather than a filter someone can later forget:
 * collectGateEntries cannot emit a gate for a session it was never given.
 * Driving several sessions at once is the normal case here, and a prompt from
 * the one you are not looking at stealing the screen is worse than the walk to
 * the gates list.
 */
export function gatesForSession(
    sessions: Record<string, GateSession | undefined>,
    sessionId: string,
): DroverGateEntry[] {
    const session = sessions[sessionId];
    if (!session) return [];
    return sortGateEntries(collectGateEntries({ [sessionId]: session }));
}

/**
 * Oldest first. A gate that has been waiting longest is the one holding up
 * work, and a list that reorders under you as new gates arrive is unanswerable
 * on a phone — the row you were reaching for moves.
 */
export function sortGateEntries(entries: DroverGateEntry[]): DroverGateEntry[] {
    return [...entries].sort((a, b) => {
        // `|| 0` is not defensive padding: an unparseable date makes the
        // comparator return NaN, and a NaN comparator leaves the whole array in
        // an engine-defined order rather than just misplacing one row.
        const at = Date.parse(a.gate.createdAt) || 0;
        const bt = Date.parse(b.gate.createdAt) || 0;
        if (at !== bt) return at - bt;
        return a.gate.id.localeCompare(b.gate.id);
    });
}

/**
 * The pending gate that is asking THIS question, wherever it was raised.
 *
 * DROVE-52. A pane session's AskUserQuestion has no `tool.permission` of its
 * own: the drover PreToolUse hook owns the answer, so nothing in the session's
 * own agentState can be resolved. The bus event for it is mirrored into the
 * bridge session instead, which is why the prompt appears on the home screen
 * and the in-session card was a dead form — every option tappable, submit
 * doing nothing because `tool.permission?.id` was undefined.
 *
 * Matching is on the question TEXT, which is what both sides carry: happy-cli
 * mirrors the bus event's `preview` into `questions[0].question`, and the bus
 * event's preview is the same string Claude Code put in the tool input. Ids
 * cannot be used — the bus id and the tool_use id are minted independently.
 */
export function gateForQuestion(
    sessions: Record<string, GateSession | undefined>,
    question: string,
): DroverGateEntry | null {
    if (!question) return null;
    for (const entry of sortGateEntries(collectGateEntries(sessions))) {
        if (entry.tool !== 'AskUserQuestion') continue;
        if (firstQuestion(entry.args)?.question === question) return entry;
    }
    return null;
}
