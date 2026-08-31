/**
 * What the session info screen says about the account a session is ON, and
 * what a flip from there is about to cost (DROVE-137).
 *
 * Clay, with a screenshot: "should the settings for a session also support
 * letting me switch the account there, and it should show what the current
 * account is." The screen listed ids, connection state, timestamps and a Flip
 * POLICY, which is a rule about flipping, without ever printing the value that
 * rule applies to. A rule with no current value is unreadable.
 *
 * Two decisions live here, both pure so they can be pinned without mounting a
 * screen.
 *
 * ONE: the account line. It is not derived a second time. The name and the
 * headroom come from the same `currentDroverAccountRow` +
 * `droverAccountHeadroomLabel` the composer popup's heading uses, and the bar
 * is the same DROVE-117 row the popup lists other accounts with, so the two
 * surfaces cannot drift apart (DROVE-129).
 *
 * TWO: who a flip is about to silence. DROVE-37 measured that Claude Code
 * binds Remote Control to one account per machine, so moving this session to
 * another account tears down every other live session bound to a different
 * one. The CLI already says this AFTER the flip, out loud, from
 * drover/flip/remoteControl.ts. This is the same rule computed from what the
 * phone already knows, so the warning can be read BEFORE the tap instead of
 * being an explanation for a chat that already went quiet.
 */
import {
    droverAccountHeadroomLabel,
    droverBindingLimit,
    usageAccountBarRow,
    type UsageBarRow,
} from '@/components/agentInputUsage';
import { currentDroverAccountRow, currentDroverUsageAccount, type DroverUsageLike } from './droverUsage';

/** The account line, its headroom, and the bar that draws it. */
export interface SessionAccountView {
    /** The account this session runs on; null when nothing knows. */
    name: string | null;
    /** Percent LEFT on its fullest limit; null when never measured. */
    headroom: number | null;
    /** "jamrizzi · 51% left on Week", or just the name, or empty. */
    label: string;
    /** The DROVE-117 bar row, or null when there is no account to draw. */
    row: UsageBarRow | null;
}

export function resolveSessionAccount(input: {
    droverUsage: DroverUsageLike;
    droverAccount?: string | null;
}): SessionAccountView {
    const account = currentDroverAccountRow(input.droverUsage, input.droverAccount);
    // An empty name is the same as no account: `name` is rendered directly in
    // JSX, and an empty string there is a bare text node in a View, which
    // React Native throws on rather than skipping.
    if (!account || !account.name) return { name: null, headroom: null, label: '', row: null };
    // Which window the headroom is about, named on the line rather than left
    // to be worked out (DROVE-230). Same call the popup's heading makes, over
    // the same rows, so this screen and that sheet cannot name two windows.
    const binding = droverBindingLimit(
        currentDroverUsageAccount(input.droverUsage, input.droverAccount),
        input.droverUsage?.modelFamily ?? null,
        input.droverUsage?.capturedAt ?? Number.NaN,
    );
    return {
        name: account.name,
        headroom: account.headroom,
        label: droverAccountHeadroomLabel(account, binding?.label ?? null),
        row: usageAccountBarRow(account),
    };
}

/**
 * A session with no CLAUDE_CONFIG_DIR runs on the ambient login, which IS
 * `main`. The CLI's own filter maps null the same way, and for the same
 * reason: `employees`, the session Clay actually lost, was started outside the
 * wrapper and reports no account at all. A filter that only compared named
 * accounts would skip exactly the session that goes quiet.
 */
export const ambientDroverAccount = 'main';

/** The subset of a session these functions read. */
export interface FlipRiskSessionLike {
    id: string;
    active?: boolean | null;
    metadata?: { droverAccount?: string | null } | null;
}

/** One session a flip is about to knock off Remote Control. */
export interface FlipRiskRow {
    id: string;
    /** The name the rest of the app calls it, never a second naming. */
    label: string;
    account: string;
}

export function droverAccountOf(session: FlipRiskSessionLike): string {
    const account = session.metadata?.droverAccount?.trim();
    return account ? account : ambientDroverAccount;
}

/**
 * Live sessions, other than this one, that a flip to `target` will disconnect.
 *
 * A session already ON the target is left out: the binding it holds is the one
 * being renewed, so it is the one session a flip cannot hurt. Mirrors
 * `sessionsAtRisk` in happy-cli's drover/flip/remoteControl.ts.
 *
 * `target` is null for a bare `/flip`, where the CLI picks the next account
 * with headroom and the app cannot know which. Nothing can be ruled safe then,
 * so every other live session is listed and the sentence says "another
 * account" rather than naming one. Over-warning by one row beats telling
 * someone a chat is safe and then silencing it.
 *
 * `nameOf` is passed in rather than imported so this file stays free of the
 * app's React tree, and so the label is whatever getSessionName already
 * decided (DROVE-129).
 */
export function sessionsLosingRemoteControl<T extends FlipRiskSessionLike>(opts: {
    sessions: readonly T[];
    /** The session doing the flipping, which is never warned about itself. */
    selfId: string;
    /** The account the flip is moving TO, or null for "next available". */
    target: string | null;
    nameOf: (session: T) => string;
}): FlipRiskRow[] {
    const target = opts.target?.trim() || null;
    const rows: FlipRiskRow[] = [];
    for (const session of opts.sessions) {
        if (session.id === opts.selfId) continue;
        if (session.active !== true) continue;
        const account = droverAccountOf(session);
        if (target !== null && account === target) continue;
        rows.push({ id: session.id, label: opts.nameOf(session), account });
    }
    return rows;
}

/** "employees (main), lookout (bitspur.com)". */
export function flipRiskNames(rows: readonly FlipRiskRow[]): string {
    return rows.map((row) => `${row.label} (${row.account})`).join(', ');
}

/** "2 other live sessions", for a row that has one line to spend. */
export function flipRiskSubtitle(rows: readonly FlipRiskRow[]): string | null {
    if (rows.length === 0) return null;
    const noun = rows.length === 1 ? 'session' : 'sessions';
    return `Drops Remote Control for ${rows.length} other live ${noun}`;
}

/**
 * The names, under the section, so the cost is legible without tapping
 * anything. The count alone answers "how many" and this answers "which",
 * which is the half that decides whether the flip is worth it.
 */
export function flipRiskFooter(rows: readonly FlipRiskRow[]): string | undefined {
    if (rows.length === 0) return undefined;
    return `Switching accounts drops Remote Control for ${flipRiskNames(rows)}.`;
}

/**
 * The sentence shown before the flip happens. Null when nothing is at risk, so
 * the confirm stays quiet rather than reassuring on every flip. A warning that
 * fires every time is one nobody reads.
 */
export function flipRiskWarning(rows: readonly FlipRiskRow[], target: string | null): string | null {
    if (rows.length === 0) return null;
    const where = target?.trim() ? `to ${target.trim()}` : 'to another account';
    const noun = rows.length === 1 ? 'session' : 'sessions';
    const them = rows.length === 1 ? 'it' : 'them';
    const names = flipRiskNames(rows);
    return (
        `Switching ${where} drops Remote Control for ${rows.length} other live ${noun} `
        + `on this machine: ${names}. Claude Code binds Remote Control to one account per `
        + `machine, so ${them} will go quiet on the phone until Remote Control is turned `
        + `back on for ${them}.`
    );
}
