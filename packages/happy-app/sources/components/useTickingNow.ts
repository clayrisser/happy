import * as React from 'react';

/**
 * `Date.now()`, re-read once a second while there is something to count
 * (DROVE-54).
 *
 * The live-status timers do not come from the network. The CLI publishes
 * absolute start times and throttles itself to at most one write a second, so
 * clocks driven by publishes alone would stutter — and would stop entirely
 * during a long tool call, which is precisely when Clay is watching them.
 *
 * One shared hook, so a screen showing the strip and six agent cards runs one
 * interval rather than seven, and tears it down the instant the session goes
 * idle.
 */
export function useTickingNow(enabled: boolean, intervalMs = 1000): number {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (!enabled) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [enabled, intervalMs]);
    return now;
}
