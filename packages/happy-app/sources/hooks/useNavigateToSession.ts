import type { Router } from "expo-router"
import { useRouter } from "expo-router"
import { storage } from '@/sync/storage';
import { trackSessionSwitched } from '@/track';

/**
 * `gate` is the gate to focus in the session's overlay on arrival, which is
 * what a tap on a gate push asks for (DROVE-94). The session screen reads it
 * off its route params.
 */
export function navigateToSession(router: Router, sessionId: string, options: { gate?: string | null } = {}) {
    const session = storage.getState().sessions[sessionId];
    if (session) {
        trackSessionSwitched(session);
    }

    const route = `/session/${encodeURIComponent(sessionId)}` as const;
    if (options.gate) {
        router.push(`${route}?gate=${encodeURIComponent(options.gate)}`);
        return;
    }
    router.push(route);
}

export function useNavigateToSession() {
    const router = useRouter();
    return (sessionId: string) => {
        navigateToSession(router, sessionId);
    }
}
