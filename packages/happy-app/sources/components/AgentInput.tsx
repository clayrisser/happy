import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { Keyboard, View, Platform, useWindowDimensions, Text, ActivityIndicator, Pressable, LayoutChangeEvent } from 'react-native';
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
import { getPermissionModeMenuLabel, getPermissionModeShortLabel } from '@/utils/permissionModeLabels';
import type { UsageLimitsLike } from '@/utils/sessionStatusBar';
import type { DroverUsageLike } from '@/utils/droverUsage';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@/sync/storageTypes';
import { isRunningOnMac } from '@/utils/platform';
import { MobileGlassSurface } from './MobileGlass';
import { GlassChromeSurface } from './GlassChromeControl';
import { AnimatedFade } from './AnimatedOverlay';
import { BubblePressable } from './BubblePressable';
import { resolveAgentInputPrimaryAction } from './agentInputPrimaryAction';
import { resolveComposerPrimaryPress, type ComposerPrimaryGesture } from './composerPrimaryPress';
import { ComposerToast } from './ComposerToast';
import { flipStreamTalk, streamTalkButton } from '@/voice/streamTalk';
import { NativeSettingsMenu, type NativeSettingsMenuGroup } from './NativeSettingsMenu';
import { AgentInputStatusRow } from './AgentInputStatusRow';
import { AddContextSheet, type AddContextSource } from './AddContextSheet';
import { resolveUsageStrip } from './agentInputUsage';
import { ProviderIcon } from './ProviderIcon';
import { isRigMetadata } from '@/sync/rig';
import {
    MOBILE_COMPOSER_LAYOUT,
    MOBILE_COMPOSER_METRICS,
    resolveMobileComposerActionGeometry,
    resolveMobileComposerControlRowGeometry,
    resolveMobileComposerLineGeometry,
} from './agentInputLayout';
import { COMPOSER_STRIP_HEIGHT } from './composerStripLayout';
import { shouldUseExpoNativeSettingsMenu } from './glassInteractionPolicy';
import { LiveMicBanner } from './LiveMicBanner';
import { TalkButton } from './TalkButton';
import { talkButtonWiring } from './talkButtonWiring';
import type { MicButtonState } from '@/voice/micButton';
import type { DictationCaptureState } from '@/voice/dictationCapture';
import { DroverChannelsSheet } from './DroverChannelsSheet';
import { buildSessionPillLabel } from './sessionPillLabel';
import type { AgentModePendingFlags } from '@/sync/useAgentModePending';
import { permissionModeGlyph } from './sessionControlGlyphs';
import { ComposerSessionControls, type ComposerSessionPicker } from './ComposerSessionControls';
import { useEffortSlider } from './EffortSliderPopover';
import { effortSliderScaleFromLevels } from './effortSlider';
import {
    composerControlPalette,
    micColour,
    primaryActionColour,
} from './composerControlColour';

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
     * Read-aloud (DROVE-30, mode B). Absent when the device has no speech
     * synthesiser at all, so the toggle is not offered where it cannot work.
     */
    readAloudEnabled?: boolean;
    onReadAloudToggle?: () => void;
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
     * One tap, on a control with no touch stream (DROVE-210). The primary
     * button is a plain `onPress`, so this is all it can do: latch the mic
     * open, and stop a latched one. Same capture as the capsule above.
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
const MOBILE_CONTROL_ROW_GEOMETRY = resolveMobileComposerControlRowGeometry();
const MOBILE_ICON_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('icon');
const MOBILE_PRIMARY_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('primary');
const MOBILE_ADD_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('add');

// Shared with the action-area offset reported to onActionAreaOffsetChange —
// the Shaker's layout.y is relative to innerContainer, which sits this far
// below AgentInput's top edge.
const CONTAINER_TOP_PADDING = 8;

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
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        // NO PADDING, and that is the ticket (DROVE-196). Clay: "the second
        // row buttons should sit outside the speech bubble." The card is the
        // message he is writing, so it holds the field and nothing else, and
        // it hugs it: the in-field send button's own 4pt inset is the only air
        // inside this card. The gutter that used to live here is on the
        // composer line and the control row now, and 30pt of radius over a
        // 44pt field draws the 22pt capsule that makes the bubble a bubble.
    },
    /**
     * The composer's first line (DROVE-196): the `+` at the leading edge, the
     * bubble taking the rest. Messages exactly, and the half of it DROVE-153
     * left undone when it put the primary inside the field.
     */
    mobileComposerLine: MOBILE_COMPOSER_LINE_GEOMETRY,
    /** The bubble takes whatever the `+` leaves. */
    mobileBubbleShell: {
        flex: 1,
        minWidth: 0,
    },
    /**
     * Mode, effort, model, speaker and mic, under the bubble rather than in it
     * (DROVE-196). Every control keeps its 44pt and its colours; only the
     * surface behind them changed, from the card's glass to the dock's own
     * frame, and each of them carries glass of its own already.
     */
    mobileControlRow: MOBILE_CONTROL_ROW_GEOMETRY,
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
    mobileInputContainer: {
        alignItems: 'center',
        // The bubble's whole height when the composer is empty (DROVE-196):
        // the card has no padding of its own, so this floor is the card's
        // floor, and it is already derived from what it holds — the 36pt send
        // button inset 4 at each end.
        minHeight: MOBILE_COMPOSER_METRICS.inputMinHeight,
        // Symmetric again, and for the opposite reason to before (DROVE-206).
        // The field holds a control at EACH rim now, so the text stops short
        // of both: 4 off the rim, a 36pt disc, 6 of air. 46 a side.
        paddingLeft: MOBILE_COMPOSER_LAYOUT.inputLeadingActionPadding,
        // The send button sits inside the field at this edge (DROVE-153), so
        // the text stops short of it rather than running underneath. Reserved
        // whether or not the button can fire, because the button is always
        // drawn: that is what keeps the text's width off the composer's state.
        paddingRight: MOBILE_COMPOSER_LAYOUT.inputTrailingActionPadding,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    },
    /**
     * The field with no `+` in it: zen mode, or a session that takes no
     * context (DROVE-206). The text falls back to the glyph column the `+`
     * would have stood in rather than to the bubble's rim, so the caret is in
     * the same place either way and only the gap in front of it changes.
     */
    mobileInputContainerNoAdd: {
        paddingLeft: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingLeft,
    },
    /**
     * Where the in-field primary sits: hard against the capsule's trailing
     * edge, and pinned to the BOTTOM so it stays put as the field grows.
     */
    mobilePrimaryAnchor: {
        position: 'absolute',
        right: MOBILE_COMPOSER_METRICS.primaryActionInset,
        bottom: MOBILE_COMPOSER_METRICS.primaryActionInset,
    },
    /**
     * And where the `+` sits: the mirror of it, at the leading rim
     * (DROVE-206).
     *
     * Same 4pt inset and the same bottom pin, for the same reason. The field
     * grows upward as the message wraps and both controls have to stay on the
     * last line where the thumb left them, rather than one of them riding up
     * the side of a tall capsule.
     */
    mobileAddAnchor: {
        position: 'absolute',
        left: MOBILE_COMPOSER_METRICS.primaryActionInset,
        bottom: MOBILE_COMPOSER_METRICS.primaryActionInset,
    },
    mobileAddButton: MOBILE_ADD_ACTION_GEOMETRY,

    // Overlay styles
    autocompleteOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    overlaySection: {
        paddingVertical: 8,
    },
    settingsStatusInfo: {
        paddingTop: 6,
        paddingBottom: 4,
        paddingHorizontal: 8,
    },
    overlaySectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
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
    /**
     * The audio pair's shared capsule (DROVE-153).
     *
     * DROVE-118 gave the speaker and the mic a filled surface each so they read
     * as buttons rather than as decoration beside the primary. That was right
     * and this keeps it; what changes is that the surface is now one capsule
     * around both, in the material, instead of two flat discs. Clay's
     * Screenshot-toolbar reference is exactly this shape.
     */
    mobileAudioCapsule: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        height: MOBILE_COMPOSER_METRICS.actionSize,
    },
    mobileAudioDivider: {
        width: StyleSheet.hairlineWidth,
        height: 20,
        backgroundColor: theme.colors.glass.divider,
    },
    // Stream-talk on: the surface carries it, not just the glyph, which is
    // what a blue icon on nothing could never say at a glance.
    mobileIconButtonOn: {
        backgroundColor: theme.colors.radio.active,
    },
    // A control whose sheet is showing reads as held down, the same step the
    // session controls use for an open picker.
    mobileIconButtonOpen: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    // The talk button's two live states (DROVE-74). Held is a solid red disc
    // with a white glyph; latched is the resting surface inside a red ring
    // with a red glyph, so a mic that will stay open after the lift looks
    // different from one that will not, and both look different from idle.
    //
    // The ring and the glyph read the SAME entry (DROVE-176), because the
    // light theme's recording red is a darker crimson than the banner's
    // #FF3B30, which is 2.54:1 on the light glass; a ring one shade off its
    // own glyph is a mistake nobody would make on purpose.
    talkButtonHeld: {
        backgroundColor: composerControlPalette(theme.dark).recording,
        borderRadius: 999,
    },
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
    mobilePrimaryButton: MOBILE_PRIMARY_ACTION_GEOMETRY,
    mobilePrimaryButtonActive: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    mobilePrimaryButtonInactive: {
        backgroundColor: theme.dark ? '#3A3A3C' : '#D1D1D6',
    },
    mobileStopButton: {
        backgroundColor: theme.dark ? '#F5F5F5' : theme.colors.button.primary.background,
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

const formatTokenCount = (tokens: number): string => {
    if (tokens < 1000) {
        return `${Math.max(0, Math.round(tokens))}`;
    }
    if (tokens < 999500) {
        return `${Math.round(tokens / 1000)}k`;
    }
    const millions = tokens / 1000000;
    return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
};

const getContextStatus = (contextSize: number, alwaysShow: boolean = false, theme: Theme, contextWindow: number | undefined) => {
    // Until the session reports its window there is no honest denominator, so
    // nothing is shown rather than dividing by a guess — a percentage that
    // later corrects itself upward reads as the context refilling.
    if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
        return null;
    }
    const percentageUsed = Math.max(0, Math.min(100, (contextSize / contextWindow) * 100));
    const percentageRemaining = 100 - percentageUsed;

    let color: string;
    if (percentageRemaining <= 5) {
        color = theme.colors.warningCritical;
    } else if (percentageRemaining <= 10) {
        color = theme.colors.warning;
    } else if (alwaysShow) {
        color = theme.colors.textSecondary;
    } else {
        return null; // No display needed
    }

    return {
        percent: Math.round(percentageUsed),
        detailText: t('agentInput.context.detailContext', {
            used: formatTokenCount(contextSize),
            total: formatTokenCount(contextWindow),
        }),
        color,
    };
};

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
    // iOS only. On Android the settings/model/effort triggers are React Native
    // subtrees hosted inside a Jetpack Compose DropdownMenu, and expo-modules-core
    // pins such a child to `Modifier.size(view.width, view.height)` sampled once at
    // composition with no layout listener (ExpoComposeAndroidView) — composed before
    // React Native measures it, the trigger stays 0x0 and the control is invisible
    // while still occupying its slot. The composer's own popup pickers below render
    // identically and work, so Android uses those instead of the native menu.
    const useNativeSettingsMenus = shouldUseExpoNativeSettingsMenu(Platform.OS, runningOnMac);
    /**
     * The composer's colour vocabulary (DROVE-176). One place decides what
     * each control's glyph means by its hue and every entry is measured on
     * the glass; nothing here picks a colour of its own.
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
    const usageLimitShowRemaining = useSetting('usageLimitShowRemaining');
    const contextStatus = props.usageData?.contextSize
        ? getContextStatus(props.usageData.contextSize, props.alwaysShowContextSize ?? false, theme, props.usageData.contextWindow)
        : null;
    // The week figure and its popup, from agent state or, on a pane session,
    // from drover's snapshot (DROVE-47); resolveUsageStrip says which.
    const { weekPercent, usageBarGroups, usageBarFooter } = React.useMemo(() => resolveUsageStrip({
        usageLimits: props.sessionStatusUsageLimits ?? null,
        droverUsage: props.sessionStatusDroverUsage,
        droverAccount: props.sessionStatusDroverAccount,
        showRemaining: usageLimitShowRemaining,
    }), [
        props.sessionStatusUsageLimits,
        props.sessionStatusDroverUsage,
        props.sessionStatusDroverAccount,
        usageLimitShowRemaining,
    ]);

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const [stopRequested, setStopRequested] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const sendBlockShakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);
    // The handlers TalkButton needs, built once and passed BY REFERENCE
    // (DROVE-210). Never wrap these in a lambda: an arrow that forgets to
    // forward `touchAt` type-checks and silently undoes DROVE-140.
    const talkWiring = React.useMemo(
        () => talkButtonWiring({
            onTalkPressIn: props.onTalkPressIn,
            onTalkPressOut: props.onTalkPressOut,
            onTalkSlide: props.onTalkSlide,
        }),
        [props.onTalkPressIn, props.onTalkPressOut, props.onTalkSlide],
    );
    /** The mic is open right now, latched by a tap or held under a finger. */
    const micLive = props.talkState === 'latched' || props.talkState === 'held';
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
     * The waveform, on the control row (DROVE-206).
     *
     * The condition is what `canVoice` used to be on the primary action, moved
     * unchanged: only the phone's glass composer folds a voice turn into this
     * row, and the desktop keeps its own send/mic resolution below. What
     * changed is that it now decides whether a CONTROL is drawn rather than
     * which face another control wears.
     */
    const showBossButton = compactMobileComposer && !!props.onMicPress;
    /**
     * The in-field send glyph: the accent once there is something to send, the
     * theme's neutral when there is not (DROVE-176). It no longer wears a
     * second identity on an empty field, because the waveform moved out to the
     * control row (DROVE-206), so the arrow that turns accent is the one thing
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
     * The status row's two expanders are deliberately NOT here. They open
     * ComposerSheet from the row itself (DROVE-117's mechanism), and
     * that sheet's own click-away backdrop is what keeps them from stacking
     * with these pickers.
     */
    type ComposerPicker = 'channels' | 'attach' | 'permission' | 'model' | 'effort';
    const [openPicker, setOpenPicker] = React.useState<ComposerPicker | null>(null);
    const pickerOpeningRef = React.useRef<ComposerPicker | null>(null);
    const pickerKeyboardSubscriptionRef = React.useRef<ReturnType<typeof Keyboard.addListener> | null>(null);
    const pickerOpenTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const cancelPendingPickerOpen = React.useCallback(() => {
        pickerOpeningRef.current = null;
        pickerKeyboardSubscriptionRef.current?.remove();
        pickerKeyboardSubscriptionRef.current = null;
        if (pickerOpenTimerRef.current) {
            clearTimeout(pickerOpenTimerRef.current);
            pickerOpenTimerRef.current = null;
        }
    }, []);

    const closePicker = React.useCallback(() => {
        cancelPendingPickerOpen();
        setOpenPicker(null);
    }, [cancelPendingPickerOpen]);

    React.useEffect(() => cancelPendingPickerOpen, [cancelPendingPickerOpen]);

    const handlePickerPress = React.useCallback((picker: ComposerPicker) => {
        hapticsLight();
        if (openPicker === picker || pickerOpeningRef.current === picker) {
            closePicker();
            return;
        }

        closePicker();
        if (Platform.OS === 'web' || !Keyboard.isVisible()) {
            setOpenPicker(picker);
            return;
        }

        pickerOpeningRef.current = picker;
        const finishOpening = () => {
            const pickerToOpen = pickerOpeningRef.current;
            cancelPendingPickerOpen();
            if (pickerToOpen) {
                setOpenPicker(pickerToOpen);
            }
        };
        pickerKeyboardSubscriptionRef.current = Keyboard.addListener('keyboardDidHide', finishOpening);
        pickerOpenTimerRef.current = setTimeout(finishOpening, 420);
        inputRef.current?.blur();
        Keyboard.dismiss();
    }, [cancelPendingPickerOpen, closePicker, openPicker]);

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
    const handleMobilePrimaryPress = React.useCallback(() => dispatchPrimaryGesture('press'), [dispatchPrimaryGesture]);
    const handleMobilePrimaryLongPress = React.useCallback(() => dispatchPrimaryGesture('longPress'), [dispatchPrimaryGesture]);

    // The stream-talk button (DROVE-98): the speaker DROVE-83 took off the
    // composer, back as a one-tap shortcut to the same local key the channel
    // sheet row and Settings > Voice flip. A tick and a one-line toast, so the
    // change is felt as well as seen.
    const streamTalk = streamTalkButton(props.onReadAloudToggle ? props.readAloudEnabled : undefined);
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
    const handleStreamTalkPress = React.useCallback(() => {
        if (!props.onReadAloudToggle) return;
        const flipped = flipStreamTalk(!!props.readAloudEnabled, sentenceTapUsed);
        hapticsLight();
        props.onReadAloudToggle();
        showComposerToast(t(flipped.toastKey));
    }, [props.onReadAloudToggle, props.readAloudEnabled, sentenceTapUsed, showComposerToast]);

    const permissionSettingsGroups = React.useMemo<NativeSettingsMenuGroup[]>(() => {
        if (!props.onPermissionModeChange || availableModes.length === 0) {
            return [];
        }
        return [{
            key: 'permission',
            label: isCodex
                ? t('agentInput.codexPermissionMode.title')
                : isGemini
                    ? t('agentInput.geminiPermissionMode.title')
                    : t('agentInput.permissionMode.title'),
            systemImage: 'shield',
            options: availableModes.map((mode) => ({
                key: mode.key,
                label: withSandboxSuffix(getPermissionModeMenuLabel(mode), mode.key),
                disabled: mode.disabled,
            })),
            selectedKey: permissionModeKey,
            onSelect: (key) => {
                const mode = availableModes.find((candidate) => candidate.key === key);
                if (mode) handleSettingsSelect(mode);
            },
        }];
    }, [availableModes, handleSettingsSelect, isCodex, isGemini, permissionModeKey, props.onPermissionModeChange, withSandboxSuffix]);

    const modelSettingsGroups = React.useMemo<NativeSettingsMenuGroup[]>(() => {
        const groups: NativeSettingsMenuGroup[] = [];
        if (availableModels.length > 0 && props.onModelModeChange) {
            groups.push({
                key: 'model',
                label: props.modelMode?.name ?? t('agentInput.model.title'),
                title: t('agentInput.model.title'),
                systemImage: 'cube',
                options: availableModels.map((model) => ({ key: model.key, label: model.name, disabled: model.disabled })),
                selectedKey: props.modelMode?.key,
                onSelect: (key) => {
                    const model = availableModels.find((candidate) => candidate.key === key);
                    if (!model) return;
                    hapticsLight();
                    props.onModelModeChange?.(model);
                },
            });
        }
        if (availableEffortLevels.length > 0 && props.onEffortLevelChange) {
            groups.push({
                key: 'effort',
                label: props.effortLevel?.name ?? t('agentInput.effort.title'),
                title: t('agentInput.effort.title'),
                systemImage: 'bolt',
                options: availableEffortLevels.map((level) => ({ key: level.key, label: level.name, disabled: level.disabled })),
                selectedKey: props.effortLevel?.key,
                onSelect: (key) => {
                    const level = availableEffortLevels.find((candidate) => candidate.key === key);
                    // A disabled row says why the level is out of reach; it is
                    // not a pick (DROVE-101).
                    if (!level || level.disabled) return;
                    hapticsLight();
                    props.onEffortLevelChange?.(level);
                },
            });
        }
        return groups;
    }, [availableEffortLevels, availableModels, props.effortLevel?.key, props.modelMode?.key, props.onEffortLevelChange, props.onModelModeChange]);

    const modelSettingsGroup = modelSettingsGroups.find((group) => group.key === 'model');
    const effortSettingsGroup = modelSettingsGroups.find((group) => group.key === 'effort');

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
    const effortSlider = useEffortSlider({
        scale: effortScale,
        currentKey: props.effortLevel?.key ?? null,
        onCommit: props.onEffortKeyChange,
        enabled: compactMobileComposer && !!props.onEffortKeyChange,
    });
    const effortSliderOn = compactMobileComposer && !!props.onEffortKeyChange
        && effortScale.keys.length > 1;


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
                            useNativeSettingsMenus ? (
                                <NativeSettingsMenu
                                    accessibilityLabel={t('settings.title')}
                                    groups={[...permissionSettingsGroups, ...modelSettingsGroups]}
                                    style={{ width: 40, height: 40 }}
                                >
                                    <View style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
                                        <Octicons name="gear" size={16} color={theme.colors.button.secondary.tint} />
                                    </View>
                                </NativeSettingsMenu>
                            ) : (
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
                            )
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

    // The desktop picker is on the same sheet as the phone's (DROVE-147).
    // It used to be its own floating card anchored above the composer, which
    // is the shape Clay has now asked three times to stop seeing.
    const desktopPickerOpen = !useNativeSettingsMenus && !compactMobileComposer
        && openPicker === 'permission';
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

    // Channels and Add context have sheets of their own; what is left of the
    // picker is the three session controls, and it slides up on the same shell.
    const mobilePickerOpen = compactMobileComposer && !!openPicker
        && openPicker !== 'channels' && openPicker !== 'attach';


    /** Whether the `+` is there to be drawn, which is what the field's leading padding turns on. */
    const showMobileAddButton = compactMobileComposer && !props.zenMode && canAddContext;

    /**
     * THE `+`, inside the input capsule at its LEADING edge (DROVE-206).
     *
     * Clay: "the plus should be [in the message box]". DROVE-196 put it
     * outside on the field's line, which was the instruction at the time; this
     * supersedes that, and there is exactly one of it. Same disc as the send
     * button at the other rim, same 4pt inset, same bottom pin, so the field
     * reads as one capsule with a control at each end.
     *
     * NO RESTING FILL, which is the one place it does not mirror send. Two
     * reasons. DROVE-176 measured the accent as a GLYPH over the composer's
     * glass stack, and a filled disc would put it on a backdrop nothing has
     * measured; and the filled disc is already this control's OPEN state
     * (`mobileIconButtonOpen`, the same held-down step every other control
     * uses), so spending it at rest would leave the open sheet with nothing to
     * show. Send earns its fill by being the primary; the `+` is a standing
     * offer and reads as one.
     *
     * It opens the Add context sheet (DROVE-128) rather than jumping into the
     * photo library. 36 drawn plus 6 a side is a 48pt target, over DROVE-153's
     * 44pt floor, which is the same bargain the send button strikes.
     */
    const mobileAddAction = (
        <View style={styles.mobileAddAnchor}>
            <View
                style={[
                    styles.mobileAddButton,
                    openPicker === 'attach' ? styles.mobileIconButtonOpen : undefined,
                ]}
            >
                <BubblePressable
                    style={(p) => ({
                        width: '100%',
                        height: '100%',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: p.pressed ? 0.7 : 1,
                    })}
                    hitSlop={MOBILE_COMPOSER_METRICS.primaryActionSlop}
                    onPress={handleAddContextPress}
                    accessibilityRole="button"
                    accessibilityLabel={t('imageUpload.addContextTitle')}
                    accessibilityState={{ expanded: openPicker === 'attach' }}
                >
                    <Ionicons
                        name="add"
                        size={MOBILE_COMPOSER_METRICS.addIconSize}
                        color={composerPalette.accent}
                    />
                </BubblePressable>
            </View>
        </View>
    );

    /**
     * THE SEND BUTTON, inside the input capsule at its trailing edge
     * (DROVE-153, DROVE-206).
     *
     * Clay: "we should have a send button, proper button." It used to turn
     * into the waveform on an empty composer, so the same spot did two
     * unrelated things depending on what you had typed. The waveform is on the
     * control row now and this is a send button with two things it can also
     * be: Stop, on an empty composer while the agent works, and the lock when
     * the gate refuses. Both are still send unable to proceed rather than
     * other controls.
     *
     * On an empty composer it is DRAWN AND DISABLED. It is not hidden, because
     * the field reserves its 46pt at that rim either way, and a control that
     * came and went would reflow the caret on the first keystroke and flicker
     * every time Stop borrowed the slot. The reasoning is in full on
     * `AgentInputPrimaryAction`.
     *
     * Pinned to the bottom, not centred: the field grows upward as the message
     * gets longer and the button has to stay where the thumb left it.
     */
    const mobilePrimaryAction = (
        <Shaker ref={shakerRef} style={styles.mobilePrimaryAnchor}>
            <View
                style={[
                    styles.sendButton,
                    styles.mobilePrimaryButton,
                    // Stop is checked first: a blank composer on a
                    // non-steerable agent is both blocked and abortable, and it
                    // must not look locked.
                    shouldShowStopButton ? styles.mobileStopButton
                        : isSendBlocked ? styles.sendButtonLocked
                            : canSendMessage ? styles.mobilePrimaryButtonActive
                                : styles.mobilePrimaryButtonInactive,
                ]}
            >
                <BubblePressable
                    style={(p) => ({
                        width: '100%',
                        height: '100%',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: p.pressed ? 0.7 : 1,
                    })}
                    // 36 drawn plus 6 a side is a 48pt target, above the floor.
                    hitSlop={MOBILE_COMPOSER_METRICS.primaryActionSlop}
                    onPress={handleMobilePrimaryPress}
                    // Long-press: the channel sheet (DROVE-83).
                    onLongPress={handleMobilePrimaryLongPress}
                    disabled={!canPressSendButton}
                    accessibilityRole="button"
                    // It is a send button (DROVE-206). Stop is the one face
                    // that is genuinely another action, and it only appears on
                    // an empty composer while the agent is working.
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
                        <Octicons
                            name="arrow-up"
                            size={16}
                            color={canPressSendButton ? activeSendIconColor : theme.colors.textSecondary}
                            // The color has to travel in `style`, not just the
                            // `color` prop: @expo/vector-icons builds
                            // `[styleDefaults, style, ...]` (create-icon-set.js),
                            // so a `style` entry always wins over `color`. With
                            // styles.sendButtonIcon here — it hardcodes the
                            // primary tint (white) — the computed color was
                            // discarded and the arrow painted white on the
                            // near-white glass composer, i.e. invisible.
                            style={{
                                color: canPressSendButton ? activeSendIconColor : theme.colors.textSecondary,
                                marginTop: Platform.OS === 'web' ? 2 : 0,
                            }}
                        />
                    )}
                </BubblePressable>
            </View>
        </Shaker>
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
                    open={compactMobileComposer && openPicker === 'channels'}
                    onClose={closePicker}
                />

                {/* Camera, Photos, Files (DROVE-128), on the same shell. */}
                <AddContextSheet
                    open={compactMobileComposer && openPicker === 'attach'}
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
                                        {availableModes.map((mode) => {
                                            const isSelected = permissionModeKey === mode.key;
                                            return (
                                                <BubblePressable
                                                    key={mode.key}
                                                    disabled={!props.onPermissionModeChange || mode.disabled}
                                                    onPress={() => handleSettingsSelect(mode)}
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
                        bubble's rims up with the control row and the recording
                        banner (DROVE-157). */}
                    <View style={compactMobileComposer ? styles.mobileComposerLine : undefined}>
                    <View style={[
                        compactMobileComposer && styles.unifiedPanelShadow,
                        compactMobileComposer && styles.mobileUnifiedPanelShadow,
                        compactMobileComposer && styles.mobileBubbleShell,
                    ]}>
                        {/* The slab is real Liquid Glass now, not a blur with a
                            flat colour over it (DROVE-153). `frosted` painted
                            rgba(20,20,22,0.82) on top of a blur, and a blur of a
                            black chat is black, so what Clay photographed was
                            the overlay: a flat dark grey slab. `liquid` renders
                            GlassView, which is a UIVisualEffectView carrying a
                            UIGlassEffect, and `regular` is the style the system
                            uses for its own floating controls. Legibility does
                            not depend on the material: the transcript is masked
                            to nothing before it reaches the card (DROVE-168,
                            resolveTranscriptMask), so the glass has a known
                            surface under it rather than whatever the chat is
                            showing. It is the page itself now rather than a
                            painted slab, and the card takes its separation from
                            the measured chrome tint (DROVE-171). */}
                        <MobileGlassSurface
                            enabled={compactMobileComposer}
                            nativeEffect
                            material="liquid"
                            glassEffectStyle="regular"
                            intensity={92}
                            style={[
                                styles.unifiedPanel,
                                compactMobileComposer && styles.mobileUnifiedPanel,
                            ]}
                        >
                    {/* Attachment preview strip */}
                    {props.selectedImages && props.selectedImages.length > 0 && (
                        <View style={compactMobileComposer ? styles.mobileAttachmentInset : undefined}>
                            <AgentInputAttachmentStrip
                                images={props.selectedImages}
                                onRemove={props.onRemoveImage ?? (() => {})}
                            />
                        </View>
                    )}
                    {/* Input field */}
                    <View style={[
                        styles.inputContainer,
                        compactMobileComposer && styles.mobileInputContainer,
                        compactMobileComposer && !showMobileAddButton
                            && styles.mobileInputContainerNoAdd,
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
                        {/* One control at each rim of the field, both
                            absolutely positioned against it and both pinned to
                            its bottom (DROVE-206). */}
                        {showMobileAddButton ? mobileAddAction : null}
                        {compactMobileComposer ? mobilePrimaryAction : null}
                    </View>

                    {compactMobileComposer ? null : desktopActionControls}
                        </MobileGlassSurface>
                    </View>
                    </View>

                    {compactMobileComposer ? (
                    /* The control row, OUTSIDE the bubble (DROVE-196). Clay:
                        "the second row buttons should sit outside the speech
                        bubble." Mode, effort and model, then the audio pair on
                        the right (DROVE-111, DROVE-153, DROVE-178, and
                        DROVE-98 put the speaker back). They are settings for
                        the session rather than part of the message, so the
                        card is the message and these are furniture under it.

                        Nothing about the controls changed: 44pt targets, 40pt
                        chips inside them, DROVE-176's colours. What changed is
                        the surface behind them, from the card's glass to the
                        dock's own frame, which each of them can carry because
                        each already draws glass of its own. The row keeps the
                        shell gutter itself and an 8pt gap under it, which is
                        the card's old bottom padding still holding the status
                        row's tap targets off these buttons. */
                    <>
                    <View style={styles.mobileControlRow}>
                        {/* Mode, effort and model: three segments in one glass
                            capsule (DROVE-153, DROVE-178), three pickers, one
                            tap each (DROVE-111). The name is drawn in full and
                            scales rather than truncating. */}
                        {!props.zenMode && (
                            <ComposerSessionControls
                                label={sessionPillLabel}
                                modeKind={isSandboxedYoloMode ? 'safe-yolo' : displayPermissionMode?.semanticKind}
                                modeKey={permissionModeKey}
                                effortIndex={effortIndex}
                                effortCount={effortScale.keys.length}
                                onPress={handleSessionControlPress}
                                nativeMenus={useNativeSettingsMenus}
                                modeGroups={permissionSettingsGroups}
                                effortGroup={effortSliderOn ? null : effortSettingsGroup}
                                effortSlider={effortSliderOn ? effortSlider : null}
                                effortScale={effortSliderOn ? effortScale : null}
                                modelGroup={modelSettingsGroup}
                                openPicker={openPicker === 'permission' || openPicker === 'effort'
                                    || openPicker === 'model'
                                    ? openPicker
                                    : null}
                                pending={props.pendingModes ? {
                                    permission: props.pendingModes.permissionMode,
                                    effort: props.pendingModes.effortLevel,
                                    model: props.pendingModes.modelMode,
                                } : null}
                            />
                        )}

                        <View style={{ flex: 1 }} />

                        {/* The audio group, in ONE capsule (DROVE-153).
                            Clay's Screenshot-toolbar reference groups related
                            actions into a single capsule rather than separate
                            circles, and these are the audio ones: what the
                            session hears from a live voice turn, what it says
                            out loud, and what it hears from the mic.

                            The WAVEFORM is the third of them, at the head of
                            the capsule, and it is new here (DROVE-206). Clay:
                            "the boss should not be in the message box." It was
                            the face the send button wore on an empty composer,
                            which made one spot on the screen two controls
                            depending on what you had typed. It is an audio
                            control, so it belongs with the other two, and the
                            row does not grow for it: a 44pt control on a 44pt
                            row. Each third is still its own 44pt target. */}
                        {(showBossButton || streamTalk.shown || props.onTalkPressIn) ? (
                        <GlassChromeSurface
                            radius={MOBILE_COMPOSER_METRICS.actionSize / 2}
                            interactive
                            style={styles.mobileAudioCapsule}
                        >
                        {showBossButton && (
                            <BubblePressable
                                onPress={handleMicrophonePress}
                                style={styles.mobileIconButton}
                                accessibilityRole="button"
                                accessibilityLabel="Voice"
                                accessibilityState={{ selected: !!props.isMicActive }}
                            >
                                {/* Neutral at rest, DROVE-142's recording red
                                    once the turn is live (DROVE-176). A live
                                    voice turn is a live mic, which is the
                                    entry the vocabulary already has, so this
                                    needed no new colour and reads the same
                                    helper the mic beside it does. */}
                                {props.isMicActive ? (
                                    <Ionicons
                                        name="mic"
                                        size={20}
                                        color={micColour(composerPalette, 'latched')}
                                    />
                                ) : (
                                    <Image
                                        source={require('@/assets/images/icon-voice-white.png')}
                                        style={{ width: 22, height: 22 }}
                                        tintColor={micColour(composerPalette, 'idle')}
                                    />
                                )}
                            </BubblePressable>
                        )}
                        {showBossButton && (streamTalk.shown || props.onTalkPressIn) ? (
                            <View style={styles.mobileAudioDivider} />
                        ) : null}
                        {streamTalk.shown && (
                            <BubblePressable
                                onPress={handleStreamTalkPress}
                                style={[
                                    styles.mobileIconButton,
                                    streamTalk.on && styles.mobileIconButtonOn,
                                ]}
                                accessibilityRole="button"
                                accessibilityState={{ selected: streamTalk.on }}
                                accessibilityLabel={t(streamTalk.labelKey)}
                            >
                                {/* The speaker is the one control whose FILL
                                    already carries the state (DROVE-118): on
                                    is a solid accent disc, so the glyph on it
                                    is the tint that reads against that disc,
                                    not a colour of its own. Off it is neutral
                                    like the rest of the row (DROVE-176). */}
                                <Ionicons
                                    name={streamTalk.icon}
                                    size={16}
                                    color={streamTalk.on
                                        ? theme.colors.button.primary.tint
                                        : composerPalette.neutral}
                                />
                            </BubblePressable>
                        )}
                        {streamTalk.shown && props.onTalkPressIn ? (
                            <View style={styles.mobileAudioDivider} />
                        ) : null}

                        {talkWiring && (
                            // The gesture and the slide-off live in
                            // TalkButton (DROVE-105); this row only says
                            // where it sits and what it is drawn in.
                            //
                            // The handlers go in BY REFERENCE, never wrapped
                            // in a lambda (DROVE-210). See talkButtonWiring.ts
                            // for what a wrapper costs.
                            <TalkButton
                                state={props.talkState ?? 'idle'}
                                onPressIn={talkWiring.onPressIn}
                                onPressOut={talkWiring.onPressOut}
                                onSlide={talkWiring.onSlide}
                                style={styles.mobileIconButton}
                                heldStyle={styles.talkButtonHeld}
                                latchedStyle={styles.talkButtonLatched}
                                // Neutral at rest, the recording red once it
                                // is latched or held, which is DROVE-142's
                                // banner red so the glyph and the bar under it
                                // are one signal (DROVE-176).
                                idleColor={micColour(composerPalette, 'idle')}
                                activeColor={micColour(composerPalette, 'latched')}
                            />
                        )}
                        </GlassChromeSurface>
                        ) : null}
                    </View>
                    </>
                    ) : null}
                </Shaker>

                {/* The strip under the composer, and both things that live
                    in it. It is under the CONTROL ROW now rather than under
                    the card (DROVE-196) and its box did not move a point for
                    it: 6pt of padding over an 18pt line, 24 in total, with the
                    row keeping its own 8pt clear above.
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
                    timer and its sheets survive the recording. The mic button
                    on the action row is still the only control that stops or
                    sends (DROVE-105) and it has not moved. */}
                <View style={compactMobileComposer && props.talk?.active
                    ? { minHeight: COMPOSER_STRIP_HEIGHT }
                    : undefined}
                >
                    <AgentInputStatusRow
                        sessionId={props.sessionId}
                        connectionStatus={props.connectionStatus}
                        contextStatus={contextStatus}
                        weekPercent={weekPercent}
                        usageBarGroups={usageBarGroups}
                        usageBarFooter={usageBarFooter}
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
