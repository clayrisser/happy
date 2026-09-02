import * as React from 'react';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { MONOCHROME_HARNESS_ICONS, type AvatarHarnessIcon } from '@/utils/avatarHarness';

/**
 * One mark per harness the catalog names (DROVE-393).
 *
 * Keyed by the catalog's own type, so a harness added there without an entry
 * here fails to compile instead of arriving badge-free the way pi (DROVE-379),
 * gemini (DROVE-381) and cursor did. The avatar badge and the row glyph both
 * read this map; there is no second one.
 *
 * A mark is a bitmap from the bundle when one shipped, and an Ionicons glyph
 * when none did. opencode is the glyph: nothing in the bundle draws it, and a
 * terminal is what a `drover opencode` pane is (the TUI runs in the pane
 * itself, drover/cli/opencode.ts). ProviderIcon.tsx does the same for the
 * providers without a mark.
 */
export type HarnessMark =
    | { kind: 'image'; source: number }
    | { kind: 'glyph'; name: keyof typeof Ionicons.glyphMap };

export const HARNESS_MARKS: Record<AvatarHarnessIcon, HarnessMark> = {
    claude: { kind: 'image', source: require('@/assets/images/icon-claude.png') },
    codex: { kind: 'image', source: require('@/assets/images/icon-gpt.png') },
    cursor: { kind: 'image', source: require('@/assets/images/icon-cursor.png') },
    gemini: { kind: 'image', source: require('@/assets/images/icon-gemini.png') },
    openclaw: { kind: 'image', source: require('@/assets/images/icon-openclaw.png') },
    agy: { kind: 'image', source: require('@/assets/images/icon-agy.png') },
    rig: { kind: 'image', source: require('@/assets/images/logo-drover.png') },
    pi: { kind: 'image', source: require('@/assets/images/icon-pi.png') },
    opencode: { kind: 'glyph', name: 'terminal-outline' },
};

/**
 * The tint a bitmap takes: the given colour for line art, none for a mark
 * that has colours of its own. A glyph always takes the colour.
 */
export function harnessIconTint(harness: AvatarHarnessIcon, color: string): string | undefined {
    return MONOCHROME_HARNESS_ICONS.has(harness) ? color : undefined;
}

/**
 * The harness mark, at any size: the avatar badge draws it in the text colour
 * inside its circle, and a session row draws it at row size in the secondary
 * text colour so the line-art marks read on either theme.
 */
export const HarnessGlyph = React.memo(({ harness, size, color, accessibilityLabel }: {
    harness: AvatarHarnessIcon;
    size: number;
    color?: string;
    accessibilityLabel?: string;
}) => {
    const { theme } = useUnistyles();
    const tint = color ?? theme.colors.textSecondary;
    const mark = HARNESS_MARKS[harness];
    if (mark.kind === 'glyph') {
        return (
            <Ionicons
                name={mark.name}
                size={size}
                color={tint}
                accessible={accessibilityLabel !== undefined}
                accessibilityLabel={accessibilityLabel}
            />
        );
    }
    return (
        <Image
            source={mark.source}
            style={{ width: size, height: size }}
            contentFit="contain"
            tintColor={harnessIconTint(harness, tint)}
            accessible={accessibilityLabel !== undefined}
            accessibilityLabel={accessibilityLabel}
        />
    );
});
