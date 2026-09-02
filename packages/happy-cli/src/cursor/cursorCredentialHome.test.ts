/**
 * The private home a `--account` session's credential lives in (DROVE-387).
 *
 * Every case runs against a mkdtemp "real home" and a mkdtemp state dir.
 * Nothing here reads a credential, and nothing goes near ~/.cursor.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { cursorCredentialHomeDir, cursorCredentialHomeHasToken, prepareCursorCredentialHome } from './cursorCredentialHome';

const temps: string[] = [];
function tempDir(tag: string): string {
    const dir = mkdtempSync(join(tmpdir(), `cursor-cred-${tag}-`));
    temps.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A home shaped like Clay's: a git identity, an ssh dir, a real ~/.cursor. */
function fakeHome(): string {
    const home = tempDir('home');
    writeFileSync(join(home, '.gitconfig'), '[user]\n\temail = clayrisser@gmail.com\n');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'config'), 'Host *\n');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{"mcpServers":{}}\n');
    writeFileSync(join(home, '.cursor', 'hooks.json'), '{"version":1}\n');
    writeFileSync(join(home, '.cursor', 'auth.json'), '{"accessToken":"FIXTURESECRET-MACHINES-OWN"}\n');
    return home;
}

describe('cursorCredentialHomeDir', () => {
    it('is per account, and an address is not a path component', () => {
        expect(cursorCredentialHomeDir('/s', 'jam@example.com')).toBe('/s/cursor-home/jam_example.com');
        expect(cursorCredentialHomeDir('/s', '../escape')).toBe('/s/cursor-home/.._escape');
    });
});

describe('prepareCursorCredentialHome', () => {
    it('puts the token in the ONE file cursor-agent reads, 0600 in a 0700 dir', () => {
        const real = fakeHome();
        const home = prepareCursorCredentialHome(join(tempDir('state'), 'cursor-home', 'jam'), 'tok-FIXTURESECRET-jam', real);
        const auth = join(home, '.cursor', 'auth.json');
        expect(existsSync(auth)).toBe(true);
        expect(cursorCredentialHomeHasToken(home)).toBe(true);
        // The shape cursor-agent's own setAuthentication writes.
        expect(JSON.parse(readFileSync(auth, 'utf8'))).toEqual({
            accessToken: 'tok-FIXTURESECRET-jam',
            refreshToken: 'tok-FIXTURESECRET-jam',
            apiKey: null,
        });
        expect(statSync(auth).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, '.cursor')).mode & 0o777).toBe(0o700);
        expect(statSync(home).mode & 0o777).toBe(0o700);
    });

    it('never writes the machine\'s own ~/.cursor/auth.json', () => {
        const real = fakeHome();
        const before = readFileSync(join(real, '.cursor', 'auth.json'), 'utf8');
        prepareCursorCredentialHome(join(tempDir('state'), 'h'), 'tok-FIXTURESECRET-jam', real);
        expect(readFileSync(join(real, '.cursor', 'auth.json'), 'utf8')).toBe(before);
    });

    it('SHADOWS the real home, so the turn keeps its git identity and its MCP servers', () => {
        const real = fakeHome();
        const home = prepareCursorCredentialHome(join(tempDir('state'), 'h'), 'tok-FIXTURESECRET-jam', real);
        // Everything but .cursor is the real thing, reached through a link.
        expect(readFileSync(join(home, '.gitconfig'), 'utf8')).toContain('clayrisser@gmail.com');
        expect(readFileSync(join(home, '.ssh', 'config'), 'utf8')).toBe('Host *\n');
        expect(lstatSync(join(home, '.gitconfig')).isSymbolicLink()).toBe(true);
        // .cursor is OURS, with everything but the credential linked back out.
        expect(lstatSync(join(home, '.cursor')).isSymbolicLink()).toBe(false);
        expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('{"mcpServers":{}}\n');
        expect(readlinkSync(join(home, '.cursor', 'hooks.json'))).toBe(join(real, '.cursor', 'hooks.json'));
        expect(lstatSync(join(home, '.cursor', 'auth.json')).isSymbolicLink()).toBe(false);
    });

    it('converges instead of rebuilding, so a second session on one account is not a demolition', () => {
        const real = fakeHome();
        const dir = join(tempDir('state'), 'h');
        prepareCursorCredentialHome(dir, 'tok-FIXTURESECRET-old', real);
        // Something new in the real home between the two starts.
        writeFileSync(join(real, '.npmrc'), 'registry=https://example\n');
        const home = prepareCursorCredentialHome(dir, 'tok-FIXTURESECRET-new', real);
        expect(JSON.parse(readFileSync(join(home, '.cursor', 'auth.json'), 'utf8')).accessToken).toBe('tok-FIXTURESECRET-new');
        expect(existsSync(join(home, '.npmrc'))).toBe(true);
    });

    it('replaces a LINK where the credential goes rather than writing through it', () => {
        const real = fakeHome();
        const dir = join(tempDir('state'), 'h');
        mkdirSync(join(dir, '.cursor'), { recursive: true });
        symlinkSync(join(real, '.cursor', 'auth.json'), join(dir, '.cursor', 'auth.json'));
        prepareCursorCredentialHome(dir, 'tok-FIXTURESECRET-jam', real);
        expect(JSON.parse(readFileSync(join(dir, '.cursor', 'auth.json'), 'utf8')).accessToken).toBe('tok-FIXTURESECRET-jam');
        // The one that must not have moved.
        expect(JSON.parse(readFileSync(join(real, '.cursor', 'auth.json'), 'utf8')).accessToken).toBe('FIXTURESECRET-MACHINES-OWN');
    });

    it('links hooks.json before it exists, because the hooks are registered after the account is', () => {
        const real = tempDir('home-nohooks');
        mkdirSync(join(real, '.cursor'), { recursive: true });
        const home = prepareCursorCredentialHome(join(tempDir('state'), 'h'), 'tok-FIXTURESECRET-jam', real);
        const link = join(home, '.cursor', 'hooks.json');
        // Dangling for now, and dangling reads as absent.
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readlinkSync(link)).toBe(join(real, '.cursor', 'hooks.json'));
        expect(existsSync(link)).toBe(false);
        // The moment installHooks writes the real file, the turn sees it.
        writeFileSync(join(real, '.cursor', 'hooks.json'), '{"version":1,"hooks":{}}\n');
        expect(readFileSync(link, 'utf8')).toBe('{"version":1,"hooks":{}}\n');
    });

    it('refuses to make the real home its own shadow', () => {
        const real = fakeHome();
        expect(() => prepareCursorCredentialHome(real, 'tok-FIXTURESECRET', real)).toThrow(/refusing/);
        expect(() => prepareCursorCredentialHome('', 'tok', real)).toThrow(/refusing/);
        expect(() => prepareCursorCredentialHome(join(real, '..'), 'tok', join(real, 'inner'))).toThrow(/refusing/);
    });
});
