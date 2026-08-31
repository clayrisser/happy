/**
 * EVERY HORIZONTAL DRAG IN THE APP, AND WHAT IT DOES ABOUT SWIPE-BACK
 * (DROVE-216).
 *
 * Clay: "when trying to slide a slider instead it swipes the screen." The
 * effort slider was the one he hit, but a control that loses its pan to the
 * navigator is a shape, not an incident, so this is the whole list rather than
 * one patch. `backSwipeOwners.test.ts` beside this file scans the tree and
 * fails BOTH ways: a file that owns a horizontal drag and is not listed here,
 * and a listed file whose reason has stopped matching the code.
 *
 * `lockedIn` names the file that calls `useBackSwipeLock`, which is usually the
 * control itself and once is the hook behind it. `null` means the control is
 * deliberately left alone, and `reason` has to say why.
 */

export interface BackSwipeOwner {
    /** Path under `sources/`. */
    source: string;
    /** What owns a horizontal drag there. */
    control: string;
    /** The file that takes the lock, or `null` when nothing needs to. */
    lockedIn: string | null;
    /** Why it holds the gesture, or why it does not have to. */
    reason: string;
}

export const backSwipeOwners: BackSwipeOwner[] = [
    {
        source: 'app/(app)/dev/expo-constants.tsx',
        control: 'horizontal ScrollView over the constants dump',
        lockedIn: null,
        reason: 'A dev screen reached only from the dev menu. A stray pop there '
            + 'costs a debug dump nobody is mid-gesture on.',
    },
    {
        source: 'app/(app)/dev/inverted-list.tsx',
        control: 'horizontal ScrollView in the inverted-list harness',
        lockedIn: null,
        reason: 'A dev screen, same as the constants dump. It exists to '
            + 'reproduce list behaviour, not to be used.',
    },
    {
        source: 'components/ActiveSessionsGroupCompact.tsx',
        control: 'RNGH Swipeable archive row',
        lockedIn: null,
        reason: 'Renders on the home screen and in the tablet sidebar, neither '
            + 'of which is a pushed screen, so there is no pop gesture to lose. '
            + 'Latent: an archive row inside a pushed screen would need the lock.',
    },
    {
        source: 'components/AgentInputAttachmentStrip.tsx',
        control: 'horizontal ScrollView of image thumbnails',
        lockedIn: 'components/AgentInputAttachmentStrip.tsx',
        reason: 'Sits in the composer on the session screen, which is pushed.',
    },
    {
        source: 'components/AudioCueSettings.tsx',
        control: 'six @react-native-community/slider rows',
        lockedIn: 'components/AudioCueSettings.tsx',
        reason: 'UISlider on a pushed settings screen, so its drag races the '
            + 'same recogniser the effort slider lost to.',
    },
    {
        source: 'components/ComposerSessionControls.tsx',
        control: 'the effort slider, a raw JS responder reading pageX',
        lockedIn: 'components/EffortSliderPopover.tsx',
        reason: 'The responder is here but the gesture state is the hook\'s, so '
            + 'the hold is taken and dropped where press-in and press-out '
            + 'already live. This is the control Clay photographed.',
    },
    {
        source: 'components/ComposerSheet.tsx',
        control: 'Gesture.Pan on the sheet grabber',
        lockedIn: null,
        reason: 'activeOffsetY([-12,12]).failOffsetX([-16,16]) — it fails on a '
            + 'horizontal move, so it never competes for one.',
    },
    {
        source: 'components/FlatSessionRow.tsx',
        control: 'RNGH Swipeable archive row',
        lockedIn: null,
        reason: 'Same as ActiveSessionsGroupCompact: home screen and tablet '
            + 'sidebar only.',
    },
    {
        source: 'components/HorizontalScrollView.tsx',
        control: 'the shared horizontal ScrollView, and through it every '
            + 'markdown code block and table',
        lockedIn: 'components/HorizontalScrollView.tsx',
        reason: 'Many instances, all in the chat transcript on a pushed screen. '
            + 'Locking here is what makes this one mechanism rather than one '
            + 'patch per call site.',
    },
    {
        source: 'components/ImageViewer.tsx',
        control: 'axis-unrestricted Gesture.Pan for the zoomed picture',
        lockedIn: null,
        reason: 'Lives inside an RN Modal, which iOS presents outside the '
            + 'navigation stack, so the pop recogniser is not in that hierarchy. '
            + 'The pan is also inert until the picture is zoomed in.',
    },
    {
        source: 'components/SessionGateOverlay.tsx',
        control: 'pagingEnabled full-width gate-card deck',
        lockedIn: 'components/SessionGateOverlay.tsx',
        reason: 'The highest-risk collision after the slider: page one\'s left '
            + 'swipe starts at the screen edge, which is where swipe-back is '
            + 'most eager. The sheet\'s own Pan needs nothing, it fails on X.',
    },
    {
        source: 'components/SideChatPanel.tsx',
        control: 'horizontal ScrollView of side-chat tabs',
        lockedIn: 'components/SideChatPanel.tsx',
        reason: 'Inside the session screen\'s sidebar, which is pushed on a '
            + 'tablet where UIKit still runs the pop gesture.',
    },
    {
        source: 'components/SpeakingVoiceSettings.tsx',
        control: 'five @react-native-community/slider rows',
        lockedIn: 'components/SpeakingVoiceSettings.tsx',
        reason: 'Same UISlider on the same pushed voice settings screen.',
    },
    {
        source: 'components/TabBar.tsx',
        control: 'long-press-then-drag Gesture.Pan across the tabs',
        lockedIn: null,
        reason: 'The home screen is the first route, so there is nothing to pop '
            + 'to. It also only activates after a hold, which an edge swipe '
            + 'never survives.',
    },
    {
        source: 'components/tools/views/BashViewFull.tsx',
        control: 'horizontal ScrollView around the unwrapped terminal card',
        lockedIn: 'components/tools/views/BashViewFull.tsx',
        reason: 'A wide command in the transcript on a pushed screen. Only the '
            + 'unwrapped mode scrolls; wrapped has no scroller at all.',
    },
    {
        source: 'components/usage/UsageChart.tsx',
        control: 'horizontal ScrollView of usage bars',
        lockedIn: 'components/usage/UsageChart.tsx',
        reason: 'The bar strip is wider than the pushed usage settings screen.',
    },
];

/** The files allowed to call `useBackSwipeLock`. */
export function backSwipeLockSites(): string[] {
    const sites = new Set<string>();
    for (const owner of backSwipeOwners) {
        if (owner.lockedIn) sites.add(owner.lockedIn);
    }
    return [...sites].sort();
}
