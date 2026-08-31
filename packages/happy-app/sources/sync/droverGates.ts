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
import type { DroverDelivery } from './droverChannels';
import { withoutWithdrawn } from './droverWithdrawn';

const PREVIEW_LIMIT = 240;

interface QuestionCard {
    question?: string;
    header?: string;
    options?: unknown;
    multiSelect?: boolean;
}

/** The account-login card's own reader, so the title and preview read it once. */
import { accountLoginCard } from '@/components/tools/views/droverAccountLogin';

/** The first question on an AskUserQuestion card, drover-mirrored or Claude's own. */
function firstQuestion(args: unknown): QuestionCard | null {
    const questions = (args as { questions?: unknown } | undefined)?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return null;
    const first = questions[0] as QuestionCard;
    return first && typeof first === 'object' ? first : null;
}

export function previewFor(tool: string, args: unknown): string {
    const input = (args ?? {}) as Record<string, unknown>;
    // A to-do's own card (DROVE-69). Its command is the preview when it has
    // one, and its title when it does not — "log in to the box" is a job with
    // nothing to run, and showing an empty line for it says nothing.
    if (tool === 'DroverTodo') {
        const command = typeof input.command === 'string' ? input.command.trim() : '';
        const title = typeof input.title === 'string' ? input.title : '';
        const text = command || title;
        return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
    }
    // A login card's body is its LINK (DROVE-212). It carries no `command` and
    // no `questions[]`, so it fell all the way to the JSON.stringify below and
    // Clay's phone showed him the literal string `{"url":"https://…"}` — text
    // he could not tap, on a card he could not answer. The URL is the one thing
    // on it worth reading at any size, wrist included.
    const login = tool === 'DroverAccountLogin' ? accountLoginCard(args) : null;
    if (login) return login.url;
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
export function optionsFor(args: unknown, tool?: string): DroverGateOption[] {
    // A to-do carries its two buttons on the card itself, not inside a
    // questions[] (DROVE-69). They have to reach the wrist as real options
    // with ids, because a to-do is now answerable ONLY by naming one of them —
    // happy-cli's busResolutionFor refuses a bare allow, which is what let the
    // app ack event 4c3f5082 with nobody touching it.
    const raw = tool === 'DroverTodo'
        ? (args as { options?: unknown } | undefined)?.options
        : firstQuestion(args)?.options;
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

/**
 * Whether the question lets the human tick more than one option (DROVE-53).
 *
 * Read off the CARD rather than off the bus event, because that is all the
 * phone has: happy-cli mirrors a bus question into an AskUserQuestion card and
 * the card is what storage holds. It used to hardcode multiSelect false there,
 * so this would have been false for every drover gate however the question was
 * asked — both halves had to change or neither was worth changing.
 */
export function multiSelectFor(args: unknown): boolean {
    return firstQuestion(args)?.multiSelect === true;
}

/**
 * The text of the question a request is asking, or null when it is not asking
 * one.
 *
 * This is a KEY, not a label. Claude resolves AskUserQuestion through its
 * permission callback and reads the answer out of the tool input under the
 * question's own text (`{ answers: { [question]: "Yes" } }`, see
 * askUserQuestionAnswers.ts). The wrist sent `{ optionId }` instead, which the
 * bus bridge accepts and Claude's own card does not — so a NATIVE question
 * answered from the watch merged a stray key into the input and the harness
 * never saw an answer at all. The feed needs the text to build the payload the
 * phone's own card builds.
 */
export function questionTextFor(
    sessions: Record<string, GateSession | undefined>,
    sessionId: string,
    requestId: string,
): string | null {
    const request = sessions[sessionId]?.agentState?.requests?.[requestId] as
        | { tool?: string; arguments?: unknown }
        | undefined;
    if (!request || request.tool !== 'AskUserQuestion') return null;
    const question = firstQuestion(request.arguments)?.question;
    return typeof question === 'string' && question ? question : null;
}

/** Wrist-sized title: the question's own header beats a generic "Question". */
export function titleFor(tool: string, args: unknown): string {
    // "Run DroverTodo" is nonsense on a wrist. The to-do's own title is the
    // whole of what it is.
    if (tool === 'DroverTodo') {
        const title = (args as { title?: unknown } | undefined)?.title;
        return typeof title === 'string' && title.trim() ? title : 'Needs you';
    }
    // "Run DroverAccountLogin" is not a thing anyone can act on, and it is what
    // Clay's phone actually said (DROVE-212). The card's own header names the
    // account it is adding — "Log in to Claude for ~/.claude-accounts/account-1".
    const login = tool === 'DroverAccountLogin' ? accountLoginCard(args) : null;
    if (login) return login.header;
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
    /** The session HOLDING the card — which is who an answer is sent to. */
    sessionId: string;
    requestId: string;
    tool: string;
    args: unknown;
    /**
     * The session that actually RAISED it, when the bridge mirrored it here
     * (DROVE-19). Different from `sessionId` for every drover gate: the bridge
     * holds one session per machine and every local agent's prompt lands in it.
     */
    origin?: DroverGateOrigin;
    /**
     * The bus event's own facts, when the bridge mirrored this card. Absent on
     * a rig or remote session's native permission, which never came off the
     * bus at all.
     */
    event?: DroverGateEvent;
    /**
     * A JOB, not a decision (DROVE-71).
     *
     * The one distinction the inbox is built on. A pending PROMPT is blocking
     * a session right now and can time out; a to-do is something Clay does
     * when he can and never expires. A single count would hide the one that
     * matters, so the two are counted and grouped apart everywhere.
     */
    todo: boolean;
}

/**
 * The bus event a mirrored card came from, verbatim (DROVE-71).
 *
 * Written by happy-cli's requestForEvent. The card shapes are chosen to
 * RENDER — a Bash card packs title and reason into one description string —
 * so an inbox that has to group prompts apart from to-dos, print the why on
 * its own line and show a true age had only a display string to read.
 */
export interface DroverGateEvent {
    kind?: 'permission' | 'question' | 'idle' | 'expiry' | 'todo' | null;
    title?: string | null;
    reason?: string | null;
    command?: string | null;
    createdAt?: number | null;
    /**
     * Which channels announce this prompt and which may answer it, as the bus
     * stamped it (DROVE-72). Absent from a bus older than the field.
     */
    delivery?: DroverDelivery | null;
}

/** Written by happy-cli's droverBridge; see requestForEvent (DROVE-19). */
export interface DroverGateOrigin {
    /** The Claude Code session uuid, the same one the bus event carries. */
    sessionId?: string | null;
    /** For reading only — never matched on, see gatesForSession. */
    cwd?: string | null;
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
        /** What a mirrored gate's `droverOrigin.sessionId` is matched against. */
        claudeSessionId?: string;
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
            const event = (request as { droverEvent?: DroverGateEvent | null }).droverEvent ?? undefined;
            // The BUS's createdAt first (DROVE-71). The bridge re-mirrors every
            // pending event on restart and stamps the card fresh each time, so
            // a to-do — the one kind that never expires — read as newly raised
            // after every launchd roll, and the list sorted on that lie.
            const createdAt = createdAtFor(
                `${sessionId}:${requestId}`,
                event?.createdAt ?? (request as { createdAt?: number | null }).createdAt,
            );
            const account = session?.metadata?.droverAccount;
            const options = optionsFor(args, tool);
            const origin = (request as { droverOrigin?: DroverGateOrigin | null }).droverOrigin;
            const multiSelect = multiSelectFor(args);
            const todo = event?.kind === 'todo' || tool === 'DroverTodo';
            entries.push({
                sessionId,
                requestId,
                tool,
                args,
                todo,
                ...(origin ? { origin } : {}),
                ...(event ? { event } : {}),
                gate: {
                    id: `${sessionId}:${requestId}`,
                    title: titleFor(tool, args),
                    // The EVENT's reason when the bus sent one, because that is
                    // the line that says why this is waiting; the session
                    // summary is only ever context, and on the bridge session
                    // it is one fixed string for every gate on the machine.
                    reason: event?.reason
                        || session?.metadata?.summary?.text
                        || session?.metadata?.path
                        || '',
                    preview: previewFor(tool, args),
                    // Off the EVENT, so the wrist finally draws a to-do as one.
                    // GateListView has had the green checklist glyph for `todo`
                    // since DROVE-53 and never saw the kind, because this line
                    // read the TOOL name and every drover card that was not a
                    // question came through as a permission.
                    // A login is a QUESTION — its answer is the code typed
                    // back, not a yes or a no. Left as 'permission' it got
                    // Allow and Deny, and a bare allow reaches the bus with no
                    // code in it (DROVE-212).
                    kind: todo
                        ? 'todo'
                        : tool === 'AskUserQuestion' || tool === 'DroverAccountLogin'
                            ? 'question'
                            : 'permission',
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
                    // Omitted when false, so the payload stays exactly the size
                    // it was and a watch build that predates the key decodes it
                    // unchanged — absent reads as single-select there, which is
                    // what every gate was.
                    ...(multiSelect ? { multiSelect } : {}),
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
    // A card Clay withdrew himself is gone from every surface at once, not
    // just the one he was looking at (DROVE-218). Filtered here rather than in
    // each hook so the wrist feed, which reads this same collector, drops it
    // too. See droverWithdrawn: this is a withdrawal, never an approval.
    return withoutWithdrawn(entries);
}

/** Every pending request in storage, flattened into wrist-sized gates. */
export function collectGates(
    sessions: Record<string, GateSession | undefined> = storage.getState().sessions ?? {},
): DroverGate[] {
    return collectGateEntries(sessions).map((entry) => entry.gate);
}

/**
 * The gates the session on screen is waiting on, oldest first (DROVE-19).
 *
 * Two kinds, and the second is the whole ticket:
 *
 * 1. A card the session holds itself. That is a rig or remote session, whose
 *    permissions come back through the app's own permission machinery.
 * 2. A card the drover bridge mirrored. A pane session's prompts never reach
 *    its own agentState at all — the PreToolUse hook publishes to the bus and
 *    the bridge mirrors every local agent's gate into ONE bridge session per
 *    machine. So the session Clay was watching held nothing, the only copy was
 *    on the home screen, and he had to navigate away to find a prompt his own
 *    session had just raised.
 *
 * The join for (2) is the Claude session uuid: `droverOrigin.sessionId` on the
 * card against `metadata.claudeSessionId` on the session. Exact uuid or
 * nothing. NOT cwd — several lanes share one checkout here, so a cwd match
 * would put one lane's question on another lane's screen, and a prompt from
 * the session you are NOT looking at taking the screen is worse than the walk
 * to the gates list. An older bridge that sends no origin leaves its gate
 * where it is, on the bridge session and the gates screen, rather than being
 * guessed onto a session.
 *
 * Collecting over the WHOLE map and filtering after is deliberate. Collecting
 * over a one-session map instead made collectGateEntries believe every other
 * session's gate had gone away, which evicted them from `firstSeenAt` and
 * minted them a new "first seen" timestamp on the next global read — a
 * createdAt that moves is exactly the render/read loop the map exists to stop.
 */
export function gatesForSession(
    sessions: Record<string, GateSession | undefined>,
    sessionId: string,
): DroverGateEntry[] {
    const session = sessions[sessionId];
    if (!session) return [];
    const claudeSessionId = session.metadata?.claudeSessionId;
    return sortGateEntries(collectGateEntries(sessions).filter((entry) => (
        entry.sessionId === sessionId
        || (!!claudeSessionId && entry.origin?.sessionId === claudeSessionId)
    )));
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

/**
 * The inbox, split the way the two halves actually differ (DROVE-71).
 *
 * A pending PROMPT — a permission gate, a question — is blocking a session
 * right now: a turn is stopped waiting on an answer and it can time out. A
 * TO-DO is a job Clay does when he can; nothing is stalled on it and it never
 * expires (`ttlMs: 0`, by design, because a to-do that timed out is a to-do
 * nobody did). One combined count would hide the half that is holding work up,
 * so nothing in this feature ever adds them together.
 *
 * Both halves are oldest first. For a prompt that is not a preference: the
 * oldest is the one that has held a session up longest. For a to-do it keeps
 * the row you are reaching for from moving as new ones arrive.
 */
export function splitInbox(entries: DroverGateEntry[]): {
    prompts: DroverGateEntry[];
    todos: DroverGateEntry[];
} {
    const sorted = sortGateEntries(entries);
    return {
        prompts: sorted.filter((entry) => !entry.todo),
        todos: sorted.filter((entry) => entry.todo),
    };
}

/**
 * How old, in the terminal renderer's own words.
 *
 * The same three bands `libexec/drover-todos` prints — seconds under 90,
 * minutes under 90, hours above — so a row reads identically on the phone and
 * in `drover todos`. Two spellings of an age is two things to keep in step for
 * no gain.
 */
export function ageLabel(createdAt: string | number, now: number = Date.now()): string {
    const at = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
    if (!Number.isFinite(at)) return '';
    const seconds = Math.max(0, (now - at) / 1000);
    if (seconds < 90) return `${Math.floor(seconds)}s`;
    if (seconds < 5400) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
}

/**
 * What the longhorn's two indicators say, and whether it says anything at all.
 *
 * Separate counts, never a sum: "2 prompts waiting" and "3 to-dos" mean
 * different things and carry different urgency, and a single number would hide
 * the blocking one. No badge at all when both are zero — a badge that is
 * always there is a badge nobody reads.
 */
export function inboxCounts(entries: DroverGateEntry[]): {
    prompts: number;
    todos: number;
    total: number;
} {
    let prompts = 0;
    let todos = 0;
    for (const entry of entries) {
        if (entry.todo) todos++;
        else prompts++;
    }
    return { prompts, todos, total: prompts + todos };
}
