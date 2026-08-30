/**
 * What the usage strip under the composer shows, decided in one place.
 *
 * Two feeds can fill it. `agentState.usageLimits` is live from the SDK on a
 * remote session. `metadata.droverUsage` (DROVE-47) is the CLI's reading of
 * every drover account's usage cache, and on a pane session it is the ONLY
 * feed there is: a Claude Code TUI in tmux has no rate_limit_event stream, so
 * the strip stayed blank on the phone while `drover accounts` in the terminal
 * knew every number.
 *
 * Pure so the choice between the two, the gate on the week figure and the
 * popup's rows can be pinned by a test without mounting the composer.
 */
import type { NativeSettingsMenuGroup, NativeSettingsMenuOption } from './NativeSettingsMenu';
import {
    currentDroverUsageAccount,
    droverFamilyRows,
    droverOtherAccounts,
    usageLimitsFromDroverUsage,
    type DroverUsageLike,
} from '@/utils/droverUsage';
import {
    formatUsageLimitResetTime,
    getUsageLimitDisplayPercentage,
    getUsageLimitRows,
    type UsageLimitsLike,
} from '@/utils/sessionStatusBar';
import { t } from '@/text';

export type UsageStripInput = {
    /** Plan quota windows from agent state; the remote path's feed. */
    usageLimits: UsageLimitsLike;
    /** Every drover account's headroom from session metadata (DROVE-47). */
    droverUsage: DroverUsageLike;
    /** The older per-account stamp, the fallback when the snapshot marks nothing current. */
    droverAccount?: string | null;
    /** The "% left" setting; utilization is always percent USED on the wire. */
    showRemaining: boolean;
    /**
     * The strip's own rule for the week figure: it shows when the context
     * gauge does, or when the user asked for it always. A drover-fed session
     * ignores this, see resolveUsageStrip.
     */
    contextShown: boolean;
};

export type UsageStrip = {
    /** The number on the strip, already flipped for the "% left" setting; null hides it. */
    weekPercent: number | null;
    /** Nothing from the SDK; the snapshot is what the strip is reading. */
    usageFromDrover: boolean;
    /**
     * The popup: this account's session, week and family rows under its own
     * headroom, then every other account folded under a second heading.
     */
    usageMenuGroups: NativeSettingsMenuGroup[];
};

export function resolveUsageStrip(input: UsageStripInput): UsageStrip {
    // Agent state first, because it is live from the SDK; the drover snapshot
    // when there is none, which is every pane session.
    const droverLimits = usageLimitsFromDroverUsage(input.droverUsage, input.droverAccount);
    const usageLimits = input.usageLimits ?? droverLimits;
    const usageFromDrover = !input.usageLimits && !!droverLimits;
    // Only Session and Week are user-meaningful; provider-internal windows
    // (nimbus_quill and friends) stay out of the popup.
    const rows = getUsageLimitRows(usageLimits ?? null);
    const session = rows.find((row) => row.id === 'five_hour') ?? null;
    const week = rows.find((row) => row.id === 'seven_day') ?? null;
    // A session with the snapshot and no stream shows the strip regardless of
    // the context setting: the number is the reason Clay opens the popup, not
    // a near-limit warning that happens to be on.
    const weekPercent = week?.utilization != null && (input.contextShown || usageFromDrover)
        ? getUsageLimitDisplayPercentage(week.utilization, input.showRemaining)
        : null;

    const options: NativeSettingsMenuOption[] = [];
    const push = (key: string, label: string, row: { utilization: number | null; resetsAt: number | null } | null) => {
        if (!row || row.utilization == null) return;
        const percent = getUsageLimitDisplayPercentage(row.utilization, input.showRemaining);
        // The newline renders as a second line inside the native menu row.
        const reset = row.resetsAt != null
            ? `\n${t('agentInput.usagePopup.resets', { time: formatUsageLimitResetTime(row.resetsAt) })}`
            : '';
        options.push({ key, label: `${label} · ${Math.round(percent)}%${reset}` });
    };
    push('session', t('agentInput.usagePopup.session'), session);
    push('week', t('agentInput.usagePopup.week'), week);
    // Per model family, where the cache scopes a limit (DROVE-47): on Clay's
    // plan a Fable weekly row sits beside weekly_all, and the two differ by
    // forty points on the day it matters.
    for (const row of droverFamilyRows(input.droverUsage, input.droverAccount)) {
        push(row.id, t('agentInput.usagePopup.familyWeek', { family: row.family }), row);
    }
    const groups: NativeSettingsMenuGroup[] = [];
    if (options.length > 0) {
        // The heading carries the picker's own number for THIS account —
        // "jamrizzi · 65% left" — so the popup and `drover accounts` agree at
        // a glance.
        const current = currentDroverUsageAccount(input.droverUsage, input.droverAccount);
        const headroom = current?.headroom;
        const title = current && typeof headroom === 'number' && Number.isFinite(headroom)
            ? `${current.name} · ${input.showRemaining
                ? t('agentInput.usagePopup.left', { percent: Math.round(headroom) })
                : t('agentInput.usagePopup.used', { percent: Math.round(100 - headroom) })}`
            : current?.name ?? '';
        groups.push({ key: 'usage', label: '', title, options, selectedKey: null, onSelect: () => { } });
    }
    // Every OTHER account, folded under its own heading rather than dropped
    // (DROVE-47): the phone has to answer "where can I flip to" without a
    // terminal. Same figures the flip picker prints.
    const others = droverOtherAccounts(input.droverUsage, input.droverAccount)
        .map((a) => {
            const state = !a.loggedIn
                ? t('agentInput.usagePopup.noLogin')
                : a.headroom == null
                    ? t('agentInput.usagePopup.unmeasured')
                    : input.showRemaining
                        ? t('agentInput.usagePopup.left', { percent: a.headroom })
                        : t('agentInput.usagePopup.used', { percent: 100 - a.headroom });
            const back = a.back != null
                ? `\n${a.family
                    ? t('agentInput.usagePopup.familyBack', { family: a.family, time: formatUsageLimitResetTime(a.back) })
                    : t('agentInput.usagePopup.back', { time: formatUsageLimitResetTime(a.back) })}`
                : '';
            return { key: `account:${a.name}`, label: `${a.name} · ${state}${back}`, disabled: !a.loggedIn };
        });
    if (others.length > 0) {
        groups.push({
            key: 'accounts',
            label: '',
            title: t('agentInput.usagePopup.otherAccounts'),
            options: others,
            selectedKey: null,
            onSelect: () => { },
        });
    }
    return { weekPercent, usageFromDrover, usageMenuGroups: groups };
}
