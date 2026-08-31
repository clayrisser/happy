import type { Theme } from '@/theme';

/**
 * The tint that says "you are inside a subagent" (DROVE-109).
 *
 * The agent screen (DROVE-93) draws a subagent's transcript with the session's
 * own cards, so with several agents open it is easy to lose track of where you
 * are. The fix is a wash over the whole surface in the colour family the
 * status row already uses for a running agent, applied as a THEME OVERRIDE
 * around the subtree rather than as props threaded through every row: the
 * tinted themes registered in `unistyles.ts` are the base themes with their
 * surfaces mixed towards the accent, and the agent screen wraps its body in
 * `<ScopedTheme>` so every card and tool view picks it up for free.
 *
 * Everything here is pure — colours in, colours out — so both themes can be
 * checked for contrast in a unit test instead of by eye.
 *
 * The accent is `colors.permission.acceptEdits`, the theme's own system blue
 * (#007AFF light, #0A84FF dark). That is the same family as the running-agent
 * dot in AgentInputStatusRow, so the tree and the screen agree, while still
 * coming from the theme rather than a hardcoded hex.
 */

export type Rgb = { r: number; g: number; b: number };

/** The names the tinted themes are registered under in `unistyles.ts`. */
export type SubagentThemeName = 'lightSubagent' | 'darkSubagent';

/** The tinted counterpart of whichever theme is live, including when it is already the tinted one. */
export function subagentThemeName(themeName: string | undefined): SubagentThemeName {
    return themeName === 'dark' || themeName === 'darkSubagent' ? 'darkSubagent' : 'lightSubagent';
}

/** How hard each role is pulled towards the accent. Dark needs more: a wash over near-black reads as nothing. */
const ratios = {
    light: { ground: 0.08, surface: 0.06, elevated: 0.09, header: 0.10, divider: 0.22, userMessage: 0.07 },
    dark: { ground: 0.12, surface: 0.11, elevated: 0.12, header: 0.15, divider: 0.30, userMessage: 0.12 },
} as const;

const railAlpha = { light: 0.9, dark: 0.85 } as const;
const railMarkerAlpha = { light: 0.45, dark: 0.5 } as const;

export function parseHex(color: string): Rgb | null {
    if (typeof color !== 'string') {
        return null;
    }
    const normalized = color.trim().replace('#', '');
    if (normalized.length === 3 && /^[0-9a-fA-F]{3}$/.test(normalized)) {
        const [r, g, b] = normalized.split('');
        return {
            r: Number.parseInt(r + r, 16),
            g: Number.parseInt(g + g, 16),
            b: Number.parseInt(b + b, 16),
        };
    }
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
        return null;
    }
    return {
        r: Number.parseInt(normalized.slice(0, 2), 16),
        g: Number.parseInt(normalized.slice(2, 4), 16),
        b: Number.parseInt(normalized.slice(4, 6), 16),
    };
}

function channelToHex(value: number): string {
    const clamped = Math.max(0, Math.min(255, Math.round(value)));
    return clamped.toString(16).padStart(2, '0');
}

export function toHex(rgb: Rgb): string {
    return `#${channelToHex(rgb.r)}${channelToHex(rgb.g)}${channelToHex(rgb.b)}`;
}

/**
 * `base` pulled `ratio` of the way towards `overlay`. Anything that is not a
 * plain hex (an rgba glass colour, a gradient) is handed back untouched rather
 * than mangled.
 */
export function mixHex(base: string, overlay: string, ratio: number): string {
    const a = parseHex(base);
    const b = parseHex(overlay);
    if (!a || !b) {
        return base;
    }
    const t = Math.max(0, Math.min(1, ratio));
    return toHex({
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
    });
}

export function withAlpha(color: string, alpha: number): string {
    const rgb = parseHex(color);
    if (!rgb) {
        return color;
    }
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** WCAG relative luminance. Returns 0 for anything unparseable, which makes contrastRatio conservative. */
export function relativeLuminance(color: string): number {
    const rgb = parseHex(color);
    if (!rgb) {
        return 0;
    }
    const channel = (value: number) => {
        const s = value / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(foreground: string, background: string): number {
    const a = relativeLuminance(foreground);
    const b = relativeLuminance(background);
    const lighter = Math.max(a, b);
    const darker = Math.min(a, b);
    return (lighter + 0.05) / (darker + 0.05);
}

/** How far apart two colours are, 0 to 1, in plain sRGB distance. Used to prove the tint is actually visible. */
export function colorDistance(a: string, b: string): number {
    const first = parseHex(a);
    const second = parseHex(b);
    if (!first || !second) {
        return 0;
    }
    const dr = (first.r - second.r) / 255;
    const dg = (first.g - second.g) / 255;
    const db = (first.b - second.b) / 255;
    return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/** Just the colours the tint reads, so the maths can be tested without pulling react-native in. */
export type SubagentTintSource = {
    dark: boolean;
    accent: string;
    ground: string;
    surface: string;
    surfacePressed: string;
    surfaceSelected: string;
    surfaceHigh: string;
    surfaceHighest: string;
    header: string;
    divider: string;
    input: string;
    userMessage: string;
};

export type SubagentTintPalette = {
    accent: string;
    ground: string;
    surface: string;
    surfacePressed: string;
    surfaceSelected: string;
    surfaceHigh: string;
    surfaceHighest: string;
    header: string;
    divider: string;
    input: string;
    userMessage: string;
    /** The left edge rail, and the notches repeated down it. Both survive scrolling. */
    rail: string;
    railMarker: string;
};

export function subagentTintPalette(source: SubagentTintSource): SubagentTintPalette {
    const r = source.dark ? ratios.dark : ratios.light;
    const accent = source.accent;
    return {
        accent,
        ground: mixHex(source.ground, accent, r.ground),
        surface: mixHex(source.surface, accent, r.surface),
        surfacePressed: mixHex(source.surfacePressed, accent, r.elevated),
        surfaceSelected: mixHex(source.surfaceSelected, accent, r.elevated),
        surfaceHigh: mixHex(source.surfaceHigh, accent, r.elevated),
        surfaceHighest: mixHex(source.surfaceHighest, accent, r.elevated),
        header: mixHex(source.header, accent, r.header),
        divider: mixHex(source.divider, accent, r.divider),
        input: mixHex(source.input, accent, r.elevated),
        userMessage: mixHex(source.userMessage, accent, r.userMessage),
        rail: withAlpha(accent, source.dark ? railAlpha.dark : railAlpha.light),
        railMarker: withAlpha(accent, source.dark ? railMarkerAlpha.dark : railMarkerAlpha.light),
    };
}

export function subagentTintSource(theme: Theme): SubagentTintSource {
    return {
        dark: theme.dark,
        accent: theme.colors.permission.acceptEdits,
        ground: theme.colors.groupped.background,
        surface: theme.colors.surface,
        surfacePressed: theme.colors.surfacePressed,
        surfaceSelected: theme.colors.surfaceSelected,
        surfaceHigh: theme.colors.surfaceHigh,
        surfaceHighest: theme.colors.surfaceHighest,
        header: theme.colors.header.background,
        divider: theme.colors.divider,
        input: theme.colors.input.background,
        userMessage: theme.colors.userMessageBackground,
    };
}

export function subagentTintPaletteFor(theme: Theme): SubagentTintPalette {
    return subagentTintPalette(subagentTintSource(theme));
}

/**
 * The base theme with its surfaces washed towards the accent. Text colours are
 * left exactly as they are: the tint sits BEHIND body text, so moving both
 * would be the way to quietly lose contrast.
 */
export function createSubagentTheme<T extends Theme>(theme: T): T {
    const palette = subagentTintPaletteFor(theme);
    return {
        ...theme,
        colors: {
            ...theme.colors,
            surface: palette.surface,
            surfacePressed: palette.surfacePressed,
            surfaceSelected: palette.surfaceSelected,
            surfaceHigh: palette.surfaceHigh,
            surfaceHighest: palette.surfaceHighest,
            divider: palette.divider,
            userMessageBackground: palette.userMessage,
            groupped: {
                ...theme.colors.groupped,
                background: palette.ground,
            },
            header: {
                ...theme.colors.header,
                background: palette.header,
            },
            input: {
                ...theme.colors.input,
                background: palette.input,
            },
        },
    } as T;
}
