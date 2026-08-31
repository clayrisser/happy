/**
 * The handover a flip leaves behind (DROVE-240).
 *
 * The interesting half is `pushed`, because it is the field that changes what
 * the next session DOES: an agent that pushed wants a rebase and a finish, one
 * that did not wants a restart. Getting it wrong in the optimistic direction
 * sends someone hunting for a branch that was never created, so the tests
 * below are mostly about not saying "pushed" when nobody pushed.
 *
 * The fixtures are the real record shape, taken off Clay's own transcripts:
 * `type: "assistant"`, `isSidechain: true`, `message.content[]` holding a
 * `tool_use` named `Bash` whose `input.command` is the shell string.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildHandover, handoverNote, handoverPath, renderHandover } from './handover'
import { projectDirFor } from './transcript'

let root: string
const savedState = process.env.XDG_STATE_HOME

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-handover-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
})

afterEach(() => {
    if (savedState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = savedState
})

/** One `assistant` record running a Bash command, as Claude Code writes it. */
function bashRecord(command: string): string {
    return JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        agentId: 'a752a2a9e89efbca8',
        message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [
                {
                    type: 'tool_use',
                    id: 'toolu_01UZhN21doJsDwmbrtg2SUUQ',
                    name: 'Bash',
                    input: { command, description: 'a step', timeout: 300000 },
                },
            ],
        },
    })
}

/** A record where the words appear but nothing was run: prose, or tool output. */
function proseRecord(text: string): string {
    return JSON.stringify({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] },
    })
}

/** A subagent transcript on disk, in the layout carryTranscript moves. */
function writeAgent(opts: {
    configDir: string
    cwd: string
    session: string
    agentId: string
    lines: string[]
    meta?: Record<string, unknown>
}): void {
    const dir = join(projectDirFor(opts.configDir, opts.cwd), opts.session, 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `agent-${opts.agentId}.jsonl`), opts.lines.join('\n') + '\n', 'utf8')
    if (opts.meta) {
        writeFileSync(join(dir, `agent-${opts.agentId}.meta.json`), JSON.stringify(opts.meta), 'utf8')
    }
}

describe('what the handover says about each stranded agent', () => {
    const cwd = '/Users/clay/Projects/thing'
    const session = '19c2f0a8-f803-4cb8-8bee-c68b6773e412'

    it('finds the transcript, the label and the ticket, and sees the push', () => {
        const configDir = join(root, 'acct-alt')
        writeAgent({
            configDir,
            cwd,
            session,
            agentId: 'a752a2a9e89efbca8',
            meta: { agentType: 'general-purpose', description: 'DROVE-227 gauge contrast', spawnDepth: 1 },
            lines: [
                bashRecord('cd /Users/clay/Projects/thing && git status --short'),
                bashRecord('git push fork lane/DROVE-227-gauge-contrast 2>&1 | tail -8'),
            ],
        })

        const [entry] = buildHandover([{ id: 'a752a2a9e89efbca8' }], { cwd, session, configDir })
        expect(entry.label).toBe('DROVE-227 gauge contrast')
        expect(entry.ticket).toBe('DROVE-227')
        expect(entry.transcript).toContain('subagents/agent-a752a2a9e89efbca8.jsonl')
        expect(entry.pushed).toBe(true)
        expect(entry.lane).toBe('lane/DROVE-227-gauge-contrast')
    })

    it('does NOT call it pushed when the words are only prose or tool output', () => {
        // Measured over 15 real transcripts: `git push` is on 24 lines but is
        // an actual command on only 15. A raw grep over-reports by 60%, and
        // over-reporting sends the next session after a branch that does not
        // exist.
        const configDir = join(root, 'acct-alt')
        writeAgent({
            configDir,
            cwd,
            session,
            agentId: 'a0222667a1b1a8886',
            meta: { agentType: 'general-purpose', description: 'read only sweep' },
            lines: [
                proseRecord('The plan is to run git push once the tests are green.'),
                proseRecord('README says: run `git push` to publish your lane.'),
                bashRecord('git log --oneline -5'),
            ],
        })

        const [entry] = buildHandover([{ id: 'a0222667a1b1a8886' }], { cwd, session, configDir })
        expect(entry.pushed).toBe(false)
        expect(entry.lane).toBeUndefined()
    })

    it('falls back to the account it came FROM when the copy has not landed', () => {
        const fromConfigDir = join(root, 'acct-main')
        writeAgent({
            configDir: fromConfigDir,
            cwd,
            session,
            agentId: 'a0069e0ee74dfc36b',
            meta: { agentType: 'general-purpose', description: 'still here' },
            lines: [bashRecord('ls')],
        })

        const [entry] = buildHandover([{ id: 'a0069e0ee74dfc36b' }], {
            cwd,
            session,
            configDir: join(root, 'acct-empty'),
            fromConfigDir,
        })
        expect(entry.transcript).toContain('acct-main')
        expect(entry.label).toBe('still here')
    })

    it('labels a workflow agent by its type, which is all its meta carries', () => {
        const configDir = join(root, 'acct-alt')
        writeAgent({
            configDir,
            cwd,
            session,
            agentId: 'a013535c0b554e932',
            meta: { agentType: 'workflow-subagent', spawnDepth: 1 },
            lines: [bashRecord('ls')],
        })

        const [entry] = buildHandover([{ id: 'a013535c0b554e932' }], { cwd, session, configDir })
        expect(entry.label).toBe('workflow-subagent')
    })

    it('keeps the launch description over the meta, and still reads the ticket off it', () => {
        const [entry] = buildHandover([{ id: 'a1', name: 'BASED-113 inline prompts', output: '/tmp/a1.jsonl' }], {
            cwd,
        })
        expect(entry.label).toBe('BASED-113 inline prompts')
        expect(entry.ticket).toBe('BASED-113')
        expect(entry.transcript).toBe('/tmp/a1.jsonl')
    })

    it('degrades to a thinner entry rather than to no handover', () => {
        const [entry] = buildHandover([{ id: 'a9', name: 'no file anywhere' }], {
            cwd,
            session,
            configDir: join(root, 'nothing-here'),
        })
        expect(entry.pushed).toBe(false)
        expect(entry.transcript).toBeUndefined()
        expect(entry.label).toBe('no file anywhere')
    })
})

describe('how the handover reads', () => {
    it('tells the reader to open the file first, and calls it a re-dispatch', () => {
        const text = renderHandover([
            { id: 'a1', label: 'gauge contrast', ticket: 'DROVE-227', transcript: '/t/a1.jsonl', pushed: false },
        ])
        expect(text).toContain('RE-DISPATCH')
        expect(text).toContain('READ THAT FILE FIRST')
        expect(text).toContain('/t/a1.jsonl')
        expect(text).not.toMatch(/resuming/i)
    })

    it('says rebase and finish for an agent that already pushed', () => {
        const text = renderHandover([
            { id: 'a1', label: 'gauge', transcript: '/t/a1.jsonl', pushed: true, lane: 'lane/DROVE-227-x' },
        ])
        expect(text).toContain('ALREADY PUSHED lane/DROVE-227-x')
        expect(text).toContain('rebase and finish')
        expect(text).not.toContain('starting over rather')
    })

    it('says so plainly when a transcript could not be found', () => {
        const text = renderHandover([{ id: 'a1', label: 'gauge', pushed: false }])
        expect(text).toContain('transcript: not found on disk')
    })
})

describe('where the handover lives', () => {
    it('writes the file and inlines the text while it is small', () => {
        const note = handoverNote(
            [{ id: 'a1', label: 'one job', transcript: '/t/a1.jsonl', pushed: false }],
            'sess-a',
        )
        expect(note).toContain('one job')
        expect(note).not.toContain(handoverPath('sess-a'))
    })

    it('points at the file once the block outgrows the prompt', () => {
        const many = Array.from({ length: 8 }, (_, i) => ({
            id: `a${i}`,
            label: `job number ${i} with a reasonably long description`,
            transcript: `/Users/clay/.claude/projects/-Users-clay-thing/sess/subagents/agent-a${i}.jsonl`,
            pushed: false,
        }))
        const note = handoverNote(many, 'sess-b')
        expect(note).toContain(handoverPath('sess-b'))
        expect(note).toContain('Read that file before you start anything')
        // The property worth having: the prompt stops growing with the fan-out.
        expect(note).not.toContain('job number 5')
        expect(note!.length).toBeLessThan(renderHandover(many).length)
    })

    it('lands outside either account, so the far side of the flip can read it', () => {
        // Not in a CLAUDE_CONFIG_DIR: the session reading this has already
        // moved accounts and must not have to know which one wrote it.
        expect(handoverPath('sess-c')).toContain(join('cattle-drover', 'handover'))
        expect(handoverPath('sess-c')).not.toContain('.claude')
    })

    it('does not let a strange session id escape the handover directory', () => {
        expect(handoverPath('../../etc/passwd')).toBe(
            join(root, 'state', 'cattle-drover', 'handover', 'latest.md'),
        )
    })

    it('drops the block entirely for bare ids, which name nothing actionable', () => {
        expect(handoverNote([{ id: 'a1', pushed: false }, { id: 'a2', pushed: false }], 'sess-d')).toBeNull()
        expect(handoverNote([], 'sess-d')).toBeNull()
    })
})
