import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_ACCEPT_SUBTITLE } from '../components/autoAcceptRow';
import { MODE_COPY } from '../sync/droverChannels';
import { accountGroupFooter, addAccountStatus } from '../sync/machineAccountsFlow';
import { mcpOnlyFooter } from '../sync/mcpText';
import { noTasksHeadline } from '../utils/sessionTasks';
import { noMachineTrouble, paneStatus, paneTrouble } from '../utils/worktreeSheetTabs';
import { en } from './_default';

/**
 * COPY DENSITY (DROVE-346).
 *
 * Clay, with three screens photographed and the generated copy scribbled out:
 * "the original, handcrafted part was very clean and nice, but all of the AI
 * stuff you generated just slopped all kinds of text everywhere."
 *
 * He is right, and the screenshot that proves it is the permission sheet: the
 * handcrafted modes read "asks when unsure", "edits, no asking", "plan first",
 * and directly above them the generated Auto-accept row ran three sentences
 * over four lines. Same list, same width, two different apps.
 *
 * So the rule, and this file is where it is enforced rather than remembered:
 * a row gets a title and at most ONE short subtitle fragment, and a group
 * footer gets ONE line. An explanation longer than that goes behind a tap,
 * into the docs, or nowhere.
 *
 * THE TWO NUMBERS ARE MEASURED, NOT PICKED.
 *
 * Subtitles: the handcrafted rows this has to sit beside are "Manage your
 * account details" (27) and "Customize how the app looks" (27), and upstream's
 * own longest is "Configure voice interaction preferences" at 39. So 40 is the
 * top of the range the original app already lives in — a bar the handcrafted
 * copy passes unchanged, which is the only kind of bar worth setting here.
 *
 * Footers: the footer type is smaller and full width, and the screenshot gives
 * the scale directly — the cursor group's 200-character footer wrapped to four
 * lines, so a line is about fifty characters. 48 keeps a footer on one of them.
 */
const subtitleMaxChars = 40;
const footerMaxChars = 48;
/**
 * Empty states sit on the same 40, and DROVE-359 is why they are named here
 * at all. The sheet DROVE-330 built came in after this sweep and every empty
 * state on it was a paragraph — the Todos tab explained `drover needs` to the
 * person holding a phone, the inbox screen ran five lines under a tick — and
 * this file passed the whole time, because none of it is a `subtitle=`.
 * An empty state is a row's copy in a different position, so it gets the
 * row's bar: "Nothing waiting" and "No worktrees" already lived under it.
 */
const emptyStateMaxChars = 40;

/**
 * Strings this rule does NOT govern, and why each one is out.
 *
 * `app/(app)/dev/` is the developer menu. It is not shipped UI, Clay never
 * opens it, and it is upstream's besides.
 *
 * The rest are upstream Happy's own copy, sitting in files the fork happens to
 * have touched for other reasons. The whole point of this ticket is to match
 * the handcrafted app, so rewriting the handcrafted app to pass our own bar
 * would be the tail wagging the dog. They are listed by their exact text so
 * that a drover string can never quietly join them.
 */
const upstreamCopy = new Set([
    'Shows every push token registered on your account. Tap an old token to delete it.',
    'Current-device metadata comes from this phone. Older tokens use their token fingerprint plus server timestamps.',
    'Once this device is registered, it will appear here.',
    'Developer-only diagnostics and local override controls for the current voice rollout. The paid voice gate runs through Happy server unless Direct Connection and a custom ElevenLabs agent are both enabled.',
    'Simple local override for the voice-upsell flag',
]);

const sourcesDir = path.resolve(__dirname, '..');

function tsxFiles(dir: string, found: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            tsxFiles(full, found);
        } else if (entry.name.endsWith('.tsx')) {
            found.push(full);
        }
    }
    return found;
}

/** `subtitle="..."` / `footer="..."` / `note="..."` as written in the JSX. */
const literal = /\b(subtitle|footer|note)\s*=\s*"([^"]+)"/g;

/**
 * THE HOLE DROVE-359 CLOSED.
 *
 * An empty state is not an attribute. It is the text BETWEEN the tags —
 * `<Text style={styles.empty}>Nothing waiting</Text>` — so the scan above
 * walked straight past every one of them, reported its thirty-odd rows, and
 * went green over the worst copy in the app.
 *
 * The style is the classifier, and it is a fair one: a string drawn under a
 * style whose name starts with `empty` or `trouble` IS an empty state, said
 * by the person who wrote the style. Anything with a `{` in it is an
 * expression — a translation key, a variable, a bus error passed through —
 * and not copy this file is entitled to judge.
 */
const emptyChild = /<Text\b[^>]*\bstyles\.(?:empty|trouble)[A-Za-z]*\b[^>]*>([\s\S]*?)<\/Text>/g;

/** `{/* ... *\/}` inside a Text child: a comment, not copy. */
const jsxComment = /\{\/\*[\s\S]*?\*\/\}/g;

type Row = { kind: string; text: string; where: string };

function renderedLiterals(): Row[] {
    const rows: Row[] = [];
    for (const file of tsxFiles(sourcesDir)) {
        const rel = path.relative(sourcesDir, file);
        if (rel.startsWith(path.join('app', '(app)', 'dev'))) continue;
        const source = fs.readFileSync(file, 'utf8');
        const lines = source.split('\n');
        lines.forEach((line, i) => {
            for (const m of line.matchAll(literal)) {
                const text = m[2];
                if (upstreamCopy.has(text)) continue;
                rows.push({ kind: m[1], text, where: `${rel}:${i + 1}` });
            }
        });
        for (const m of source.matchAll(emptyChild)) {
            const body = m[1].replace(jsxComment, '');
            // An expression, not copy. See `emptyChild`.
            if (/[{<]/.test(body)) continue;
            // JSX collapses the wrapping the source is written with.
            const text = body.replace(/\s+/g, ' ').trim();
            if (!text || upstreamCopy.has(text)) continue;
            const before = source.slice(0, m.index ?? 0);
            rows.push({ kind: 'empty', text, where: `${rel}:${before.split('\n').length}` });
        }
    }
    return rows;
}

describe('copy density', () => {
    // The scan is the regression guard: a new row written next month is held
    // to the bar without anyone remembering this ticket existed.
    const rows = renderedLiterals();

    it('finds the rows it is meant to be guarding', () => {
        expect(rows.length).toBeGreaterThan(30);
    });

    it('no subtitle exceeds one short fragment', () => {
        const tooLong = rows
            .filter((r) => (r.kind === 'subtitle' || r.kind === 'note') && r.text.length > subtitleMaxChars)
            .map((r) => `${r.where} (${r.text.length}) "${r.text}"`);
        expect(tooLong).toEqual([]);
    });

    it('no group footer exceeds one line', () => {
        const tooLong = rows
            .filter((r) => r.kind === 'footer' && r.text.length > footerMaxChars)
            .map((r) => `${r.where} (${r.text.length}) "${r.text}"`);
        expect(tooLong).toEqual([]);
    });

    // The three below are the empty-state half (DROVE-359). Split into
    // separate its so a failure names WHICH rule was broken, because "too
    // long" and "two sentences" get fixed differently.

    it('finds the empty states the attribute scan could not see', () => {
        const empties = rows.filter((r) => r.kind === 'empty');
        expect(empties.length).toBeGreaterThan(5);
        // The sheet's own, so a rename cannot quietly drop it from the scan.
        expect(empties.map((r) => r.text)).toContain('Nothing waiting');
    });

    it('no empty state exceeds one short fragment', () => {
        const tooLong = rows
            .filter((r) => r.kind === 'empty' && r.text.length > emptyStateMaxChars)
            .map((r) => `${r.where} (${r.text.length}) "${r.text}"`);
        expect(tooLong).toEqual([]);
    });

    it('no empty state runs to a second sentence or spells out a command', () => {
        const preachy = rows
            .filter((r) => r.kind === 'empty')
            // A sentence break inside it, a full stop closing it, or a
            // backticked command: the three shapes DROVE-346 scribbled out.
            .filter((r) => /[.!?]\s/.test(r.text) || /\.$/.test(r.text) || r.text.includes('`'))
            .map((r) => `${r.where} "${r.text}"`);
        expect(preachy).toEqual([]);
    });
});

/**
 * The copy that is BUILT rather than written into the JSX. The scan above
 * cannot see these, and they are the ones Clay actually scribbled out, so they
 * are pinned by value.
 */
describe('copy density: generated strings', () => {
    it('the auto-accept subtitle is a fragment like the modes under it', () => {
        expect(AUTO_ACCEPT_SUBTITLE.length).toBeLessThanOrEqual(subtitleMaxChars);
        // A fragment, not a sentence: the rows beneath it are "asks when
        // unsure" and "plan first", and a capital letter or a full stop is
        // what makes one row read as a different kind of thing.
        expect(AUTO_ACCEPT_SUBTITLE).not.toMatch(/\.$/);
        expect(AUTO_ACCEPT_SUBTITLE[0]).toBe(AUTO_ACCEPT_SUBTITLE[0].toLowerCase());
    });

    it('it still names the boundary it is there to name', () => {
        // The wording is the safety feature: a question arriving while this is
        // on has to read as expected, not as a bug. Shorter is fine; silent
        // about the half it does NOT answer is not.
        expect(AUTO_ACCEPT_SUBTITLE).toMatch(/prompts/);
        expect(AUTO_ACCEPT_SUBTITLE).toMatch(/questions/);
    });

    it('every channel mode subtitle is a fragment', () => {
        for (const [name, copy] of Object.entries(MODE_COPY)) {
            expect(copy.subtitle.length, `${name}: "${copy.subtitle}"`)
                .toBeLessThanOrEqual(subtitleMaxChars);
        }
    });

    it('every account group footer is one line', () => {
        const footers = [
            accountGroupFooter('claude', true),
            accountGroupFooter('cursor', true),
            accountGroupFooter('claude', false),
            accountGroupFooter('cursor', false),
        ];
        for (const footer of footers) {
            expect(footer.length, `"${footer}"`).toBeLessThanOrEqual(footerMaxChars);
        }
    });

    it('the cursor footer still says the thing that makes it different', () => {
        // Why there is nothing to flip is the one fact the Claude footer does
        // not carry, so it is the one the short version has to keep.
        expect(accountGroupFooter('cursor', true)).toMatch(/tokens/);
        expect(accountGroupFooter('cursor', true)).toMatch(/flip/);
    });

    it('the login card says one fragment under its title (DROVE-351)', () => {
        // The card Clay photographed carried a four-line paragraph over
        // controls that contradicted it, and the paragraph was the half this
        // rule governs. Only the two link-ready rows are pinned here: they are
        // the card's own prose, and the rest of `addAccountStatus` is the
        // waiting and the outcome, which DROVE-346 did not scribble out.
        const linkReady = (harness: 'claude' | 'cursor') => addAccountStatus({
            kind: 'waiting',
            harness,
            startedAt: 0,
            before: [],
            stale: [],
            linkReady: true,
            linkSeen: true,
            linkLate: false,
        })!;
        for (const harness of ['claude', 'cursor'] as const) {
            const { detail } = linkReady(harness);
            expect(detail.length, `${harness}: "${detail}"`).toBeLessThanOrEqual(subtitleMaxChars);
            // A fragment, like the rows it sits among: no full stop, and no
            // capital where the neighbours have none.
            expect(detail, harness).not.toMatch(/\.$/);
            expect(detail[0], harness).toBe(detail[0].toLowerCase());
            // One fragment, not two clauses wearing a comma.
            expect(detail, harness).not.toMatch(/[;\u2014]/);
        }
    });

    it('the MCP footer is one line and drops the counts and the apology', () => {
        const harness = {
            configured: true,
            count: 42,
            scopes: [{ servers: [{ enabled: true }, { enabled: false }] }],
            providers: { count: 5, modelCount: 141 },
        };
        const footer = mcpOnlyFooter(harness);
        expect(footer.length, `"${footer}"`).toBeLessThanOrEqual(footerMaxChars);
        // Counts belong on the row, which already draws them. In prose they
        // were the second telling of the same number.
        expect(footer).not.toMatch(/\d/);
        // "not built yet" describes the roadmap, not this screen.
        expect(footer).not.toMatch(/not built/);
        expect(mcpOnlyFooter({ ...harness, configured: false }).length)
            .toBeLessThanOrEqual(footerMaxChars);
    });

    /**
     * The worktrees sheet's built copy (DROVE-359).
     *
     * `paneTrouble` lives in a `.ts`, so it is not JSX and the scan above
     * cannot reach it however the classifier is written. Pinned by value, the
     * way the auto-accept subtitle is.
     */
    it('every pane refusal is one fragment, and each says its own thing', () => {
        const keys = ['no pane', 'no live session in that worktree', 'no such session'];
        const lines = keys.map(paneTrouble);
        for (const line of lines) {
            expect(line.length, `"${line}"`).toBeLessThanOrEqual(emptyStateMaxChars);
            expect(line, `"${line}"`).not.toMatch(/[.!?]\s/);
            expect(line, `"${line}"`).not.toMatch(/\.$/);
        }
        // Short is not the same as interchangeable: three refusals that read
        // alike leave you unable to tell which one you are looking at.
        expect(new Set(lines).size).toBe(keys.length);
        expect(noMachineTrouble.length).toBeLessThanOrEqual(emptyStateMaxChars);
    });

    it('a bus error the app has no line for is handed through untouched', () => {
        const raw = 'The drover bus is not running on this machine (drover bus).';
        expect(paneTrouble(raw)).toBe(raw);
    });

    it('the terminal status line stays a status line', () => {
        const waiting = paneStatus({ scopeLabel: '~/wt/x', pane: null, troubled: false });
        expect(waiting).toBe('~/wt/x · capturing');
        // A trouble line is under the box already; repeating "capturing"
        // above it would say the app is still trying when it is not.
        expect(paneStatus({ scopeLabel: '~/wt/x', pane: null, troubled: true })).toBe('~/wt/x');
        expect(paneStatus({
            scopeLabel: '~/wt/x',
            pane: { pane: '%3', age: '2s', redacted: 2 },
            troubled: false,
        })).toBe('~/wt/x · pane %3 · 2s ago · 2 masked');
    });

    it('the empty task list is one fragment, and the same one everywhere', () => {
        // The list is drawn in three places off SessionTasksList, so the
        // headline and the empty view have to be the one string.
        expect(noTasksHeadline.length).toBeLessThanOrEqual(emptyStateMaxChars);
        expect(noTasksHeadline).not.toMatch(/[.!?]/);
    });
});

/**
 * The copy that comes through `t()` (DROVE-190).
 *
 * The scan above reads JSX string LITERALS, so a row written as
 * `subtitle={t('...')}` is invisible to it, and the phone-haptics row was
 * exactly that: a 133-character subtitle and a 312-character footer that
 * passed a suite whose whole job is to stop them, because the strings live in
 * text/ and the rule looks at tsx/.
 *
 * The scan is not widened here on purpose. Sixty-three rows in the app are
 * written this way and thirty-two of them are over the bar; nearly all are
 * upstream Happy's own copy (appearance, voice, account, terminal), which
 * DROVE-346 already decided not to rewrite. Widening the regex would fail the
 * suite on a sweep this ticket is not doing. So the drover rows that go
 * through `t()` are pinned by value, the way the generated strings above are,
 * and each new one joins this list.
 */
describe('copy density: settings copy that arrives through t()', () => {
    const rows: { key: string; kind: 'subtitle' | 'footer'; text: string }[] = [
        { key: 'agentInput.channels.phoneHapticsSubtitle', kind: 'subtitle', text: en.agentInput.channels.phoneHapticsSubtitle },
        { key: 'agentInput.channels.phoneHapticsFooter', kind: 'footer', text: en.agentInput.channels.phoneHapticsFooter },
    ];

    for (const row of rows) {
        const max = row.kind === 'footer' ? footerMaxChars : subtitleMaxChars;
        it(`${row.key} is ${row.kind === 'footer' ? 'one line' : 'one fragment'}: "${row.text}"`, () => {
            expect(row.text.length).toBeLessThanOrEqual(max);
        });
    }

    it('the phone-haptics subtitle is a fragment, like the channel rows above it', () => {
        // Its neighbours on Settings > Channels are "The alert push, the card,
        // the watch face" and "A tap on the phone, a buzz on the wrist": no
        // full stop, one clause. A sentence there reads as a different app.
        expect(en.agentInput.channels.phoneHapticsSubtitle).not.toMatch(/\.$/);
    });

    it('the footer still says the two facts the row cannot show', () => {
        // Shorter is fine. Silent about the default, or about the watch, is
        // not: those are the whole reason the group exists (DROVE-190).
        const footer = en.agentInput.channels.phoneHapticsFooter;
        expect(footer).toMatch(/[Oo]ff by default/);
        expect(footer).toMatch(/watch/i);
    });
});
