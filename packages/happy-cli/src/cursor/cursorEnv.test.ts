import { describe, it, expect } from 'vitest';

import { cursorTurnEnv, scrubbedCursorVars, cursorApiKeySourceIsOwnLogin } from './cursorEnv';

describe('cursorTurnEnv', () => {
    it('scrubs an inherited key, token and endpoint', () => {
        const env = cursorTurnEnv('/cfg', {}, {
            PATH: '/bin',
            CURSOR_API_KEY: 'key_someone_elses',
            CURSOR_AUTH_TOKEN: 'tok',
            CURSOR_API_ENDPOINT: 'https://elsewhere',
        });
        expect(env.CURSOR_API_KEY).toBeUndefined();
        expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
        expect(env.CURSOR_API_ENDPOINT).toBeUndefined();
        expect(env.PATH).toBe('/bin');
        expect(env.CURSOR_CONFIG_DIR).toBe('/cfg');
    });

    it('keeps a key the SESSION owns, because that is not inheritance', () => {
        const env = cursorTurnEnv('/cfg', { apiKey: 'key_mine', apiEndpoint: 'https://mine' }, {
            CURSOR_API_KEY: 'key_someone_elses',
        });
        expect(env.CURSOR_API_KEY).toBe('key_mine');
        expect(env.CURSOR_API_ENDPOINT).toBe('https://mine');
    });

    it('an owned endpoint does not license an inherited key', () => {
        const env = cursorTurnEnv('/cfg', { apiEndpoint: 'https://mine' }, {
            CURSOR_API_KEY: 'key_someone_elses',
        });
        expect(env.CURSOR_API_KEY).toBeUndefined();
        expect(env.CURSOR_API_ENDPOINT).toBe('https://mine');
    });

    it('never mutates the environment it was handed', () => {
        const base = { CURSOR_API_KEY: 'key_someone_elses' };
        cursorTurnEnv('/cfg', {}, base);
        expect(base.CURSOR_API_KEY).toBe('key_someone_elses');
    });

    it('reports only what it actually removed', () => {
        expect(scrubbedCursorVars({}, { CURSOR_API_KEY: 'k' })).toEqual(['CURSOR_API_KEY']);
        expect(scrubbedCursorVars({ apiKey: 'k' }, { CURSOR_API_KEY: 'k' })).toEqual([]);
        expect(scrubbedCursorVars({}, {})).toEqual([]);
    });
});

describe('cursorApiKeySourceIsOwnLogin', () => {
    it('only `login` and nothing are quiet', () => {
        expect(cursorApiKeySourceIsOwnLogin('login')).toBe(true);
        expect(cursorApiKeySourceIsOwnLogin(null)).toBe(true);
        expect(cursorApiKeySourceIsOwnLogin(undefined)).toBe(true);
        expect(cursorApiKeySourceIsOwnLogin('env')).toBe(false);
        expect(cursorApiKeySourceIsOwnLogin('flag')).toBe(false);
        expect(cursorApiKeySourceIsOwnLogin('config')).toBe(false);
    });
});
