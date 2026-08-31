import * as React from 'react';
import { Session } from '@/sync/storageTypes';
import { resolveSessionState } from '@/sync/sessionState';
import type { SessionState } from '@/sync/sessionState';
import { t } from '@/text';
import {
    SESSION_DOT_TICK_MS,
    sessionDotFacts,
    sessionDotPresentation,
} from '@/components/sessionDot';
import type { StatusDotState } from '@/components/statusDotState';
import { useTickingNow } from '@/components/useTickingNow';
import { buildResumeCommand, buildResumeCommandBlock, ResumeCommandBlock } from './resumeCommand';
import { sessionDisplayTitle } from './sessionTitle';

export type { SessionState } from '@/sync/sessionState';

export interface SessionStatus {
    state: SessionState;
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    /** The colour of the WORDS. Prose, and still its own thing. */
    statusColor: string;
    /**
     * The dot, from `statusDotColors` (DROVE-231, DROVE-243).
     *
     * This used to be `statusColor` again: grey for gone, and the same three
     * hues as the two list tables. It is the shared palette now, so the card on
     * the session info screen and the strip at the bottom of the chat cannot
     * disagree about the session they are both looking at.
     */
    statusDotColor: string;
    /** Which of DROVE-231's six states the dot is in. */
    dotState: StatusDotState;
    /** What a screen reader hears for the dot. */
    dotLabel: string;
    isPulsing?: boolean;
}

/**
 * Get the current state of a session based on presence and thinking status.
 * Uses centralized session state from storage.ts
 */
export function useSessionStatus(session: Session): SessionStatus {
    const isOnline = session.presence === "online";
    const state = resolveSessionState({
        agentState: session.agentState,
        thinking: session.thinking,
        isOnline,
    });

    // The dot, once, for every surface that is ABOUT this session (DROVE-243).
    // It blinks here, unlike a list row: there is one of it on the screen and
    // it is the session Clay is in, which is the same argument the strip makes.
    // The clock runs while the session is down (yellow has to become red) or
    // while a live snapshot is on it (which goes stale on a threshold too).
    const live = session.metadata?.liveStatus ?? null;
    const now = useTickingNow(!isOnline || !!live, SESSION_DOT_TICK_MS);
    const dot = React.useMemo(
        () => sessionDotPresentation(sessionDotFacts(session, now), now),
        [session, now],
    );

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [state]);

    // One shape for the dot, spread into whichever branch answers. The words
    // and the colour of the words still branch on the state; the dot does not.
    const dotFields = {
        statusDotColor: dot.color,
        dotState: dot.state,
        dotLabel: dot.label,
        isPulsing: dot.isPulsing,
    };

    if (state === 'disconnected') {
        return {
            state,
            isConnected: false,
            statusText: t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) }),
            shouldShowStatus: true,
            statusColor: '#999',
            ...dotFields,
        };
    }

    if (state === 'permission_required') {
        return {
            state,
            isConnected: true,
            statusText: t('status.permissionRequired'),
            shouldShowStatus: true,
            statusColor: '#FF9500',
            ...dotFields,
        };
    }

    if (state === 'input_required') {
        return {
            state,
            isConnected: true,
            statusText: t('status.inputRequired'),
            shouldShowStatus: true,
            statusColor: '#FF9500',
            ...dotFields,
        };
    }

    if (state === 'thinking') {
        return {
            state,
            isConnected: true,
            statusText: vibingMessage,
            shouldShowStatus: true,
            statusColor: '#007AFF',
            ...dotFields,
        };
    }

    return {
        state,
        isConnected: true,
        statusText: t('status.online'),
        shouldShowStatus: false,
        statusColor: '#34C759',
        ...dotFields,
    };
}

/**
 * The session's display name.
 *
 * Delegated, not implemented: the wrist names sessions too, and while this
 * function held the rule the watch feed held a second one that answered
 * `cattle-drover` where this answered `DROVER` (DROVE-127). `sessionTitle.ts`
 * is the one owner now; both surfaces call it.
 */
export function getSessionName(session: Session): string {
    return sessionDisplayTitle(session);
}

/**
 * Generates a deterministic avatar ID from machine ID and path.
 * This ensures the same machine + path combination always gets the same avatar.
 */
export function getSessionAvatarId(session: Session): string {
    if (session.metadata?.machineId && session.metadata?.path) {
        // Combine machine ID and path for a unique, deterministic avatar
        return `${session.metadata.machineId}:${session.metadata.path}`;
    }
    // Fallback to session ID if metadata is missing
    return session.id;
}

/**
 * Returns the CLI command to resume a disconnected session, or null if not resumable.
 * Uses flavor-specific commands which work without happy-agent auth.
 */
export function getResumeCommand(session: Session): string | null {
    return buildResumeCommand(session.metadata ?? {});
}

export function getResumeCommandBlock(session: Session): ResumeCommandBlock | null {
    return buildResumeCommandBlock(session.metadata ?? {});
}

/**
 * Formats a path relative to home directory if possible.
 * If the path starts with the home directory, replaces it with ~
 * Otherwise returns the full path.
 */
export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;
    
    // Normalize paths to handle trailing slashes
    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    const normalizedPath = path;
    
    // Check if path starts with home directory
    if (normalizedPath.startsWith(normalizedHome)) {
        // Replace home directory with ~
        const relativePath = normalizedPath.slice(normalizedHome.length);
        // Add ~ and ensure there's a / after it if needed
        if (relativePath.startsWith('/')) {
            return '~' + relativePath;
        } else if (relativePath === '') {
            return '~';
        } else {
            return '~/' + relativePath;
        }
    }
    
    return path;
}

/**
 * Returns the session path for the subtitle.
 */
export function getSessionSubtitle(session: Session): string {
    if (session.metadata) {
        return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
    }
    return t('status.unknown');
}

/**
 * Checks if a session is currently online based on the active flag.
 * A session is considered online if the active flag is true.
 */
export function isSessionOnline(session: Session): boolean {
    return session.active;
}

/**
 * Checks if a session should be shown in the active sessions group.
 * Uses the active flag directly.
 */
export function isSessionActive(session: Session): boolean {
    return session.active;
}

export { getSessionActivityAt } from './sessionActivity';

/**
 * Formats OS platform string into a more readable format
 */
export function formatOSPlatform(platform?: string): string {
    if (!platform) return '';

    const osMap: Record<string, string> = {
        'darwin': 'macOS',
        'win32': 'Windows',
        'linux': 'Linux',
        'android': 'Android',
        'ios': 'iOS',
        'aix': 'AIX',
        'freebsd': 'FreeBSD',
        'openbsd': 'OpenBSD',
        'sunos': 'SunOS'
    };

    return osMap[platform.toLowerCase()] || platform;
}

/**
 * Formats the last seen time of a session into a human-readable relative time.
 * @param activeAt - Timestamp when the session was last active
 * @param isActive - Whether the session is currently active
 * @returns Formatted string like "Active now", "5 minutes ago", "2 hours ago", or a date
 */
export function formatLastSeen(activeAt: number, isActive: boolean = false): string {
    if (isActive) {
        return t('status.activeNow');
    }

    const now = Date.now();
    const diffMs = now - activeAt;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
        return t('time.justNow');
    } else if (diffMinutes < 60) {
        return t('time.minutesAgo', { count: diffMinutes });
    } else if (diffHours < 24) {
        return t('time.hoursAgo', { count: diffHours });
    } else if (diffDays < 7) {
        return t('sessionHistory.daysAgo', { count: diffDays });
    } else {
        // Format as date
        const date = new Date(activeAt);
        const options: Intl.DateTimeFormatOptions = {
            month: 'short',
            day: 'numeric',
            year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
        };
        return date.toLocaleDateString(undefined, options);
    }
}

export const vibingMessages = ["Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling", "Wizarding", "Working", "Wrangling"];
