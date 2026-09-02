/**
 * Which chrome controls answer a press with the platform's own glass, and
 * which deliberately do not (DROVE-356).
 *
 * Clay, with the sessions header and a tool screen's header photographed:
 * "Why do all these buttons not behave like all the other liquid glass
 * buttons?" and "Why are the right two buttons not liquid glassing, where you
 * push it and it grows?"
 *
 * WHAT WAS WRONG. The composer's `+` is a `GlassChromeButton`: its `Pressable`
 * sits INSIDE a `GlassChromeSurface` with `interactive` on, so
 * `UIGlassEffect.isInteractive` sees the touch and the material swells past
 * its resting frame (DROVE-266, unclipped by DROVE-328). The header slots were
 * not that. `navigation/Header.tsx` drew all three of its slots on a surface
 * that was never interactive, on the reasoning that a slot sometimes holds a
 * `ToolStatusIndicator` rather than a button. True, and it made the decision
 * once for every screen: the sessions header's filter and gear are two real
 * buttons that drew the material and never answered a press. The per-project
 * `+` was not on the material at all — a filled `View` inside a `Pressable`
 * that faded to `opacity: 0.5`, which is the hand-rolled press DROVE-169 spent
 * three springs removing.
 *
 * WHAT IS TRUE NOW. The screen says which of its slots are buttons, and the
 * ones that are get the same surface, the same tint rule and the same swell as
 * the composer's `+`, through the shared components rather than a copy.
 *
 * AND TWO CONTROLS STAY STILL ON PURPOSE, which is the other half of the
 * answer and the reason this file is a table rather than a flag. A capsule
 * that swells under a finger it cannot act on is a button that does nothing.
 * Both are named below with the reason, so the next person reads a decision
 * instead of an omission.
 *
 * The RULES this is an instance of live in `nativeControls.ts`; the material
 * itself is `GlassChromeControl.tsx`; the app-wide walk is
 * `glassChromeScreens.ts`. This file is narrower than that walk: it is about
 * the PRESS, one control at a time.
 */

/** The shared surfaces. There is no third, and no local copy of either. */
export type HeaderGlassSurface = 'GlassChromeButton' | 'GlassChromeSurface';

export interface HeaderGlassControl {
    /** What a person would call it. */
    name: string;
    /** The row it shares with its neighbours, for reading. */
    group: string;
    /** Path under `sources/` where the surface is MOUNTED. */
    source: string;
    /**
     * Path under `sources/` where the screen SAYS the slot is a button, when
     * that is a different file from the one that mounts the surface. The
     * shared header takes whatever a screen puts in its slots, so the answer
     * cannot live with the mount.
     */
    declaredIn?: string;
    surface: HeaderGlassSurface;
    /** Does a finger landing on it do anything? */
    tappable: boolean;
    /**
     * Independent presses living on the ONE surface.
     *
     * Two is not two surfaces. `isInteractive` is a property of the effect
     * view, so one surface holding two `Pressable`s is how the system draws a
     * grouped control (DROVE-169, DROVE-343): the segment under the finger
     * answers, and the presses stay separate.
     */
    presses: number;
    /** Required when `tappable` is false. */
    reason?: string;
}

export const headerGlassControls: readonly HeaderGlassControl[] = [
    {
        name: 'sessions header drover mark',
        group: 'sessions header',
        source: 'components/navigation/Header.tsx',
        declaredIn: 'components/MainView.tsx',
        surface: 'GlassChromeSurface',
        tappable: false,
        presses: 0,
        reason: 'It is the mark and nothing else. This phone reaches its inbox through the tab bar, so the mark opens nothing. Clay circled it beside the pill, which is why it is written down rather than left out: a decoration that swells under a finger is a button that does nothing.',
    },
    {
        name: 'sessions header filter and gear pill',
        group: 'sessions header',
        source: 'components/navigation/Header.tsx',
        declaredIn: 'components/MainView.tsx',
        surface: 'GlassChromeSurface',
        tappable: true,
        presses: 2,
    },
    {
        name: 'sessions list per-project new-session +',
        group: 'sessions list project row',
        source: 'components/ProjectGroup.tsx',
        surface: 'GlassChromeButton',
        tappable: true,
        presses: 1,
    },
    {
        name: 'session header back chevron',
        group: 'session header',
        source: 'components/ChatHeaderView.tsx',
        surface: 'GlassChromeButton',
        tappable: true,
        presses: 1,
    },
    {
        name: 'session header title pill',
        group: 'session header',
        source: 'components/ChatHeaderView.tsx',
        surface: 'GlassChromeSurface',
        tappable: true,
        presses: 1,
    },
    {
        name: 'session header avatar',
        group: 'session header',
        source: 'components/ChatHeaderView.tsx',
        surface: 'GlassChromeSurface',
        tappable: true,
        presses: 1,
    },
    {
        name: 'shared header back chevron',
        group: 'tool message header',
        source: 'components/navigation/Header.tsx',
        surface: 'GlassChromeButton',
        tappable: true,
        presses: 1,
    },
    {
        name: 'tool message header title pill',
        group: 'tool message header',
        source: 'components/navigation/Header.tsx',
        declaredIn: 'app/(app)/session/[id]/message/[messageId].tsx',
        surface: 'GlassChromeSurface',
        tappable: false,
        presses: 0,
        reason: 'The title is a `ToolHeader`: the tool\'s icon and its name, with no gesture on it. This is the pill in Clay\'s second photograph, and the answer to "why does it not grow" is that there is nothing for it to do. It is not made to look pressable.',
    },
    {
        name: 'tool message header status disc',
        group: 'tool message header',
        source: 'components/navigation/Header.tsx',
        declaredIn: 'app/(app)/session/[id]/message/[messageId].tsx',
        surface: 'GlassChromeSurface',
        tappable: false,
        presses: 0,
        reason: 'The green disc is a `ToolStatusIndicator` — a checkmark for a finished tool call, a spinner for a running one. It reads as an avatar and is not one, and it has no action behind it.',
    },
];

export interface HeaderPressOutcome {
    /** Controls whose glass swells under this press. */
    swells: string[];
    /** Every other control, which must not move. */
    calm: string[];
}

/**
 * What one press does to the whole table.
 *
 * Every control in it mounts its OWN surface, so a press reaches exactly one
 * of them and its neighbours never move. That is what the spec beside this
 * asserts, control by control, and what a shared surface would break: the
 * filter and the gear share one, which is why they are ONE row here with two
 * presses rather than two rows.
 */
export function resolveHeaderPress(pressed: string): HeaderPressOutcome {
    const control = headerGlassControls.find((entry) => entry.name === pressed);
    if (!control) {
        throw new Error(`no header glass control named ${pressed}`);
    }
    return {
        swells: control.tappable ? [control.name] : [],
        calm: headerGlassControls
            .filter((entry) => entry.name !== control.name)
            .map((entry) => entry.name),
    };
}
