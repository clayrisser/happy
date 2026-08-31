/**
 * Claude Code's OWN approval dialog, all the way to the phone card (DROVE-198).
 *
 * Clay: "Why didn't this prompt me in the app." A four option Bash approval sat
 * in his terminal and nothing appeared anywhere else. The reason was not the
 * SHAPE. Nothing in the drover watched the surface that prompt lives on: it is
 * drawn by the harness after every PreToolUse hook has returned, so it is
 * neither a tool call (claude-pretooluse.sh) nor a gate we raised
 * (lib/drover-gate.sh). The only signal that escaped was Notification
 * `permission_prompt`, which claude-notification.sh turned into `kind: "idle"`
 * — and the mirror below takes permission, question and todo, so the card
 * reached no surface at all.
 *
 * cattle-drover's adapters/claude-approval.sh now reads the dialog off the pane
 * and publishes it. This file is the half that lives here: that the registration
 * exists, and that every option survives the trip to the card.
 *
 * The events are copied field for field off a real publish on 2026-08-31, from
 * a live Claude Code showing the exact dialog in the ticket's screenshot.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { droverHooks } from './hooks'
import { busResolutionFor, requestForEvent, type DroverEvent } from './droverBridge'

/** The four option approval, as adapters/claude-approval.sh publishes it. */
const fourOption: DroverEvent = {
    id: 'ac034e76-b443-40d9-9465-3a4d7f453a58',
    kind: 'question',
    state: 'pending',
    title: 'Bash command',
    reason: 'Claude Code is waiting for approval in the terminal',
    preview: [
        'tmux capture-pane -p -t drove198 2>/dev/null | grep -v "^$" | tail -3',
        '',
        'This command requires approval',
        '',
        'Do you want to proceed?',
    ].join('\n'),
    options: [
        { id: '1', label: 'Yes' },
        { id: '2', label: "Yes, and don't ask again for tmux capture-pane commands in /Users/clayrisser/Projects/bitspur/cattle-drover" },
        { id: '3', label: 'Yes, and switch to auto mode · auto mode handles these prompts for you' },
        { id: '4', label: 'No' },
    ],
    origin: {
        harness: 'claude-code',
        gate: 'terminal-approval',
        cwd: '/Users/clayrisser/Projects/bitspur/cattle-drover',
        surface: '%1',
    },
}

/** A shape the parser could not read. The session is blocked all the same. */
const unreadable: DroverEvent = {
    id: 'ev-unknown',
    kind: 'question',
    state: 'pending',
    title: 'Terminal approval',
    reason: "Cattle Drover could not read this prompt's options. This is what the terminal says.",
    preview: 'PLEASE CONFIRM THE THING\ntype yes or no and press return',
    options: [
        { id: 'enter', label: 'Press Enter (take the highlighted choice)' },
        { id: 'esc', label: 'Press Esc (cancel)' },
    ],
}

describe('the terminal approval reaches the phone with every option', () => {
    it('mirrors as an AskUserQuestion card, which is the only card that carries options', () => {
        const request = requestForEvent(fourOption)
        // A `permission` would render as a Bash card with Allow and Deny, and
        // its options are dropped — which is exactly the silent discard the
        // ticket forbids: "don't ask again" and "switch to auto mode" are the
        // two Clay wants and neither is Allow or Deny.
        expect(request.tool).toBe('AskUserQuestion')
        const questions = (request.arguments as { questions: { options: { label: string }[] }[] }).questions
        expect(questions[0].options).toHaveLength(4)
        expect(questions[0].options.map((o) => o.label)).toEqual([
            'Yes',
            "Yes, and don't ask again for tmux capture-pane commands in /Users/clayrisser/Projects/bitspur/cattle-drover",
            'Yes, and switch to auto mode · auto mode handles these prompts for you',
            'No',
        ])
    })

    it('puts the command on the card, so the answer is an informed one', () => {
        const request = requestForEvent(fourOption)
        const questions = (request.arguments as { questions: { question: string }[] }).questions
        expect(questions[0].question).toContain('tmux capture-pane')
        expect(questions[0].question).toContain('This command requires approval')
    })

    it('answers the option Clay picked, not the first one that looks affirmative', () => {
        // The phone submits LABELS keyed by question text; the bus takes ids.
        const resolution = busResolutionFor(fourOption, {
            id: fourOption.id,
            approved: true,
            updatedInput: {
                answers: {
                    'Do you want to proceed?':
                        'Yes, and switch to auto mode · auto mode handles these prompts for you',
                },
            },
        })
        expect(resolution).toMatchObject({ action: 'option', optionId: '3' })
    })

    it('is not shredded on the comma every "Yes, and …" option carries', () => {
        // answerCandidates splits a multi-select answer on ", " to recover the
        // picks. Every option in this dialog but Yes and No has a comma in its
        // own label, so the whole value has to be tried first or "Yes, and
        // don't ask again for X" resolves as a bare "Yes" — an approval Clay
        // would have to give again on the very next command.
        const resolution = busResolutionFor(fourOption, {
            id: fourOption.id,
            approved: true,
            updatedInput: { answers: { 'Do you want to proceed?': fourOption.options![1].label } },
        })
        expect(resolution).toMatchObject({ action: 'option', optionId: '2' })
    })

    it('answers No as No, which a permission card could only have spelled Deny', () => {
        const resolution = busResolutionFor(fourOption, {
            id: fourOption.id,
            approved: true,
            updatedInput: { optionId: '4' },
        })
        expect(resolution).toMatchObject({ action: 'option', optionId: '4' })
    })

    it('carries the raw prompt text when the shape could not be read', () => {
        const request = requestForEvent(unreadable)
        const questions = (request.arguments as { questions: { question: string; options: { label: string }[] }[] }).questions
        expect(questions[0].question).toContain('PLEASE CONFIRM THE THING')
        // Answerable, and the buttons name the key they press.
        expect(questions[0].options).toHaveLength(2)
    })
})

describe('the producer is registered, which is the half that was missing', () => {
    const dirs: string[] = []

    afterEach(() => {
        delete process.env.DROVER_DIR
        delete process.env.DROVER_HOOKS
    })

    function checkout(adapters: string[]): string {
        const dir = mkdtempSync(join(tmpdir(), 'drover-hooks-'))
        dirs.push(dir)
        const { mkdirSync } = require('node:fs') as typeof import('node:fs')
        mkdirSync(join(dir, 'adapters'), { recursive: true })
        for (const name of adapters) writeFileSync(join(dir, 'adapters', name), '#!/bin/sh\n')
        return dir
    }

    it('gives permission_prompt to the approval adapter and idle_prompt to the ding', () => {
        process.env.DROVER_DIR = checkout(['claude-approval.sh', 'claude-notification.sh'])
        const hooks = droverHooks()
        const matchers = (hooks.Notification ?? []).map((m) => m.matcher)
        // One owner per type: two adapters on one notification is two cards for
        // one dialog, and a dialog takes one key.
        expect(matchers).toContain('permission_prompt')
        expect(matchers).toContain('idle_prompt')
        expect(matchers).not.toContain('idle_prompt|permission_prompt')
        const approval = (hooks.Notification ?? []).find((m) => m.matcher === 'permission_prompt')
        expect(approval?.hooks[0].command).toContain('claude-approval.sh')
    })

    it('leaves permission_prompt with the ding on a checkout that has no approval adapter', () => {
        // An older cattle-drover on disk must still ding rather than go quiet.
        process.env.DROVER_DIR = checkout(['claude-notification.sh'])
        const hooks = droverHooks()
        const matchers = (hooks.Notification ?? []).map((m) => m.matcher)
        expect(matchers).toEqual(['idle_prompt|permission_prompt'])
    })
})
