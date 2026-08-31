/**
 * The kitchen-sink demo, and the wall that keeps it a demo (DROVE-75).
 *
 * Of 74 DROVE tickets on 2026-08-31, 65 were `inreview` and none `done`,
 * because done means proven on the device and a haptic can only be proven by
 * waiting for a real gate while holding the right device. This screen fires
 * every channel on demand instead. The price is that a demo tap must NEVER
 * create, resolve or transmit a real bus event, or the first person to build
 * it publishes test gates onto Clay's live bus at one in the morning.
 *
 * So every demo card lives in the `demo:` namespace, and the namespace is
 * refused at every point where an answer could leave the phone:
 *
 *   - ops.ts: sessionAllow / sessionDeny / sessionAnswerQuestion /
 *     sessionCancelCommunication short-circuit a demo id into the sink below
 *     and never reach the socket.
 *   - apiSocket.ts: sessionRPC throws on a demo session id, so a caller that
 *     bypasses ops cannot put one on the wire either.
 *   - happy-cli droverBridge.ts: the permission handler refuses a demo request
 *     id before touching the bus, in case one ever reaches the Mac by a path
 *     nobody has written yet.
 *
 * The cards are the app's REAL components rendered from the fixtures here, so
 * that one choke point in ops.ts covers every button they have. Nothing below
 * imports the socket, and the store only through droverGates' default
 * argument; a spec loads it whole with that one mock.
 */

import type { ToolCall } from './typesMessage';
import {
    multiSelectFor,
    optionsFor,
    previewFor,
    titleFor,
    type DroverGateEntry,
    type DroverGateEvent,
} from './droverGates';

/**
 * The namespace. A session id or request id starting with this is a demo and
 * must never reach a session, a machine or the bus.
 */
export const DEMO_ID_PREFIX = 'demo:';

/** The session every demo card claims to belong to. No such session exists. */
export const DEMO_SESSION_ID = 'demo:cattle-drover';

export function isDroverDemoId(id: string | null | undefined): boolean {
    return typeof id === 'string' && id.startsWith(DEMO_ID_PREFIX);
}

/**
 * Every demo line is prefixed so a demo buzz is never mistaken for a missed
 * real one when someone is reading the log at two in the morning. The app's
 * Logger captures console output, so these land in Settings > Developer >
 * Logs beside everything else.
 */
export function demoLog(line: string): void {
    console.log(`[drover-demo] ${line}`);
}

export type DemoVerdict = 'allow' | 'deny' | 'answer' | 'cancel';

export interface DemoAnswer {
    sessionId: string;
    requestId: string;
    verdict: DemoVerdict;
    /** What was chosen or typed, for the log and the card. */
    detail?: string;
}

let sink: ((answer: DemoAnswer) => void) | null = null;

/**
 * Where a demo answer goes instead of the bus. The demo screen registers one
 * while it is mounted so the card it drew can show the answered state; with
 * nobody listening the answer is logged and dropped, which is still the right
 * outcome for a demo id arriving from anywhere else.
 */
export function setDemoAnswerSink(next: ((answer: DemoAnswer) => void) | null): void {
    sink = next;
}

/** Called by ops.ts in place of the RPC. Logged, handed to the sink, never sent. */
export function recordDemoAnswer(answer: DemoAnswer): void {
    demoLog(
        `answered ${answer.requestId} on ${answer.sessionId}: ${answer.verdict}`
        + `${answer.detail ? ` (${answer.detail})` : ''}; nothing sent`,
    );
    sink?.(answer);
}

/**
 * What an answer's updatedInput was, in one line for the log.
 *
 * Reads the same keys happy-cli's answerCandidates reads, so the demo log says
 * what the bridge would have seen.
 */
export function describeDemoInput(input: Record<string, unknown> | undefined): string | undefined {
    if (!input) return undefined;
    if (typeof input.code === 'string') return `code ${input.code.length} chars`;
    if (Array.isArray(input.optionIds)) return input.optionIds.join(', ');
    if (typeof input.optionId === 'string') return input.optionId;
    const answers = input.answers;
    if (answers && typeof answers === 'object') {
        return Object.values(answers as Record<string, unknown>)
            .map((v) => (Array.isArray(v) ? v.join(', ') : String(v)))
            .join('; ');
    }
    return undefined;
}

// ---- the fixtures ---------------------------------------------------------

export interface DemoCard {
    /** The request id; always in the demo namespace. */
    id: string;
    /** The row heading on the demo screen. */
    label: string;
    /** What this shape is for, in one line under the heading. */
    note: string;
    tool: ToolCall;
}

const questionOptions = [
    { label: 'main', description: 'The default branch; CI runs the full suite' },
    { label: 'develop', description: 'Merges into main on Friday' },
    { label: 'lane/BASED-113', description: 'The inline prompts lane' },
];

/**
 * One transcript card per shape, exactly as the bridge mirrors it
 * (happy-cli requestForEvent) so the layout being judged is the real one.
 *
 * `createdAt` is stamped at call time rather than baked in: every card shows
 * its own age, and a fixture minted at module load would read as hours old by
 * the time the screen was opened.
 */
export function demoTranscriptCards(now: number = Date.now()): DemoCard[] {
    const base = { state: 'running' as const, createdAt: now, startedAt: now, completedAt: null };
    const pending = (id: string) => ({ id, status: 'pending' as const, date: now });
    return [
        {
            id: 'demo:permission',
            label: 'Permission',
            note: 'A yes/no gate on an action. Allow, Deny, and allow-for-session.',
            tool: {
                ...base,
                name: 'Bash',
                description: 'Destructive Bash command, rm -rf on a checkout',
                input: { command: 'rm -rf build && git clean -fdx', description: 'Destructive Bash command, rm -rf on a checkout' },
                permission: pending('demo:permission'),
            },
        },
        {
            id: 'demo:question',
            label: 'Question with options',
            note: 'AskUserQuestion; one pick, or something else typed.',
            tool: {
                ...base,
                name: 'AskUserQuestion',
                description: null,
                input: {
                    questions: [{
                        header: 'Branch',
                        question: 'Which branch should this land on?',
                        options: questionOptions,
                        multiSelect: false,
                    }],
                },
                permission: pending('demo:question'),
            },
        },
        {
            id: 'demo:question-freeform',
            label: 'Question, freeform',
            note: 'No options offered. The answer is typed or dictated.',
            tool: {
                ...base,
                name: 'AskUserQuestion',
                description: null,
                input: {
                    questions: [{
                        header: 'Release name',
                        question: 'What should this release be called?',
                        options: [],
                        multiSelect: false,
                    }],
                },
                permission: pending('demo:question-freeform'),
            },
        },
        {
            id: 'demo:question-multi',
            label: 'Multi-select',
            note: 'Pick as many as apply, then Submit.',
            tool: {
                ...base,
                name: 'AskUserQuestion',
                description: null,
                input: {
                    questions: [{
                        header: 'Suites',
                        question: 'Which test suites should run before the merge?',
                        options: [
                            { label: 'vitest', description: 'Unit, about a minute' },
                            { label: 'bats', description: 'The shell suite' },
                            { label: 'watch:test', description: 'The wrist wire checks' },
                        ],
                        multiSelect: true,
                    }],
                },
                permission: pending('demo:question-multi'),
            },
        },
        {
            id: 'demo:todo',
            label: 'Needs you',
            note: 'A job, not a decision. Never expires; only Done or Drop it closes it.',
            tool: {
                ...base,
                name: 'DroverTodo',
                description: null,
                input: {
                    title: 'Push the release',
                    reason: 'the lane is blocked on it (by 10:00)',
                    command: 'git push origin lane/DROVE-53-needs-you',
                    options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
                },
                permission: pending('demo:todo'),
            },
        },
        {
            id: 'demo:login',
            label: 'Account login',
            note: 'A link out through the share sheet, and a code back.',
            tool: {
                ...base,
                name: 'DroverAccountLogin',
                description: null,
                input: {
                    url: 'https://claude.ai/login#cattle-drover-demo',
                    header: 'Log in to Claude',
                    reason: 'account spare has no credentials on this Mac',
                    cancelLabel: 'Cancel',
                },
                permission: pending('demo:login'),
            },
        },
    ];
}

/**
 * The same three kinds as the inbox lists them, already flattened into the
 * entries GateCard renders.
 *
 * Built with droverGates' own title / preview / options readers over the card
 * shapes the bridge writes (droverEvent and all), so the fixture is what the
 * real inbox would draw for these cards. NOT through collectGateEntries over a
 * one-session map: that function's first-seen bookkeeping treats a partial map
 * as the whole world and evicts every real gate's timestamp, which is the
 * render loop gatesForSession's comment already warns about.
 */
export function demoInboxEntries(now: number = Date.now()): DroverGateEntry[] {
    const cards: Array<{
        requestId: string;
        tool: string;
        args: unknown;
        event: DroverGateEvent;
    }> = [
        {
            requestId: 'demo:inbox-permission',
            tool: 'Bash',
            args: {
                command: 'rm -rf build && git clean -fdx',
                description: 'Destructive Bash command, rm -rf on a checkout',
            },
            event: {
                kind: 'permission',
                title: 'Destructive Bash command',
                reason: 'rm -rf on a checkout',
                command: 'rm -rf build && git clean -fdx',
                createdAt: now - 45_000,
            },
        },
        {
            requestId: 'demo:inbox-question',
            tool: 'AskUserQuestion',
            args: {
                questions: [{
                    header: 'Branch',
                    question: 'Which branch should this land on?',
                    options: questionOptions,
                    multiSelect: false,
                }],
            },
            event: {
                kind: 'question',
                title: 'Branch',
                reason: 'AskUserQuestion',
                createdAt: now - 4 * 60_000,
            },
        },
        {
            requestId: 'demo:inbox-todo',
            tool: 'DroverTodo',
            args: {
                title: 'Push the release',
                reason: 'the lane is blocked on it (by 10:00)',
                command: 'git push origin lane/DROVE-53-needs-you',
                options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
            },
            event: {
                kind: 'todo',
                title: 'Push the release',
                reason: 'the lane is blocked on it (by 10:00)',
                command: 'git push origin lane/DROVE-53-needs-you',
                createdAt: now - 3 * 3600_000,
            },
        },
    ];
    return cards.map(({ requestId, tool, args, event }) => {
        const options = optionsFor(args, tool);
        const multiSelect = multiSelectFor(args);
        const todo = event.kind === 'todo';
        return {
            sessionId: DEMO_SESSION_ID,
            requestId,
            tool,
            args,
            todo,
            event,
            gate: {
                id: `${DEMO_SESSION_ID}:${requestId}`,
                title: titleFor(tool, args),
                reason: event.reason ?? '',
                preview: previewFor(tool, args),
                kind: todo ? 'todo' : tool === 'AskUserQuestion' ? 'question' : 'permission',
                createdAt: new Date(event.createdAt ?? now).toISOString(),
                account: 'demo',
                ...(options.length ? { options } : {}),
                ...(multiSelect ? { multiSelect } : {}),
            },
        };
    });
}

// ---- audio ----------------------------------------------------------------

/**
 * A question read out with its options, the DROVE-73 shape in its simplest
 * form: the header, the body, then the options numbered so a headphone click
 * or a spoken "two" can name one. DROVE-73 owns the real reader; this is what
 * the demo says until it exists, and it is pure so that reader can start from
 * a tested sentence.
 */
export function spokenQuestion(card: {
    header?: string;
    question: string;
    options: Array<{ label: string; description?: string | null }>;
}): string {
    const parts: string[] = [];
    parts.push(`Question${card.header ? `, ${card.header}` : ''}. ${card.question}`);
    if (card.options.length === 0) {
        parts.push('No options. Say your answer.');
    } else {
        parts.push(card.options.length === 1 ? 'One option.' : `${card.options.length} options.`);
        card.options.forEach((option, index) => {
            parts.push(`${index + 1}. ${option.label}${option.description ? `, ${option.description}` : ''}.`);
        });
    }
    return parts.join(' ');
}

/**
 * The sample reply the read-aloud voice reads (DROVE-30). Markdown on
 * purpose: the point is to hear what the stripper keeps and what it drops.
 */
export const demoSampleReply = [
    '## Done',
    '',
    'The lane is pushed and the MR is open. Two things worth knowing:',
    '',
    '- `vitest` passed, 212 tests.',
    '- The watch wire checks passed too.',
    '',
    '```sh',
    'git push origin lane/DROVE-75-demo-screen',
    '```',
    '',
    'Nothing is waiting on you.',
].join('\n');
