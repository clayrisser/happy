import type { Message, ToolCall } from '@/sync/typesMessage';
import type { AudioCueId } from './audioCues';
import type { AudioCues } from '@/sync/settings';

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
 *    thirty spoken lines, so at most `titlesPerRun` tool titles are said per
 *    RUN of consecutive tool calls and the rest of the run goes unnamed, the
 *    same way the transcript folds a run into one row (DROVE-84). An agent
 *    spawn is always named: it is the one Clay said he most wants to hear.
 * 4. A TOOL FINISHING IS NOT AN EVENT. One cue per call is exactly what makes
 *    a cue system unusable inside a minute. Only agents get a finish and a
 *    failure sound, because an agent is a thing you were waiting on.
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

function trim(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= titleLimit) return clean;
    return `${clean.slice(0, titleLimit).replace(/\s\S*$/, '')}…`;
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
    /** A run of tool calls is open: its earcon has been played. */
    private inRun = false;

    reset(): void {
        this.seen.clear();
        this.spokenInRun = 0;
        this.inRun = false;
    }

    /** How many tool titles the current run has used. For the tests. */
    get runTitles(): number {
        return this.spokenInRun;
    }

    /**
     * What this message is worth. Called once per message per delivery; the
     * `seen` map is what makes a second delivery of the same call silent.
     */
    observe(message: Message, settings: Required<AudioCues>): TitleDecision {
        if (message.kind === 'user-text') {
            // A new turn ends whatever run was open.
            this.spokenInRun = 0;
            this.inRun = false;
            return nothing;
        }
        if (message.kind === 'agent-text') {
            // Prose between two tool calls is what makes them two runs, which
            // is the same rule the transcript folds by.
            if (!message.isThinking && typeof message.text === 'string' && message.text.length > 0) {
                this.spokenInRun = 0;
                this.inRun = false;
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
                if (!this.inRun) {
                    this.inRun = true;
                    this.spokenInRun = 0;
                    events.push('toolRun');
                }
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
