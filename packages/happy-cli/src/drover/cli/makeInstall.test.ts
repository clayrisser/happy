/**
 * `make install` / `make uninstall` in node, against the same fixtures
 * cattle-drover's tests/make-install.bats drives the shell script with
 * (DROVE-315).
 *
 * NOTHING HERE MAY TOUCH A REAL INSTALL. The bats file's four guards are kept
 * exactly, because the target of this code is a machine's ~/.local/bin, its
 * ~/Library/LaunchAgents and its live launchd domain — the three places a
 * wrong write costs the CLI, the phone surface, or both:
 *
 *   HOME is a per-test throwaway, and BIN_DIR/AGENTS_DIR/STATE_DIR are all
 *   derived from it explicitly, so nothing resolves to the real ones even if a
 *   default is wrong.
 *
 *   DROVER_DIR is a FIXTURE checkout under the test tmpdir, never a real one,
 *   so `unlinks` — which removes only symlinks pointing into $DROVER_DIR/bin —
 *   can never match anything real.
 *
 *   DROVER_LAUNCHCTL is a recording stub. No launchctl is executed. The stub
 *   keeps state, so "already loaded" is a real answer and the idempotency
 *   assertions mean something.
 *
 *   The one thing the stub cannot prove is the real command line, so the
 *   DRY_RUN cases assert the exact `bootstrap gui/<uid> <plist>` and
 *   `bootout gui/<uid>/<label>` strings a real install would run.
 *
 * THE PROOF THAT THIS IS A PORT AND NOT A REWRITE is the last case: the shell
 * script and this module render the same template into two directories, and
 * the bytes are compared. `plutil -lint` says each is a valid plist; `cmp`
 * says they are the same plist.
 */

import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { droverEnv } from './env';
import { installCfg, labelPrefix, renderPlist, run } from './makeInstall';

/** The cattle-drover checkout the templates and the shell script come from. */
const CATTLE = droverEnv().droverDir;

let root: string;
let home: string;
let binDir: string;
let agentsDir: string;
let stateDir: string;
let droverDir: string;
let loaded: string;
let lctlLog: string;
let launchctl: string;
let env: Record<string, string | undefined>;
const lines: string[] = [];
const io = { out: (s: string) => void lines.push(s), err: (s: string) => void lines.push(s) };
const output = () => lines.join('');
const plist = (s: string) => join(agentsDir, `${labelPrefix}.${s}.plist`);

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-install-'));
    home = join(root, 'home');
    binDir = join(home, '.local', 'bin');
    agentsDir = join(home, 'Library', 'LaunchAgents');
    stateDir = join(home, 'state');
    droverDir = join(root, 'checkout');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(droverDir, 'bin'), { recursive: true });
    mkdirSync(join(droverDir, 'launchd'), { recursive: true });
    // A fixture checkout: the one binary that gets linked, and the REAL plist
    // templates, so a template that stops rendering valid XML fails here.
    writeFileSync(join(droverDir, 'bin', 'drover'), '#!/bin/sh\necho drover\n');
    chmodSync(join(droverDir, 'bin', 'drover'), 0o755);
    for (const f of readdirSync(join(CATTLE, 'launchd'))) {
        writeFileSync(join(droverDir, 'launchd', f), readFileSync(join(CATTLE, 'launchd', f)));
    }

    // The recording launchctl. It logs every call and keeps a loaded-set, so
    // `print` answers truthfully and a second converge run sees the world the
    // first one left.
    loaded = join(root, 'loaded');
    lctlLog = join(root, 'launchctl.log');
    mkdirSync(loaded, { recursive: true });
    writeFileSync(lctlLog, '');
    launchctl = join(root, 'launchctl');
    writeFileSync(launchctl, `#!/bin/sh
printf '%s\\n' "$*" >>"${lctlLog}"
case "$1" in
print)
    l=\${2##*/}
    [ -f "${loaded}/$l" ] || exit 1
    ;;
bootstrap)
    l=\${3##*/}
    l=\${l%.plist}
    : >"${loaded}/$l"
    ;;
bootout)
    l=\${2##*/}
    rm -f "${loaded}/$l"
    ;;
list)
    ls "${loaded}"
    ;;
esac
exit 0
`);
    chmodSync(launchctl, 0o755);

    env = {
        HOME: home,
        BIN_DIR: binDir,
        AGENTS_DIR: agentsDir,
        STATE_DIR: stateDir,
        DROVER_DIR: droverDir,
        LINKS: 'drover',
        LEGACY_LINKS: 'claude-acct drover-flip',
        SERVICES: 'bus relay bridge daemon',
        STARTED: 'bus bridge daemon',
        DRY_RUN: '0',
        DROVER_LAUNCHCTL: launchctl,
    };
    lines.length = 0;
});

const cfg = (over: Record<string, string | undefined> = {}) => installCfg({ ...env, ...over });
const log = () => readFileSync(lctlLog, 'utf8');

describe('symlinks', () => {
    it('creates the one command on PATH, and a second run changes nothing', async () => {
        expect(await run(['links'], io, cfg())).toBe(0);
        expect(output()).toContain('(created)');
        expect(readlinkSync(join(binDir, 'drover'))).toBe(join(droverDir, 'bin', 'drover'));

        lines.length = 0;
        expect(await run(['links'], io, cfg())).toBe(0);
        expect(output()).toContain('(unchanged)');
        expect(output()).not.toContain('(created)');
    });

    it('refuses a real file it did not create, byte for byte untouched', async () => {
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, 'drover'), 'somebody elses drover\n');
        expect(await run(['links'], io, cfg())).toBe(1);
        expect(output()).toContain('not a symlink');
        expect(readFileSync(join(binDir, 'drover'), 'utf8')).toBe('somebody elses drover\n');
    });

    it('refuses a symlink that is not another drover checkout, and repoints one that is', async () => {
        mkdirSync(binDir, { recursive: true });
        mkdirSync(join(root, 'other'), { recursive: true });
        writeFileSync(join(root, 'other', 'thing'), 'x\n');
        symlinkSync(join(root, 'other', 'thing'), join(binDir, 'drover'));
        expect(await run(['links'], io, cfg())).toBe(1);
        expect(output()).toContain('is not another drover checkout');
        expect(readlinkSync(join(binDir, 'drover'))).toBe(join(root, 'other', 'thing'));

    });

    it('repoints another checkout, and says what it was', async () => {
        // The documented multi-checkout case: `<something>/bin/<name>` is
        // drover-shaped, so replacing it is this install's business.
        mkdirSync(binDir, { recursive: true });
        mkdirSync(join(root, 'older', 'bin'), { recursive: true });
        writeFileSync(join(root, 'older', 'bin', 'drover'), 'x\n');
        symlinkSync(join(root, 'older', 'bin', 'drover'), join(binDir, 'drover'));
        expect(await run(['links'], io, cfg())).toBe(0);
        expect(output()).toContain(`repointed, was ${join(root, 'older', 'bin', 'drover')}`);
        expect(readlinkSync(join(binDir, 'drover'))).toBe(join(droverDir, 'bin', 'drover'));
    });

    it('refuses to point PATH at a linked git worktree', async () => {
        // A worktree has a .git FILE. Linking from one aims the live CLI at a
        // lane that gets deleted, and every terminal then has a dangling
        // `drover`.
        writeFileSync(join(droverDir, '.git'), 'gitdir: /somewhere/.git/worktrees/lane\n');
        expect(await run(['links'], io, cfg())).toBe(1);
        expect(output()).toContain('linked git worktree');
        expect(existsSync(join(binDir, 'drover'))).toBe(false);
    });

    it('unlinks only what this checkout owns', async () => {
        mkdirSync(binDir, { recursive: true });
        symlinkSync(join(droverDir, 'bin', 'drover'), join(binDir, 'drover'));
        symlinkSync(join(root, 'elsewhere', 'bin', 'claude-acct'), join(binDir, 'claude-acct'));
        expect(await run(['unlinks'], io, cfg())).toBe(0);
        expect(existsSync(join(binDir, 'drover'))).toBe(false);
        // The legacy name points somewhere else, so it is not ours to delete.
        expect(output()).toContain('left alone');
        expect(readlinkSync(join(binDir, 'claude-acct'))).toContain('elsewhere');
    });
});

describe('plists', () => {
    it('renders one valid agent per service with every placeholder gone', async () => {
        expect(await run(['plists'], io, cfg())).toBe(0);
        for (const s of ['bus', 'relay', 'bridge', 'daemon']) {
            expect(existsSync(plist(s))).toBe(true);
            const lint = spawnSync('plutil', ['-lint', plist(s)], { encoding: 'utf8' });
            expect(lint.status).toBe(0);
            expect(readFileSync(plist(s), 'utf8')).not.toContain('__');
        }
        expect(readFileSync(plist('bus'), 'utf8')).toContain(`<string>${labelPrefix}.bus</string>`);
        // The daemon still gets its OWN template, but the COMMAND is no longer
        // what separates it. It used to name libexec/drover-daemon by path,
        // because `drover daemon` was a passthrough to the fork CLI and that
        // cannot adopt a daemon already running. bin/drover has a `daemon)`
        // case now, so both units run `drover <name>`: one command, one
        // dispatch path (DROVE-315). Pin the whole argv, not a substring —
        // a plist that ran the wrong thing would still CONTAIN the right path.
        const programArgs = (xml: string): string[] => {
            const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
            expect(block, 'the unit must have a ProgramArguments array').not.toBeNull();
            return [...(block?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
        };
        const daemonXml = readFileSync(plist('daemon'), 'utf8');
        const busXml = readFileSync(plist('bus'), 'utf8');
        expect(programArgs(daemonXml)).toEqual([`${droverDir}/bin/drover`, 'daemon']);
        expect(programArgs(busXml)).toEqual([`${droverDir}/bin/drover`, 'bus']);
        // What DOES still separate the two templates: the QoS pair the shared
        // one carries (BASED-116) and the daemon's has never had. Fold the
        // daemon into the shared template and this is the assertion that says
        // the interactive band was a decision, not a side effect.
        expect(busXml).toContain('<key>ProcessType</key>');
        expect(daemonXml).not.toContain('<key>ProcessType</key>');
    });

    it('is byte-identical on a second run, and reports a changed template as updated', async () => {
        expect(await run(['plists'], io, cfg())).toBe(0);
        const first = readFileSync(plist('bus'));
        lines.length = 0;
        expect(await run(['plists'], io, cfg())).toBe(0);
        expect(output()).toContain('(unchanged)');
        expect(output()).not.toContain('(written)');
        expect(readFileSync(plist('bus'))).toEqual(first);

        writeFileSync(join(droverDir, 'launchd', `${labelPrefix}.plist.in`),
            readFileSync(join(droverDir, 'launchd', `${labelPrefix}.plist.in`), 'utf8') + '\n<!-- moved -->\n');
        lines.length = 0;
        expect(await run(['plists'], io, cfg())).toBe(0);
        expect(output()).toContain('(updated)');
        expect(readFileSync(plist('bus'), 'utf8')).toContain('moved');
    });

    it('removes drover\'s own agents and leaves a stranger\'s alone', async () => {
        expect(await run(['plists'], io, cfg())).toBe(0);
        // Ownership is the LABEL, not the filename.
        writeFileSync(plist('relay'),
            '<plist><dict><key>Label</key><string>com.example.other</string></dict></plist>\n');
        lines.length = 0;
        expect(await run(['unplists'], io, cfg())).toBe(0);
        expect(existsSync(plist('bus'))).toBe(false);
        expect(existsSync(plist('daemon'))).toBe(false);
        expect(existsSync(plist('relay'))).toBe(true);
        expect(output()).toContain('left alone');
    });
});

describe('the converging load', () => {
    it('loads the started units the first time and leaves the relay rendered but stopped', async () => {
        expect(await run(['launchd'], io, cfg())).toBe(0);
        expect(output()).toContain('(loading)');
        for (const s of ['bus', 'bridge', 'daemon']) {
            expect(existsSync(join(loaded, `${labelPrefix}.${s}`))).toBe(true);
        }
        expect(existsSync(plist('relay'))).toBe(true);
        expect(existsSync(join(loaded, `${labelPrefix}.relay`))).toBe(false);
    });

    it('boots NOTHING out on a rerun that changed nothing', async () => {
        expect(await run(['launchd'], io, cfg())).toBe(0);
        writeFileSync(lctlLog, '');
        lines.length = 0;
        expect(await run(['launchd'], io, cfg())).toBe(0);
        expect(output()).toContain('already loaded, unchanged');
        // THE ASSERTION THAT MATTERS. A rerun that boots the bus out drops the
        // surface a live session's prompts ride on, for no change at all.
        expect(log()).not.toContain('bootout');
        expect(log()).not.toContain('bootstrap');
    });

    it('reloads only the unit whose plist actually changed', async () => {
        expect(await run(['launchd'], io, cfg())).toBe(0);
        writeFileSync(lctlLog, '');
        // The daemon has its own template, so touching it moves exactly one unit.
        const t = join(droverDir, 'launchd', `${labelPrefix}.daemon.plist.in`);
        writeFileSync(t, readFileSync(t, 'utf8') + '\n<!-- daemon only -->\n');
        lines.length = 0;
        expect(await run(['launchd'], io, cfg())).toBe(0);
        expect(output()).toContain('plist changed — reloading');
        const moved = (unit: string) => log().split('\n')
            .filter((l) => l.match(new RegExp(`^(bootout|bootstrap) .*cattle-drover\\.${unit}`))).length;
        expect(moved('daemon')).toBe(2);
        expect(moved('bus')).toBe(0);
    });

    it('unload boots out every service, started or not', async () => {
        expect(await run(['launchd'], io, cfg())).toBe(0);
        writeFileSync(join(loaded, `${labelPrefix}.relay`), '');
        expect(await run(['unload'], io, cfg())).toBe(0);
        expect(readdirSync(loaded)).toEqual([]);
    });
});

describe('DRY_RUN', () => {
    it('prints the exact launchctl commands and writes nothing', async () => {
        const uid = String(process.getuid?.() ?? 0);
        expect(await run(['launchd'], io, cfg({ DRY_RUN: '1' }))).toBe(0);
        expect(output()).toContain(`would run: ${launchctl} bootstrap gui/${uid} ${plist('bus')}`);
        expect(output()).toContain(`would run: ${launchctl} bootstrap gui/${uid} ${plist('daemon')}`);
        // Not a single byte on disk, and nothing loaded.
        expect(existsSync(agentsDir)).toBe(false);
        expect(readdirSync(loaded)).toEqual([]);
    });

    it('prints the symlink it would make and makes none', async () => {
        expect(await run(['links'], io, cfg({ DRY_RUN: '1' }))).toBe(0);
        expect(output()).toContain(`would run: ln -sfn ${join(droverDir, 'bin', 'drover')} ${join(binDir, 'drover')}`);
        expect(existsSync(join(binDir, 'drover'))).toBe(false);
    });

    it('prints the bootout it would run over an existing install, and rewrites nothing', async () => {
        expect(await run(['launchd'], io, cfg())).toBe(0);
        const t = join(droverDir, 'launchd', `${labelPrefix}.plist.in`);
        writeFileSync(t, readFileSync(t, 'utf8') + '\n<!-- changed -->\n');
        const before = readFileSync(plist('bus'));
        lines.length = 0;
        expect(await run(['launchd'], io, cfg({ DRY_RUN: '1' }))).toBe(0);
        const uid = String(process.getuid?.() ?? 0);
        expect(output()).toContain(`would run: ${launchctl} bootout gui/${uid}/${labelPrefix}.bus`);
        expect(output()).toContain('DRY_RUN, not written');
        expect(readFileSync(plist('bus'))).toEqual(before);
    });
});

describe('report and the round trip', () => {
    it('names what is linked, rendered and loaded', async () => {
        expect(await run(['report'], io, cfg())).toBe(0);
        expect(output()).toContain('is NOT linked');
        expect(output()).toContain('not rendered, not loaded');
        await run(['links'], io, cfg());
        await run(['launchd'], io, cfg());
        lines.length = 0;
        expect(await run(['report'], io, cfg())).toBe(0);
        expect(output()).toContain(`${join(binDir, 'drover')} -> ${join(droverDir, 'bin', 'drover')}`);
        expect(output()).toContain('bus: rendered, loaded');
        expect(output()).toContain('relay: rendered, not loaded');
    });

    it('converges, then leaves nothing behind', async () => {
        expect(await run(['links'], io, cfg())).toBe(0);
        expect(await run(['launchd'], io, cfg())).toBe(0);
        const busFirst = readFileSync(plist('bus'));
        const linkFirst = readlinkSync(join(binDir, 'drover'));
        writeFileSync(lctlLog, '');

        expect(await run(['links'], io, cfg())).toBe(0);
        expect(await run(['launchd'], io, cfg())).toBe(0);
        expect(readFileSync(plist('bus'))).toEqual(busFirst);
        expect(readlinkSync(join(binDir, 'drover'))).toBe(linkFirst);
        expect(log().match(/bootout|bootstrap/)).toBeNull();

        expect(await run(['unload'], io, cfg())).toBe(0);
        expect(await run(['unplists'], io, cfg())).toBe(0);
        expect(await run(['unlinks'], io, cfg())).toBe(0);
        expect(existsSync(join(binDir, 'drover'))).toBe(false);
        for (const s of ['bus', 'relay', 'bridge', 'daemon']) {
            expect(existsSync(plist(s))).toBe(false);
            expect(existsSync(join(loaded, `${labelPrefix}.${s}`))).toBe(false);
        }
    });
});

/**
 * THE PORT'S OWN PROOF. Everything above says this module behaves like the
 * shell script; this says it produces the same bytes. Both renderers run over
 * the same templates into two directories, and the plists are compared byte
 * for byte after `plutil -lint` has agreed each is valid. A placeholder that
 * stopped being substituted, a substitution applied in the wrong order, or a
 * stray newline would all show up here and nowhere else.
 */
describe('byte-identical with the shell that still ships', () => {
    it('renders every unit exactly as scripts/drover-install.sh does', async () => {
        const script = join(CATTLE, 'scripts', 'drover-install.sh');
        if (!existsSync(script)) {
            throw new Error(`the shell renderer is the reference and it is missing: ${script}`);
        }
        const shellAgents = join(root, 'shell-agents');
        const r = spawnSync('sh', [script, 'plists'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                HOME: home,
                DROVER_DIR: droverDir,
                AGENTS_DIR: shellAgents,
                STATE_DIR: stateDir,
                SERVICES: 'bus relay bridge daemon',
                // The shell script never reaches launchctl on this path, but
                // the stub is exported anyway so a future edit that did could
                // not touch a real domain from here.
                DROVER_LAUNCHCTL: launchctl,
                DRY_RUN: '0',
            },
        });
        expect(r.status, r.stderr).toBe(0);

        expect(await run(['plists'], io, cfg())).toBe(0);

        for (const s of ['bus', 'relay', 'bridge', 'daemon']) {
            const shell = join(shellAgents, `${labelPrefix}.${s}.plist`);
            expect(spawnSync('plutil', ['-lint', shell], { encoding: 'utf8' }).status).toBe(0);
            expect(spawnSync('plutil', ['-lint', plist(s)], { encoding: 'utf8' }).status).toBe(0);
            const cmp = spawnSync('cmp', [shell, plist(s)], { encoding: 'utf8' });
            expect(cmp.status, `${s}: ${cmp.stdout}${cmp.stderr}`).toBe(0);
            // And the in-memory render is the same string, so the identity is
            // the renderer's and not an artefact of how it was written out.
            expect(renderPlist(cfg(), s)).toBe(readFileSync(shell, 'utf8'));
        }
    });
});
