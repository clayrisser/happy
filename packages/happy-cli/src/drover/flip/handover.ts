/**
 * What the new session is told about the subagents the flip just killed
 * (DROVE-240).
 *
 * THIS IS A RE-DISPATCH, NOT A RESUME. Say it that way everywhere, because the
 * difference is the whole design. A SESSION resumes: `claude --resume <id>`
 * hands the conversation back and the model carries on mid-thought. A SUBAGENT
 * cannot. It is an in-process child of the Claude Code process, the flip
 * restarts that process, and there is no API that hands a half-finished agent
 * back to the Agent tool. There is no such call to add, either. It is not a
 * gap in this code, it is a gap in the tool.
 *
 * What replaces it is what a person already does by hand when a session dies:
 * the ORCHESTRATOR dispatches the work again. The new session reads what its
 * predecessor's agents were doing and starts fresh agents on the same jobs. So
 * nothing here may be called resuming, in a log line, in an announce, or in
 * the arrival prompt. It is a re-dispatch and it costs money twice.
 *
 * WHY IT IS STILL WORTH DOING RATHER THAN BLIND. The transcripts survive the
 * SIGTERM. Claude Code writes each agent to
 *
 *     <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl
 *
 * with an `agent-<agentId>.meta.json` beside it -- the same pair DROVE-185's
 * nested tree and DROVE-211's transcript reader already live on -- and
 * carryTranscript copies the whole `<sessionId>/` directory into the target
 * account, so the path handed over is one the new session owns. The handover
 * never says "five tasks were running, start them again". Per agent it says
 * what it was doing and WHERE ITS FILE IS, and the re-dispatched agent opens
 * that file and continues from however far its predecessor got.
 *
 * The path is POINTED AT, never inlined. Five subagent transcripts are tens of
 * megabytes; pasting even a summary of each would push the real instruction
 * off the top of the arrival prompt.
 *
 * THE FIELD THAT MATTERS MOST IS `pushed`. An agent that had already pushed a
 * lane does not need restarting at all. It needs a rebase and a finish, which
 * is a different job with a different first step. That distinction is how
 * several lanes were salvaged rather than redone, and it is the one thing a
 * human doing this by hand always checks first.
 *
 * WHY THE FILE IS ALWAYS WRITTEN. The prompt only inlines the entries while
 * they are small. Past that it points at a file instead, because an arrival
 * prompt that grows with the number of agents is the failure this is meant to
 * avoid. But the file is written on EVERY flip that stranded anything, short
 * or long, and that is deliberate. The flips nobody is watching, a usage limit
 * at 4am or an auto-downgrade, are exactly the ones where the record has
 * to outlive the prompt. It lands under the drover state dir, not in either
 * account's config dir, so the session on the far side of the flip can read it
 * without knowing which account it came from.
 */

import { mkdirSync, openSync, closeSync, fstatSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { findSubagentTranscript } from '@/claude/utils/subagentTranscript'
import { logger } from '@/ui/logger'
import { droverStateDir } from './accounts'
import { projectDirFor } from './transcript'

/** An agent that was still running when the child was stopped. */
export interface StrandedAgent {
    id: string
    /** The Task's own description, when the launch record carried one. */
    name?: string
    /** `tasks/<id>.output` — a symlink to the subagent's own transcript. */
    output?: string
}

/** One agent's line in the handover. */
export interface HandoverEntry {
    id: string
    /** What the Task was called. The description, or the agent type. */
    label?: string
    /** `DROVE-240` and the like, when the label names one. */
    ticket?: string
    /** The agent's own JSONL, for the re-dispatched agent to read. */
    transcript?: string
    /** Did it get as far as `git push`? Then it wants a finish, not a restart. */
    pushed: boolean
    /** The lane it pushed, when the command named one. */
    lane?: string
}

/**
 * How much handover text may go straight into the arrival prompt.
 *
 * Measured against the real shape: the preamble is a fixed ~460 characters and
 * an entry with a full transcript path is ~170, so this inlines up to four
 * agents and sends five to the file. That is the right boundary rather than an
 * arbitrary one -- four fit under the instruction they belong to, and by five
 * the handover is longer than everything else in the prompt combined and the
 * actual ask scrolls off the top.
 *
 * Above the line the prompt is a constant two lines whether five agents died
 * or twelve, which is the property worth having: the arrival prompt stops
 * growing with the fan-out.
 */
const inlineLimit = 1200

/** Ceiling on one transcript scan, so a 190 MB agent log is not read whole. */
const maxScanBytes = 8 * 1024 * 1024

/**
 * A ticket identifier inside a Task description.
 *
 * Clay's agents are launched with labels like "DROVE-240 flip drains" or
 * "fix the gauge (BASED-113)", so the ticket is usually right there and is the
 * single most useful thing to put in front of the re-dispatched agent: it can
 * read the ticket itself rather than being told what the job was second-hand.
 */
const ticketPattern = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/

const pushCommand = /\bgit\s+(?:-\S+\s+|\S+=\S+\s+)*push\b/
const lanePattern = /\blane\/[A-Za-z0-9._\-/]+/

/**
 * `agent-<id>.meta.json`'s label.
 *
 * The same derivation two other readers already use -- description first,
 * agent type as the fallback -- so a name here matches the one on the phone's
 * agent card (`subagentTranscript.ts`, DROVE-93/211) and in the nested tree
 * (`liveStatus.ts`, DROVE-185). A workflow-launched agent has no description
 * at all, which is why the fallback is not optional.
 */
function readLabel(transcript: string): string | undefined {
    try {
        const raw = readTail(transcript.replace(/\.jsonl$/, '.meta.json'), 64 * 1024)
        if (!raw) return undefined
        const meta = JSON.parse(raw) as Record<string, unknown>
        const description = typeof meta.description === 'string' ? meta.description.trim() : ''
        const agentType = typeof meta.agentType === 'string' ? meta.agentType.trim() : ''
        return description || agentType || undefined
    } catch (err) {
        logger.debug('[handover] unreadable agent meta', err)
        return undefined
    }
}

/**
 * The last `limit` bytes of a file, or the whole thing when it is smaller.
 *
 * Tail rather than head because a push is the LAST thing an agent does. An
 * agent big enough to be clipped has certainly pushed by the end of it if it
 * pushed at all, so reading the end is not a compromise here, it is the right
 * end of the file.
 */
function readTail(path: string, limit: number): string | null {
    let fd: number | null = null
    try {
        fd = openSync(path, 'r')
        const size = fstatSync(fd).size
        if (size === 0) return null
        const from = Math.max(0, size - limit)
        const length = size - from
        const buf = Buffer.allocUnsafe(length)
        const read = readSync(fd, buf, 0, length, from)
        return buf.subarray(0, read).toString('utf8')
    } catch {
        return null
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd)
            } catch {
                /* nothing useful to do */
            }
        }
    }
}

/**
 * Did this agent push, and onto what?
 *
 * The Bash BLOCK is parsed; the line is not grepped. Measured over 15
 * transcripts of one session, `git push` appears on 24 lines of which only 15
 * are commands the agent actually ran. The other 9 are prompt text, `git
 * push` echoed back inside a tool_result, and the contents of files the agent
 * read. A 60% over-count on this field is not a rounding error, it is telling
 * someone to rebase a lane that was never created, which costs more time than
 * saying nothing would have.
 *
 * The cheap prefilter is what makes reading megabytes of JSONL affordable:
 * Bash is ~85% of subagent tool use, but a line without the literal `"Bash"`
 * cannot be a Bash call, and skipping the JSON.parse on the rest is the
 * difference between a scan Clay waits for and one he does not.
 *
 * Known blind spot, stated rather than papered over: a NESTED agent writes its
 * own `agent-<id>.jsonl`, so a push made by a child of this agent is not in
 * this file and is reported as "nothing pushed". Under-reporting is the safe
 * direction: it costs a redundant restart, where over-reporting sends someone
 * hunting for a branch that does not exist.
 */
function readPush(transcript: string): { pushed: boolean, lane?: string } {
    const text = readTail(transcript, maxScanBytes)
    if (!text) return { pushed: false }
    const lines = text.split('\n')
    // A tail that clipped the file starts mid-record, and half a JSON object
    // is not worth trying to read.
    for (const raw of lines) {
        if (!raw.includes('"Bash"') || !raw.includes('git')) continue
        let record: unknown
        try {
            record = JSON.parse(raw)
        } catch {
            continue
        }
        for (const command of bashCommands(record)) {
            if (!pushCommand.test(command)) continue
            const lane = lanePattern.exec(command)?.[0]
            return { pushed: true, ...(lane ? { lane } : {}) }
        }
    }
    return { pushed: false }
}

/** Every `Bash` tool_use command on one transcript record. */
function bashCommands(record: unknown): string[] {
    if (!record || typeof record !== 'object') return []
    const message = (record as Record<string, unknown>).message
    if (!message || typeof message !== 'object') return []
    const content = (message as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    const out: string[] = []
    for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b.type !== 'tool_use' || b.name !== 'Bash') continue
        const input = b.input
        if (!input || typeof input !== 'object') continue
        const command = (input as Record<string, unknown>).command
        if (typeof command === 'string') out.push(command)
    }
    return out
}

export interface HandoverContext {
    /** Where the flipped session's transcripts are, on the far side. */
    configDir?: string
    /** Where they came from, read when the target copy is not there yet. */
    fromConfigDir?: string
    cwd: string
    session?: string | null
}

/**
 * Turn what the guard was counting into what the next session needs to read.
 *
 * Everything is best effort: a missing transcript, an unreadable meta, a
 * scan that throws all degrade to a thinner entry rather than to no handover.
 * Losing one agent's line is a nuisance; losing the whole block because one
 * file was mid-write is the bug.
 */
export function buildHandover(agents: StrandedAgent[], ctx: HandoverContext): HandoverEntry[] {
    return agents.map((agent) => {
        const transcript = locate(agent, ctx)
        const label = agent.name ?? (transcript ? readLabel(transcript) : undefined)
        const push = transcript ? safePush(transcript) : { pushed: false }
        const ticket = label ? ticketPattern.exec(label)?.[1] : undefined
        return {
            id: agent.id,
            ...(label ? { label } : {}),
            ...(ticket ? { ticket } : {}),
            ...(transcript ? { transcript } : {}),
            pushed: push.pushed,
            ...(push.lane ? { lane: push.lane } : {}),
        }
    })
}

function safePush(transcript: string): { pushed: boolean, lane?: string } {
    try {
        return readPush(transcript)
    } catch (err) {
        logger.debug('[handover] could not scan an agent transcript', err)
        return { pushed: false }
    }
}

/**
 * Where the agent's JSONL is, preferring the copy in the account we are
 * MOVING TO.
 *
 * carryTranscript has already run by the time this is asked, so the target
 * holds its own copy of `<sessionId>/subagents/`, and that is the one the new
 * session will still have if the source account is ever cleaned up. The source
 * is the fallback because nothing is deleted on a flip, so it is still valid;
 * `tasks/<id>.output` is the last resort, since it is a symlink that only
 * resolves from inside the account that made it.
 */
function locate(agent: StrandedAgent, ctx: HandoverContext): string | undefined {
    const session = ctx.session
    if (session) {
        for (const dir of [ctx.configDir, ctx.fromConfigDir]) {
            if (!dir) continue
            try {
                const found = findSubagentTranscript(projectDirFor(dir, ctx.cwd), session, agent.id)
                if (found) return found
            } catch (err) {
                logger.debug('[handover] could not look for an agent transcript', err)
            }
        }
    }
    return agent.output
}

/** "raft animation [DROVE-227]. ALREADY PUSHED lane/DROVE-227-gauge" + its path. */
function line(entry: HandoverEntry): string {
    const who = entry.label ?? entry.id
    const ticket = entry.ticket && !who.includes(entry.ticket) ? ` [${entry.ticket}]` : ''
    const state = entry.pushed
        ? `. ALREADY PUSHED${entry.lane ? ` ${entry.lane}` : ''}, so rebase and finish it rather than starting over.`
        : '. Nothing pushed.'
    const where = entry.transcript ? `\n    transcript: ${entry.transcript}` : '\n    transcript: not found on disk'
    return `  - ${who}${ticket}${state}${where}`
}

/**
 * The whole handover, as the new session reads it.
 *
 * Written in the second person and ending in an instruction, because it is
 * pasted into a prompt and an agent that is merely shown a list does nothing
 * with it. The word "resume" does not appear, on purpose.
 */
export function renderHandover(entries: HandoverEntry[]): string {
    const n = entries.length
    const were = n === 1 ? 'was' : 'were'
    const they = n === 1 ? 'it' : 'they'
    return (
        `${n} subagent${n === 1 ? '' : 's'} ${were} running when this session moved accounts, and ` +
        `moving accounts restarted Claude Code, so ${they} ${n === 1 ? 'was' : 'were'} killed. ` +
        'There is no way to resume a subagent, so this is a RE-DISPATCH: you start new agents on ' +
        'the same jobs. It is not a resume and must not be described as one.\n\n' +
        'Their transcripts survived. Each one below names the file its predecessor was writing; ' +
        'have the new agent READ THAT FILE FIRST and carry on from where it stopped, rather than ' +
        'beginning the job again.\n\n' +
        entries.map(line).join('\n') +
        '\n\nAn agent marked ALREADY PUSHED does not want a restart. Its lane exists: rebase it on ' +
        'the current base, finish what is missing, and push again.'
    )
}

/** Where the long form goes when the prompt is the wrong size for it. */
export function handoverPath(session: string | null | undefined): string {
    const name = session && /^[0-9a-zA-Z-]+$/.test(session) ? session : 'latest'
    return join(droverStateDir(), 'handover', `${name}.md`)
}

/**
 * Write the record, always, and answer with the path when it was written.
 *
 * Never throws. A state dir that cannot be written to is a reason to fall back
 * to inlining the text, not a reason for the flip to fail.
 */
export function writeHandover(text: string, session: string | null | undefined): string | null {
    const path = handoverPath(session)
    try {
        mkdirSync(join(droverStateDir(), 'handover'), { recursive: true })
        writeFileSync(path, `${text}\n`, 'utf8')
        return path
    } catch (err) {
        logger.debug('[handover] could not write the handover file', err)
        return null
    }
}

/**
 * What gets appended to the arrival prompt.
 *
 * Short handovers go in whole, because one hop is better than two and four
 * agents still fit. Long ones become a pointer, so the prompt stays the same
 * size whether three agents died or twelve. Either way the file on disk holds
 * the full text.
 */
export function handoverNote(entries: HandoverEntry[], session: string | null | undefined): string | null {
    // An entry with no transcript AND no label is a bare agent id, which tells
    // the next session nothing it can act on -- it cannot read the work and it
    // cannot name the job. A block of those is noise in an arrival prompt, so
    // the whole thing is dropped rather than handing over a list of hex.
    if (!entries.some((e) => e.transcript || e.label)) return null
    const text = renderHandover(entries)
    const path = writeHandover(text, session)
    if (text.length <= inlineLimit || !path) return `\n\n${text}`
    const n = entries.length
    return (
        `\n\n${n} subagents were running when this session moved accounts and were killed by the ` +
        'restart. There is no way to resume a subagent, so they have to be RE-DISPATCHED: new ' +
        'agents on the same jobs, each one reading the transcript its predecessor left behind. ' +
        `What every one of them was doing, where its transcript is, and whether it had already ` +
        `pushed a lane is written here:\n  ${path}\nRead that file before you start anything.`
    )
}
