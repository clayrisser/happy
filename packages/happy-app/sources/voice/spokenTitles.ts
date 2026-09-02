import type { Message, ToolCall } from '@/sync/typesMessage';
import type { AudioCueId } from './audioCues';
import type { AudioCues } from '@/sync/settings';
import {
    envelopePreview,
    parseUserEnvelope,
    shortAgentId,
    taskPreview,
    taskStatusWord,
} from '@/utils/userEnvelope';

/**
 * The third thing read-aloud says (DROVE-112).
 *
 * Clay: "can you also read off the titles of terminal calls and tool calls,
 * as well as the titles of agents when you spawn up agents". Eyes free, he
 * wants to know that something is happening AND what it is. Beside the reply
 * prose and the earcons, then, a one-line title per tool call, terminal call
 * and agent spawn.
 *
 * FOUR DECISIONS, written down because the ticket asked for them to be:
 *
 * 1. THE TITLE IS NOT SPOKEN LIKE THE REPLY. It goes out faster and at a
 *    higher pitch (settings.asideRateScale / asidePitchScale), with the cue's
 *    earcon in front of it. So a tool call never sounds like Claude talking.
 *    Volume would have been the natural third axis; the native speech module
 *    takes no per-utterance volume, so it is not available without a build.
 * 2. ORDER IS KEPT BY CONSTRUCTION, not by a scheduler. A title is pushed
 *    into the reader's own timeline at the tool call's createdAt, so it is
 *    spoken exactly where it belongs among the sentences around it and never
 *    after the reply has moved past it. It also inherits the spoken-once
 *    invariant (DROVE-126) and the skip-ahead cut for free: when the voice is
 *    behind, titles are stepped over with everything else.
 * 3. AGENTS ARE EXEMPT FROM THE FOLD. A run of thirty greps must not become
 *    thirty spoken LINES, so at most `titlesPerRun` tool titles are said per
 *    RUN of consecutive tool calls and the rest of the run goes unnamed, the
 *    same way the transcript folds a run into one row (DROVE-84). An agent
 *    spawn is always named: it is the one Clay said he most wants to hear.
 *
 *    The fold survives DROVE-174 and it matters more there than it did here.
 *    Titles are SPEECH, and a cue may only sound in a gap between sentences;
 *    a run that spoke thirty titles would leave no gaps at all and every tick
 *    in the burst would go stale unheard. Three titles then quiet is what
 *    gives the ticks somewhere to land.
 * 4. A TOOL FINISHING IS NOT AN EVENT. Only agents get a finish and a failure
 *    sound, because an agent is a thing you were waiting on. A tool finishing
 *    would double the rate and say nothing the start did not.
 *
 * DROVE-174 overturned one of DROVE-112's calls and added a cue. Clay: "when
 * in reading mode, every response and tool call should have a sound".
 *
 * 5. EVERY TOOL CALL TICKS. DROVE-112 folded the earcon to one per RUN;
 *    `toolCall` now fires per CALL. A burst of twenty calls is twenty ticks,
 *    which is the information — a lot is happening — and the tick is 28ms so
 *    twenty of them rattle rather than queue up into ten seconds of ticking
 *    after the burst is over. The mixer's 4-second staleness rule is what
 *    holds that: a tick that could not be heard while it was still true is
 *    dropped, not played late.
 * 6. A REPLY HAS ITS OWN SOUND. `reply`, once per turn, on the FIRST prose
 *    that turn produces. It is played BEFORE the first sentence rather than
 *    over it, and by ordering rather than by delay: this runs from inside the
 *    reader's own message walk, before that prose has been enqueued, so the
 *    cue reaches the device first and the voice is never held for it. Nothing
 *    is allowed to delay speech, so "before" has to be free.
 *
 * Pure apart from the small amount of memory a fold needs, and that memory is
 * a field of one object the service owns, so a test drives it directly.
 */

/** What one message is worth: sounds to make now, and a line to say in place. */
export interface TitleDecision {
    /** Earcons, in order. Played immediately; they are about NOW. */
    events: AudioCueId[];
    /** The line to speak in the reading lane, or null. */
    title: string | null;
}

const nothing: TitleDecision = { events: [], title: null };

/** Long enough to be useful, short enough that it is still a footnote. */
const titleLimit = 80;

/**
 * A message from an agent is a report, not a tool's name, so it gets twice
 * the room before the cut. Still a footnote: the whole report is on the card.
 */
export const envelopeTitleLimit = 160;

function trim(text: string, limit = titleLimit): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= limit) return clean;
    return `${clean.slice(0, limit).replace(/\s\S*$/, '')}…`;
}

/** The agent's name for an id, or null when nothing on the phone knows it. */
export type AgentLabelFor = (agentId: string) => string | null;

/**
 * What an injected user turn is worth out loud (DROVE-392), or null.
 *
 * The reader never reads a user turn as prose, so the tag was never SPOKEN;
 * what was missing is the news. A subagent reporting in is the event Clay
 * most wants to hear about eyes-free, so it is said the way an agent spawn
 * is (`speakAgentTitles`): "message from <label>" and the report's first
 * line. A background agent stopping is "<label> finished" and what it said.
 * The tag, the lead line and the harness paragraph are never in the string,
 * because the parser hands over parts and this file only ever reads parts.
 *
 * A reminder and a skill receipt are the harness talking to the model, and
 * the phone's own relayed message is Clay's, so those three say nothing.
 */
export function spokenEnvelopeTitle(
    text: string,
    settings: Required<AudioCues>,
    labelFor?: AgentLabelFor,
): string | null {
    if (!settings.speakTitles || !settings.speakAgentTitles) return null;
    const envelope = parseUserEnvelope(text);
    if (!envelope) return null;
    switch (envelope.kind) {
        case 'agent-message': {
            const label = labelFor?.(envelope.from) ?? shortAgentId(envelope.from);
            return trim(`message from ${label}. ${envelopePreview(envelope.body)}`, envelopeTitleLimit);
        }
        case 'cross-session-message':
            if (!envelope.peer) return null;
            return trim(`message from ${envelope.fromName}. ${envelopePreview(envelope.body)}`, envelopeTitleLimit);
        case 'task-notification': {
            const single = envelope.taskIds.length === 1 ? envelope.taskIds[0] : null;
            const label = single
                ? labelFor?.(single) ?? envelope.name ?? shortAgentId(single)
                : envelope.name ?? `${envelope.taskIds.length} agents`;
            const preview = taskPreview(envelope);
            const outcome = `${label} ${taskStatusWord(envelope.status)}`;
            return trim(preview.length > 0 ? `${outcome}. ${preview}` : outcome, envelopeTitleLimit);
        }
        default:
            return null;
    }
}

/** Task and Agent are the same tool under two names, as knownTools has it. */
export function isAgentTool(name: string): boolean {
    return name === 'Task' || name === 'Agent';
}

/** `mcp__huly__create_issue` reads as "huly create issue" out loud. */
function readableName(name: string): string {
    if (name.startsWith('mcp__')) {
        return name.slice(5).split('__').join(' ').replace(/_/g, ' ');
    }
    return name;
}

/**
 * What a tool call is called, out loud.
 *
 * The same field the transcript row shows, which is the whole point: Clay's
 * screenshot was a shell row reading "Check OTA and build progress", and that
 * is `tool.description`. An agent names itself in `input.description`, which
 * is what knownTools' taskLikeTool draws, and falls back to the subagent type
 * because "Agent: Explore" still says more than "Agent".
 */
export function spokenToolTitle(tool: ToolCall): string {
    if (isAgentTool(tool.name)) {
        const input = (tool.input ?? {}) as { description?: unknown; subagent_type?: unknown };
        const described = typeof input.description === 'string' && input.description.trim().length > 0
            ? input.description
            : typeof input.subagent_type === 'string' && input.subagent_type.trim().length > 0
                ? input.subagent_type
                : 'task';
        return trim(`Agent: ${described}`);
    }
    if (typeof tool.description === 'string' && tool.description.trim().length > 0) {
        return trim(tool.description);
    }
    if (tool.name === 'Bash') {
        const command = (tool.input as { command?: unknown } | undefined)?.command;
        if (typeof command === 'string' && command.trim().length > 0) return trim(command);
    }
    return trim(readableName(tool.name));
}

/**
 * The fold, and the memory that makes it possible.
 *
 * One instance per focused session; `reset()` when the reader's focus moves,
 * because another session's run says nothing about this one's.
 */
export class SpokenTitleTracker {
    /** The last state seen per tool call, so a redelivery is not a new call. */
    private seen = new Map<string, ToolCall['state']>();
    /** Tool titles already spoken inside the current run. */
    private spokenInRun = 0;
    /** A run of tool calls is open. The TITLES fold to it; the ticks do not. */
    private inRun = false;
    /** This turn's reply cue has been played. Once per turn (DROVE-174). */
    private repliedInTurn = false;

    reset(): void {
        this.seen.clear();
        this.spokenInRun = 0;
        this.inRun = false;
        this.repliedInTurn = false;
    }

    /** How many tool titles the current run has used. For the tests. */
    get runTitles(): number {
        return this.spokenInRun;
    }

    /**
     * What this message is worth. Called once per message per delivery; the
     * `seen` map is what makes a second delivery of the same call silent.
     */
    observe(message: Message, settings: Required<AudioCues>, labelFor?: AgentLabelFor): TitleDecision {
        if (message.kind === 'user-text') {
            // A new turn ends whatever run was open, and owes a reply cue.
            this.spokenInRun = 0;
            this.inRun = false;
            this.repliedInTurn = false;
            // An injected envelope is a user turn to the state above and a
            // line to say to the ear (DROVE-392). No cue: the agent's own
            // finish sound already rode its tool call (DROVE-115).
            const title = typeof message.text === 'string' ? spokenEnvelopeTitle(message.text, settings, labelFor) : null;
            return title === null ? nothing : { events: [], title };
        }
        if (message.kind === 'agent-text') {
            // Prose between two tool calls is what makes them two runs, which
            // is the same rule the transcript folds by. Thinking is not prose
            // and does not end a run (DROVE-181).
            if (!message.isThinking && typeof message.text === 'string' && message.text.length > 0) {
                this.spokenInRun = 0;
                this.inRun = false;
                // The reply cue, once per turn, on the first prose of it
                // (DROVE-174). Fired here rather than on the sentence so it
                // reaches the device before the sentence is even queued.
                if (!this.repliedInTurn) {
                    this.repliedInTurn = true;
                    return { events: ['reply'], title: null };
                }
            }
            return nothing;
        }
        if (message.kind !== 'tool-call') return nothing;

        const tool = message.tool;
        const previous = this.seen.get(message.id);
        this.seen.set(message.id, tool.state);
        const agent = isAgentTool(tool.name);
        const events: AudioCueId[] = [];
        let title: string | null = null;

        if (previous === undefined) {
            if (agent) {
                events.push('agentStart');
                if (settings.speakTitles && settings.speakAgentTitles) title = spokenToolTitle(tool);
            } else {
                // One tick per CALL (DROVE-174). The run still exists, and it
                // still folds the spoken TITLES below; what it no longer does
                // is swallow the sound of every call after the first.
                if (!this.inRun) {
                    this.inRun = true;
                    this.spokenInRun = 0;
                }
                events.push('toolCall');
                if (settings.speakTitles && settings.speakToolTitles && this.spokenInRun < settings.titlesPerRun) {
                    this.spokenInRun += 1;
                    title = spokenToolTitle(tool);
                }
            }
        }

        // A finish sound only for agents. A tool finishing is one cue per call,
        // which is the rate problem this whole design exists to avoid.
        if (agent && previous !== tool.state && (tool.state === 'completed' || tool.state === 'error')) {
            events.push(tool.state === 'error' ? 'agentFailed' : 'agentDone');
        }

        return { events, title };
    }
}
