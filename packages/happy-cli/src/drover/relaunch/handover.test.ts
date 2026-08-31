import { describe, expect, it } from 'vitest'

import { buildRelaunchArgv, relaunchExitCode, relaunchFileEnv, relaunchIsSupervised } from './handover'

const id = '19c2f0a8-f803-4cb8-8bee-c68b6773e412'
const other = '0a12da8b-1111-4222-8333-444444444444'

describe('buildRelaunchArgv', () => {
    it('replaces the resume id the session was started with', () => {
        // The shape every daemon-spawned and picker-resolved session has.
        expect(buildRelaunchArgv(['--dangerously-skip-permissions', '--resume', other], id))
            .toEqual(['--dangerously-skip-permissions', '--resume', id])
    })

    it('adds a resume to a session that was started fresh', () => {
        expect(buildRelaunchArgv(['--yolo'], id)).toEqual(['--yolo', '--resume', id])
    })

    it('leaves a bare --resume\'s neighbour alone', () => {
        // `drover --resume --yolo` is the picker plus a flag, not an id.
        expect(buildRelaunchArgv(['--resume', '--yolo'], id)).toEqual(['--yolo', '--resume', id])
    })

    it('turns -c and --continue into the explicit id', () => {
        expect(buildRelaunchArgv(['-c'], id)).toEqual(['--resume', id])
        expect(buildRelaunchArgv(['--continue'], id)).toEqual(['--resume', id])
        expect(buildRelaunchArgv(['-r', other], id)).toEqual(['--resume', id])
    })

    it('drops the clone seed', () => {
        // runClaude keeps the seed off the argv precisely so a relaunch cannot
        // paste the whole seeded conversation in again (DROVE-58).
        expect(buildRelaunchArgv(['--seed', '/tmp/seed.txt', '--yolo'], id))
            .toEqual(['--yolo', '--resume', id])
    })

    it('carries everything else through untouched', () => {
        expect(buildRelaunchArgv(
            ['--started-by', 'daemon', '--claude-env', 'FOO=bar', '--happy-starting-mode', 'local'],
            id,
        )).toEqual(['--started-by', 'daemon', '--claude-env', 'FOO=bar', '--happy-starting-mode', 'local', '--resume', id])
    })

    it('refuses an id that is not a transcript id', () => {
        expect(() => buildRelaunchArgv([], 'not-a-uuid')).toThrow(/non-uuid/)
    })
})

describe('relaunchIsSupervised', () => {
    it('is true only when a wrapper named a relaunch file', () => {
        expect(relaunchIsSupervised({ [relaunchFileEnv]: '/tmp/x/relaunch.json' })).toBe(true)
        expect(relaunchIsSupervised({})).toBe(false)
        expect(relaunchIsSupervised({ [relaunchFileEnv]: '' })).toBe(false)
    })
})

describe('relaunchExitCode', () => {
    it('is EX_TEMPFAIL, which nothing else in the tree produces', () => {
        // claude exits 0/1/143; 75 means "try again", which is the whole
        // message from the launcher to its wrapper.
        expect(relaunchExitCode).toBe(75)
    })
})
