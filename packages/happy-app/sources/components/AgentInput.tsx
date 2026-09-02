import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { Keyboard, View, Platform, Switch, useWindowDimensions, Text, ActivityIndicator, Pressable, LayoutChangeEvent } from 'react-native';
import { Image } from 'expo-image';
import { AgentInputAttachmentStrip } from './AgentInputAttachmentStrip';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { generateThumbhash } from '@/utils/thumbhash';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { PermissionMode, ModelMode } from './PermissionModeSelector';
import { EffortLevel } from './modelModeOptions';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { useActiveWord } from './autocomplete/useActiveWord';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { ComposerSheet } from './ComposerSheet';
import { TextInputState, MultiTextInputHandle } from './MultiTextInput';
import { applySuggestion } from './autocomplete/applySuggestion';
import { GitStatusBadge, useHasMeaningfulGitStatus } from './GitStatusBadge';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSetting, useSetting } from '@/sync/storage';
import { hackMode, hackModes } from '@/sync/modeHacks';
import { getPermissionModeShortLabel } from '@/utils/permissionModeLabels';
import type { UsageLimitsLike } from '@/utils/sessionStatusBar';
import type { DroverUsageLike } from '@/utils/droverUsage';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@/sync/storageTypes';
import { isRunningOnMac } from '@/utils/platform';
import { MobileGlassSurface } from './MobileGlass';
import { ComposerBubble } from './ComposerBubble';
import { ComposerControlButton } from './ComposerControlButton';
import { GlassChromeSurface, useGlassChromeMaterial } from './GlassChromeControl';
import { AnimatedFade } from './AnimatedOverlay';
import { BubblePressable } from './BubblePressable';
import { resolveAgentInputPrimaryAction } from './agentInputPrimaryAction';
import { resolveComposerPrimaryPress, type ComposerPrimaryGesture } from './composerPrimaryPress';
import { talkButtonWiring } from './talkButtonWiring';
import { useTalkTouchStream } from './talkTouchStream';
import { ComposerToast } from './ComposerToast';
import { audioOutToast } from '@/voice/streamTalk';
import { audioOutButton } from './composerAudioOut';
import type { TransportEffect } from '@/voice/readAloudTransport';
import { AgentInputStatusRow } from './AgentInputStatusRow';
import { AddContextSheet, type AddContextSource } from './AddContextSheet';
import { resolveUsageStrip } from './agentInputUsage';
import { ProviderIcon } from './ProviderIcon';
import { isRigMetadata } from '@/sync/rig';
import {
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
    MOBILE_COMPOSER_LAYOUT,
    MOBILE_COMPOSER_METRICS,
    resolveMobileComposerActionGeometry,
    resolveMobileComposerLineGeometry,
} from './agentInputLayout';
import {

    COMPOSER_BUBBLE_SURFACE,
} from './composerBubbleLayout';
import { COMPOSER_STRIP_BOX } from './composerStripLayout';
import { sheetSectionRhythm, sheetSectionTitleInset } from './sheetHeaderLayout';
import { LiveMicBanner } from './LiveMicBanner';
import type { MicButtonState } from '@/voice/micButton';
import type { DictationCaptureState } from '@/voice/dictationCapture';
import { DroverChannelsSheet } from './DroverChannelsSheet';
import { buildSessionPillLabel } from './sessionPillLabel';
import type { AgentModePendingFlags } from '@/sync/useAgentModePending';
import { permissionModeGlyph } from './sessionControlGlyphs';
import { useAutoAccept, useAutoAcceptToggle } from '@/hooks/useAutoAccept';
import { AUTO_ACCEPT_SUBTITLE, AUTO_ACCEPT_TITLE, autoAcceptGlyph } from './autoAcceptRow';
import { ComposerSessionControls, type ComposerSessionPicker } from './ComposerSessionControls';
import { effortSliderScaleFromLevels } from './effortSlider';
import {
    composerPickerClosed,
    composerPickerDismiss,
    composerPickerKeyboardGone,
    composerPickerPress,
    composerPickerSheetOpen,
    type ComposerPickerKind,
    type ComposerPickerState,
    type ComposerPickerStep,
} from './composerPicker';
import {
    COMPOSER_IN_FIELD_DISC,
    COMPOSER_IN_FIELD_DISC_OPEN,
    composerControlPalette,
    composerFillTint,
    composerGlyphColour,
    composerMicSurface,
    composerSendSurface,
    micColour,
    primaryActionColour,
} from './composerControlColour';
import { DOCK_CONTENT_TOP_PADDING } from './agentDockLayout';

interface AgentInputProps {
    // `initialValue` seeds the uncontrolled textarea once; keystrokes never
    // round-trip back into it via React, which is what keeps fast typing/
    // deletion crisp. The parent reads the live text via the imperative ref.
    initialValue: string;
    placeholder: string;
    // Fires on every keystroke so the parent can sync derived state (drafts,
    // hasText) — typically wrapped in startTransition / debounce by the caller.
    onChangeText?: (text: string) => void;
    sessionId?: string;
    onSend: () => void;
    sendIcon?: React.ReactNode;
    onMicPress?: () => void;
    isMicActive?: boolean;
    /**
     * A live ElevenLabs call is up or dialling (DROVE-236).
     *
     * Separate from `isMicActive`, and it has to be: `onMicPress` is withdrawn
     * for the length of a call, because the header pill is the only stop
     * control (SessionView). Before the collapse that simply removed the
     * waveform; now the same control is also the speaker and cannot go
     * anywhere, so it needs to be TOLD that a call is up rather than inferring
     * it from a handler it no longer has.
     */
    bossModeActive?: boolean;
    /**
     * Read-aloud (DROVE-30, mode B). Absent when the device has no speech
     * synthesiser at all, so the toggle is not offered where it cannot work.
     */
    readAloudEnabled?: boolean;
    /** On and holding its place (DROVE-233). */
    readAloudPaused?: boolean;
    /**
     * The tap on the one audio-out button (DROVE-327): start from off, stop
     * while reading, RESUME from paused. Like the long press it applies the
     * effect itself and returns what the transport table chose, so this
     * component only says it. It was `onReadAloudToggle`, a bare flip of the
     * session's switch, which is how a tap on a paused reader turned it off.
     */
    onAudioOutPress?: () => TransportEffect;
    /**
     * The long press on the one audio-out button (DROVE-233, DROVE-236).
     *
     * It APPLIES the read-aloud half itself and returns what the transport
     * table chose, so pause and resume never round-trip through this component
     * and `boss-mode` arrives as a name for the composer to act on. One
     * decider, in the voice layer, beside the headphone and lock-screen
     * presses.
     */
    onAudioOutLongPress?: () => TransportEffect;
    /**
     * Dictation (DROVE-30 mode A, DROVE-74, DROVE-105). One button, three
     * outcomes: press and hold, released ON the button, sends; a tap latches
     * the mic open and the next tap stops it with the words left in the
     * composer; sliding off the button before the lift cancels. Separate
     * from `onMicPress`, which starts boss mode and on the compact composer
     * already owns the send button.
     */
    onTalkPressIn?: (touchAt?: number) => void;
    onTalkPressOut?: (touchAt?: number) => void;
    /** The finger crossed the button's edge while still down (DROVE-105). */
    onTalkSlide?: (inside: boolean) => void;
    /**
     * One tap, on a control with no touch stream (DROVE-210). Latch the mic
     * open, and stop a latched one. Same capture as the three above.
     *
     * The composer's mic is NOT one of those controls any more: it has the
     * full stream again (DROVE-269), so this is here for the headphone double
     * press, the lock screen and the watch, which report a press and nothing
     * else. A latch opened by any of them is stopped by the button, and the
     * other way round.
     */
    onTalkTap?: () => void;
    onTalkCancel?: () => void;
    /** What the button draws. Absent when there is no button. */
    talkState?: MicButtonState;
    /** The finger is off the button: the lift will cancel. */
    talkCancelArmed?: boolean;
    /** The press is a hold now: the lift will send (DROVE-140, DROVE-142). */
    talkSendArmed?: boolean;
    /** What the live banner draws. */
    talk?: DictationCaptureState;
    permissionMode?: PermissionMode | null;
    availableModes?: PermissionMode[];
    onPermissionModeChange?: (mode: PermissionMode) => void;
    modelMode?: ModelMode | null;
    availableModels?: ModelMode[];
    onModelModeChange?: (mode: ModelMode) => void;
    effortLevel?: EffortLevel | null;
    availableEffortLevels?: EffortLevel[];
    onEffortLevelChange?: (level: EffortLevel) => void;
    /**
     * Which of the three picks the terminal has not confirmed yet (DROVE-217).
     * Derived in SessionView from the request/observed pair DROVE-199 already
     * tracks; drawn by ComposerSessionControls.
     */
    pendingModes?: AgentModePendingFlags | null;
    /**
     * The effort slider's write (DROVE-200). A wire key, or `null` for `auto`,
     * which is a mode rather than a level and so has no key: paneModelSync
     * spells a null effort `/effort auto`, the reset. Absent means the phone
     * still lists effort rather than dragging it.
     */
    onEffortKeyChange?: (key: string | null) => void;
    metadata?: Metadata | null;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        dotColor: string;
        isPulsing?: boolean;
        cliStatus?: {
            claude: boolean | null;
            codex: boolean | null;
            gemini?: boolean | null;
        };
    };
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<{ key: string, text: string, component: React.ElementType }[]>;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindow?: number;
    };
    alwaysShowContextSize?: boolean;
    /** Hide the auxiliary connection/mode row while reading older messages. */
    showStatusDetails?: boolean;
    /** Opens session info; the status row's connection segment taps into it (DROVE-82). */
    onSessionInfoPress?: () => void;
    /**
     * Reports the composer card's top offset from AgentInput's own top edge.
     * The status/chips rows above the card keep their layout space when faded
     * out, so callers anchoring to AgentInput would float above empty space.
     */
    onActionAreaOffsetChange?: (offset: number) => void;
    /** Plan quota windows from agent state, for the week stat and its popup. */
    sessionStatusUsageLimits?: UsageLimitsLike | null;
    /**
     * Every drover account's headroom from session metadata (DROVE-47). The
     * fallback for a pane session, which has no agent-state windows, and the
     * source of the folded "other accounts" group either way.
     */
    sessionStatusDroverUsage?: DroverUsageLike;
    sessionStatusDroverAccount?: string | null;
    /**
     * The session's harness, `metadata.flavor` (DROVE-352). The quota sheet
     * lists only accounts of this harness: a Claude session was showing Cursor
     * rows it could never move onto. Absent reads as claude.
     */
    sessionStatusFlavor?: string | null;
    onFileViewerPress?: () => void;
    agentType?: 'claude' | 'codex' | 'gemini' | 'openclaw' | 'agy';
    onAgentClick?: () => void;
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
    blockSend?: boolean;
    isSendDisabled?: boolean;
    isSending?: boolean;
    minHeight?: number;
    zenMode?: boolean;
    /** Image attachments waiting to be sent. */
    selectedImages?: AttachmentPreview[];
    onPickImages?: () => void;
    /** The camera tile of the Add context sheet (DROVE-128). */
    onTakePhoto?: () => void;
    /** The files tile of the Add context sheet (DROVE-128). */
    onPickFiles?: () => void;
    onRemoveImage?: (id: string) => void;
    onAddImages?: (images: AttachmentPreview[]) => void;
}

/**
 * The picker list's glyph is the button row's glyph (DROVE-129, DROVE-141).
 *
 * These were two maps that disagreed: the list drew a folder for the default
 * and the button drew a shield, and the button drew a warning triangle for
 * yolo, which read as an error. One derivation now, in sessionControlGlyphs.ts,
 * so a mode looks the same wherever it appears.
 */
function permissionKindIcon(kind: string | null | undefined): React.ComponentProps<typeof Ionicons>['name'] {
    return permissionModeGlyph(kind);
}

const MOBILE_COMPOSER_LINE_GEOMETRY = resolveMobileComposerLineGeometry();

/**
 * How long a deferred picker waits for `keyboardDidHide` before opening
 * anyway. Longer than any keyboard dismissal, short enough not to read as a
 * dropped tap if the event never arrives.
 */
const PICKER_KEYBOARD_FALLBACK_MS = 420;
const MOBILE_ICON_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('icon');
/*
 * The four IN-BUBBLE variants are gone from here (DROVE-266). The `+`, the
 * audio disc, the mic and send are `ComposerControlButton` now, which takes its
 * size from `MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE` — the same constant those
 * variants resolve from — so a style holding the geometry a second time would
 * be a second place for it to drift. `resolveMobileComposerActionGeometry` is
 * untouched: HomeDock still draws from it, and composerBubbleLayout.spec.ts
 * still models this row through it.
 *
 * `icon` stays because Home's 44pt row is a different size and still reads it
 * here.
 */

// Shared with the action-area offset reported to onActionAreaOffsetChange —
// the Shaker's layout.y is relative to innerContainer, which sits this far
// below AgentInput's top edge. Read from agentDockLayout, which adds it up
// with the rest of the dock's parts for the chat list's bottom floor
// (DROVE-373); a second literal here is a floor that silently stops matching.
const CONTAINER_TOP_PADDING = DOCK_CONTENT_TOP_PADDING;

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignItems: 'center',
        paddingBottom: 8,
        paddingTop: CONTAINER_TOP_PADDING,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
    },
    unifiedPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        // The FLAT card's clip: off the material this is what rounds the
        // field's background. On the material `MobileGlassSurface` overrides
        // it last with `visible`, because the bubble is interactive glass and
        // an interactive surface swells past this frame on press (DROVE-202,
        // DROVE-328). Do not "fix" that by clipping the glass host.
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    },
    unifiedPanelShadow: {
        borderRadius: 24,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: theme.dark ? 6 : 2 },
        shadowOpacity: theme.dark ? 0.22 : 0.08,
        shadowRadius: theme.dark ? 16 : 8,
        elevation: theme.dark ? 4 : 2,
    },
    mobileUnifiedPanel: {
        // The frosted material is supplied by MobileGlassSurface. The dense
        // tint keeps the transcript illegible behind it without losing glass.
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.input.background,
        }),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        // THE BUBBLE'S OWN LAYOUT IS `ComposerBubble`'S NOW (DROVE-345). The
        // column, the padding and the gap were spread here and Home spread
        // nothing at all, which is how five glass tickets landed on one screen
        // and missed the other. What is left is the tint an Android without
        // the material needs and the hairline that separates the card from the
        // chat.
    },
    /**
     * The composer's first line, which carries the gutter and holds the
     * bubble. It has had the `+` beside it (DROVE-196) and inside the field
     * (DROVE-206); since DROVE-214 the `+` is on the bubble's own bottom row
     * and this line has one child and one job.
     */
    mobileComposerLine: MOBILE_COMPOSER_LINE_GEOMETRY,
    /** The bubble takes the whole line. */
    mobileBubbleShell: {
        flex: 1,
        minWidth: 0,
    },
    /**
     * Thumbnails inside a card with no padding would sit on its rim, so the
     * strip brings the air the card used to. 64pt thumb plus this is the 72
     * `attachmentExtraHeight` has always promised.
     */
    mobileAttachmentInset: {
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    },
    mobileUnifiedPanelShadow: {
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 2,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },
    /**
     * THE BUBBLE'S TEXT ROW: the full interior width, one line tall when the
     * composer is empty, and nothing beside it (DROVE-214).
     *
     * Every leading and trailing reservation is gone, because the `+` and send
     * are on the row below now. That is what removes the caret's dependence on
     * what is drawn: it starts at the bubble's interior edge in every state,
     * zen mode included, so there is nothing left for the pinned text widths
     * to protect.
     *
     * The base `inputContainer` under this sets `paddingLeft: 2`,
     * `paddingRight: 8` and `minHeight: 40`, so all three are overridden here
     * rather than left to a shorthand.
     */
    mobileInputContainer: {
        // THE GEOMETRY IS `ComposerBubble`'S NOW (DROVE-345). It was spread
        // here, and Home spread nothing at all, which is how five glass
        // tickets landed on one screen and missed the other. What is left is
        // the one thing that is this screen's: the field sits centred in a row
        // it shares with nothing.
        alignItems: 'center',
    },
    /**
     * THE BUBBLE'S BUTTON ROW: the `+`, a spacer, send (DROVE-214).
     *
     * `alignItems: 'center'` is the whole of what three passes of arithmetic
     * were standing in for. It holds at 36 and it would hold at any other
     * height this row were given, which is exactly what the offsets it
     * replaces could not do.
     */
    /** Holds send at the trailing end even in zen mode, where no `+` is drawn. */
    /**
     * One fixed gap between two controls on that row (DROVE-236).
     *
     * A child with a width, not a margin and not the row's `gap`. The row
     * wants a fixed 6 in three places and slack in exactly one, and `gap`
     * cannot say that; the reasoning is on `resolveComposerBubbleGapGeometry`.
     */

    // Overlay styles
    autocompleteOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    // The section rhythm (DROVE-376), shared with DroverChannelsSheet. The
    // title used to sit 8pt left of the rows it heads, with four points of air
    // under it; the inset is derived from the row card's now.
    overlaySection: {
        paddingTop: sheetSectionRhythm.top,
        paddingBottom: sheetSectionRhythm.bottom,
    },
    settingsStatusInfo: {
        paddingTop: 6,
        paddingBottom: 4,
        paddingHorizontal: 8,
    },
    overlaySectionTitle: {
        fontSize: sheetSectionRhythm.titleSize,
        lineHeight: sheetSectionRhythm.titleLine,
        color: theme.colors.textSecondary,
        paddingHorizontal: sheetSectionTitleInset,
        paddingBottom: sheetSectionRhythm.gap,
        ...Typography.default('semiBold'),
    },
    overlayDivider: {
        height: 1,
        backgroundColor: theme.colors.glass.divider,
        marginHorizontal: 16,
    },

    // Selection styles
    selectionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: 'transparent',
    },
    selectionItemPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    radioButton: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    radioButtonActive: {
        borderColor: theme.colors.radio.active,
    },
    radioButtonInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioButtonDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    selectionLabel: {
        fontSize: 14,
        ...Typography.default(),
    },
    selectionLabelActive: {
        color: theme.colors.radio.active,
    },
    selectionLabelInactive: {
        color: theme.colors.text,
    },

    // Status styles
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusText: {
        fontSize: 11,
        ...Typography.default(),
    },
    permissionModeContainer: {
        flexDirection: 'column',
        alignItems: 'flex-end',
    },
    permissionModeText: {
        fontSize: 11,
        ...Typography.default(),
    },
    contextWarningText: {
        fontSize: 11,
        marginLeft: 8,
        ...Typography.default(),
    },

    // Button styles
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    mobileIconButton: MOBILE_ICON_ACTION_GEOMETRY,
    talkButtonLatched: {
        borderWidth: 2,
        borderColor: composerControlPalette(theme.dark).recording,
        borderRadius: 999,
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        gap: 8,
        flex: 1,
        overflow: 'hidden',
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 8,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.button.secondary.tint,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    sendButtonLocked: {
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonInnerPressed: {
        opacity: 0.7,
    },
    sendButtonIcon: {
        color: theme.colors.button.primary.tint,
    },
}));


// `getContextStatus` lived here and derived the strip's percent, its detail
// text and its colour, and gated the gauge to the last 10% of the window. All
// four moved to contextCompaction.ts (DROVE-231): the ring is a countdown to
// the next COMPACTION now, which is what Clay asked to see, and a gauge that
// only appears at 90% cannot answer when the next one is.

// Stable sub-trees extracted from AgentInput so they don't reconcile when
// the input's keystroke-derived state (hasText / inputState) flips. Their
// props are derived from session metadata, not from the textarea content,
// so memo skips re-render on typing entirely.

type ContextChipsProps = {
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
};

const AgentInputContextChips = React.memo(function AgentInputContextChips(p: ContextChipsProps) {
    const { theme } = useUnistyles();
    if (p.machineName === undefined && !p.currentPath) {
        return null;
    }
    return (
        <View style={{
            backgroundColor: theme.colors.surfacePressed,
            borderRadius: 12,
            padding: 8,
            marginBottom: 8,
            gap: 4,
        }}>
            {p.machineName !== undefined && p.onMachineClick && (
                <BubblePressable
                    onPress={() => {
                        hapticsLight();
                        p.onMachineClick?.();
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(s) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: Platform.select({ default: 16, android: 20 }),
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        height: 32,
                        opacity: s.pressed ? 0.7 : 1,
                        gap: 6,
                    })}
                >
                    <Ionicons name="desktop-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.text,
                        fontWeight: '600',
                        ...Typography.default('semiBold'),
                    }}>
                        {p.machineName === null ? t('agentInput.noMachinesAvailable') : p.machineName}
                    </Text>
                </BubblePressable>
            )}
            {p.currentPath && p.onPathClick && (
                <BubblePressable
                    onPress={() => {
                        hapticsLight();
                        p.onPathClick?.();
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(s) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: Platform.select({ default: 16, android: 20 }),
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        height: 32,
                        opacity: s.pressed ? 0.7 : 1,
                        gap: 6,
                    })}
                >
                    <Ionicons name="folder-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.text,
                        fontWeight: '600',
                        ...Typography.default('semiBold'),
                    }}>
                        {p.currentPath}
                    </Text>
                </BubblePressable>
            )}
        </View>
    );
});

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const screenWidth = useWindowDimensions().width;
    // The compact action row is deliberately limited to the narrow native
    // layout. Desktop web, Mac Catalyst, and tablet-width canvases retain the
    // existing composer affordances rather than inheriting it.
    const runningOnMac = isRunningOnMac();
    const compactMobileComposer = Platform.OS !== 'web' && !runningOnMac && screenWidth <= 700;
    /**
     * WHICH MATERIAL THE COMPOSER IS ACTUALLY ON (DROVE-343).
     *
     * The shell's `overflow` depends on it: on Liquid Glass nothing in the
     * composer may be clipped, because three surfaces inside it swell past
     * their resting frames; off it the flat card is the only thing rounding
     * what it holds. `getGlassSurfaceOverflow` is the rule and this is its
     * argument. The hook watches Reduce Transparency, so a reader who has
     * turned the material off gets the clipped card rather than a card
     * pretending to hold a swell that is not drawn.
     */
    const glassChromeMaterial = useGlassChromeMaterial();
    // `useNativeSettingsMenus` was here and is gone (DROVE-242). It sent iOS to
    // a SwiftUI menu for the mode and the model while every other platform used
    // the sheets below. There is no native menu on the composer now, so nothing
    // asks the platform; `openSheet` is the whole of the surface question.
    /**
     * The composer's colour vocabulary (DROVE-176, DROVE-215). One place
     * decides what a control's glyph is drawn in, and the rule it decides by
     * is that a glyph is the row's foreground unless something is happening
     * right now. Every entry is measured on the glass; nothing here picks a
     * colour of its own.
     */
    const composerPalette = composerControlPalette(theme.dark);
    const isSendBlocked = props.blockSend ?? false;

    // `hasText` drives only the send-button appearance/enabled state. It's
    // updated via startTransition from the keystroke handler so a busy reducer
    // never blocks the next character from landing in the textarea.
    const [hasText, setHasText] = React.useState(() => props.initialValue.trim().length > 0);
    const hasImages = (props.selectedImages?.length ?? 0) > 0;
    const hasComposerContent = hasText || hasImages;

    // Check if this is a Codex, Gemini, or OpenClaw session
    // Use metadata.flavor for existing sessions, agentType prop for new sessions
    const isRig = isRigMetadata(props.metadata);
    const isCodex = !isRig && (props.metadata?.flavor === 'codex' || props.agentType === 'codex');
    const isGemini = props.metadata?.flavor === 'gemini' || props.agentType === 'gemini';
    const isOpenClaw = props.metadata?.flavor === 'openclaw' || props.agentType === 'openclaw';
    const displayPermissionMode = React.useMemo(() => (
        props.permissionMode ? hackMode(props.permissionMode) : null
    ), [props.permissionMode]);
    const permissionModeKey = displayPermissionMode?.key ?? 'default';
    // The chip is one word; the sandbox qualifier stays on the menu options and
    // the status badge, which both have room to spell it out.
    const permissionShortLabel = getPermissionModeShortLabel(displayPermissionMode);
    const availableModes = React.useMemo(() => (
        hackModes(props.availableModes ?? [])
    ), [props.availableModes]);
    const availableModels = props.availableModels ?? [];
    const availableEffortLevels = props.availableEffortLevels ?? [];
    // Auto-accept for THIS session (DROVE-277). In memory, so it is false on
    // every fresh launch without anything resetting it, and it is read here
    // rather than in the capsule so the padlock and the sheet row cannot
    // disagree about what the session is set to.
    const autoAccept = useAutoAccept(props.sessionId);
    // The sheet's switch is the ONE setter since DROVE-331. DROVE-281's bolt
    // on the capsule wrote through this same setter; Clay ruled two controls
    // for one bit redundant and the bolt is gone.
    const setAutoAccept = useAutoAcceptToggle(props.sessionId);
    const modelLabel = props.modelMode?.name ?? t('agentInput.model.title');
    const effortLabel = props.effortLevel?.name;
    const isSandboxEnabled = React.useMemo(() => {
        const sandbox = props.metadata?.sandbox as unknown;
        if (!sandbox) {
            return false;
        }
        if (typeof sandbox === 'object' && sandbox !== null && 'enabled' in sandbox) {
            return Boolean((sandbox as { enabled?: unknown }).enabled);
        }
        return true;
    }, [props.metadata?.sandbox]);
    const isSandboxedYoloMode = isSandboxEnabled && (
        permissionModeKey === 'bypassPermissions' || permissionModeKey === 'yolo'
    );

    const withSandboxSuffix = React.useCallback((label: string, modeKey?: string) => {
        if (!isSandboxEnabled) {
            return label;
        }
        if (modeKey === 'bypassPermissions' || modeKey === 'yolo') {
            return `${label} (sandboxed)`;
        }
        return label;
    }, [isSandboxEnabled]);

    // Usage row under the card: week quota + context gauge
    /**
     * The two raw numbers, straight down (DROVE-231).
     *
     * `getContextStatus` used to derive the strip's percent, its detail text
     * and its colour here, and also decided the gauge was only worth drawing
     * within 10% of the window. The strip owns all of that now: it fills the
     * ring toward the next COMPACTION rather than the window, which is the
     * question Clay asked, and a gauge that only appears at 90% cannot answer
     * it.
     */
    const contextUsage = React.useMemo(() => (
        props.usageData?.contextSize
            ? {
                contextSize: props.usageData.contextSize,
                ...(props.usageData.contextWindow ? { contextWindow: props.usageData.contextWindow } : {}),
            }
            : null
    ), [props.usageData?.contextSize, props.usageData?.contextWindow]);
    // The week figure and its popup, from agent state or, on a pane session,
    // from drover's snapshot (DROVE-47); resolveUsageStrip says which.
    // `usageBarCapturedAt` is DROVE-230's: the strip says how old the reading
    // is, and the direction setting it replaced is deleted, not re-read here.
    const { weekPercent, weekTone, usageBarGroups, usageBarFooter, usageBarCapturedAt } = React.useMemo(() => resolveUsageStrip({
        usageLimits: props.sessionStatusUsageLimits ?? null,
        droverUsage: props.sessionStatusDroverUsage,
        droverAccount: props.sessionStatusDroverAccount,
        // The sheet lists this session's own harness and nothing else
        // (DROVE-352).
        flavor: props.sessionStatusFlavor,
    }), [
        props.sessionStatusUsageLimits,
        props.sessionStatusDroverUsage,
        props.sessionStatusDroverAccount,
        props.sessionStatusFlavor,
    ]);

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const [stopRequested, setStopRequested] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const sendBlockShakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);
    /*
     * THE TALK GESTURE, BACK ON THE COMPOSER (DROVE-269).
     *
     * `talkWiring` stood here, fed a `TalkButton` on the control row, and went
     * with that row in DROVE-236, which folded the mic into the primary button
     * and named losing hold-to-talk as the price. DROVE-264 split the two
     * controls apart again and left the price paid: "a second gesture on this
     * button is a decision rather than a refactor."
     *
     * It was a decision, and it was taken without asking the person who uses
     * it. Clay: "why isn't holding down the microphone doing push to talk like
     * it used to do." So the three-outcome contract this file has documented on
     * `onTalkPressIn` since DROVE-30 is wired to the standalone mic, whole:
     * press and hold released ON the button sends, a tap latches and the next
     * tap stops with the words left in the composer, sliding off before the
     * lift cancels.
     *
     * NOTHING HERE INVENTS THE GESTURE. All four handlers stayed on the
     * interface through both collapses and are still driven by the same
     * reducer in `micButton.ts`; what was missing was a control feeding them a
     * touch stream. `talkTouchStream.ts` is that stream, lifted out of
     * TalkButton so the two buttons cannot drift, and the mic spreads what it
     * returns.
     *
     * The hold still could NOT be the primary's long press: that gesture is the
     * channel sheet at every face (`composerPrimaryPress.ts`). It is the MIC's
     * own touch stream, on the mic's own rectangle, which is the one place a
     * hold has never meant anything else.
     *
     * Handlers by REFERENCE, never wrapped in a lambda (DROVE-210): an arrow
     * that forgets to forward `touchAt` type-checks and silently undoes
     * DROVE-140.
     */
    const talkWiring = React.useMemo(
        () => talkButtonWiring({
            onTalkPressIn: props.onTalkPressIn,
            onTalkPressOut: props.onTalkPressOut,
            onTalkSlide: props.onTalkSlide,
        }),
        [props.onTalkPressIn, props.onTalkPressOut, props.onTalkSlide],
    );
    const micTouch = useTalkTouchStream(talkWiring);
    /** The mic is open right now, latched by a tap or held under a finger. */
    const micLive = props.talkState === 'latched' || props.talkState === 'held';
    /**
     * The collapse is the PHONE's (DROVE-236). The desktop composer resolves
     * its own send/mic below and has no talk button, so both of these are false
     * there and its table is exactly what it was.
     */
    /**
     * The mic is drawn at all where this surface can dictate: a recogniser and
     * a wire to it. It no longer decides anything about SEND (DROVE-264); it
     * decides whether the mic button exists.
     *
     * The wire is now the touch stream rather than the tap (DROVE-269).
     * `talkButtonWiring` is null exactly when there is no `onTalkPressIn`, and
     * a press-in with no lift behind it would leave the mic open with no way to
     * close it, so a half-wired button is not drawn at all. The voice layer
     * hands all four out together off one `offersDictation`, so on the phone
     * this is the same condition it was.
     */
    const canDictateHere = compactMobileComposer && !!talkWiring;
    const primaryAction = resolveAgentInputPrimaryAction({
        hasComposerContent,
        isSendBlocked,
        isSendDisabled: props.isSendDisabled ?? false,
        showAbortButton: props.showAbortButton ?? false,
        canAbort: !!props.onAbort && !stopRequested,
    });
    const shouldShowStopButton = primaryAction === 'stop';
    const canSendMessage = primaryAction === 'send';
    /**
     * WHICH SURFACE EACH OF THE TWO WEARS (DROVE-254, DROVE-264).
     *
     * Two tables now, because they are two buttons. Clay: "the send button
     * shouldn't have a circle around it", and the mic's open-only disc from
     * DROVE-254 stands. Both are in composerControlColour.ts with the argument;
     * each is read from the same flags its glyph is drawn from, so a fill and a
     * glyph cannot disagree about which face this is.
     */
    const sendSurface = composerSendSurface({
        stop: shouldShowStopButton,
        blocked: isSendBlocked,
    });
    const micSurface = composerMicSurface({ live: micLive });
    /**
     * EACH CONTROL'S FILL, AS A VALUE RATHER THAN AS A STYLESHEET ENTRY
     * (DROVE-266).
     *
     * Clay, for the second time: "stop doing your custom buttons shouldn't they
     * just be smaller liquid glass buttons". They are `ComposerControlButton`
     * now, which is `GlassChromeButton` at the composer's size, so the fill is
     * spent as `UIGlassEffect.tintColor` on the button's own effect rather than
     * as a `backgroundColor` on a view wrapped round a Pressable. A prop takes a
     * colour, not a style, which is why these stop being `styles.*` entries.
     *
     * Every one of them is an OPAQUE hex and `composerGlassTint` refuses
     * anything else, which is how DROVE-254's measurement survives the control
     * becoming a real material rather than being replaced by a promise.
     */
    const composerDiscFill = theme.dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light;
    const composerDiscOpenFill = theme.dark ? COMPOSER_IN_FIELD_DISC_OPEN.dark : COMPOSER_IN_FIELD_DISC_OPEN.light;
    /**
     * The in-field send glyph: the accent once there is something to send, the
     * theme's neutral when there is not (DROVE-176). It no longer wears a
     * second identity on an empty field, because the waveform moved out to the
     * control row (DROVE-206), so the glyph that turns accent is the one thing
     * this colour has to say. Stop keeps its own colour and a blocked send
     * keeps the lock's grey; neither reads this.
     *
     * Only on the phone's glass composer. The desktop keeps its filled primary
     * disc, where the glyph is the button's tint and the FILL says active.
     *
     * Below `canSendMessage` on purpose: that IS "something to send", once the
     * primary action has been resolved.
     */
    const activeSendIconColor = compactMobileComposer
        ? primaryActionColour(composerPalette, canSendMessage)
        : theme.colors.button.primary.tint;
    const mobileCanPressSendButton = !isAborting && primaryAction !== 'idle';
    const desktopCanPressSendButton = !props.isSending
        && !props.isSendDisabled
        && (isSendBlocked
            ? hasComposerContent
            : hasComposerContent || !!props.onMicPress);
    const canPressSendButton = compactMobileComposer
        ? mobileCanPressSendButton
        : desktopCanPressSendButton;

    // A local acknowledgement avoids leaving Stop visible forever when the
    // session-status update arrives after the abort RPC has completed. The next
    // agent turn, or the eventual idle update, makes Stop eligible again.
    React.useEffect(() => {
        if (!props.showAbortButton) {
            setStopRequested(false);
        }
    }, [props.showAbortButton]);

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    // Web paste/drag — intercept image pastes and file drops for the
    // attachment feature. Both handlers funnel through props.onAddImages.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !props.onAddImages) return;

        const handlePaste = async (e: ClipboardEvent) => {
            // Only handle pastes targeted at a focused text-editable element.
            // The listener is attached to document, so without this guard a
            // paste in the URL bar, another modal, or any focused-elsewhere
            // input would steal images intended for somewhere else.
            const active = document.activeElement;
            const isEditableTarget = active instanceof HTMLInputElement
                || active instanceof HTMLTextAreaElement
                || (active instanceof HTMLElement && active.isContentEditable);
            if (!isEditableTarget) return;

            const { getImagesFromClipboard, fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const files = getImagesFromClipboard(e);
            if (!files.length) return;
            e.preventDefault();
            const previews = (await Promise.all(
                files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
            )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
            if (previews.length) {
                props.onAddImages!(previews.map((p) => ({
                    ...p,
                    id: `paste_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                })));
            }
        };

        // dragover must call preventDefault for drop to fire; we gate on
        // `types.includes('Files')` so we don't hijack drag-text/HTML in the
        // rest of the app.
        const isFileDrag = (e: DragEvent) => {
            const types = e.dataTransfer?.types;
            if (!types) return false;
            // DataTransferItemList vs DOMStringList — both expose .includes-ish.
            for (let i = 0; i < types.length; i++) {
                if (types[i] === 'Files') return true;
            }
            return false;
        };

        const handleDragOver = (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        };

        const handleDrop = async (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            const { getImagesFromDrop, fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const files = getImagesFromDrop(e);
            if (!files.length) return;
            const previews = (await Promise.all(
                files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
            )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
            if (previews.length) {
                props.onAddImages!(previews.map((p) => ({
                    ...p,
                    id: `drop_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                })));
            }
        };

        document.addEventListener('paste', handlePaste as any);
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        return () => {
            document.removeEventListener('paste', handlePaste as any);
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('drop', handleDrop);
        };
    }, [props.onAddImages]);

    // Autocomplete state — text + selection. Updated via startTransition so
    // typing renders the character immediately and the autocomplete pipeline
    // catches up on the next idle frame instead of blocking input.
    const [inputState, setInputState] = React.useState<TextInputState>(() => ({
        text: props.initialValue,
        selection: { start: props.initialValue.length, end: props.initialValue.length }
    }));

    const onActionAreaOffsetChange = props.onActionAreaOffsetChange;
    const handleActionAreaLayout = React.useCallback((event: LayoutChangeEvent) => {
        onActionAreaOffsetChange?.(CONTAINER_TOP_PADDING + event.nativeEvent.layout.y);
    }, [onActionAreaOffsetChange]);

    const onChangeTextProp = props.onChangeText;
    const handleTextChange = React.useCallback((text: string) => {
        React.startTransition(() => {
            setHasText(text.trim().length > 0);
        });
        onChangeTextProp?.(text);
    }, [onChangeTextProp]);

    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        React.startTransition(() => {
            setInputState(newState);
        });
    }, []);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Debug logging
    // React.useEffect(() => {
    //     console.log('🔍 Autocomplete Debug:', JSON.stringify({
    //         value: props.value,
    //         inputState,
    //         activeWord,
    //         suggestionsCount: suggestions.length,
    //         selected,
    //         prefixes: props.autocompletePrefixes
    //     }, null, 2));
    // }, [props.value, inputState, activeWord, suggestions.length, selected]);

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];

        // Apply the suggestion
        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            props.autocompletePrefixes,
            true // add space after
        );

        // Use imperative API to set text and selection
        inputRef.current.setTextAndSelection(result.text, {
            start: result.cursorPosition,
            end: result.cursorPosition
        });

        // console.log('Selected suggestion:', suggestion.text);

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // The compact composer's popups: the session sheet and the channel sheet
    // (DROVE-83), and the permission, model and effort pickers the session
    // sheet's rows open. Keep a single popup state so only one selection
    // surface is ever visible, including while we dismiss the keyboard on
    // mobile.
    /*
     * 'session' is gone (DROVE-111). It was DROVE-83's intermediate sheet,
     * three rows that opened the three pickers; Clay: "I don't like this
     * extra menu, then I have to click twice." The mode, the effort and the
     * model are three controls in the button row now and each opens its own
     * picker on the first tap.
     *
     * 'attach' is the plus (DROVE-128). It is in the union rather than a
     * flag of its own so that opening it closes a picker, and so it inherits
     * handlePickerPress's keyboard dance: a sheet that opens under a keyboard
     * that is still on its way out lands in the wrong place.
     *
     * 'effort' reaches here from a TAP ON THE SLIDER as well as from a plain
     * segment press (DROVE-229). It did not before: the slider's segment is a
     * raw responder, so a tap latched its own readout open and this toggle was
     * dead code for the one control Clay was tapping. Every composer picker
     * goes through this function now, which is what makes the second tap,
     * the tap outside and the back gesture one set of rules rather than four.
     *
     * The status row's two expanders are deliberately NOT here. They open
     * ComposerSheet from the row itself (DROVE-117's mechanism), and
     * that sheet's own click-away backdrop is what keeps them from stacking
     * with these pickers.
     */
    /*
     * The rules are composerPicker.ts and are specced there (DROVE-229); this
     * is the wiring. `pickerRef` mirrors the state so a listener and a timer
     * armed on an old render still reduce against what is true now.
     */
    const [picker, setPicker] = React.useState<ComposerPickerState>(composerPickerClosed);
    const openPicker = picker.open;
    /**
     * What the CONTROL reads as, which is not the same thing (DROVE-229).
     *
     * A deferred picker is owed for a few hundred milliseconds before it is
     * drawn. The control should look pressed for that whole time, or the tap
     * reads as dropped and the obvious next move is to tap again. The sheets
     * still key off `openPicker`; only the control's own state uses this.
     */
    const engagedPicker = picker.open ?? picker.opening;
    const pickerRef = React.useRef(picker);
    pickerRef.current = picker;
    const pickerKeyboardSubscriptionRef = React.useRef<ReturnType<typeof Keyboard.addListener> | null>(null);
    const pickerOpenTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const cancelPendingPickerOpen = React.useCallback(() => {
        pickerKeyboardSubscriptionRef.current?.remove();
        pickerKeyboardSubscriptionRef.current = null;
        if (pickerOpenTimerRef.current) {
            clearTimeout(pickerOpenTimerRef.current);
            pickerOpenTimerRef.current = null;
        }
    }, []);

    /** Land a step: the state, then whatever it asked the keyboard to do. */
    const applyPickerStep = React.useCallback((step: ComposerPickerStep) => {
        pickerRef.current = step.state;
        setPicker(step.state);
        // Whatever was armed goes, on every step: this one either no longer
        // owes a picker or owes a different one and re-arms below. Leaving the
        // old listener up is how a cancelled tap comes back as a sheet.
        cancelPendingPickerOpen();
        if (step.defer) {
            // A sheet that opens under a keyboard still on its way out lands in
            // the wrong place, so it waits — for the keyboard, or for the
            // fallback if the event never comes.
            const finishOpening = () => applyPickerStep(composerPickerKeyboardGone(pickerRef.current));
            pickerKeyboardSubscriptionRef.current = Keyboard.addListener('keyboardDidHide', finishOpening);
            pickerOpenTimerRef.current = setTimeout(finishOpening, PICKER_KEYBOARD_FALLBACK_MS);
        }
        if (step.dismissKeyboard) {
            inputRef.current?.blur();
            Keyboard.dismiss();
        }
    }, [cancelPendingPickerOpen]);

    const closePicker = React.useCallback(() => {
        applyPickerStep(composerPickerDismiss());
    }, [applyPickerStep]);

    React.useEffect(() => cancelPendingPickerOpen, [cancelPendingPickerOpen]);

    const handlePickerPress = React.useCallback((kind: ComposerPickerKind) => {
        hapticsLight();
        applyPickerStep(composerPickerPress(pickerRef.current, kind, {
            // Web has no keyboard to get out of the way of.
            keyboardVisible: Platform.OS !== 'web' && Keyboard.isVisible(),
        }));
    }, [applyPickerStep]);

    const handleSettingsPress = React.useCallback(() => {
        handlePickerPress('permission');
    }, [handlePickerPress]);

    /*
     * The Add context sheet (DROVE-128). A tile with no handler behind it is
     * not drawn rather than drawn dead: a rig that cannot take attachments at
     * all leaves SessionView passing none of the three, and then the plus
     * itself is gone, exactly as it was before this sheet existed.
     */
    const addContextAvailable = React.useMemo(() => ({
        camera: !!props.onTakePhoto,
        photos: !!props.onPickImages,
        files: !!props.onPickFiles,
    }), [props.onPickFiles, props.onPickImages, props.onTakePhoto]);
    const canAddContext = addContextAvailable.camera
        || addContextAvailable.photos
        || addContextAvailable.files;
    const handleAddContextPress = React.useCallback(() => {
        handlePickerPress('attach');
    }, [handlePickerPress]);
    const handleAddContextSelect = React.useCallback((source: AddContextSource) => {
        if (source === 'camera') props.onTakePhoto?.();
        else if (source === 'photos') props.onPickImages?.();
        else props.onPickFiles?.();
    }, [props.onPickFiles, props.onPickImages, props.onTakePhoto]);

    // Mode, effort and model each open their own picker, straight from the
    // button row, never an intermediate menu (DROVE-111). All three are
    // segments of the one capsule again since DROVE-178, so this is the only
    // route to a picker from the row.
    const handleSessionControlPress = React.useCallback((picker: ComposerSessionPicker) => {
        handlePickerPress(picker);
    }, [handlePickerPress]);

    // Long-press on the primary button opens the channel sheet (DROVE-72):
    // the mode picker and the three channel switches, with DROVE-30's
    // read-aloud switch kept inside the audio channel. DROVE-83 put audio
    // here first because the sheet did not exist yet; the long-press stays as
    // the shortcut and the sheet is DroverChannelsSheet.
    const handleChannelsLongPress = React.useCallback(() => {
        handlePickerPress('channels');
    }, [handlePickerPress]);

    // Handle settings selection
    const handleSettingsSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        closePicker();
    }, [closePicker, props.onPermissionModeChange]);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;

        hapticsError();
        setStopRequested(true);
        setIsAborting(true);
        const startTime = Date.now();

        try {
            await props.onAbort?.();

            // Ensure minimum 300ms loading time
            const elapsed = Date.now() - startTime;
            if (elapsed < 300) {
                await new Promise(resolve => setTimeout(resolve, 300 - elapsed));
            }
        } catch (error) {
            // Shake on error
            setStopRequested(false);
            shakerRef.current?.shake();
            console.error('Abort RPC call failed:', error);
        } finally {
            setIsAborting(false);
        }
    }, [props.onAbort]);

    const handleBlockedSendAttempt = React.useCallback(() => {
        if (!isSendBlocked || !hasText || props.isSending) return;
        hapticsError();
        sendBlockShakerRef.current?.shake();
    }, [hasText, isSendBlocked, props.isSending]);

    const handleSendPress = React.useCallback(() => {
        if (isSendBlocked) {
            handleBlockedSendAttempt();
            return;
        }
        if (props.isSendDisabled || (!compactMobileComposer && props.isSending)) return;

        hapticsLight();
        // Live read avoids stalling behind the transitioned `hasText`.
        const liveHasText = (inputRef.current?.getText() ?? '').trim().length > 0;
        if (liveHasText || hasImages) {
            setStopRequested(false);
            props.onSend();
        } else if (!compactMobileComposer) {
            props.onMicPress?.();
        }
    }, [compactMobileComposer, handleBlockedSendAttempt, hasImages, isSendBlocked, props.isSendDisabled, props.isSending, props.onMicPress, props.onSend]);

    const handleMicrophonePress = React.useCallback(() => {
        if (!props.onMicPress || props.isSendDisabled) return;
        hapticsLight();
        props.onMicPress();
    }, [props.isSendDisabled, props.onMicPress]);

    // Stop and send share one button, so which one fires is resolved from the
    // live text rather than from `hasText`, which is set in a transition and
    // lags a fast type-then-tap. Without the live read that tap would abort
    // the agent instead of sending what was just typed. Boss mode used to be
    // a third answer here and is a control of its own on the row now
    // (DROVE-206). The tap / long-press split is resolveComposerPrimaryPress
    // (DROVE-98), one table for both handlers.
    const dispatchPrimaryGesture = React.useCallback((gesture: ComposerPrimaryGesture) => {
        const liveHasContent = (inputRef.current?.getText() ?? '').trim().length > 0 || hasImages;
        const dispatch = resolveComposerPrimaryPress({
            gesture,
            action: primaryAction,
            liveHasContent,
            canPress: canPressSendButton,
        });
        switch (dispatch) {
            case 'abort':
                handleAbortPress();
                return;
            case 'channels':
                handleChannelsLongPress();
                return;
            case 'send':
                handleSendPress();
                return;
            // `mic` is gone from this table (DROVE-264). The microphone is its
            // own button with its own press, `handleMobileMicPress` above.
            case 'none':
                return;
        }
    }, [
        canPressSendButton,
        handleAbortPress,
        handleChannelsLongPress,
        handleMicrophonePress,
        handleSendPress,
        hasImages,
        primaryAction,
    ]);
    /*
     * `handleMobileMicPress` stood here and is gone (DROVE-269).
     *
     * DROVE-264 gave the mic a plain `onPress` straight to `onTalkTap`, with a
     * haptic of its own in front of it. Both are wrong for a button with a
     * touch stream: the gesture reducer is fed press-in and press-out now, and
     * it names its own haptics -- one on the open, one on each crossing, one on
     * the lift -- so a `hapticsLight` here was a second tick on top of the
     * first. `onTalkTap` remains the entry for controls that genuinely have no
     * touch stream: the headphone mic press, the lock screen, the watch.
     * Same reducer, same capture, so a latch opened by ear is still stopped by
     * thumb (DROVE-210).
     */
    const handleMobilePrimaryPress = React.useCallback(() => dispatchPrimaryGesture('press'), [dispatchPrimaryGesture]);
    const handleMobilePrimaryLongPress = React.useCallback(() => dispatchPrimaryGesture('longPress'), [dispatchPrimaryGesture]);

    // The stream-talk button (DROVE-98): the speaker DROVE-83 took off the
    // composer, back as a one-tap shortcut to the same local key the channel
    // sheet row and Settings > Voice flip. A tick and a one-line toast, so the
    // change is felt as well as seen.
    /**
     * ONE AUDIO-OUT BUTTON where the waveform and the speaker used to be
     * (DROVE-236). What it draws is `composerAudioOut.ts`; what a gesture on it
     * MEANS is the transport table in the voice layer.
     */
    const audioOut = audioOutButton({
        readAloudEnabled: props.onAudioOutPress ? props.readAloudEnabled : undefined,
        paused: props.readAloudPaused === true,
        bossActive: props.bossModeActive === true,
    });
    const [composerToast, setComposerToast] = React.useState<string | null>(null);
    const composerToastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const showComposerToast = React.useCallback((text: string) => {
        if (composerToastTimer.current) clearTimeout(composerToastTimer.current);
        setComposerToast(text);
        composerToastTimer.current = setTimeout(() => {
            composerToastTimer.current = null;
            setComposerToast(null);
        }, 1400);
    }, []);
    React.useEffect(() => () => {
        if (composerToastTimer.current) clearTimeout(composerToastTimer.current);
    }, []);
    // Turning reading on is the moment the sentence tap starts working, so it
    // is the moment to say the gesture exists (DROVE-195). Until he has used
    // it once; after that the toast is the plain line again.
    const sentenceTapUsed = useLocalSetting('sentenceTapUsed');
    /**
     * The tap: start, stop, or RESUME (DROVE-327).
     *
     * Clay: "if it's paused and I single tap it should unpause not end the
     * reading." The voice layer has already done it and says which; this only
     * announces it. It used to flip the switch here and toast the flip, which
     * on a paused reader announced "off" and meant it.
     */
    const handleAudioOutPress = React.useCallback(() => {
        if (!props.onAudioOutPress) return;
        const effect = props.onAudioOutPress();
        const toast = audioOutToast(effect, sentenceTapUsed);
        if (toast === null) return;
        hapticsLight();
        showComposerToast(t(toast));
    }, [props.onAudioOutPress, sentenceTapUsed, showComposerToast]);
    /**
     * The long press: pause, off, or boss mode (DROVE-233, DROVE-236,
     * DROVE-327).
     *
     * Clay: "if you long press the read back it goes into pause so when you
     * resume it goes back to where it was reading", "long press for boss
     * mode", and then "To go into pause though you hold it in." The hold is
     * the second gesture on the same control, which is the pattern the send
     * button already uses (resolveComposerPrimaryPress); from paused it is the
     * way OUT, because the tap is the resume.
     *
     * The decision is `transportEffect`'s, over in the voice layer beside the
     * headphone and lock-screen presses, so the three surfaces cannot come to
     * mean different things. What comes back is the effect it chose, already
     * applied where the voice layer could apply it.
     */
    const handleAudioOutLongPress = React.useCallback(() => {
        if (!props.onAudioOutLongPress) return;
        const effect = props.onAudioOutLongPress();
        // BOSS MODE IS THE COMPOSER'S HALF (DROVE-236). The table names it and
        // the handler that owns the call performs it. Where there is no call to
        // start the press is simply not answered, which is an embedded chat or
        // one already in a call, both of which withdraw `onMicPress`. It does
        // not fall back to a pause: read-aloud is off in that cell, so there is
        // no place being held to pause.
        if (effect === 'boss-mode') {
            if (!props.onMicPress) return;
            handleMicrophonePress();
            return;
        }
        const toast = audioOutToast(effect, sentenceTapUsed);
        if (toast === null) return;
        hapticsLight();
        showComposerToast(t(toast));
    }, [handleMicrophonePress, props.onAudioOutLongPress, props.onMicPress, sentenceTapUsed, showComposerToast]);

    const permissionTitle = isCodex
        ? t('agentInput.codexPermissionMode.title')
        : isGemini
            ? t('agentInput.geminiPermissionMode.title')
            : t('agentInput.permissionMode.title');

    // What the session pill reads and what its sheet lists (DROVE-83). A
    // session started in a mode this build no longer offers has no mode word;
    // the pill drops that segment and the sheet row shows the picker instead
    // of inventing a word for a state we cannot name.
    const sessionPillLabel = React.useMemo(() => buildSessionPillLabel({
        modeLabel: permissionShortLabel,
        model: props.modelMode,
        effortLabel,
    }), [effortLabel, permissionShortLabel, props.modelMode]);
    /**
     * The scale the DIAL and the SLIDER share (DROVE-200).
     *
     * `availableEffortLevels` is the picker's list, which appends the levels
     * this model cannot reach as disabled rows so the sheet can say why
     * (DROVE-101). Neither the needle nor the line may count those: the ticket
     * asks for the current model's REAL ends, and a needle drawn 3 of 6 on a
     * model whose ceiling is the fourth stop is the same lie the bar meter
     * told. So both read the reachable run.
     */
    const effortScale = React.useMemo(
        () => effortSliderScaleFromLevels(availableEffortLevels),
        [availableEffortLevels],
    );
    // Where this effort sits on the scale the current model offers, for the
    // meter on the session control. A level that is on the sheet but not on
    // the reachable run — the disabled row DROVE-101 draws — reads as the
    // ceiling rather than dropping the segment off the row entirely.
    const effortIndex = React.useMemo(() => {
        if (!props.effortLevel) return -1;
        const found = effortScale.keys.indexOf(props.effortLevel.key);
        if (found >= 0) return found;
        return effortScale.keys.length > 0 ? effortScale.keys.length - 1 : -1;
    }, [effortScale, props.effortLevel]);
    /*
     * THE EFFORT DRAG IS GONE (DROVE-242). The segment was a raw JS responder
     * that raised a readout above the row on touch-DOWN and slid along it.
     * Clay, with a screenshot of that readout over his field: "Why does it
     * show the old shitty slider when I hold down effort?" So effort presses
     * like the mode and the model: one press, `handleSessionControlPress`, the
     * same sheet. `useEffortSlider`, `EffortSliderPopover` and the layer that
     * placed it are deleted; effortSlider.ts keeps the SCALE above, which the
     * dial and the sheet both read and always did.
     */

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (event.key === 'ArrowUp') {
                moveUp();
                return true;
            } else if (event.key === 'ArrowDown') {
                moveDown();
                return true;
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                // Both Enter and Tab select the current suggestion
                // If none selected (selected === -1), select the first one
                const indexToSelect = selected >= 0 ? selected : 0;
                handleSuggestionSelect(indexToSelect);
                return true;
            } else if (event.key === 'Escape') {
                // Clear suggestions by collapsing selection (triggers activeWord to clear)
                if (inputRef.current) {
                    const cursorPos = inputState.selection.start;
                    inputRef.current.setTextAndSelection(inputState.text, {
                        start: cursorPos,
                        end: cursorPos
                    });
                }
                return true;
            }
        }

        // Handle Escape for abort when no suggestions are visible
        if (event.key === 'Escape' && props.showAbortButton && props.onAbort && !isAborting) {
            handleAbortPress();
            return true;
        }

        // Original key handling
        if (Platform.OS === 'web') {
            // On mobile web (touch devices), Enter should insert a newline since
            // there's no Shift key available. Users send via the send button instead.
            // Use pointer:coarse media query instead of ontouchstart/maxTouchPoints
            // to avoid false positives on Windows touch-screen laptops with keyboards.
            const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
            if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey && !isTouchDevice) {
                // Read live text from the textarea — `hasText` is debounced via
                // startTransition and would lag behind a quick type-then-Enter.
                const liveText = inputRef.current?.getText() ?? '';
                if (liveText.trim()) {
                    if (isSendBlocked) {
                        handleBlockedSendAttempt();
                    } else if (!props.isSendDisabled) {
                        props.onSend();
                    }
                    return true; // Key was handled
                }
            }
            // Handle Shift+Tab for permission mode switching
            if (event.key === 'Tab' && event.shiftKey && props.onPermissionModeChange && availableModes.length > 0) {
                const currentIndex = availableModes.findIndex((mode) => mode.key === permissionModeKey);
                const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + 1) % availableModes.length;
                props.onPermissionModeChange(availableModes[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }

        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, agentInputEnterToSend, props.onSend, props.onPermissionModeChange, availableModes, permissionModeKey, isSendBlocked, handleBlockedSendAttempt, props.isSendDisabled]);

    const desktopActionControls = (
        <View style={styles.actionButtonsContainer}>
            <View style={{ flexDirection: 'column', flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    {props.zenMode && <View style={{ flex: 1 }} />}
                    {!props.zenMode && <View style={styles.actionButtonsLeft}>
                        {props.onPermissionModeChange && (
                            /* The gear opens the settings sheet, on every
                               platform (DROVE-242). iOS anchored a SwiftUI
                               menu here instead, which is the same split the
                               capsule had on the phone. */
                            <Pressable
                                onPress={handleSettingsPress}
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                    paddingHorizontal: 8,
                                    paddingVertical: 6,
                                    justifyContent: 'center',
                                    height: 32,
                                    opacity: p.pressed ? 0.7 : 1,
                                })}
                            >
                                <Octicons name="gear" size={16} color={theme.colors.button.secondary.tint} />
                            </Pressable>
                        )}

                        {props.agentType && props.onAgentClick && (
                            <Pressable
                                onPress={() => {
                                    hapticsLight();
                                    props.onAgentClick?.();
                                }}
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                    paddingHorizontal: 10,
                                    paddingVertical: 6,
                                    justifyContent: 'center',
                                    height: 32,
                                    opacity: p.pressed ? 0.7 : 1,
                                    gap: 6,
                                })}
                            >
                                <Octicons name="cpu" size={14} color={theme.colors.button.secondary.tint} />
                                <Text style={{
                                    fontSize: 13,
                                    color: theme.colors.button.secondary.tint,
                                    fontWeight: '600',
                                    ...Typography.default('semiBold'),
                                }}>
                                    {props.agentType === 'claude'
                                        ? t('agentInput.agent.claude')
                                        : props.agentType === 'codex'
                                            ? t('agentInput.agent.codex')
                                            : props.agentType === 'openclaw'
                                                ? t('agentInput.agent.openclaw')
                                                : t('agentInput.agent.gemini')}
                                </Text>
                            </Pressable>
                        )}

                        {props.onAbort && (
                            <Shaker ref={shakerRef}>
                                <Pressable
                                    style={(p) => ({
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        borderRadius: Platform.select({ default: 16, android: 20 }),
                                        paddingHorizontal: 8,
                                        paddingVertical: 6,
                                        justifyContent: 'center',
                                        height: 32,
                                        opacity: p.pressed ? 0.7 : 1,
                                    })}
                                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                    onPress={handleAbortPress}
                                    disabled={isAborting}
                                >
                                    {isAborting ? (
                                        <ActivityIndicator size="small" color={theme.colors.button.secondary.tint} />
                                    ) : (
                                        <Octicons name="stop" size={16} color={theme.colors.button.secondary.tint} />
                                    )}
                                </Pressable>
                            </Shaker>
                        )}

                        <GitStatusButton sessionId={props.sessionId} onPress={props.onFileViewerPress} />

                        {props.onPickImages && (
                            <Pressable
                                onPress={props.onPickImages}
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                    paddingHorizontal: 8,
                                    paddingVertical: 6,
                                    justifyContent: 'center',
                                    height: 32,
                                    opacity: p.pressed ? 0.7 : 1,
                                })}
                            >
                                <Ionicons
                                    name="image-outline"
                                    size={16}
                                    color={(props.selectedImages?.length ?? 0) > 0
                                        ? theme.colors.radio.active
                                        : theme.colors.button.secondary.tint}
                                />
                            </Pressable>
                        )}
                    </View>}

                    <View
                        style={[
                            styles.sendButton,
                            isSendBlocked
                                ? styles.sendButtonLocked
                                : (hasText || props.isSending || (props.onMicPress && !props.isMicActive))
                                    ? styles.sendButtonActive
                                    : styles.sendButtonInactive,
                        ]}
                    >
                        <Pressable
                            style={(p) => ({
                                width: '100%',
                                height: '100%',
                                alignItems: 'center',
                                justifyContent: 'center',
                                opacity: p.pressed ? 0.7 : 1,
                            })}
                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                            onPress={handleSendPress}
                            disabled={!desktopCanPressSendButton}
                        >
                            {props.isSending ? (
                                <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                            ) : isSendBlocked ? (
                                <Ionicons name="lock-closed" size={15} color={theme.colors.textSecondary} />
                            ) : hasText ? (
                                <Octicons
                                    name="arrow-up"
                                    size={16}
                                    color={theme.colors.button.primary.tint}
                                    style={[styles.sendButtonIcon, { marginTop: Platform.OS === 'web' ? 2 : 0 }]}
                                />
                            ) : props.onMicPress && !props.isMicActive ? (
                                <Image
                                    source={require('@/assets/images/icon-voice-white.png')}
                                    style={{ width: 24, height: 24 }}
                                    tintColor={theme.colors.button.primary.tint}
                                />
                            ) : (
                                <Octicons
                                    name="arrow-up"
                                    size={16}
                                    color={theme.colors.button.primary.tint}
                                    style={[styles.sendButtonIcon, { marginTop: Platform.OS === 'web' ? 2 : 0 }]}
                                />
                            )}
                        </Pressable>
                    </View>
                </View>
            </View>
        </View>
    );

    /*
     * A PICKER ROW IS A RADIO, TO VOICEOVER AS WELL (DROVE-242).
     *
     * The mark is a dot in a ring, which is the same mark all four composer
     * sheets use and is why they read as one thing. Sighted, that says which
     * choice is current. It is a plain `View`, so it said nothing at all to
     * VoiceOver, where a SwiftUI `Menu` marked its selected row for free.
     * Converting mode and model to sheets would have quietly dropped that, so
     * the role and the checked state are on every row here instead. The effort
     * rows DROVE-229 wrote get them too, since half a fix is a new split.
     */
    const renderDesktopPickerOption = (
        key: string,
        selected: boolean,
        label: string,
        description: string | null | undefined,
        onPress: () => void,
        disabled?: boolean,
    ) => (
        <Pressable
            key={key}
            onPress={disabled ? undefined : onPress}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityHint={description ?? undefined}
            accessibilityState={{ checked: selected, disabled: !!disabled }}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'flex-start',
                paddingHorizontal: 16,
                paddingVertical: 8,
                opacity: disabled ? 0.45 : 1,
                backgroundColor: pressed && !disabled ? theme.colors.surfacePressed : 'transparent',
            })}
        >
            <View style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                borderWidth: 2,
                borderColor: selected ? theme.colors.radio.active : theme.colors.radio.inactive,
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: 12,
                marginTop: 2,
            }}>
                {selected && <View style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: theme.colors.radio.dot,
                }} />}
            </View>
            <View style={{ flex: 1 }}>
                <Text style={{
                    fontSize: 14,
                    color: selected ? theme.colors.radio.active : theme.colors.text,
                    ...Typography.default(),
                }}>
                    {label}
                </Text>
                {!!description && (
                    <Text style={{
                        fontSize: 11,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}>
                        {description}
                    </Text>
                )}
            </View>
        </Pressable>
    );

    /*
     * WHICH SHEET IS UP, from the picker and the width alone (DROVE-242).
     *
     * Three booleans used to work this out inline, and each carried its own
     * platform test, which is how iOS ended up with two of the five pickers on
     * a surface neither the placement rule nor the dismissal state machine
     * reached. The rule is `composerPickerSheetOpen` in composerPicker.ts now,
     * beside the state machine it belongs to, and it is specced there.
     */
    const openSheet = composerPickerSheetOpen({
        open: openPicker,
        compact: compactMobileComposer,
        hasEffortLevels: availableEffortLevels.length > 0 && !!props.onEffortLevelChange,
    });
    // The desktop picker is on the same sheet as the phone's (DROVE-147).
    // It used to be its own floating card anchored above the composer, which
    // is the shape Clay has now asked three times to stop seeing.
    const desktopPickerOpen = openSheet === 'settings';
    const desktopSettingsOverlay = (
        <ComposerSheet
            open={desktopPickerOpen}
            onClose={closePicker}
            keyboardShouldPersistTaps="always"
        >
            {desktopPickerOpen && (
                <>
                    <View style={styles.overlaySection}>
                        <Text style={styles.overlaySectionTitle}>
                            {isCodex
                                ? t('agentInput.codexPermissionMode.title')
                                : isGemini
                                    ? t('agentInput.geminiPermissionMode.title')
                                    : t('agentInput.permissionMode.title')}
                        </Text>
                        {availableModes.map((mode) => renderDesktopPickerOption(
                            mode.key,
                            permissionModeKey === mode.key,
                            withSandboxSuffix(mode.name, mode.key),
                            mode.description,
                            () => handleSettingsSelect(mode),
                        ))}
                    </View>

                    <View style={{ height: 1, backgroundColor: theme.colors.divider, marginHorizontal: 16 }} />

                    <View style={{ flexDirection: 'row' }}>
                        <View style={{ paddingVertical: 8, flex: 1 }}>
                            <Text style={{
                                fontSize: 12,
                                fontWeight: '600',
                                color: theme.colors.textSecondary,
                                paddingHorizontal: 16,
                                paddingBottom: 4,
                                ...Typography.default('semiBold'),
                            }}>
                                {t('agentInput.model.title')}
                            </Text>
                            {availableModels.length > 0 ? availableModels.map((model) => renderDesktopPickerOption(
                                model.key,
                                props.modelMode?.key === model.key,
                                model.name,
                                model.description,
                                () => {
                                    hapticsLight();
                                    props.onModelModeChange?.(model);
                                    closePicker();
                                },
                            )) : (
                                <Text style={{
                                    fontSize: 13,
                                    color: theme.colors.textSecondary,
                                    paddingHorizontal: 16,
                                    paddingVertical: 8,
                                    ...Typography.default(),
                                }}>
                                    {t('agentInput.model.configureInCli')}
                                </Text>
                            )}
                        </View>

                        {availableEffortLevels.length > 0 && props.onEffortLevelChange && (
                            <>
                                <View style={{ width: 1, backgroundColor: theme.colors.divider, marginVertical: 8 }} />
                                <View style={{ paddingVertical: 8, flex: 1 }}>
                                    <Text style={{
                                        fontSize: 12,
                                        fontWeight: '600',
                                        color: theme.colors.textSecondary,
                                        paddingHorizontal: 16,
                                        paddingBottom: 4,
                                        ...Typography.default('semiBold'),
                                    }}>
                                        {t('agentInput.effort.title')}
                                    </Text>
                                    {availableEffortLevels.map((level) => renderDesktopPickerOption(
                                        level.key,
                                        props.effortLevel?.key === level.key,
                                        level.name,
                                        level.description,
                                        () => {
                                            hapticsLight();
                                            props.onEffortLevelChange?.(level);
                                            closePicker();
                                        },
                                        level.disabled,
                                    ))}
                                </View>
                            </>
                        )}
                    </View>
                </>
            )}
        </ComposerSheet>
    );

    /*
     * Channels and Add context have sheets of their own; what is left of the
     * picker is the three session controls, and all three slide up on this one
     * (DROVE-242). Mode and model reach it on iOS for the first time here: the
     * rows below were already written and Android already drew them, but on the
     * phone Clay holds, a native menu was intercepting the press.
     *
     * A SHEET WITH NOTHING IN IT DOES NOT OPEN (DROVE-229), which is the
     * `hasEffortLevels` half of the call above.
     */
    const mobilePickerOpen = openSheet === 'list';


    /** Whether the `+` is there to be drawn, which is what the field's leading padding turns on. */
    const showMobileAddButton = compactMobileComposer && !props.zenMode && canAddContext;

    /**
     * THE `+`, a DISC at the leading end of the bubble's button row
     * (DROVE-206, DROVE-214).
     *
     * Clay, settling three passes of argument in one sentence: "the plus to
     * add images and stuff should be a circle just like on the right hand side
     * send button." So it is the same object as send, drawn at the other end
     * of the same row: identical geometry, identical resting surface, no
     * mirrored offsets between them.
     *
     * WHY A DISC AND NOT A BARE GLYPH. A disc nests inside the shape that
     * holds it, so its clearance is even everywhere rather than at a handful
     * of points; a bare glyph has that at no offset, which is why every
     * attempt to place one by arithmetic looked wrong however exactly the
     * numbers matched. That is a reason to draw a circle, not a number to
     * compute, and the row places it now.
     *
     * DROVE-206 ARGUED AGAINST THIS FILL and the argument does not survive.
     * It said the fill was already the OPEN state so spending it at rest would
     * leave the sheet nothing to show. But send has carried a resting fill and
     * a distinct live one all along, so a control can plainly have both: open
     * steps to `mobileIconButtonOpen`, a different surface from the resting
     * disc, and reads as held down exactly as it did. It also said a filled
     * disc would put the accent on a backdrop nothing had measured. There is
     * no accent on it any more, which is the other half of this.
     *
     * THE GLYPH IS THE FOREGROUND, which settles the exception DROVE-215 left
     * open for this lane. That file took the colour off the control row and
     * wrote that the `+` "keeps its accent... DROVE-214 owns that pair". Under
     * its own rule the `+` never qualifies: it holds no value and is never one
     * press from the app doing something, it is simply always available, and a
     * colour that is always on carries nothing. Clay has asked twice for no
     * coloured icons. The blue goes, and the accent at the other rim gets its
     * meaning back: an empty composer is two white glyphs on two identical
     * discs, and blue appears only when there is something to send.
     *
     * It opens the Add context sheet (DROVE-128) rather than jumping into the
     * photo library. 36 drawn plus 6 a side is a 48pt target, over DROVE-153's
     * 44pt floor, which is the same bargain the send button strikes.
     */
    const mobileAddAction = (
        <ComposerControlButton
            // The same disc the send button wears at rest, so the two ends of
            // the row are one object (DROVE-214). Open still steps off it, so
            // the held-down read survives the control having a resting fill.
            //
            // It is a `GlassChromeButton` now (DROVE-266): the press is UIKit's
            // own deformation on the button's own effect, not a `withSpring`
            // scale and a 0.7 fade drawn to look like one.
            fill={engagedPicker === 'attach' ? composerDiscOpenFill : composerDiscFill}
            onPress={handleAddContextPress}
            accessibilityRole="button"
            accessibilityLabel={t('imageUpload.addContextTitle')}
            accessibilityState={{ expanded: engagedPicker === 'attach' }}
        >
            <Ionicons
                name="add"
                size={MOBILE_COMPOSER_METRICS.addIconSize}
                // THE FOREGROUND, and this is DROVE-215's exception being
                // settled rather than a new ruling (DROVE-214). That file left
                // the `+` its accent and said the pair was this lane's to
                // decide. The `+` holds no state and is never one press from
                // anything: it is always available, which under DROVE-215 is
                // exactly the case that does NOT earn a colour. Clay has asked
                // twice for no coloured icons. So the blue goes, and what it
                // buys is that the accent still means something at the other
                // rim: on an empty composer both ends are a white glyph on the
                // same disc, and the blue appears only when there is something
                // to send.
                color={composerGlyphColour(composerPalette)}
            />
        </ComposerControlButton>
    );

    /**
     * THE SEND BUTTON, inside the bubble at the trailing end of its button row
     * (DROVE-153, DROVE-206, moved out of the field in DROVE-214).
     *
     * Clay: "we should have a send button, proper button." It used to turn
     * into the waveform on an empty composer, so the same spot did two
     * unrelated things depending on what you had typed. The waveform is folded
     * into the audio button two places along this same row now (DROVE-236),
     * and this is a send button with three things it can also be: Stop, on an
     * empty composer while the agent works, the lock when the gate refuses,
     * and the microphone, which is dictation filling THIS composer rather than
     * an unrelated second identity. The first two are still send unable to
     * proceed; the third has its own table in `agentInputPrimaryAction.ts`.
     *
     * DROVE-206 made this the CONTROL. DROVE-214 made it the GLYPH: it drew a
     * bare up-arrow, which is the submit affordance a field uses when it has
     * no send button, and DROVE-236 draws the flat arrowhead Clay sent a crop
     * of.
     *
     * On an empty composer it is DRAWN AND DISABLED. It is not hidden, because
     * a control that came and went would make the row twitch every time Stop
     * borrowed the slot. The reasoning is in full on `AgentInputPrimaryAction`.
     *
     * NOT PINNED TO ANYTHING ANY MORE (DROVE-214). It used to be
     * `position: absolute` against the bottom of the text's own row, which is
     * the row that grows, so a wrapped message dragged it down the side of a
     * tall capsule. It is on a row that cannot grow, at that row's trailing
     * end, centred in it.
     *
     * AND ITS SURFACE IS A TABLE, NOT A TERNARY (DROVE-254). Clay: "No circle
     * on this icon unless pressed as mic." So the mic face at rest is a bare
     * glyph on the bubble and gains a disc the moment the mic is open. Every
     * face and the argument for it, including why the `+` and send keep theirs,
     * is on `composerPrimarySurface` in composerControlColour.ts.
     */
    const mobilePrimaryAction = (
        <Shaker ref={shakerRef}>
            <ComposerControlButton
                // THREE FACES NOW, AND TWO OF THEM ARE THE SAME (DROVE-264).
                //
                // Clay: "the send button shouldn't have a circle around it." So
                // there is no resting fill at all, with something to send or
                // without — the GLYPH carries that, and always has (DROVE-214,
                // DROVE-215). No fill means no glass button of its own either
                // (DROVE-266): a bare glyph stands on the bubble's own
                // interactive glass and the platform draws its press from
                // there, where giving it a surface would be putting back the
                // circle Clay removed.
                //
                // Stop is checked first, because a blank composer on a
                // non-steerable agent is both blocked and abortable and must
                // not look locked; the gate's lock keeps its surface, because a
                // lock with no surface reads as decoration rather than as a
                // button refusing. Both of those faces ARE glass buttons.
                //
                // The mic is not one of these faces any more. It is its own
                // button, immediately to the left. `composerSendSurface` holds
                // the table and the argument.
                fill={sendSurface === 'stop'
                    ? (theme.dark ? '#F5F5F5' : theme.colors.button.primary.background)
                    : sendSurface === 'locked' ? theme.colors.surfaceHigh : undefined}
                // The lock keeps its hairline, which is the one composer
                // surface that has ever wanted one: it is a REFUSAL drawn on a
                // near-surface fill, so the edge is what makes it a shape at
                // all rather than a second answer to a separation the fill
                // already gives (DROVE-254's rule, and its stated exception).
                style={sendSurface === 'locked'
                    ? { borderWidth: 1, borderColor: theme.colors.divider }
                    : undefined}
                onPress={handleMobilePrimaryPress}
                // Long-press: the channel sheet (DROVE-83).
                onLongPress={handleMobilePrimaryLongPress}
                disabled={!canPressSendButton}
                accessibilityRole="button"
                // It is a send button (DROVE-206). Stop is the one face that is
                // genuinely another action, and it only appears on an empty
                // composer while the agent is working.
                accessibilityLabel={shouldShowStopButton ? 'Stop' : 'Send'}
                accessibilityState={{ disabled: !canPressSendButton }}
            >
                    {isAborting ? (
                        <ActivityIndicator
                            size="small"
                            color={shouldShowStopButton && theme.dark ? '#000000' : activeSendIconColor}
                        />
                    ) : shouldShowStopButton ? (
                        <Octicons
                            name="stop"
                            size={16}
                            color={theme.dark ? '#000000' : '#FFFFFF'}
                        />
                    ) : isSendBlocked ? (
                        <Ionicons
                            name="lock-closed"
                            size={14}
                            color={theme.colors.textSecondary}
                        />
                    ) : (
                        // A FLAT ARROWHEAD, not a tilted plane (DROVE-236).
                        // Clay, with a reference crop: "Shouldn't send look
                        // more like this?" The crop is the solid,
                        // right-pointing dart Slack and Telegram draw, level
                        // rather than pitched up at 45 degrees. Ionicons ships
                        // exactly it as `send`, so this costs no asset either.
                        //
                        // DROVE-214's argument survives the swap: an up-arrow
                        // is what a chat field submits with when it has no send
                        // button, a send button carries a send glyph, and this
                        // is one. It is now the only thing this slot ever
                        // draws apart from Stop and the lock (DROVE-264), which
                        // is what makes "a paper plane means a press sends" a
                        // property of the tree rather than of an ordering.
                        //
                        // Sized by ink rather than by the number it replaces,
                        // and by the LONGEST ink span rather than the x one.
                        // `send` is 0.936807 of its em wide and 0.811523 tall;
                        // `paper-plane` was square in its bounds so DROVE-214
                        // never had to choose. 17.35 here and 26 at the other
                        // rim draw the same 16.25pt box of ink, so neither rim
                        // out-weighs the other.
                        <Ionicons
                            name="send"
                            size={MOBILE_COMPOSER_LAYOUT.sendIconSize}
                            color={canPressSendButton ? activeSendIconColor : theme.colors.textSecondary}
                            // The color has to travel in `style`, not just the
                            // `color` prop: @expo/vector-icons builds
                            // `[styleDefaults, style, ...]` (create-icon-set.js),
                            // so a `style` entry always wins over `color`. With
                            // styles.sendButtonIcon here — it hardcodes the
                            // primary tint (white) — the computed color was
                            // discarded and the glyph painted white on the
                            // near-white glass composer, i.e. invisible.
                            //
                            // No vertical nudge any more. The web `marginTop:
                            // 2` was propping up Octicons `arrow-up`, whose
                            // ink centre sits 0.0255em over its line box's;
                            // `paper-plane`'s sits 0.0005em over, which is a
                            // hundredth of a point at this size (DROVE-214).
                            style={{
                                color: canPressSendButton ? activeSendIconColor : theme.colors.textSecondary,
                            }}
                        />
                )}
            </ComposerControlButton>
        </Shaker>
    );

    /**
     * THE MICROPHONE, ITS OWN BUTTON AGAIN, IMMEDIATELY LEFT OF SEND
     * (DROVE-264, reversing DROVE-236's collapse).
     *
     * Clay: "I don't think we should combine the send and the microphone button
     * because I might wanna type some stuff and then hit the microphone and
     * then say some stuff." A single morphing slot cannot draw that: reaching
     * the mic means the send affordance has to go. Both are here at once now,
     * both independently tappable, at every length of text and at every moment
     * of a capture.
     *
     * ONE CAPTURE, STILL (DROVE-210). It presses `onTalkTap`, the same handler
     * the headphone gesture and the lock screen reach, so a latch opened
     * anywhere is closed anywhere. This is not a second recogniser; it is the
     * render site DROVE-236 gave the primary button and DROVE-264 gives back to
     * a control of its own.
     *
     * NO CIRCLE UNLESS OPEN, which is DROVE-254's rule and Clay's standing
     * instruction. At rest it is a bare white glyph on the bubble, 10.862:1 on
     * dark and 18.819:1 on light, measured in composerControlColour.spec.ts.
     * Held or latched it fills with the row's recording red and the glyph goes
     * white on it, the same surface the row's talk button wears, so an open mic
     * looks the same wherever it was opened from.
     *
     * PUSH TO TALK, BACK (DROVE-269, reversing this comment's own refusal).
     *
     * What stood here said push-to-talk was not coming back, because DROVE-236
     * named the loss as the cost of the collapse and a second gesture was a
     * decision rather than a refactor. The decision has now been taken, by the
     * person it costs: "why isn't holding down the microphone doing push to
     * talk like it used to do."
     *
     * So the mic runs the whole three-outcome contract again, on its own
     * rectangle. Press and hold, released ON the button: the words are sent.
     * Tap: the mic latches open and the next tap stops it with the words in the
     * composer, unsent, exactly as before -- a hold is ADDED to the tap, not
     * put in its place, and the reducer reads the same lift for both. Slide off
     * before lifting: the recording is thrown away.
     *
     * STILL NO LONG PRESS, which is a different thing. `onLongPress` is the
     * channel sheet on the primary button, and this control never had one; the
     * hold here is the press stream itself, so there is no second gesture to
     * arbitrate with. `micButton.ts` decides tap from hold on the OS touch
     * clock, under the finger, at HOLD_MIN_MS.
     *
     * AND IT CANNOT FLIP UNDER A THUMB, which is the trap DROVE-236 wrote its
     * longest comment about and the reason this had to be checked rather than
     * assumed. That failure was one morphing button whose FACE was resolved
     * from the composer's contents, so a dictation partial landing mid-word
     * turned the mic into Send under a held finger. Nothing on this control
     * reads the composer: `canDictateHere` is the recogniser and the wiring,
     * the surface is `micLive`, and send is a separate permanent button to its
     * right. `micPushToTalkEndToEnd.spec.ts` drives a hold with partials
     * arriving mid-hold and pins that.
     *
     * The handlers are SPREAD, not written out (DROVE-210, DROVE-269). There is
     * no call site here for a lambda to be added to, so the OS touch clock
     * cannot be dropped on the way to the reducer.
     */
    const mobileMicAction = canDictateHere ? (
        <View
            // The button's own rectangle owns the touch stream: `onLayout`
            // measures it and the pressable's touches bubble here, so the slide
            // test is this box with slop and no window measuring (DROVE-269).
            // The SURFACE moved into the glass button below (DROVE-266); this
            // View keeps only the geometry the slide test measures.
            // No style of its own: the glass button below sizes itself (39,
            // MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE) and this View shrink-wraps
            // it, so the measured box IS the button's box.
            {...micTouch.view}
        >
            {/*
              THE PRESSABLE OUTLIVES THE FACE (DROVE-286).

              The press stream used to be spread on ComposerControlButton
              itself, and that control swaps COMPONENT TYPE with its fill:
              BubblePressable bare, GlassChromeButton open. The mic's press-in
              is exactly what turns its fill red, so the very press that
              opened the capture unmounted the pressable under the finger, and
              React Native fires no onPressOut for a press whose responder was
              unmounted. The opening tap's lift died with the old view, the
              reducer sat 'held' over a phantom finger, and the CLOSING tap's
              lift read as a push-to-talk release and sent (Clay: "not if I
              tap and then talk and then tap again"). The same loss ate a
              hold's release, which is push-to-talk's one gesture.

              So the gesture lives on this plain Pressable, mounted for the
              life of the control, and the face below is DECORATION behind
              `pointerEvents="none"`: it may remount with every fill it likes,
              and no press event is riding on it when it does. This is
              DROVE-236's "it cannot flip under a thumb" finished: the face
              may not DECIDE from the composer, and now it cannot take the
              gesture down with it either.

              Still no `onPress`: the lift is `onPressOut`, and an `onPress`
              beside it would fire on the same lift and toggle the latch
              straight back off (DROVE-269).

              The cost, named: the open disc's own press response (the glass
              deform, the 0.6 fallback fade) no longer fires, because its
              pressable never hears the touch. The reducer ticks a haptic on
              every lift, and at rest the bubble's interactive glass still
              draws the press, so the closing tap is felt and the resting tap
              looks as it did.
            */}
            <Pressable
                {...micTouch.press}
                // 36 reserved plus 6 a side, the same bargain every control on
                // this row strikes.
                hitSlop={MOBILE_COMPOSER_METRICS.primaryActionSlop}
                accessibilityRole="button"
                accessibilityState={{ busy: props.talkState === 'held', selected: props.talkState === 'latched' }}
                accessibilityLabel={t(micLive
                    ? 'agentInput.audioOut.micStop'
                    : 'agentInput.audioOut.micStart')}
            >
                <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <ComposerControlButton
                        // NO CIRCLE UNLESS OPEN, which is why `fill` is undefined at
                        // rest (DROVE-254, and Clay's standing instruction). A bare
                        // glyph gets no glass button of its own — that would BE the
                        // circle he took off — and it does not need one: it stands on
                        // the bubble's own interactive glass, so the press it draws is
                        // already the platform's. Open, it is a glass button tinted
                        // with the row's recording red (DROVE-266).
                        fill={micSurface === 'recording' ? composerControlPalette(theme.dark).recording : undefined}
                    >
                        <Ionicons
                            name="mic"
                            size={18}
                            // White on the red disc while it is open, the row's
                            // foreground while it is not. `micColour` is the one way to
                            // either, so the glyph and the fill read the same state.
                            color={micLive
                                ? composerFillTint(composerControlPalette(theme.dark).recording)
                                : micColour(composerPalette, 'idle')}
                        />
                    </ComposerControlButton>
                </View>
            </Pressable>
        </View>
    ) : null;

    /**
     * THE SESSION GROUP, INSIDE THE BUBBLE (DROVE-236), HOLDING FOUR THINGS
     * (DROVE-284, DROVE-331).
     *
     * It was a capsule on a row of its own under the bubble, which is where
     * DROVE-196 put it: "the second row buttons should sit outside the speech
     * bubble." Clay drew the reverse in red — the capsule circled, an arrow up
     * into the bubble's empty middle beside the `+` — so it is on the bubble's
     * own button row. DROVE-281 added the auto-accept bolt and DROVE-284 added
     * read-aloud, on "add the reading mode whatever thing to the group".
     * DROVE-331 took the bolt back out: "because of the toggles in the sheet
     * for auto-accept, we don't need it also in the bar group." The sheet's
     * switch below is the one auto-accept control; the padlock wears the
     * state.
     *
     * THE PRESSES HAVE NOT MOVED. Three of the four segments open their own
     * picker on the first tap through `handleSessionControlPress`, and every
     * one of those is a sheet (DROVE-242). Read-aloud is the one that DOES
     * something and keeps both of its gestures, tap for reading mode and long
     * press for pause or boss mode.
     *
     * WHAT IT COSTS. The capsule is the row's height rather than 44
     * (`MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE`) and its glyph segments are
     * narrower than they are tall (`MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`).
     * Both are touch target spent on width, both are argued on the constants,
     * and the second is what buys back the single row Clay asked for with a
     * fourth thing in the group. The 27pt the bolt held is the model name's
     * now, through the budget in sessionPillLabel.ts.
     */
    const mobileSessionControls = props.zenMode ? null : (
            <ComposerSessionControls
                label={sessionPillLabel}
                size={MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE}
                // The glyph segments are NOT square in here (DROVE-284). Four
                // of them at a disc's width is 156pt of a 393pt phone, and a
                // segment bounded by hairlines never needed a circle's
                // diameter. The measurement is on the constant.
                segmentWidth={MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH}
                // The row's own slop, vertically. Horizontally these segments
                // touch each other inside one capsule, so there is none to
                // take.
                verticalSlop={MOBILE_COMPOSER_METRICS.primaryActionSlop}
                modeKind={isSandboxedYoloMode ? 'safe-yolo' : displayPermissionMode?.semanticKind}
                modeKey={permissionModeKey}
                effortIndex={effortIndex}
                effortCount={effortScale.keys.length}
                onPress={handleSessionControlPress}
                /* THE PADLOCK WEARS THIS (DROVE-277, DROVE-331): the accent
                   while it is on, and "auto-accept on" in its accessibility
                   value. It is not a segment any more; the switch in the
                   sheet this padlock opens is the one control. */
                autoAccept={autoAccept}
                /* READ-ALOUD, MOVED IN OFF THE ROW (DROVE-284).

                   Clay: "Add the reading mode whatever thing to the group and
                   keep it all on the same row as send and +." DROVE-236 moved
                   it OUT of a capsule onto the row when he circled the speaker
                   and drew an arrow to the mic; that capsule was the audio pair
                   and is gone, and this one is the session's, which is where he
                   has now put it.

                   IT KEEPS BOTH GESTURES AND THE WHOLE STATE TABLE. Single
                   press is reading mode, long press is boss mode, and in
                   reading mode the long press is DROVE-233's pause. Same two
                   handlers, same `audioOutButton`; only the box changed, which
                   is what DROVE-236 said the last time this control moved.

                   ABSENT WITHOUT A READER:
                   `audioOut.shown` is false on an embedded or disconnected
                   chat, and a speaker with nothing behind it says only that
                   something is missing. */
                readAloud={audioOut.shown ? {
                    glyph: audioOut.glyph,
                    fill: audioOut.fill,
                    on: audioOut.on,
                    accessibilityLabel: t(audioOut.labelKey),
                    onPress: handleAudioOutPress,
                    onLongPress: handleAudioOutLongPress,
                } : null}
                canOpen={{
                    // The sheet behind the padlock holds the auto-accept switch
                    // as well as the mode list (DROVE-277, and the ONE
                    // auto-accept control since DROVE-331), so a session whose
                    // harness publishes no modes still has something to open.
                    permission: (!!props.onPermissionModeChange && availableModes.length > 0) || !!props.sessionId,
                    effort: availableEffortLevels.length > 0 && !!props.onEffortLevelChange,
                    model: availableModels.length > 0 && !!props.onModelModeChange,
                }}
                openPicker={engagedPicker === 'permission' || engagedPicker === 'effort'
                    || engagedPicker === 'model'
                    ? engagedPicker
                    : null}
                pending={props.pendingModes ? {
                    permission: props.pendingModes.permissionMode,
                    effort: props.pendingModes.effortLevel,
                    model: props.pendingModes.modelMode,
                } : null}
            />
    );

    return (
        <View style={[
            styles.container,
            // The composer's outer gutter, and the status strip is inside it
            // too: the strip's budget reads the same constant, so the row
            // cannot be measured against width the phone never gave it
            // (DROVE-223).
            {
                paddingHorizontal: screenWidth > 700
                    ? MOBILE_COMPOSER_METRICS.shellGutterWide
                    : MOBILE_COMPOSER_METRICS.shellGutter,
            },
        ]}>
            <View style={[
                styles.innerContainer,
                { maxWidth: layout.maxWidth }
            ]}>
                {/* Autocomplete suggestions overlay */}
                {suggestions.length > 0 && (
                    <View style={[
                        styles.autocompleteOverlay,
                        { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                    ]}>
                        <AgentInputAutocomplete
                            suggestions={suggestions.map(s => {
                                const Component = s.component;
                                return <Component key={s.key} />;
                            })}
                            selectedIndex={selected}
                            onSelect={handleSuggestionSelect}
                            itemHeight={48}
                        />
                    </View>
                )}

                {desktopSettingsOverlay}

                <ComposerToast text={composerToast} />

                {/* The channel sheet slides up on its own (DROVE-123), like
                    the quota sheet, so it is out of the shared panel below. */}
                <DroverChannelsSheet
                    open={openSheet === 'channels'}
                    onClose={closePicker}
                />

                {/* Camera, Photos, Files (DROVE-128), on the same shell. */}
                <AddContextSheet
                    open={openSheet === 'attach'}
                    onClose={closePicker}
                    onSelect={handleAddContextSelect}
                    available={addContextAvailable}
                />

                {/* On Android, the permission, model and effort pickers the
                    three session controls open (DROVE-111). On iOS those three
                    are native menus anchored to the controls themselves, so
                    nothing renders here at all. DROVE-83's intermediate
                    session sheet is gone, and DROVE-123 took channels out to
                    its own sheet. It was the last floating card off the
                    composer strip until DROVE-147 put it on the sheet too. */}
                <ComposerSheet
                    open={mobilePickerOpen}
                    onClose={closePicker}
                    keyboardShouldPersistTaps="always"
                >
                    {mobilePickerOpen && (
                        <>
                                {openPicker === 'permission' ? (
                                    <View style={styles.overlaySection}>
                                        <Text style={styles.overlaySectionTitle}>
                                            {permissionTitle}
                                        </Text>
                                        {/* AUTO-ACCEPT, at the top of the permission
                                            sheet (DROVE-277), and THE ONE PLACE IT IS
                                            SET since DROVE-331 took DROVE-281's bolt
                                            off the capsule. It sits above the mode
                                            list rather than below it because it is the
                                            widest thing on the sheet: while it is on,
                                            every Allow / Deny prompt in this session is
                                            answered without being shown, whichever mode
                                            is ticked underneath. A switch, not a radio,
                                            because it is not one of the modes and must
                                            not read as picking one.

                                            The wording is the safety feature and lives
                                            in autoAcceptRow.ts, where a test can hold
                                            it: it names what still asks, and it says
                                            out loud that a restart turns this off. */}
                                        {!!props.sessionId && (
                                            <View
                                                style={{
                                                    flexDirection: 'row',
                                                    alignItems: 'flex-start',
                                                    paddingHorizontal: 16,
                                                    paddingVertical: 8,
                                                    marginHorizontal: 8,
                                                    marginBottom: 4,
                                                    borderRadius: 14,
                                                    gap: 12,
                                                }}
                                            >
                                                <Ionicons
                                                    name={autoAcceptGlyph(autoAccept)}
                                                    size={16}
                                                    color={autoAccept ? theme.colors.radio.active : theme.colors.textSecondary}
                                                    style={{ marginTop: 2 }}
                                                />
                                                <View style={{ flex: 1 }}>
                                                    <Text style={{
                                                        fontSize: 14,
                                                        color: theme.colors.text,
                                                        ...Typography.default(),
                                                    }}>
                                                        {AUTO_ACCEPT_TITLE}
                                                    </Text>
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: theme.colors.textSecondary,
                                                        ...Typography.default(),
                                                    }}>
                                                        {AUTO_ACCEPT_SUBTITLE}
                                                    </Text>
                                                </View>
                                                <Switch
                                                    value={autoAccept}
                                                    onValueChange={setAutoAccept}
                                                    accessibilityLabel={AUTO_ACCEPT_TITLE}
                                                    accessibilityHint={AUTO_ACCEPT_SUBTITLE}
                                                />
                                            </View>
                                        )}
                                        {availableModes.map((mode) => {
                                            const isSelected = permissionModeKey === mode.key;
                                            return (
                                                <BubblePressable
                                                    key={mode.key}
                                                    disabled={!props.onPermissionModeChange || mode.disabled}
                                                    onPress={() => handleSettingsSelect(mode)}
                                                    accessibilityRole="radio"
                                                    accessibilityLabel={withSandboxSuffix(mode.name, mode.key)}
                                                    accessibilityHint={mode.description ?? undefined}
                                                    accessibilityState={{
                                                        checked: isSelected,
                                                        disabled: !props.onPermissionModeChange || !!mode.disabled,
                                                    }}
                                                    style={({ pressed }) => ({
                                                        flexDirection: 'row',
                                                        alignItems: 'flex-start',
                                                        paddingHorizontal: 16,
                                                        paddingVertical: 8,
                                                        marginHorizontal: 8,
                                                        borderRadius: 14,
                                                        backgroundColor: pressed
                                                            ? theme.colors.surfacePressedOverlay
                                                            : isSelected
                                                                ? theme.colors.glass.backgroundSubtle
                                                                : 'transparent',
                                                        opacity: (!props.onPermissionModeChange || mode.disabled) ? 0.55 : 1,
                                                    })}
                                                >
                                                    <View style={{
                                                        width: 16,
                                                        height: 16,
                                                        borderRadius: 8,
                                                        borderWidth: 2,
                                                        borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        marginRight: 12,
                                                        marginTop: 2,
                                                    }}>
                                                        {isSelected && <View style={{
                                                            width: 6,
                                                            height: 6,
                                                            borderRadius: 3,
                                                            backgroundColor: theme.colors.radio.dot,
                                                        }} />}
                                                    </View>
                                                    <View style={{ flex: 1 }}>
                                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                                                            {mode.semanticKind && (
                                                                <Ionicons
                                                                    name={permissionKindIcon(mode.semanticKind)}
                                                                    size={13}
                                                                    color={isSelected ? theme.colors.radio.active : theme.colors.textSecondary}
                                                                />
                                                            )}
                                                            <Text style={{
                                                                fontSize: 14,
                                                                color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                                ...Typography.default(),
                                                            }}>
                                                                {withSandboxSuffix(mode.name, mode.key)}
                                                            </Text>
                                                        </View>
                                                        {!!mode.description && (
                                                            <Text style={{
                                                                fontSize: 11,
                                                                color: theme.colors.textSecondary,
                                                                ...Typography.default(),
                                                            }}>
                                                                {mode.description}
                                                            </Text>
                                                        )}
                                                    </View>
                                                </BubblePressable>
                                            );
                                        })}
                                    </View>
                                ) : (
                                    <>
                                        {openPicker === 'model' && (
                                        <View style={styles.overlaySection}>
                                            <Text style={styles.overlaySectionTitle}>
                                                {props.modelMode?.name ?? t('agentInput.model.title')}
                                            </Text>
                                            {availableModels.length > 0 ? availableModels.map((model) => {
                                                const isSelected = props.modelMode?.key === model.key;
                                                return (
                                                    <BubblePressable
                                                        key={model.key}
                                                        disabled={!props.onModelModeChange || model.disabled}
                                                        onPress={() => {
                                                            hapticsLight();
                                                            props.onModelModeChange?.(model);
                                                            closePicker();
                                                        }}
                                                        accessibilityRole="radio"
                                                        accessibilityLabel={model.name}
                                                        accessibilityHint={model.description ?? undefined}
                                                        accessibilityState={{
                                                            checked: isSelected,
                                                            disabled: !props.onModelModeChange || !!model.disabled,
                                                        }}
                                                        style={({ pressed }) => ({
                                                            flexDirection: 'row',
                                                            alignItems: 'flex-start',
                                                            paddingHorizontal: 16,
                                                            paddingVertical: 8,
                                                            marginHorizontal: 8,
                                                            borderRadius: 14,
                                                            backgroundColor: pressed
                                                                ? theme.colors.surfacePressedOverlay
                                                                : isSelected
                                                                    ? theme.colors.glass.backgroundSubtle
                                                                    : 'transparent',
                                                            opacity: (!props.onModelModeChange || model.disabled) ? 0.55 : 1,
                                                        })}
                                                    >
                                                        <View style={{
                                                            width: 16,
                                                            height: 16,
                                                            borderRadius: 8,
                                                            borderWidth: 2,
                                                            borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            marginRight: 12,
                                                            marginTop: 2,
                                                        }}>
                                                            {isSelected && <View style={{
                                                                width: 6,
                                                                height: 6,
                                                                borderRadius: 3,
                                                                backgroundColor: theme.colors.radio.dot,
                                                            }} />}
                                                        </View>
                                                        <View style={{ flex: 1 }}>
                                                            {model.providerName ? (
                                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                                                                    <ProviderIcon kind={model.providerKind} size={12} />
                                                                    <Text style={{
                                                                        fontSize: 14,
                                                                        color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                                        ...Typography.default(),
                                                                    }}>
                                                                        {model.name}
                                                                    </Text>
                                                                </View>
                                                            ) : (
                                                                <Text style={{
                                                                    fontSize: 14,
                                                                    color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                                    ...Typography.default(),
                                                                }}>
                                                                    {model.name}
                                                                </Text>
                                                            )}
                                                            {!!model.description && (
                                                                <Text style={{
                                                                    fontSize: 11,
                                                                    color: theme.colors.textSecondary,
                                                                    ...Typography.default(),
                                                                }}>
                                                                    {model.description}
                                                                </Text>
                                                            )}
                                                        </View>
                                                    </BubblePressable>
                                                );
                                            }) : (
                                                <Text style={{
                                                    fontSize: 13,
                                                    color: theme.colors.textSecondary,
                                                    paddingHorizontal: 16,
                                                    paddingVertical: 8,
                                                    ...Typography.default(),
                                                }}>
                                                    {t('agentInput.model.configureInCli')}
                                                </Text>
                                            )}
                                        </View>
                                        )}
                                        {openPicker === 'effort' && availableEffortLevels.length > 0 && props.onEffortLevelChange && (
                                                <View style={styles.overlaySection}>
                                                    <Text style={styles.overlaySectionTitle}>
                                                        {props.effortLevel?.name ?? t('agentInput.effort.title')}
                                                    </Text>
                                                    {/* AUTO, at the head of the list (DROVE-229).
                                                        It is a MODE, not a level: `/effort auto`
                                                        hands the choice back to Claude Code, so it
                                                        is not a seventh notch and it is not below
                                                        `low` (DROVE-200). It was a pill on the
                                                        slider's own popover, which is the surface
                                                        that stopped taking touches; here it is a
                                                        row like the levels beside it, on the sheet
                                                        a tap opens. Its wire value is the reset,
                                                        `effortLevel: null`, through the same
                                                        `onEffortKeyChange` the drag commits on. */}
                                                    {props.onEffortKeyChange ? (() => {
                                                        const isSelected = !props.effortLevel;
                                                        return (
                                                            <BubblePressable
                                                                key="__auto"
                                                                onPress={() => {
                                                                    hapticsLight();
                                                                    props.onEffortKeyChange?.(null);
                                                                    closePicker();
                                                                }}
                                                                accessibilityRole="radio"
                                                                accessibilityLabel="Auto"
                                                                accessibilityHint="Let the agent choose"
                                                                accessibilityState={{ checked: isSelected }}
                                                                style={({ pressed }) => ({
                                                                    flexDirection: 'row',
                                                                    alignItems: 'flex-start',
                                                                    paddingHorizontal: 16,
                                                                    paddingVertical: 8,
                                                                    marginHorizontal: 8,
                                                                    borderRadius: 14,
                                                                    backgroundColor: pressed
                                                                        ? theme.colors.surfacePressedOverlay
                                                                        : isSelected
                                                                            ? theme.colors.glass.backgroundSubtle
                                                                            : 'transparent',
                                                                })}
                                                            >
                                                                <View style={{
                                                                    width: 16,
                                                                    height: 16,
                                                                    borderRadius: 8,
                                                                    borderWidth: 2,
                                                                    borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                                    alignItems: 'center',
                                                                    justifyContent: 'center',
                                                                    marginRight: 12,
                                                                    marginTop: 2,
                                                                }}>
                                                                    {isSelected && <View style={{
                                                                        width: 6,
                                                                        height: 6,
                                                                        borderRadius: 3,
                                                                        backgroundColor: theme.colors.radio.dot,
                                                                    }} />}
                                                                </View>
                                                                <View style={{ flex: 1 }}>
                                                                    <Text style={{
                                                                        fontSize: 14,
                                                                        color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                                        ...Typography.default(),
                                                                    }}>
                                                                        Auto
                                                                    </Text>
                                                                    <Text style={{
                                                                        fontSize: 11,
                                                                        color: theme.colors.textSecondary,
                                                                        ...Typography.default(),
                                                                    }}>
                                                                        Let the agent choose
                                                                    </Text>
                                                                </View>
                                                            </BubblePressable>
                                                        );
                                                    })() : null}
                                                    {availableEffortLevels.map((level) => {
                                                        const isSelected = props.effortLevel?.key === level.key;
                                                        // Out of reach on this model: the row
                                                        // stays, with its reason, but it is not
                                                        // a pick (DROVE-101).
                                                        const isDisabled = !!level.disabled;
                                                        return (
                                                            <BubblePressable
                                                                key={level.key}
                                                                disabled={isDisabled}
                                                                onPress={() => {
                                                                    if (isDisabled) return;
                                                                    hapticsLight();
                                                                    props.onEffortLevelChange?.(level);
                                                                    closePicker();
                                                                }}
                                                                accessibilityRole="radio"
                                                                accessibilityLabel={level.name}
                                                                accessibilityHint={level.description ?? undefined}
                                                                accessibilityState={{ checked: isSelected, disabled: isDisabled }}
                                                                style={({ pressed }) => ({
                                                                    flexDirection: 'row',
                                                                    alignItems: 'flex-start',
                                                                    paddingHorizontal: 16,
                                                                    paddingVertical: 8,
                                                                    marginHorizontal: 8,
                                                                    borderRadius: 14,
                                                                    opacity: isDisabled ? 0.45 : 1,
                                                                    backgroundColor: pressed && !isDisabled
                                                                        ? theme.colors.surfacePressedOverlay
                                                                        : isSelected
                                                                            ? theme.colors.glass.backgroundSubtle
                                                                            : 'transparent',
                                                                })}
                                                            >
                                                                <View style={{
                                                                    width: 16,
                                                                    height: 16,
                                                                    borderRadius: 8,
                                                                    borderWidth: 2,
                                                                    borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                                    alignItems: 'center',
                                                                    justifyContent: 'center',
                                                                    marginRight: 12,
                                                                    marginTop: 2,
                                                                }}>
                                                                    {isSelected && <View style={{
                                                                        width: 6,
                                                                        height: 6,
                                                                        borderRadius: 3,
                                                                        backgroundColor: theme.colors.radio.dot,
                                                                    }} />}
                                                                </View>
                                                                <View style={{ flex: 1 }}>
                                                                    <Text style={{
                                                                        fontSize: 14,
                                                                        color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                                        ...Typography.default(),
                                                                    }}>
                                                                        {level.name}
                                                                    </Text>
                                                                    {!!level.description && (
                                                                        <Text style={{
                                                                            fontSize: 11,
                                                                            color: theme.colors.textSecondary,
                                                                            ...Typography.default(),
                                                                        }}>
                                                                            {level.description}
                                                                        </Text>
                                                                    )}
                                                                </View>
                                                            </BubblePressable>
                                                        );
                                                    })}
                                                </View>
                                        )}
                                    </>
                                )}
                        </>
                    )}
                </ComposerSheet>

                <AnimatedFade visible={props.showStatusDetails !== false}>
                    <AgentInputContextChips
                        machineName={props.machineName}
                        onMachineClick={props.onMachineClick}
                        currentPath={props.currentPath}
                        onPathClick={props.onPathClick}
                    />
                </AnimatedFade>

                {/* Box 2: Action Area (Input + Send) */}
                <Shaker ref={sendBlockShakerRef} onLayout={handleActionAreaLayout}>
                    {/* The composer's FIRST LINE, which is the bubble and
                        nothing else now (DROVE-206). DROVE-196 put the `+` out
                        here beside the field; Clay looked at it and asked for
                        the opposite, so it went inside to the leading rim and
                        this line has one child. It stays a row because it
                        carries the composer's gutter, which is what lines the
                        bubble's rims up with the recording banner, which is
                        the only thing left measured against it now the control
                        row is inside the bubble (DROVE-157, DROVE-236). */}
                    <View style={compactMobileComposer ? styles.mobileComposerLine : undefined}>
                    <View style={[
                        compactMobileComposer && styles.unifiedPanelShadow,
                        compactMobileComposer && styles.mobileUnifiedPanelShadow,
                        compactMobileComposer && styles.mobileBubbleShell,
                    ]}>
                        {/* THE COMPOSER, WHICH IS ONE COMPONENT NOW
                            (DROVE-345). The shell, the field's surface and the
                            button row are `ComposerBubble`'s; this screen fills
                            the slots. Clay filed it about Home — "this input is
                            not using our liquid glass input that we have
                            everywhere else" — and the fix that makes it true is
                            that there is one input for both screens to use.

                            The slab is real Liquid Glass, not a blur with a
                            flat colour over it (DROVE-153). `frosted` painted
                            rgba(20,20,22,0.82) on top of a blur, and a blur of
                            a black chat is black, so what Clay photographed was
                            the overlay: a flat dark grey slab. Legibility does
                            not depend on the material: the transcript is masked
                            to nothing before it reaches the card (DROVE-168,
                            resolveTranscriptMask), so the glass has a known
                            surface under it. */}
                        {compactMobileComposer ? (
                            <ComposerBubble
                                // `unifiedPanel` is the DESKTOP card's style and
                                // is not in here: it carries a 8/8/2 padding
                                // that the bubble's four longhands used to have
                                // to fight, and on this branch there is no
                                // desktop card to style.
                                style={styles.mobileUnifiedPanel}
                                fieldStyle={[
                                    styles.mobileInputContainer,
                                    props.minHeight ? { minHeight: props.minHeight } : undefined,
                                ]}
                                above={props.selectedImages && props.selectedImages.length > 0 ? (
                                    <View style={styles.mobileAttachmentInset}>
                                        <AgentInputAttachmentStrip
                                            images={props.selectedImages}
                                            onRemove={props.onRemoveImage ?? (() => {})}
                                        />
                                    </View>
                                ) : null}
                                leading={showMobileAddButton ? mobileAddAction : null}
                                controls={mobileSessionControls}
                                /* THE MIC, ITS OWN CONTROL AGAIN (DROVE-264),
                                   and since DROVE-284 send's only neighbour.
                                   The pair it belongs to is voice-in and send:
                                   one puts words in the field, the next sends
                                   them, and Clay's composition runs left to
                                   right across exactly those two. */
                                trailing={[mobileMicAction, mobilePrimaryAction]}
                            >
                        <MultiTextInput
                            ref={inputRef}
                            defaultValue={props.initialValue}
                            paddingTop={compactMobileComposer
                                ? MOBILE_COMPOSER_METRICS.inputPaddingTop
                                : Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={compactMobileComposer
                                ? MOBILE_COMPOSER_METRICS.inputPaddingBottom
                                : Platform.OS === 'web' ? 10 : 8}
                            onChangeText={handleTextChange}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={Platform.OS === 'web' ? 480 : MOBILE_COMPOSER_METRICS.inputMaxHeight}
                            lineHeight={compactMobileComposer ? MOBILE_COMPOSER_METRICS.inputLineHeight : undefined}
                        />
                            </ComposerBubble>
                        ) : (
                            /* THE DESKTOP CARD, which is a different
                               arrangement and not this component's business:
                               one row with the controls beside the field rather
                               than a bubble with a button row under it. It has
                               never been the bubble and `ComposerBubble` does
                               not pretend it is. */
                            <MobileGlassSurface enabled={false} style={styles.unifiedPanel}>
                    {/* Attachment preview strip */}
                    {props.selectedImages && props.selectedImages.length > 0 && (
                        <View style={compactMobileComposer ? styles.mobileAttachmentInset : undefined}>
                            <AgentInputAttachmentStrip
                                images={props.selectedImages}
                                onRemove={props.onRemoveImage ?? (() => {})}
                            />
                        </View>
                    )}
                                <View style={[
                                    styles.inputContainer,
                                    props.minHeight ? { minHeight: props.minHeight } : undefined,
                                ]}>
                        <MultiTextInput
                            ref={inputRef}
                            defaultValue={props.initialValue}
                            paddingTop={compactMobileComposer
                                ? MOBILE_COMPOSER_METRICS.inputPaddingTop
                                : Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={compactMobileComposer
                                ? MOBILE_COMPOSER_METRICS.inputPaddingBottom
                                : Platform.OS === 'web' ? 10 : 8}
                            onChangeText={handleTextChange}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={Platform.OS === 'web' ? 480 : MOBILE_COMPOSER_METRICS.inputMaxHeight}
                            lineHeight={compactMobileComposer ? MOBILE_COMPOSER_METRICS.inputLineHeight : undefined}
                        />
                                </View>
                                {desktopActionControls}
                            </MobileGlassSurface>
                        )}
                    </View>
                    </View>
                </Shaker>

                {/* The strip under the composer, and both things that live
                    in it. It is under the BUBBLE now, and there is nothing
                    between them any more (DROVE-236): the control row it used
                    to sit under is inside the bubble's own button row. Its box
                    did not move a point for that either: 6pt of padding over
                    the status text's 14pt line, 20 in total, with the composer
                    line keeping the same 8pt clear above.

                    The 8 changed OWNER, not value. It was the control row's
                    `marginBottom` and it is the composer line's, so the tap
                    floor is where it was and the nearest button is now 4pt
                    further off it, because the bubble's discs stop
                    `bubbleInsetBottom` short of the bubble's rim.

                    That 20 is `COMPOSER_STRIP_BOX`, and the floor here is the
                    same object's `minHeight` rather than a second number
                    (DROVE-221). This wrapper used to say 24 while the row said
                    20, so speaking pushed the whole composer up 4pt and
                    DROVE-219's fade went with it. The band cannot change
                    height on a recording now, because there is nothing left
                    for it to change TO.
                    Every status fact on one line (DROVE-82): working state and
                    timer, connection, quota. Clay, seeing it in place: "this is
                    great, keep that shit down there." It owns its own two
                    sheets (DROVE-117, DROVE-111), so nothing here has to route
                    them.

                    The live-mic banner sits over it while dictation runs
                    (DROVE-157). It was a child of the card, above the text
                    field, so starting to talk grew the composer and shoved the
                    transcript up. Here it is absolutely positioned, so it adds
                    no height and the dock cannot move; the status row stays
                    mounted underneath, covered rather than unmounted, so its
                    timer and its sheets survive the recording. The control
                    that stops the capture is the bubble's primary button,
                    which draws a mic whenever one is open (DROVE-236). */}
                <View style={compactMobileComposer && props.talk?.active
                    ? { minHeight: COMPOSER_STRIP_BOX.minHeight }
                    : undefined}
                >
                    <AgentInputStatusRow
                        sessionId={props.sessionId}
                        connectionStatus={props.connectionStatus}
                        contextUsage={contextUsage}
                        alwaysShowContext={props.alwaysShowContextSize ?? false}
                        weekPercent={weekPercent}
                        weekTone={weekTone}
                        usageBarGroups={usageBarGroups}
                        usageBarFooter={usageBarFooter}
                        usageBarCapturedAt={usageBarCapturedAt}
                        // Zen mode strips the account's name off the quota,
                        // as it strips the whole session capsule above; the
                        // groups still go down whole, because the sheet and
                        // the switch behind the quota are not what zen hides
                        // (DROVE-160).
                        hideAccount={!!props.zenMode}
                        // The model went back UP to the button row
                        // (DROVE-178), into the gap DROVE-153 opened. The row
                        // was carrying the main thread's clock, the agent
                        // count, the model and the account; this is the
                        // segment it gives back.
                        onSessionInfoPress={props.onSessionInfoPress}
                        showDetails={props.showStatusDetails !== false}
                    />
                    {compactMobileComposer && props.talk?.active && (
                        <LiveMicBanner
                            talk={props.talk}
                            cancelArmed={props.talkCancelArmed}
                            sendArmed={props.talkSendArmed}
                        />
                    )}
                </View>
            </View>
        </View>
    );
}));

// Git Status Button Component
function GitStatusButton({ sessionId, onPress }: { sessionId?: string, onPress?: () => void }) {
    const hasMeaningfulGitStatus = useHasMeaningfulGitStatus(sessionId || '');
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (!sessionId || !onPress) {
        return null;
    }

    return (
        <BubblePressable
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                height: 32,
                opacity: p.pressed ? 0.7 : 1,
                flex: 1,
                overflow: 'hidden',
            })}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                onPress?.();
            }}
        >
            {hasMeaningfulGitStatus ? (
                <GitStatusBadge sessionId={sessionId} />
            ) : (
                <Octicons
                    name="git-branch"
                    size={16}
                    color={theme.colors.button.secondary.tint}
                />
            )}
        </BubblePressable>
    );
}
