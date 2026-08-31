import type { Theme } from '@/theme';

/**
 * The tint that says "you are inside a subagent" (DROVE-109, DROVE-145).
 *
 * The agent screen (DROVE-93) draws a subagent's transcript with the session's
 * own cards, so with several agents open it is easy to lose track of where you
 * are. The fix is a wash over the whole surface, applied as a THEME OVERRIDE
 * around the subtree rather than as props threaded through every row: the
 * tinted themes registered in `unistyles.ts` are the base themes with their
 * surfaces mixed towards the wash, and the agent screen wraps its body in
 * `<ScopedTheme>` so every card and tool view picks it up for free.
 *
 * Everything here is pure. Colours in, colours out, so both themes can be
 * checked for contrast in a unit test instead of by eye.
 *
 * DROVE-109 washed towards `colors.permission.acceptEdits`, the theme's own
 * system blue, and drew a blue rail down the left edge. Together they read as
 * a different app rather than a different screen. DROVE-145 dropped the rail
 * and moved the wash to a NEUTRAL GREY at a lighter strength: the agent screen
 * is the same theme a shade over, darker in light mode and lighter in dark,
 * with no hue of its own. `washGrey` is a hardcoded mid grey on purpose. Every
 * grey in the theme carries a little blue, and borrowing one would put that
 * blue straight back.
 */

export type Rgb = { r: number; g: number; b: number };

/** The names the tinted themes are registered under in `unistyles.ts`. */
export type SubagentThemeName = 'lightSubagent' | 'darkSubagent';

/** The tinted counterpart of whichever theme is live, including when it is already the tinted one. */
export function subagentThemeName(themeName: string | undefined): SubagentThemeName {
    return themeName === 'dark' || themeName === 'darkSubagent' ? 'darkSubagent' : 'lightSubagent';
}

/**
 * The colour every surface is pulled towards. A pure mid grey: r, g and b are
 * equal, so a mix can only move a surface along its own lightness and can
 * never introduce a hue. Mid, so the one constant darkens the light theme and
 * lightens the dark one.
 */
export const washGrey = '#808080';

/**
 * How hard each role is pulled towards the grey. Dark needs more: a wash over
 * near-black reads as nothing. Every number is BELOW what DROVE-109 shipped
 * (light 0.08/0.06/0.09/0.10/0.22/0.07, dark 0.12/0.11/0.12/0.15/0.30/0.12),
 * which is the lighter half of DROVE-145; the spec pins them, so fading the
 * wash further or creeping it back up has to be deliberate.
 *
 * Ground and header carry most of the signal because they are the biggest
 * fields on screen. Surface moves least: in light mode those are white cards,
 * and greying them hard is what made the screen read as another app.
 */
const ratios = {
    light: { ground: 0.07, surface: 0.05, elevated: 0.075, header: 0.085, divider: 0.18, userMessage: 0.06 },
    dark: { ground: 0.10, surface: 0.09, elevated: 0.10, header: 0.12, divider: 0.25, userMessage: 0.10 },
} as const;

export type SubagentTintRatios = typeof ratios;

/** The pinned strengths, for the spec and for anyone asking how heavy the wash is. */
export function subagentTintRatios(): SubagentTintRatios {
    return ratios;
}

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

/**
 * How far a colour sits from neutral, 0 (r = g = b) to 1. This is what "no hue
 * of its own" means in a test: a washed surface may move along the lightness
 * scale, but it must not pick up a cast.
 */
export function saturation(color: string): number {
    const rgb = parseHex(color);
    if (!rgb) {
        return 0;
    }
    return (Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b)) / 255;
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
    /** The grey everything was mixed towards. Useful in a test, unused on screen. */
    wash: string;
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

export function subagentTintPalette(source: SubagentTintSource): SubagentTintPalette {
    const r = source.dark ? ratios.dark : ratios.light;
    const wash = washGrey;
    return {
        wash,
        ground: mixHex(source.ground, wash, r.ground),
        surface: mixHex(source.surface, wash, r.surface),
        surfacePressed: mixHex(source.surfacePressed, wash, r.elevated),
        surfaceSelected: mixHex(source.surfaceSelected, wash, r.elevated),
        surfaceHigh: mixHex(source.surfaceHigh, wash, r.elevated),
        surfaceHighest: mixHex(source.surfaceHighest, wash, r.elevated),
        header: mixHex(source.header, wash, r.header),
        divider: mixHex(source.divider, wash, r.divider),
        input: mixHex(source.input, wash, r.elevated),
        userMessage: mixHex(source.userMessage, wash, r.userMessage),
    };
}

export function subagentTintSource(theme: Theme): SubagentTintSource {
    return {
        dark: theme.dark,
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
 * The base theme with its surfaces washed towards the grey. Text colours are
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
