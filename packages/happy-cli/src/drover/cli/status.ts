/**
 * `drover status` — is the drover up, what is waiting on a human, and which
 * services are running (DROVE-315, the node twin of libexec/drover-status).
 *
 * Four things a person actually wants to know, in one screen: the bus is
 * answering (and only on loopback), how many prompts are pending and of what
 * kind, whether the phone can actually be buzzed, and whether the launchd units
 * are loaded. A bus that is DOWN is the common case worth reporting well —
 * every producer is fail-open, so a down bus is not an outage, it just means
 * prompts only reach the terminal.
 *
 * READ-ONLY, AND IT PAYS FOR NOTHING (DROVE-314). This verb registers no
 * session, starts no daemon and takes no build lock. It is reached through the
 * lazy dispatch table, so nothing in the session supervisor is loaded to answer
 * a question about whether the session supervisor is alive.
 *
 * IT NEVER PRINTS A LOG (DROVE-283/318). The push section reads thousands of
 * files under the Happy home and the gate section reads the publish ledger.
 * What leaves this screen is a COUNT, a CLOCK and the structured verdict field
 * the shell already extracted — never a line of a log, never a token, never a
 * transcript. The logs are a credential exposure until Clay rules on them; a
 * status screen that quoted one would be the leak.
 *
 * Every sentence below is load-bearing. They were each written against a
 * specific outage where the screen said the wrong thing — "the popup had no
 * screen to draw on", "it is UP; do not start another", "a live pid is not
 * health" — and the port keeps them to the character.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BusError, busGet } from './bus';
import {
    distAgeHuman,
    distFailureAt,
    distFailureFiles,
    distFailureReason,
    distFailureUnchanged,
    distGoodField,
    distLine,
    distStale,
    distValid,
    mtimeSeconds,
} from './dist';
import { droverEnv } from './env';

const USAGE = `drover status — bus health, pending prompts, push delivery, services.

USAGE
  drover status          Human-readable
  drover status --json   Raw /v1/status

See also: drover sessions (what is running) · drover accounts (headroom)
`;

/**
 * Every process the screen inspects, behind one seam.
 *
 * A status screen asks the OS five questions — what is this pid, what is
 * running, what does launchd supervise, which sockets does the bridge hold,
 * will this Mac sleep — and each one is a shell-out. Behind one interface they
 * are all injectable, so a test asserts the RENDER against known answers
 * instead of reading Clay's real machine while he is working. The double a test
 * hands in throws by default; a section that reached for the world would fail
 * the test rather than quietly measure it.
 */
export interface StatusProbe {
    /** `ps -o command= -p <pid>` — the command line, or '' when the pid is gone. */
    psCommand(pid: string): string;
    /** `pgrep -f <pattern>` — matching pids, newest last, as the shell reads them. */
    pgrep(pattern: string): string[];
    /** `launchctl list <label>` — the PID key of the plist it prints, or ''. */
    launchdPid(label: string): string;
    /** `launchctl print gui/<uid>/<label>` — true when the job is loaded. */
    launchdLoaded(target: string): boolean;
    /** `lsof -nP -p <pid> -a -iTCP -sTCP:ESTABLISHED`, or null when lsof is missing. */
    lsofEstablished(pid: string): string | null;
    /** `pmset -g`, or '' when the tool is missing or said nothing. */
    pmset(): string;
    /** `id -u`. */
    uid(): string;
    /** Now, in whole seconds. Injected so an age is assertable. */
    now(): number;
}

/** The real machine. Each call is guarded: a status screen must not die because a tool is missing. */
export function systemProbe(): StatusProbe {
    const spawn = (cmd: string, args: string[]): string | null => {
        try {
            const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            if (r.error) return null;
            return r.stdout ?? '';
        } catch {
            return null;
        }
    };
    return {
        psCommand: (pid) => (pid ? (spawn('ps', ['-o', 'command=', '-p', pid]) ?? '').replace(/\n$/, '') : ''),
        pgrep: (pattern) => (spawn('pgrep', ['-f', pattern]) ?? '').split('\n').filter((l) => l !== ''),
        launchdPid: (label) => {
            const out = spawn('launchctl', ['list', label]) ?? '';
            for (const line of out.split('\n')) {
                const m = line.match(/"PID" = ([0-9][0-9]*);/);
                if (m) return m[1];
            }
            return '';
        },
        launchdLoaded: (target) => {
            try {
                const r = spawnSync('launchctl', ['print', target], { stdio: 'ignore' });
                return !r.error && r.status === 0;
            } catch {
                return false;
            }
        },
        // null, not '', when lsof is not on the machine: "cannot verify its
        // sockets" and "verified, none established" are different sentences.
        lsofEstablished: (pid) => spawn('lsof', ['-nP', '-p', pid, '-a', '-iTCP', '-sTCP:ESTABLISHED']),
        pmset: () => spawn('pmset', ['-g']) ?? '',
        uid: () => String(process.getuid?.() ?? ''),
        now: () => Math.floor(Date.now() / 1000),
    };
}

/** Read a file, or null. Absent, unreadable and a directory are the same answer, as `[ -r ]` says. */
function slurp(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

/** The lines of a file, without the empty tail a trailing newline leaves. */
function lines(text: string): string[] {
    const out = text.split('\n');
    if (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
}

/** `grep -c <fixed>` — how many LINES contain this substring. */
function countContaining(text: string | null, needle: string): number {
    if (text === null) return 0;
    return lines(text).filter((l) => l.includes(needle)).length;
}

/**
 * `cut -f1,3,4 | tr '\t' ' '` over one ledger line.
 *
 * The verdict field comes along too (-f4, not just the gate), because the
 * failure line carries WHY — "publish-failed after 2x3s at <bus>" — and that is
 * the whole reason the gate writes it. Tabs to spaces: this is a screen, not a
 * TSV. A line with no tab at all is passed through untouched, which is what cut
 * does without -s.
 */
function cutFields(line: string): string {
    if (!line.includes('\t')) return line;
    const f = line.split('\t');
    return [f[0], f[2], f[3]].filter((x) => x !== undefined).join(' ');
}

/** The last line of `text` containing `needle`, or ''. */
function lastContaining(text: string | null, needle: string): string {
    if (text === null) return '';
    const hits = lines(text).filter((l) => l.includes(needle));
    return hits.length > 0 ? hits[hits.length - 1] : '';
}

// --- push ---------------------------------------------------------------------

/** One normalized verdict: "<day> <time> <verdict> <reason>", the awk's output row. */
export interface PushVerdict {
    day: string;
    time: string;
    verdict: string;
    reason: string;
}

/**
 * The bridge's own `[HH:MM:SS.mmm] ` stamp, ANCHORED AT COLUMN 1.
 *
 * The bridge log also carries the session's tool-call text verbatim, and on
 * 2026-08-31 02:06 that text included this suite's own fixtures, indented
 * inside a quoted JS string and sitting LATER in the file than the four real
 * receipts. An unanchored match took `... sendSessionNotification duplicate ...`
 * off one of those echoed lines as the newest verdict, with "?" for a time, and
 * the screen said "never attempted" over a log holding two oks. A log line
 * starts at the margin with a clock; anything indented, or quoted, is something
 * the log is quoting, not something it is saying.
 */
const PUSH_STAMP = /^\[[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9]*\] /;

/**
 * THREE line shapes are verdicts (DROVE-85), because the server path is not the
 * only one. A to-do and a wake go DIRECT to Expo from the CLI, so they never
 * produce a `sendSessionNotification <verdict>` line at all, and a machine whose
 * only pushes were to-dos read "never attempted" here while the bridge was
 * pushing every few minutes.
 */
const PUSH_MATCH = /^\[[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9]*\] (\[PUSH\] )?(sendSessionNotification [a-z][a-z_]* |\[PUSH\] receipt [^ ]+ |Push notifications sent successfully)/;

/**
 * The candidate log files, newest last.
 *
 * SCAN THE NEWEST FILES, NOT ALL OF THEM. This directory grows forever —
 * 13,632 files and 1.6 GB on this machine — and `drover status` runs it every
 * time. The names are timestamp-prefixed, which is what makes `sort | tail` mean
 * "newest" at all, so the same ordering picks the candidates BEFORE the read
 * instead of after it. `ls -f` on the DIRECTORY reads it once and neither stats
 * nor sorts; readdirSync is that call.
 */
export function pushCandidates(logsDir: string, window: number): string[] {
    let names: string[];
    try {
        names = readdirSync(logsDir);
    } catch {
        return [];
    }
    const logs = names.filter((n) => n.endsWith('.log')).sort();
    return logs.slice(Math.max(0, logs.length - window * 40)).map((n) => join(logsDir, n));
}

/** `grep -l` for a verdict shape, then `sort | tail -<window>`. */
export function pushLogs(candidates: string[], window: number): string[] {
    const hits: string[] = [];
    for (const path of candidates) {
        const text = slurp(path);
        if (text === null) continue;
        if (lines(text).some((l) => PUSH_MATCH.test(l))) hits.push(path);
    }
    hits.sort();
    return hits.slice(Math.max(0, hits.length - window));
}

/**
 * The awk normalizer: one row per verdict, sorted by day+time.
 *
 * The day comes from the log's FILENAME because the line itself carries only a
 * clock, and a clock alone cannot say whether the last success came before or
 * after the last failure once the window crosses midnight — which it does, the
 * window being the last few processes that tried to push rather than a day.
 *
 * The verdict is the field after the method name, and it must be a bare word:
 * the CLI also logs `sendSessionNotification failed: <error>` from its catch
 * block, which is a request that never reached the server rather than a verdict
 * the server returned, and counting the two together would put a network blip
 * in the same bucket as an Expo refusal.
 *
 * Sorted by day+time at the end, because file order is not time order: each
 * happy-cli process gets its own log named for when it STARTED, and a process
 * that started at 08:10 is still writing at 09:02 while one that started at
 * 08:20 stopped at 08:39. The sort is STABLE (`sort -s -k1,2`), so rows sharing
 * a stamp keep the order the files gave them.
 */
export function pushVerdicts(paths: string[]): PushVerdict[] {
    const rows: PushVerdict[] = [];
    for (const path of paths) {
        const base = path.slice(path.lastIndexOf('/') + 1);
        const day = base.match(/^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/) ? base.slice(0, 10) : '?';
        const text = slurp(path);
        if (text === null) continue;
        for (const line of lines(text)) {
            if (!PUSH_STAMP.test(line)) continue;
            const f = line.split(/[ \t]+/).filter((x) => x !== '');
            const nf = f.length;
            let verdict = '';
            let reason = '-';
            // awk indexes from 1 and stops before the last field, so the loop
            // runs i = 2 .. NF-1: `$(i+1)` must exist for every shape below.
            for (let i = 2; i <= nf - 1; i++) {
                const cur = f[i - 1];
                if (cur === 'sendSessionNotification') {
                    verdict = f[i];
                    const p = line.indexOf('reason=');
                    if (p >= 0) reason = line.slice(p + 7).replace(/[ \t]+$/, '');
                    break;
                }
                // [PUSH] receipt <ticket> ok | [PUSH] receipt <ticket> <error> <details>
                // A pending receipt is Expo not having answered yet, not a verdict.
                if (cur === '[PUSH]' && f[i] === 'receipt' && i + 3 <= nf) {
                    if (f[i + 2] === 'ok') {
                        verdict = 'delivered';
                        reason = `ticket=${f[i + 1]}`;
                    } else if (f[i + 2] !== 'pending') {
                        verdict = 'failed';
                        reason = f.slice(i + 2).join(' ');
                    }
                    break;
                }
                if (cur === 'Push' && f[i] === 'notifications' && f[i + 1] === 'sent' && f[i + 2] === 'successfully') {
                    verdict = 'sent';
                    reason = 'direct';
                    break;
                }
            }
            if (!verdict.match(/^[a-z_]+$/)) continue;
            const time = f[0].replace(/[[\]]/g, '');
            rows.push({ day, time, verdict, reason: reason === '' ? '-' : reason });
        }
    }
    // `LC_ALL=C sort -s -k1,2`: a stable sort on "<day> <time>".
    return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
            const ka = `${a.row.day} ${a.row.time}`;
            const kb = `${b.row.day} ${b.row.time}`;
            if (ka < kb) return -1;
            if (ka > kb) return 1;
            return a.index - b.index;
        })
        .map((x) => x.row);
}

/** The last stamp of a given verdict, "" when there is none. `awk … END`, not `| tail -1`. */
function whenOf(rows: PushVerdict[], verdict: string): string {
    let out = '';
    for (const r of rows) if (r.verdict === verdict) out = `${r.day} ${r.time}`;
    return out;
}

/** The last reason of a given verdict, "" when there is none. */
function whyOf(rows: PushVerdict[], verdict: string): string {
    let out = '';
    for (const r of rows) if (r.verdict === verdict) out = r.reason;
    return out;
}

// --- the screen ---------------------------------------------------------------

interface Out {
    line(text: string): void;
}

/** `printf '          %-12s %s\n'` — the indented label rows under a section head. */
function labelled(out: Out, label: string, value: string): void {
    out.line(`          ${label.padEnd(12)} ${value}`);
}

/**
 * The bus block. Same three-way split as `drover sessions`. A status command
 * that reports DOWN for a timeout is worse than useless: DOWN is the one word
 * that makes a person start a second copy of a daemon that is already running.
 */
export function renderBus(
    out: Out,
    droverUrl: string,
    stateDir: string,
    result: { body: string } | BusError,
    timeoutS: number,
): void {
    if (result instanceof BusError) {
        // curl 7 (refused) and curl 6 (cannot resolve) are both "there is
        // nothing there"; the shell prints DOWN for either.
        if (result.kind === 'refused' || result.kind === 'resolve') {
            out.line(`bus       DOWN at ${droverUrl}`);
            out.line('          start it: drover bus   (or make launchd for the supervised stack)');
            out.line('          prompts still work — every producer falls back to its own UI.');
            out.line('');
            return;
        }
        out.line(`bus       SLOW at ${droverUrl} — listening, but /v1/status did not answer in ${timeoutS}s`);
        out.line(`          it is UP; do not start another. Check ${stateDir}/logs/bus.log`);
        out.line('');
        return;
    }
    if (result.body === '') {
        out.line(`bus       answered ${droverUrl} with an empty body — a bug in the bus, not a down bus`);
        out.line(`          check ${stateDir}/logs/bus.log`);
        out.line('');
        return;
    }
    let status: Record<string, unknown>;
    try {
        status = JSON.parse(result.body) as Record<string, unknown>;
    } catch {
        // jq fails, prints nothing on stdout, and `set -e` is not in play for a
        // pipeline's first command — the shell simply prints the blank line.
        out.line('');
        return;
    }
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const byKind = (status.pendingByKind ?? {}) as Record<string, number>;
    const kinds = Object.entries(byKind);
    out.line(`bus       up · ${String(status.bind ?? '')} on ${String(status.machine ?? '')}`);
    out.line(
        `pending   ${String(num(status.pending))}`
        + (kinds.length > 0 ? ` (${kinds.map(([k, v]) => `${v} ${k}`).join(', ')})` : ''),
    );
    // To-dos get their own line rather than being left to hide inside the
    // pending count (DROVE-53). They are the one kind that never expires, so a
    // session can leave five of them behind and every other number here still
    // reads healthy — which is exactly the silence this file exists to break.
    const todo = num(byKind.todo);
    out.line(`todos     ${todo}${todo === 0 ? ' waiting on you' : ' waiting on you · drover todos'}`);
    out.line(`surfaces  ${String(num(status.surfaces))} subscribed`);
    out.line(`events    ${String(num(status.events))} seen this run`);
    // Per channel (DROVE-72). The announce set is the SETTING the bus stamps on
    // the next event; what a channel then did is only partly visible from the
    // Mac. visual = the push verdict below and the popup; haptic = the wrist
    // wake, reported under `wrist`; audio = a sentence spoken on a phone, which
    // nothing here can hear, so it is said to be unobservable rather than
    // guessed at.
    const delivery = status.delivery as {
        announce?: string[];
        answer?: string[];
        mode?: string;
        lastAnswered?: { visual?: number; audio?: number };
    } | undefined | null;
    if (delivery) {
        const announce = delivery.announce ?? [];
        out.line(
            'channels  announce '
            + (announce.length === 0 ? 'none (terminal only)' : announce.join(','))
            + ` · answer ${(delivery.answer ?? []).join(',')}`
            + (delivery.mode ? ` · mode ${delivery.mode}` : ''),
        );
        const clock = (ms: number | undefined): string => {
            if (!ms) return 'never this run';
            const d = new Date(ms);
            const pad = (n: number): string => String(n).padStart(2, '0');
            return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        };
        out.line(
            `          last answered: visual ${clock(delivery.lastAnswered?.visual)}`
            + ` · audio ${clock(delivery.lastAnswered?.audio)}`
            + ' · audio announce is not observable from the Mac',
        );
    }
    out.line('');
}

/**
 * The push block — the phone's half of the bus, and the half nothing else
 * reports on.
 *
 * Mirroring a card into the Happy session is not the same as buzzing a wrist:
 * the CLI posts the push to the Happy server, the server may suppress it, and
 * Expo may refuse it outright, and every one of those verdicts is logged at
 * debug and thrown away. So a total push outage reads identically to a healthy
 * one from every other signal here — which is exactly how zero pushes in the
 * whole history of this stack went unnoticed.
 *
 * A HISTORY, NOT ONE LINE (DROVE-14). This used to `tail -1` the newest log
 * holding a verdict and report that single reading as the state of push, which
 * cannot tell "dead" from "broke and then recovered". The 2026-08-29 run held
 * both: failures up to 08:39:23.928 and successes from 08:47:50.741, and the
 * screen said BROKEN for an hour of investigation. Counts plus the last success
 * AND the last failure are self-correcting; one verdict is not.
 */
export function renderPush(out: Out, rows: PushVerdict[], happyHome: string, forkDir: string): void {
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    const verdict = last?.verdict ?? '';
    const when = last ? `${last.day} ${last.time}` : '';
    const rawWhy = last?.reason ?? '';
    const why = rawWhy === '-' ? '' : rawWhy;

    const sentWhen = whenOf(rows, 'sent');
    const failWhen = whenOf(rows, 'failed');
    // A verdict with no reason field reads "-" out of the normalizer, and "— -"
    // on a screen names nothing. Say so instead.
    const failWhyRaw = whyOf(rows, 'failed');
    const failWhy = failWhyRaw === '-' ? 'reason not logged' : failWhyRaw;

    /**
     * The window line: what was actually counted, over what span. Without the
     * span a count is unreadable — "33 failed" means opposite things over ten
     * minutes and over three days.
     */
    const history = (): void => {
        const first = rows.length > 0 ? `${rows[0].day} ${rows[0].time}` : '';
        const lastStamp = rows.length > 0 ? `${rows[rows.length - 1].day} ${rows[rows.length - 1].time}` : '';
        const order: string[] = [];
        const tally = new Map<string, number>();
        for (const r of rows) {
            if (!tally.has(r.verdict)) order.push(r.verdict);
            tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1);
        }
        out.line(`          window    ${first} → ${lastStamp} · ${order.map((v) => `${tally.get(v)} ${v}`).join(', ')}`);
        // Only the one the headline is not already showing, so nothing is
        // printed twice — but never NEITHER, which is the whole point of the
        // ticket.
        if (sentWhen && verdict !== 'sent' && verdict !== 'delivered') {
            out.line(`          last sent ${sentWhen}`);
        }
        if (failWhen && verdict !== 'failed') {
            out.line(`          last FAIL ${failWhen} — ${failWhy}`);
        }
    };

    switch (verdict) {
        case 'delivered':
            // An Expo receipt: APNs took the message. The furthest downstream
            // anything on this machine can see, and one step past "sent".
            out.line(`push      ok · APNs accepted the last push ${when || '?'} (${why})`);
            history();
            break;
        case 'sent':
            out.line(`push      ok · last delivered ${when || '?'}`);
            history();
            break;
        case 'partial':
            out.line(`push      PARTIAL ${when} — some devices refused: ${why}`);
            history();
            break;
        case 'suppressed':
            out.line(`push      SUPPRESSED ${when} — ${why}`);
            history();
            out.line('          the server skips the push while a Happy UI reports itself active.');
            out.line('          background the app and close any open Happy web tab to get buzzed.');
            break;
        case 'no_tokens':
            out.line(`push      NO DEVICE ${when} — nothing is registered to push to`);
            history();
            out.line('          open the app, allow notifications, and it registers on next launch.');
            break;
        case 'failed':
            out.line(`push      BROKEN ${when} — ${why || 'reason not logged'}`);
            history();
            // A receipt's reason carries Expo's message after the error word, so
            // the match is on the word, not the whole field.
            if (why === 'InvalidCredentials' || why.startsWith('InvalidCredentials ')) {
                renderInvalidCredentials(out, forkDir);
            }
            break;
        case 'accepted':
            // An older Happy server answers without a verdict, and the CLI logs
            // "accepted by server". That is a real attempt, so reporting it as
            // the never-attempted case below was the same defect in miniature.
            out.line(`push      accepted ${when} — the server took it and did not say what it did`);
            history();
            out.line('          this server returns no delivery verdict; nothing here can confirm a buzz.');
            break;
        default:
            out.line(`push      never attempted — no push verdict in ${happyHome}/logs`);
            out.line('          a card can still reach the app; nothing has tried to buzz the phone.');
            break;
    }

    // The wrist does not go through any of that. The phone drives the watch over
    // WatchConnectivity, which never touches APNs or Expo, so a suppressed or
    // InvalidCredentials push says nothing about whether the watch buzzed
    // (DROVE-62). Said only when push is actually broken, because that is the
    // moment the second path matters and the moment nobody thinks to look for it.
    if (verdict === 'suppressed' || verdict === 'failed' || verdict === 'no_tokens') {
        out.line('          the WRIST is a separate path and is unaffected by any of this —');
        out.line('          it needs the phone app alive and the Drover complication on a');
        out.line('          watch face, which is what lets the phone wake the watch app.');
    }
}

/**
 * Which Expo project the app built on this machine registers its push token
 * under, measured rather than assumed (DROVE-14).
 *
 * `expo prebuild` writes updates.url into the iOS Expo.plist out of the same
 * app.config.js `easProjectId` that mints the push token, so the uuid in
 * EXUpdatesURL names the project the token belongs to. The exported archive is
 * preferred over the working prebuild because the archive is what went to
 * TestFlight, and the working tree can have moved on since.
 *
 * Empty is a real answer here and gets printed as one: this screen used to name
 * a cause it had not looked at, and an unread plist is not evidence of anything.
 */
export function readPushProject(forkDir: string): { id: string; src: string } {
    const appDir = join(forkDir, 'packages', 'happy-app');
    const candidates: string[] = [];
    // The two globs, in the shell's order: the exported archive first.
    for (const build of listDir(join(appDir, 'ios', 'build'))) {
        if (!build.endsWith('.xcarchive')) continue;
        const apps = join(appDir, 'ios', 'build', build, 'Products', 'Applications');
        for (const app of listDir(apps)) {
            if (!app.endsWith('.app')) continue;
            candidates.push(join(apps, app, 'Expo.plist'));
        }
    }
    for (const dir of listDir(join(appDir, 'ios'))) {
        candidates.push(join(appDir, 'ios', dir, 'Supporting', 'Expo.plist'));
    }
    for (const path of candidates) {
        if (!existsSync(path)) continue;
        // The archive's copy of this plist is BINARY, so it is read as latin1
        // and matched byte-wise — the shell forces LC_ALL=C for the same reason,
        // because sed in a UTF-8 locale answers an illegal byte sequence on
        // stderr, onto the status screen, instead of no match.
        let text: string;
        try {
            text = readFileSync(path, 'latin1');
        } catch {
            continue;
        }
        const m = text.match(/u\.expo\.dev\/([0-9a-f][0-9a-f-]*)/);
        if (m) return { id: m[1], src: path };
    }
    return { id: '', src: '' };
}

/**
 * Upstream's project id is READ OUT of app.config.js, never copied here, so the
 * comparison cannot drift away from what a build actually bakes in.
 */
export function upstreamPushProject(forkDir: string): string {
    const text = slurp(join(forkDir, 'packages', 'happy-app', 'app.config.js'));
    if (text === null) return '';
    for (const line of lines(text)) {
        const m = line.match(/DROVER_EAS_PROJECT_ID *\|\| *"([0-9a-f][0-9a-f-]*)"/);
        if (m) return m[1];
    }
    return '';
}

/** Names in a directory, or none. */
function listDir(path: string): string[] {
    try {
        return readdirSync(path).sort();
    } catch {
        return [];
    }
}

/**
 * InvalidCredentials, the one verdict this screen used to explain without
 * looking at anything.
 *
 * The old text asserted the upstream-Expo-project fault for EVERY
 * InvalidCredentials: four lines of remedy, nothing measured. On 2026-08-29 it
 * was wrong — build 6 had already registered a token under Clay's own project,
 * and the pre-build-6 token was simply still the most recently updated one for
 * about eight minutes — and DROVE-5 was filed quoting that paragraph as a
 * finding. An hour went into an Expo project that was not involved. So the
 * remedy is printed only after reading which project the build here actually
 * registers under, and when that cannot be read the answer is "unknown".
 */
function renderInvalidCredentials(out: Out, forkDir: string): void {
    const mine = readPushProject(forkDir);
    const up = upstreamPushProject(forkDir);
    if (mine.id === '' || up === '') {
        out.line('          cause UNKNOWN — nothing here has read which Expo project the push');
        out.line('          token is registered under, so this screen will not name one.');
        out.line('          Read it off the built app, then come back:');
        out.line(`            grep -A1 EXUpdatesURL ${join(forkDir, 'packages', 'happy-app')}/ios/*/Supporting/Expo.plist`);
        return;
    }
    if (mine.id === up) {
        out.line("          measured: this build registers under upstream's Expo project");
        out.line(`          ${mine.id}, which holds no APNs key for DROVER_BUNDLE_ID.`);
        out.line(`          (read from ${mine.src})`);
        out.line('          Set DROVER_EAS_PROJECT_ID + DROVER_EAS_OWNER to your own project,');
        out.line('          `eas credentials` an APNs key for that bundle id, then rebuild.');
        return;
    }
    out.line(`          measured: this build registers under ${mine.id},`);
    out.line(`          not upstream's ${up} — so the Expo-project remedy does not apply.`);
    out.line(`          (read from ${mine.src})`);
    out.line('          The remaining cause is NOT measured from here. A token minted by a');
    out.line('          build older than that config still belongs to upstream, and the push');
    out.line('          path follows the most recently updated token — so find out which build');
    out.line('          the phone is running before changing any credentials.');
}

/**
 * gates — has a confirmation prompt ever actually LEFT this machine?
 *
 * This is the signal whose absence cost weeks. The ask-* gates rendered a gum
 * popup and published nothing, so the popup worked, the bus was up, the bridge
 * was alive, the phone was paired, and not one prompt ever reached a phone or a
 * watch. Every line above this one said healthy. Nothing anywhere counted the
 * thing that was zero.
 *
 * The ledger is appended by the gate itself, so it survives a bus restart and
 * cannot be faked by the bus looking fine. A publish that FAILED is recorded
 * too: "nothing has happened" and "the remote path is broken" must never again
 * be the same reading.
 */
export function renderGates(out: Out, ledgerText: string | null): void {
    const ok = countContaining(ledgerText, '\tpublished ');
    const bad = countContaining(ledgerText, '\tpublish-failed');
    // THE LAST EVENT AND THE LAST FAILURE ARE TWO DIFFERENT LINES, because for
    // weeks they were one line and it lied. `tail -1` printed directly beneath
    // "2 FAILED to publish" is a SUCCESSFUL publish nine times out of ten, so
    // the screen read as though the failure had just happened. In the real
    // ledger the two failures are 22:18Z and 02:14Z and the last event is
    // 09:06Z — seven hours and a fix apart, and nothing on the screen could say
    // so. A count with no date cannot tell "the remote path is broken NOW" from
    // "it broke twice before the publish retry landed", and those want opposite
    // reactions.
    const all = ledgerText === null ? [] : lines(ledgerText);
    const lastEvent = ledgerText === null || all.length === 0 ? '' : cutFields(all[all.length - 1]);
    const lastBadLine = lastContaining(ledgerText, '\tpublish-failed');
    const lastBad = lastBadLine === '' ? '' : cutFields(lastBadLine);

    // Denied with nobody ever shown the prompt, split by CAUSE. A published
    // prompt is not the same as an answered one, and this is the gap that hid:
    // 3 of 58 firings ended popup-refused-denied with the event live on the bus
    // and a phone in hand (BASED-112), and the line above counted every one of
    // them as a healthy publish. The two causes need opposite fixes, so they are
    // counted apart rather than as one "blind" total.
    const noclient = countContaining(ledgerText, '\tpopup-no-client-denied');
    const overlay = countContaining(ledgerText, '\tpopup-refused-denied');
    const tmuxErr = countContaining(ledgerText, '\tpopup-tmux-error-denied');
    // DROVE-203's two, and they are the ones worth reading first. `foreign` is a
    // gate that refused to draw because every terminal on this tmux server was
    // watching a DIFFERENT session — the state in which tmux used to draw the
    // popup on a stranger's screen and let their keystroke allow it. `unseen` is
    // the same blindness ending the other way, with a phone or a watch answering
    // it, which is the system working as intended and not a fault at all.
    const foreign = countContaining(ledgerText, '\tpopup-foreign-client-denied');
    const unverif = countContaining(ledgerText, '\tpopup-unverifiable-denied');
    const unseenRemote = ledgerText === null ? 0 : lines(ledgerText).filter((l) => l.endsWith('-remote')).length;

    if (ok === 0 && bad === 0) {
        out.line('gates     NEVER PUBLISHED — no confirmation prompt has ever left this machine');
        out.line('          the popup will still work; the phone and the watch see nothing.');
        out.line('          check the ask-* hooks call _drover-ask.sh: grep -rl drover-gate ~/.shotgun/hooks');
    } else if (ok === 0) {
        out.line(`gates     BROKEN — ${bad} fired, 0 published`);
        out.line('          every prompt stayed on this screen. Is the bus reachable from a hook?');
        if (lastBad) labelled(out, 'last FAILURE', lastBad);
    } else {
        out.line(`gates     ${ok} published${bad > 0 ? `, ${bad} FAILED to publish` : ''}`);
        if (lastEvent) labelled(out, 'last event', lastEvent);
        if (lastBad) labelled(out, 'last FAILURE', lastBad);
    }
    if (noclient > 0) {
        out.line(`blind     ${noclient} denied with NO TMUX CLIENT attached and no surface answering`);
        out.line('          the popup had no screen to draw on. Attach a terminal, or make sure');
        out.line('          the bridge is connected so the phone can answer instead.');
    }
    if (overlay > 0) {
        out.line(`blind     ${overlay} denied while another popup held the overlay`);
        out.line('          clear a stuck one with: tmux display-popup -C');
    }
    if (tmuxErr > 0) {
        out.line(`blind     ${tmuxErr} denied because tmux would not run the popup, cause unknown`);
        out.line('          a client IS attached, so it is neither a held overlay nor a detached');
        out.line('          session. Check: tmux display-popup -E true');
    }
    if (foreign > 0) {
        out.line(`blind     ${foreign} denied rather than draw on a terminal watching another session`);
        out.line('          no client is attached to the session that raised the gate, so tmux');
        out.line('          would have drawn the popup over somebody else work, where one');
        out.line('          keystroke answers it. Attach a terminal to that session, or answer');
        out.line('          on the phone. These used to resolve ALLOW without a human (DROVE-203).');
    }
    if (unverif > 0) {
        out.line(`blind     ${unverif} denied because drover could not tell where the popup would land`);
        out.line('          lib/drover-tmux.sh missing beside lib/drover-gate.sh, or TMUX unset.');
    }
    if (unseenRemote > 0) {
        out.line(`remote    ${unseenRemote} answered on a phone or a watch after no popup could be drawn`);
        out.line('          this is the good ending for a blind gate: nothing local, a human anyway.');
    }
}

/**
 * messages — did a message from the phone actually reach the terminal?
 *
 * DROVE-48 deleted the pane paste that used to sit behind Claude's inbox
 * socket. A bracketed paste lands on whatever has focus, and the terminal drives
 * subagents now, so a message sent while Clay was inside a background task's
 * view was answered by THAT SUBAGENT, with nothing anywhere recording it.
 * Deleting a fallback turns the failure it hid into a real failure, and a real
 * failure nobody counts is the same hole the gates ledger above was dug out of.
 *
 * Same tab-separated shape as published.log, deliberately a DIFFERENT FILE:
 * that one answers "has a prompt ever left this machine", and its `last event`
 * line is the tail of it, which a message row would quietly take over.
 */
export function renderMessages(out: Out, msgsText: string | null): void {
    const ok = msgsText === null ? 0 : lines(msgsText).filter((l) => l.endsWith('\tdelivered')).length;
    const bad = countContaining(msgsText, '\tundelivered ');
    // WHY as well as WHEN, for the same reason the gate failures carry it: the
    // reason is the whole difference between an old Claude with no socket and a
    // socket that is there and refusing.
    const lastBadLine = lastContaining(msgsText, '\tundelivered ');
    const lastBad = lastBadLine === '' ? '' : cutFields(lastBadLine);

    if (ok === 0 && bad === 0) {
        out.line('messages  none yet — no phone message has reached a terminal session');
        return;
    }
    if (bad === 0) {
        out.line(`messages  ${ok} delivered by the inbox socket, none lost`);
        return;
    }
    out.line(`messages  ${ok} delivered, ${bad} UNDELIVERED — the phone was told, nothing was pasted`);
    if (lastBad) labelled(out, 'last FAILURE', lastBad);
    out.line("          a phone message rides Claude's own inbox socket and nothing else.");
    out.line('          Held for the next Claude in that pane; resend it if you need it now.');
}

/**
 * bridge — CONNECTED, not merely running. A live pid proves nothing: the bridge
 * sat "running" under launchd for an hour and a half while its last log line was
 * a module-not-found stack. What actually matters is its two sockets: one to the
 * bus (it must hear the events) and one outbound to the Happy server (it must be
 * able to forward them). Either missing and the phone is deaf.
 */
export function renderBridge(out: Out, probe: StatusProbe, droverPort: string, stateDir: string): void {
    const pid = probe.pgrep('dist/index.mjs drover-bridge')[0] ?? '';
    if (pid === '') {
        out.line('bridge    NOT RUNNING — nothing forwards events to the phone or the watch');
        return;
    }
    const socks = probe.lsofEstablished(pid);
    if (socks === null) {
        out.line(`bridge    pid ${pid} (cannot verify its sockets: lsof missing)`);
        return;
    }
    const toBus = countContaining(socks, `>127.0.0.1:${droverPort}`);
    const toSrv = countContaining(socks, ':443 ');
    if (toBus > 0 && toSrv > 0) {
        out.line(`bridge    connected · pid ${pid} · bus yes · happy server yes`);
        return;
    }
    if (toBus > 0) {
        out.line(`bridge    HALF UP · pid ${pid} · bus yes · happy server NO`);
        out.line('          it hears events and cannot forward them. Nothing reaches the phone.');
        return;
    }
    if (toSrv > 0) {
        out.line(`bridge    HALF UP · pid ${pid} · bus NO · happy server yes`);
        out.line('          it can forward, but is not subscribed to the bus — so it hears nothing.');
        return;
    }
    out.line(`bridge    RUNNING BUT CONNECTED TO NOTHING · pid ${pid}`);
    out.line(`          a live pid is not health. Check ${stateDir}/logs/bridge.log`);
}

/** `ps -o command= -p <pid>` says this pid is alive AND is really a daemon. */
function isDaemon(probe: StatusProbe, pid: string): boolean {
    if (!pid) return false;
    // One `ps` answers both questions. A `kill -0` guard as well was not just
    // redundant, it was WRONG: it fails with EPERM on a live process owned by
    // someone else, so a recycled pid that landed on a root process got reported
    // as "not running" when it was running fine and simply wasn't ours.
    return probe.psCommand(pid).match(/dist\/index\.mjs daemon start-sync/) !== null;
}

/**
 * daemon — the machine's own registration, and the piece nothing else witnesses.
 *
 * The bridge carries prompts OUT of a session that already exists. The daemon is
 * what lets the phone start one, list one or stop one at all: it registers this
 * machine with the Happy server and holds the socket the spawn-happy-session RPC
 * arrives on. When it dies the machine just stops appearing in the app, while
 * every other line on this screen still reads healthy — the same shape of silent
 * failure as the gates ledger above, so it gets the same treatment.
 */
export function renderDaemon(out: Out, probe: StatusProbe, happyHome: string): void {
    const statePath = join(happyHome, 'daemon.state.json');
    let stateJson: Record<string, unknown> = {};
    const stateText = slurp(statePath);
    if (stateText !== null) {
        try {
            stateJson = JSON.parse(stateText) as Record<string, unknown>;
        } catch {
            stateJson = {};
        }
    }
    const statePid = stateJson.pid === undefined || stateJson.pid === null ? '' : String(stateJson.pid);

    // launchd knows which daemon it is supervising; the state file only knows
    // which daemon wrote to it last. Those are different questions, and DROVE-42
    // is what happens when you answer the second and print it as the first: five
    // daemons were alive at once, all orphaned to pid 1, all sharing this one
    // file, and this line reported a pid that had already exited while launchd
    // was happily running another.
    const launchdPid = probe.launchdPid('com.bitspur.cattle-drover.daemon');

    // The pid launchd runs is NOT always a daemon. libexec/drover-daemon ADOPTS
    // an incumbent rather than racing it, so while another daemon holds the
    // state file launchd's pid is a /bin/sh standing by, which execs only once
    // the incumbent goes. Measured live on 2026-08-30: launchd ran 14797 (the
    // wrapper, standing by) while the daemon actually serving the phone was
    // 14525, orphaned to pid 1 and supervised by nothing. Preferring launchd
    // blindly reported that as "pid 14797 is alive but is not a daemon" — true
    // of the pid, wrong about the world.
    let pid: string;
    let source: 'launchd' | 'state' | 'none';
    let unsupervised = '';
    if (isDaemon(probe, launchdPid)) {
        pid = launchdPid;
        source = 'launchd';
    } else if (isDaemon(probe, statePid)) {
        pid = statePid;
        source = 'state';
        // launchd is loaded and running something that is not this daemon, so
        // nothing will restart the process the phone actually depends on.
        if (launchdPid) unsupervised = launchdPid;
    } else {
        // Nothing is up. Report whichever pid a person would go looking for.
        pid = launchdPid || statePid;
        source = 'none';
    }
    const cmd = pid ? probe.psCommand(pid) : '';

    // How many daemons are actually alive. More than one is the DROVE-42 fault
    // itself: they race on the state file, and only one of them is holding the
    // socket the phone's spawn RPC arrives on.
    const liveCount = probe.pgrep('dist/index\\.mjs daemon start-sync').length;

    const hint = (): void => {
        out.line(`          start it: launchctl kickstart -k gui/${probe.uid()}/com.bitspur.cattle-drover.daemon`);
    };

    // Printed under whatever the main line says, because a disagreement is worth
    // reporting even when the daemon it lands on is perfectly healthy.
    const extra = (): void => {
        if (source === 'launchd' && pid !== statePid) {
            if (statePid === '') {
                out.line(`          launchd runs pid ${pid}, which has not written ${statePath} yet.`);
            } else {
                out.line(`          DISAGREEMENT — launchd runs pid ${pid}, ${statePath} names pid ${statePid}.`);
                out.line('          Reporting launchd. The heartbeat below belongs to whoever wrote last.');
            }
        }
        if (unsupervised) {
            out.line(`          UNSUPERVISED — launchd is standing by on pid ${unsupervised}, not running this daemon.`);
            out.line(`          Nothing will restart pid ${pid} if it dies. Hand it over: kill ${pid}`);
        }
        if (liveCount > 1) {
            out.line(`          ${liveCount} daemons are alive and racing on ${statePath}; launchd supervises one.`);
            out.line('          List them: pgrep -fl "daemon start-sync"');
        }
    };

    if (source === 'none') {
        if (pid === '') {
            out.line('daemon    DOWN — the phone cannot start, list or stop a session here');
            out.line(`          no daemon recorded in ${statePath}, and launchd is not running one`);
        } else if (cmd === '') {
            out.line(`daemon    DOWN — ${statePath} names pid ${pid}, which is not running`);
            out.line(`          the daemon died without cleaning up; ${statePath} is stale.`);
        } else {
            // The pid is alive and is something else: the OS recycled it, or
            // launchd is running the wrapper with no daemon behind it.
            out.line(`daemon    DOWN — pid ${pid} is alive but is not a daemon`);
            out.line(`          nothing is serving ${statePath}.`);
        }
        extra();
        hint();
        return;
    }

    const port = stateJson.httpPort === undefined || stateJson.httpPort === null ? '' : String(stateJson.httpPort);
    // The heartbeat is written into the state file every 60s, but as a US-locale
    // string ("8/29/2026, 1:03:53 AM") that no shell should try to parse. The
    // file's mtime moves with it and is already an epoch, so use that.
    const beat = mtimeSeconds(statePath);
    if (beat === null) {
        out.line(`daemon    up · pid ${pid} · port ${port || '?'}`);
        extra();
        return;
    }
    const age = probe.now() - beat;
    // Three missed beats. One missed beat is a busy machine, not an outage.
    if (age > 180) {
        out.line(`daemon    STALLED · pid ${pid} · last heartbeat ${age}s ago`);
        out.line('          the process is alive and has stopped beating, so the server still');
        out.line('          thinks this machine is here. Restart it:');
        extra();
        hint();
        return;
    }
    out.line(`daemon    up · pid ${pid} · port ${port || '?'} · heartbeat ${age}s ago`);
    extra();
}

/**
 * build — the fork CLI's dist, and whether the thing every session execs is
 * actually the code in the tree (DROVE-65).
 */
export function renderBuild(out: Out, forkDir: string, stateDir: string, now: number): void {
    const cli = join(forkDir, 'packages', 'happy-cli');
    if (!existsSync(cli)) {
        out.line('');
        out.line(`build     fork not found at ${forkDir}`);
        return;
    }
    // Under the daemon, because the daemon is what loads it: which dist is on
    // disk, and how the last build went, from the record scripts/build.cjs in
    // the fork writes on every run, including one Clay ran by hand.
    out.line(distLine(cli, now));
    const goodSha = distGoodField(cli, 'sha', stateDir);
    const goodAt = distGoodField(cli, 'at', stateDir);
    const failWhy = distFailureReason(cli, stateDir);
    const failAt = distFailureAt(cli, stateDir);

    out.line('');
    if (failWhy) {
        if (failAt !== null) {
            out.line(`build     FAILING for ${distAgeHuman(failAt, now)} · ${failWhy}`);
        } else {
            out.line(`build     FAILING · ${failWhy}`);
        }
        for (const f of distFailureFiles(cli, stateDir)) {
            if (f) out.line(`          ${f}`);
        }
        if (goodSha && goodAt) {
            out.line(`          sessions run the last-known-good dist ${goodSha}, built ${distAgeHuman(Number(goodAt), now)} ago`);
        } else {
            out.line('          NO last-known-good dist — the next session start may fail outright');
        }
        if (distFailureUnchanged(cli, stateDir)) {
            out.line('          the tree has not changed since; no start will retry the build');
        } else {
            out.line('          the tree HAS changed since; the next start retries the build');
        }
        return;
    }
    if (!distValid(cli)) {
        out.line('build     dist is not loadable — the next start rebuilds it');
        return;
    }
    if (distStale(cli)) {
        out.line('build     STALE — sources are newer than dist; the next start rebuilds');
        if (goodSha) {
            out.line(`          last good ${goodSha}, built ${goodAt ? distAgeHuman(Number(goodAt), now) : '?'} ago`);
        }
        return;
    }
    if (goodSha && goodAt) {
        const dirty = distGoodField(cli, 'dirty', stateDir) === '1' ? ' (dirty)' : '';
        out.line(`build     ok · dist ${goodSha}${dirty}, built ${distAgeHuman(Number(goodAt), now)} ago · sources unchanged`);
        return;
    }
    out.line('build     ok · sources unchanged, but no build here has been stamped yet');
    out.line('          the next successful build records one, and becomes the floor');
}

/**
 * sleep — every line above this one lives on THIS Mac, and stops with it.
 *
 * DROVE-6 asked whether a prompt can reach the watch while the Mac is asleep. It
 * cannot, and it is not going to: the bus binds loopback, the bridge dials out
 * from here, and the daemon holds this machine's registration. Asleep, all three
 * are gone and a script that wants a human decision has nowhere to publish. The
 * ruling was to keep the Mac awake and say so rather than build a second broker
 * off-box.
 *
 * A written constraint that nothing checks is a constraint that quietly stops
 * holding, so it is measured here. Two independent things keep this Mac up and
 * they fail differently: `pmset sleep 0` is a SETTING that survives a reboot,
 * while a caffeinate assertion dies with the process holding it — the daemon
 * spawns `caffeinate -im` and takes it to the grave.
 */
export function renderSleep(out: Out, pm: string): void {
    let sleepMin = '';
    let sleepBy = '';
    for (const line of pm.split('\n')) {
        if (sleepMin === '') {
            const m = line.match(/^[ ]*sleep[ ]*([0-9][0-9]*)/);
            if (m) sleepMin = m[1];
        }
        if (sleepBy === '') {
            const m = line.match(/^[ ]*sleep[ ]*[0-9][0-9]*[ ]*\(sleep prevented by (.*)\)[ ]*$/);
            if (m) sleepBy = m[1];
        }
    }
    const caffeinated = sleepBy.includes('caffeinate');

    if (sleepMin === '') {
        out.line('sleep     unknown — pmset said nothing this script could read');
        out.line('          if this Mac sleeps, the bus, the bridge and the daemon sleep with it');
        out.line('          and no prompt reaches the phone or the watch (DROVE-6).');
        return;
    }
    if (Number(sleepMin) === 0) {
        out.line(caffeinated
            ? 'sleep     never · pmset sleep 0, and caffeinate is held too'
            : 'sleep     never · pmset sleep 0');
        return;
    }
    if (caffeinated) {
        out.line(`sleep     awake ONLY while caffeinate is held · pmset sleep ${sleepMin} min`);
        out.line('          the assertion dies with the process holding it — the daemon spawns');
        out.line('          caffeinate -im and takes it down with it. Lose the daemon and this');
        out.line(`          Mac idles to sleep ${sleepMin} min later, taking the bus and the bridge with`);
        out.line('          it. Make it a setting instead: sudo pmset -a sleep 0 (DROVE-6).');
        return;
    }
    out.line(`sleep     AFTER ${sleepMin} MIN IDLE — nothing is holding this Mac awake`);
    out.line("          the bus, the bridge and this machine's registration all stop when it");
    out.line('          sleeps, so a prompt raised then reaches no phone and no watch, and');
    out.line('          the script that raised it waits for an answer nobody can give.');
    out.line('          Fix: sudo pmset -a sleep 0, or keep the daemon up (DROVE-6).');
}

/** The launchd units, and the one whose absence is the intended state. */
export function renderServices(out: Out, probe: StatusProbe, home: string, serverMode: string): void {
    out.line('');
    out.line('services');
    for (const s of ['bus', 'bridge', 'daemon', 'relay']) {
        const label = `com.bitspur.cattle-drover.${s}`;
        const plist = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
        if (probe.launchdLoaded(`gui/${probe.uid()}/${label}`)) {
            out.line(`  ${s.padEnd(8)} loaded`);
        } else if (!existsSync(plist)) {
            out.line(`  ${s.padEnd(8)} NOT INSTALLED — run: make launchd`);
        } else if (s === 'relay' && serverMode !== 'relay') {
            // Not a fault, and the reason this branch exists: the relay only
            // runs in relay mode, so a bare "not loaded" beside two loaded
            // services reads as breakage. This is the one service whose absence
            // is the intended state.
            out.line(`  ${s.padEnd(8)} installed, stopped on purpose (mode=official; make relay-on)`);
        } else {
            out.line(`  ${s.padEnd(8)} NOT LOADED — run: make launchd-one SERVICE=${s}`);
        }
    }
}

export interface StatusOptions {
    env?: Record<string, string | undefined>;
    home?: string;
    probe?: StatusProbe;
    write?: (text: string) => void;
    writeErr?: (text: string) => void;
}

/**
 * The whole screen, as lines. Separated from `run` so a test asserts the render
 * against injected answers without touching argv, stdout or the process.
 */
export async function statusReport(options: StatusOptions = {}): Promise<string[]> {
    const env = options.env ?? process.env;
    const home = options.home ?? (env.HOME ?? '');
    const probe = options.probe ?? systemProbe();
    const de = droverEnv(env, home);
    const out: string[] = [];
    const sink: Out = { line: (text) => out.push(text) };

    const timeoutS = Number(env.DROVER_STATUS_TIMEOUT_S ?? '5') || 5;
    let busResult: { body: string } | BusError;
    try {
        const res = await busGet('/v1/status', timeoutS * 1000, de.droverUrl);
        busResult = { body: res.body };
    } catch (error) {
        busResult = error instanceof BusError
            ? error
            : new BusError('other', de.droverUrl, timeoutS * 1000, String(error));
    }
    renderBus(sink, de.droverUrl, de.stateDir, busResult, timeoutS);

    // `${DROVER_PUSH_WINDOW:-10}` then `case '' | *[!0-9]*` — unset, empty or
    // anything with a non-digit in it falls back to ten.
    const rawWindow = env.DROVER_PUSH_WINDOW ?? '';
    const window = rawWindow.match(/^[0-9][0-9]*$/) ? Number(rawWindow) : 10;
    const logsDir = join(de.droverHappyHome, 'logs');
    renderPush(sink, pushVerdicts(pushLogs(pushCandidates(logsDir, window), window)), de.droverHappyHome, de.forkDir);

    renderGates(sink, slurp(join(de.stateDir, 'published.log')));
    renderMessages(sink, slurp(join(de.stateDir, 'messages.log')));
    renderBridge(sink, probe, de.droverPort, de.stateDir);
    renderDaemon(sink, probe, de.droverHappyHome);
    renderBuild(sink, de.forkDir, de.stateDir, probe.now());
    renderSleep(sink, probe.pmset());
    renderServices(sink, probe, home, de.droverServerMode);

    out.push('');
    out.push(`mode      ${de.droverServerMode} (${de.droverServerMode === 'relay' ? de.relayUrl : 'official Happy server'})`);
    out.push(`happy     ${de.droverHappyHome}`);
    return out;
}

/**
 * `drover status [--json]`.
 *
 * The argument check answers before anything is read, the way the shell's `case`
 * does: `--json` execs curl and never reaches the report, `--help` prints and
 * exits 0, and an unknown word is refused with exit 2 before a single log file
 * is opened.
 */
export async function run(args: string[]): Promise<number> {
    const options: StatusOptions = {};
    const write = options.write ?? ((text: string) => process.stdout.write(text));
    const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text));
    const first = args[0] ?? '';

    if (first === '--json') {
        // The shell `exec curl -sS -m 5 "$DROVER_URL/v1/status"` — the raw body,
        // byte for byte, with curl's own exit code. Nothing is reformatted here:
        // `--json` is the endpoint's answer, not this file's opinion of it.
        const de = droverEnv();
        try {
            const res = await busGet('/v1/status', 5000, de.droverUrl);
            write(res.body);
            return 0;
        } catch (error) {
            if (error instanceof BusError) {
                // curl's exit codes, because a caller that switched on them
                // still can: 7 refused, 28 timed out, 6 could not resolve.
                const code = error.kind === 'refused' ? 7 : error.kind === 'timeout' ? 28 : error.kind === 'resolve' ? 6 : 1;
                writeErr(`curl: (${code}) ${error.detail}\n`);
                return code;
            }
            writeErr(`curl: (1) ${String(error)}\n`);
            return 1;
        }
    }
    if (first === '-h' || first === '--help') {
        write(USAGE);
        return 0;
    }
    if (first !== '') {
        writeErr(`drover status: unknown argument '${first}' (try --json or --help)\n`);
        return 2;
    }

    for (const line of await statusReport(options)) write(`${line}\n`);
    return 0;
}
