/**
 * Which relay the CLI resolves, both ways (DROVE-332).
 *
 * The cutover from Happy's hosted server to drover's own relay turns one
 * hardcoded default into a MODE, and the failure worth a test is the quiet
 * one: a CLI that keeps talking to the hosted server after the machine was
 * moved off it, or an `estate` that silently means hosted because nobody had
 * named the host yet.
 *
 * The functions here are the whole mapping, and they are pure on purpose —
 * `configuration` is a singleton that reads the env once at import, so a
 * precedence stated as a chain of `||` inside a constructor is not something a
 * test can observe without rebuilding it.
 */

import { describe, expect, it } from 'vitest'

import {
    hostedServerUrl,
    hostedWebappUrl,
    resolveDroverServer,
    resolveServerUrls,
} from './configuration'

const noSettings = () => undefined

describe('resolveDroverServer: a mode word to a mode', () => {
    it('defaults to hosted when nothing names a mode', () => {
        expect(resolveDroverServer({})).toEqual({ mode: 'hosted', url: undefined, problem: undefined })
        expect(resolveDroverServer({ DROVER_SERVER_MODE: '' }).mode).toBe('hosted')
    })

    // `official` and `relay` are written into the local.env of every machine
    // drover has already installed. A word that silently means nothing sends a
    // machine to the wrong server.
    it('keeps the old spellings working: official is hosted, relay is local', () => {
        expect(resolveDroverServer({ DROVER_SERVER_MODE: 'official' }).mode).toBe('hosted')
        expect(resolveDroverServer({ DROVER_SERVER_MODE: 'relay' }).mode).toBe('local')
    })

    it('takes the mode case-insensitively and trimmed, the way a hand-edited file spells it', () => {
        expect(resolveDroverServer({ DROVER_SERVER_MODE: ' Estate ', DROVER_ESTATE_URL: 'https://relay.example' }).mode)
            .toBe('estate')
    })

    it('refuses a word it does not know instead of falling back to hosted in silence', () => {
        const got = resolveDroverServer({ DROVER_SERVER_MODE: 'wat' })
        expect(got.url).toBeUndefined()
        expect(got.problem).toContain("unknown DROVER_SERVER_MODE 'wat'")
    })
})

describe('resolveDroverServer: a mode to a URL', () => {
    it('gives hosted no URL of its own — undefined is how the built-in default is reached', () => {
        expect(resolveDroverServer({ DROVER_SERVER_MODE: 'hosted' }).url).toBeUndefined()
    })

    it('gives local the relay port this Mac runs, and defaults it', () => {
        expect(resolveDroverServer({ DROVER_SERVER_MODE: 'local', DROVER_RELAY_URL: 'http://127.0.0.1:7999' }).url)
            .toBe('http://127.0.0.1:7999')
        expect(resolveDroverServer({ DROVER_SERVER_MODE: 'local' }).url).toBe('http://127.0.0.1:7971')
    })

    it('gives estate the address it was given', () => {
        expect(resolveDroverServer({ DROVER_SERVER_MODE: 'estate', DROVER_ESTATE_URL: 'https://relay.example' }))
            .toEqual({ mode: 'estate', url: 'https://relay.example', problem: undefined })
    })

    it('makes estate with no address a problem, never a quiet hosted', () => {
        const got = resolveDroverServer({ DROVER_SERVER_MODE: 'estate' })
        expect(got.url).toBeUndefined()
        expect(got.problem).toContain('DROVER_ESTATE_URL is unset')
    })
})

describe('resolveServerUrls: the precedence', () => {
    it('falls all the way through to the hosted default', () => {
        expect(resolveServerUrls({}, noSettings)).toEqual({
            mode: 'hosted',
            serverUrl: hostedServerUrl,
            webappUrl: hostedWebappUrl,
        })
    })

    it('lets settings.json answer when no mode and no env does', () => {
        const settings = (k: 'serverUrl' | 'webappUrl') =>
            k === 'serverUrl' ? 'https://from-settings.example' : 'https://webapp-from-settings.example'
        expect(resolveServerUrls({}, settings)).toMatchObject({
            serverUrl: 'https://from-settings.example',
            webappUrl: 'https://webapp-from-settings.example',
        })
    })

    // The whole point of the mode sitting above settings: settings.json lives
    // inside the mode's own happy home, and a stale serverUrl there must not
    // drag a switched machine back to the server it was moved off.
    it('puts the mode above settings.json', () => {
        const settings = () => 'https://stale-from-settings.example'
        expect(resolveServerUrls(
            { DROVER_SERVER_MODE: 'estate', DROVER_ESTATE_URL: 'https://relay.example' },
            settings,
        )).toMatchObject({ mode: 'estate', serverUrl: 'https://relay.example' })
    })

    // The wrappers export HAPPY_SERVER_URL from this same mode, so the two
    // agree; anyone setting it by hand means it.
    it('puts an explicit HAPPY_SERVER_URL above the mode', () => {
        expect(resolveServerUrls(
            {
                HAPPY_SERVER_URL: 'http://127.0.0.1:1',
                DROVER_SERVER_MODE: 'estate',
                DROVER_ESTATE_URL: 'https://relay.example',
            },
            noSettings,
        ).serverUrl).toBe('http://127.0.0.1:1')
    })

    // A relay serves the exported web app from its own origin. Following the
    // API to a relay and the webapp to app.happy.engineering is how `happy
    // server` used to open a login page against a server that had never heard
    // of the account.
    it('takes webappUrl to the relay too, and still lets HAPPY_WEBAPP_URL win', () => {
        expect(resolveServerUrls({ DROVER_SERVER_MODE: 'relay', DROVER_RELAY_URL: 'http://127.0.0.1:7971' }, noSettings))
            .toMatchObject({ serverUrl: 'http://127.0.0.1:7971', webappUrl: 'http://127.0.0.1:7971' })
        expect(resolveServerUrls(
            {
                DROVER_SERVER_MODE: 'relay',
                DROVER_RELAY_URL: 'http://127.0.0.1:7971',
                HAPPY_WEBAPP_URL: 'http://127.0.0.1:8080',
            },
            noSettings,
        ).webappUrl).toBe('http://127.0.0.1:8080')
    })

    it('throws rather than resolve a mode it cannot honour', () => {
        expect(() => resolveServerUrls({ DROVER_SERVER_MODE: 'estate' }, noSettings))
            .toThrow(/DROVER_ESTATE_URL is unset/)
        expect(() => resolveServerUrls({ DROVER_SERVER_MODE: 'wat' }, noSettings))
            .toThrow(/unknown DROVER_SERVER_MODE/)
    })

    // An explicit URL answers the question on its own, so a broken mode beside
    // one is not worth refusing to start over.
    it('does not throw when an explicit HAPPY_SERVER_URL already answers', () => {
        expect(resolveServerUrls(
            { DROVER_SERVER_MODE: 'estate', HAPPY_SERVER_URL: 'http://127.0.0.1:1' },
            noSettings,
        ).serverUrl).toBe('http://127.0.0.1:1')
    })
})
