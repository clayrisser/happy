import * as React from 'react';
import { ActivityIndicator, Keyboard, LayoutChangeEvent, Modal as RNModal, Platform, Pressable, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
    Easing,
    Extrapolation,
    interpolate,
    interpolateColor,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSequence,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { ComposerBubble } from './ComposerBubble';
import { ComposerControlButton } from './ComposerControlButton';
import { ComposerSessionControls, type ComposerSessionPicker } from './ComposerSessionControls';
import { ComposerPickerSheet, type ComposerPickerOption } from './ComposerPickerSheet';
import { COMPOSER_IN_FIELD_DISC } from './composerControlColour';
import { COMPOSER_BUBBLE_CONTROLS_SLOT_GEOMETRY } from './composerBubbleLayout';
import { audioOutButton } from './composerAudioOut';
import { homeComposerCapsule, homeHarnessOptions, resolveHarnessPick } from './homeComposer';
import { AgentInputAttachmentStrip } from './AgentInputAttachmentStrip';
import { Typography } from '@/constants/Typography';
import { layout } from './layout';
import { t } from '@/text';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useAllMachines, useSessions, useSetting } from '@/sync/storage';
import { getCodeAgentDefaults, resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { formatLastSeen, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { listWorktrees } from '@/utils/worktree';
import { collectSessionPlaces, collectSessionWorkspaces } from '@/sync/agentSessionPlaces';
import {
    collectMachineChoices,
    findMachineChoice,
    resolveChoiceAgent,
    resolveWorktreeCreationMachine,
} from '@/sync/machineChoices';
import type { Session } from '@/sync/storageTypes';
import {
    getEffortLevelsForModel,
    getEffortLevelsForPicker,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    filterPermissionModesForCli,
    getSupportsWorktree,
    includeConfiguredModel,
    type ModeOption,
} from './modelModeOptions';
import type { NewSessionAgentType } from '@/sync/persistence';
import { useImagePicker } from '@/hooks/useImagePicker';
import { Modal } from '@/modal';
import { resolveMultiTextInputLayout } from './multiTextInputLayout';
import {
    resolveCustomProjectPathSelection,
    resolveHomeDockBackdropPressAction,
    resolveHomeDockMachineSelection,
    resolveHomeDockPickerBackAction,
    resolveHomeDockPromptPlaceholder,
} from './homeDockInteraction';
import { registerHomeDockFocusListener, useHomeDockFocusStore } from './homeDockFocus';
import {
    resolveNewSessionPrimaryAction,
    resolveNewSessionProgressLabel,
    type NewSessionStartPhase,
} from './newSessionProgress';
import { StatusDot } from './StatusDot';
import { Shaker, type ShakeInstance } from './Shaker';
import { hapticsError } from './haptics';
import { getHarnessName } from '@/utils/harnessCatalog';
import { getRigMachineSessionCreation } from '@/sync/rigSessionCreation';
import {
    MobileHeaderScrim,
    MOBILE_HOME_SCRIM_OVERLAY_OPACITY,
} from './navigation/MobileHeaderScrim';
import {
    MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
    MOBILE_COMPOSER_LAYOUT,
    MOBILE_COMPOSER_METRICS,
    resolveMobileComposerActionGeometry,
    resolveMobileHomeComposerHeight,
    resolveMobileHomeFieldHeight,
} from './agentInputLayout';

type EnvironmentSetting = 'machine' | 'project' | 'worktree';
type AgentSetting = 'agent' | 'model' | 'permission' | 'effort';
type PickerPage = EnvironmentSetting | AgentSetting;

const CUSTOM_PROJECT_PATH_KEY = '__custom_project_path__';

const MOBILE_PRIMARY_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('primary');
const MOBILE_HOME_DOCK_TOP_PADDING = 8;
// The air the list keeps clear under the resting dock: the dock's top padding,
// the bubble at rest, and the room the safe area and the shadow take below it.
export const MOBILE_HOME_DOCK_CONTENT_INSET = MOBILE_HOME_DOCK_TOP_PADDING
    + MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT
    + 44;
// Sits in the gap the focused dock already leaves above the composer, so it
// costs no layout: showing it must not move the pickers or the composer.
const START_PROGRESS_ROW_HEIGHT = 18;
// Matches Shaker's own keyframes so a refused picker reads the same as every
// other refusal in the app.
const SHAKE_KEYFRAMES = [3, -3, 3, -3, 0];

const styles = StyleSheet.create((theme) => ({
    keyboardFollower: {
        width: '100%',
    },
    // Keep the content clear until the composer's midpoint. From there the
    // bottom scrim begins feathering over content that scrolls beneath it;
    // above that point the composer shadow provides the only separation.
    bottomBackdrop: {
        ...StyleSheet.absoluteFillObject,
        top: MOBILE_HOME_DOCK_TOP_PADDING
            + MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT / 2,
    },
    safeArea: {
        paddingHorizontal: 16,
        paddingTop: MOBILE_HOME_DOCK_TOP_PADDING,
    },
    // The focused composer replaces the resting one rather than covering it:
    // the modal sits a safe-area inset higher, so leaving this on screen showed
    // its send button peeking out below. `display` rather than `opacity` because
    // an ancestor below full alpha kills the native blur underneath.
    safeAreaBehindFocus: {
        display: 'none',
    },
    // The entry's field: the focused field's own type, as a line of text
    // rather than an input, because the whole bubble is the button (DROVE-394).
    entryPlaceholder: {
        color: theme.colors.textSecondary,
    },
    /**
     * What is left of Home's own composer card (DROVE-345): where it sits, and
     * the dense tint an Android without the material needs. The SHAPE — the
     * radius, the padding, the two rows, the clip — is `ComposerBubble`'s, and
     * restating any of it here is what let this screen drift away from the
     * chat's through five glass tickets.
     */
    focusedComposerSurface: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    focusedComposerAnimationShell: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        overflow: 'hidden',
    },
    focusedComposerShadow: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: theme.dark ? 6 : 2 },
        shadowOpacity: theme.dark ? 0.22 : 0.08,
        shadowRadius: theme.dark ? 16 : 8,
        elevation: theme.dark ? 4 : 2,
    },
    focusedComposerAnchored: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusedInput: {
        flex: 1,
        width: '100%',
        maxHeight: MOBILE_COMPOSER_METRICS.inputMaxHeight,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
        color: theme.colors.text,
        fontSize: MOBILE_COMPOSER_METRICS.inputFontSize,
        lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
        textAlignVertical: 'top',
        ...Typography.default(),
    },
    focusedInputMeasurement: {
        position: 'absolute',
        left: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingLeft,
        right: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingRight,
        opacity: 0,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
        fontSize: MOBILE_COMPOSER_METRICS.inputFontSize,
        lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
        ...Typography.default(),
    },
    focusedInputReveal: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 0,
        paddingLeft: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingLeft,
        paddingRight: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingRight,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    },
    primaryActionFlash: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: MOBILE_PRIMARY_ACTION_GEOMETRY.borderRadius,
        backgroundColor: theme.dark ? '#4A4A4E' : '#FFFFFF',
    },
    modalRoot: {
        flex: 1,
    },
    modalBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusBackdropDim: {
        backgroundColor: theme.dark ? 'rgba(0, 0, 0, 0.88)' : 'rgba(255, 255, 255, 0.88)',
    },
    focusDock: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusConfig: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: 24,
        // Clears the status line that sits below it, which is placed out of
        // layout: the pickers hold this gap open whether or not it is filled.
        paddingBottom: START_PROGRESS_ROW_HEIGHT + 4,
        gap: 8,
    },
    focusConfigGroup: {
        gap: 1,
    },
    focusConfigRevealRow: {
        width: '100%',
    },
    focusInlineSurface: {
        maxHeight: 220,
    },
    focusConfigRow: {
        minHeight: 42,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 6,
        borderRadius: 12,
    },
    // One fixed square per icon, with the glyph centred inside it. The square is
    // what the row lays out against, so the label after it starts at the same x
    // on every row no matter which glyph is in the box or how wide it draws.
    focusConfigIcon: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        flexGrow: 0,
        flexShrink: 0,
    },
    focusConfigValue: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    focusComposerArea: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    // A plain sheet of glass over the controls that are settled for this
    // session. It blocks the touch — including the SwiftUI hosts the native
    // menus mount, which nothing in React Native can disable — without tinting
    // what is underneath, and turns the press into a shake.
    pressBlocker: {
        ...StyleSheet.absoluteFillObject,
    },
    composerPressBlocker: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        // Stops at the action row's top edge so the row's own blocker can leave
        // the send button, which is now Stop, reachable. Absolute children
        // measure from the padding box, so the shell's bottom padding counts.
        bottom: MOBILE_COMPOSER_METRICS.actionRowHeight + MOBILE_COMPOSER_METRICS.shellPaddingBottom,
    },
    // Reads like the session status row above the chat composer: one pulsing
    // dot and one line saying what is happening now. Absolutely placed in the
    // gap above the composer so that showing it moves nothing on the screen.
    // Absolute children measure from the padding box, so the inset the composer
    // gets from `focusComposerArea` is restated here to reach the same bounds.
    startProgressRow: {
        position: 'absolute',
        left: 16,
        right: 16,
        top: -START_PROGRESS_ROW_HEIGHT,
        height: START_PROGRESS_ROW_HEIGHT,
        alignItems: 'center',
    },
    // Sits inside the composer's own width, then insets by the same 16 the
    // session status bar uses inside its composer, so both screens hold their
    // status line the same distance from the shell on either side.
    startProgressContent: {
        width: '100%',
        maxWidth: layout.maxWidth,
        height: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 16,
    },
    startProgressText: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default(),
    },
    startProgressHint: {
        flexShrink: 0,
        marginLeft: 'auto',
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default(),
    },
}));

function resolveOption(options: ModeOption[], preferred: Array<string | null | undefined>): ModeOption | null {
    for (const key of preferred) {
        const option = options.find((candidate) => candidate.key === key);
        if (option) return option;
    }
    return options[0] ?? null;
}

function shakeOnce(value: SharedValue<number>) {
    value.value = withSequence(
        ...SHAKE_KEYFRAMES.map((offset) => withTiming(offset, { duration: 50 })),
    );
}

/**
 * One control that refuses its own presses while a session is being created.
 *
 * The refusal is per control rather than per region so only the thing actually
 * touched shakes: the answer is about what was pressed. The blocker is a plain
 * transparent sheet because a native menu mounts a SwiftUI host that no React
 * Native `disabled` prop can reach, and it is a later sibling so it paints and
 * hits over the control it covers.
 */
function RefusableControl({
    refusing,
    onRefuse,
    slot,
    children,
}: {
    refusing: boolean;
    onRefuse: () => void;
    /**
     * What this wrapper owes the row it stands in (DROVE-375).
     *
     * A disc is fixed-size and a bare view round it is invisible to the layout.
     * The CAPSULE is the action row's flexible child, and a bare view round
     * THAT swallows the flex — so the slot the wrapper is filling is passed in
     * and spread on it. See `resolveComposerControlsSlotGeometry`.
     */
    slot?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}) {
    const shake = useSharedValue(0);
    const shakeStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: shake.value }],
    }));
    return (
        <Animated.View style={[slot, shakeStyle]}>
            {children}
            {refusing && (
                <Pressable
                    style={styles.pressBlocker}
                    onPress={() => {
                        shakeOnce(shake);
                        onRefuse();
                    }}
                />
            )}
        </Animated.View>
    );
}

/**
 * One picker row, which also does its own refusing while a session is starting.
 *
 * The refusal reuses the row's own animated view rather than wrapping it, so
 * nothing is added to the tree and the row's layout is untouched either way.
 */
function FocusConfigRevealRow({
    progress,
    index,
    refusing,
    onRefuse,
    children,
}: {
    progress: SharedValue<number>;
    index: number;
    refusing?: boolean;
    onRefuse?: () => void;
    children: React.ReactNode;
}) {
    const shake = useSharedValue(0);
    const revealStyle = useAnimatedStyle(() => {
        const start = 0.18 + index * 0.09;
        const end = start + 0.28;
        const reveal = interpolate(
            progress.value,
            [start, end],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [
                { translateY: 10 * (1 - reveal) },
                { translateX: shake.value },
            ],
        };
    }, [index]);

    return (
        <Animated.View style={[styles.focusConfigRevealRow, revealStyle]}>
            {children}
            {refusing && (
                <Pressable
                    style={styles.pressBlocker}
                    onPress={() => {
                        shakeOnce(shake);
                        onRefuse?.();
                    }}
                />
            )}
        </Animated.View>
    );
}

export const HomeDock = React.memo(({
    prompt,
    onPromptChange,
    onSubmit,
    isSubmitting,
    submitPhase,
    onSubmitCancel,
    showBottomBackdrop = true,
}: {
    prompt: string;
    onPromptChange: (prompt: string) => void;
    onSubmit: () => Promise<boolean>;
    isSubmitting: boolean;
    /** Which step of session creation is running, shown above the composer. */
    submitPhase?: NewSessionStartPhase | null;
    /** Stops session creation, the way the session composer stops the agent. */
    onSubmitCancel?: () => void;
    showBottomBackdrop?: boolean;
}) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const keyboard = useReanimatedKeyboardAnimation();
    const focusedInputRef = React.useRef<TextInput>(null);
    const mountedRef = React.useRef(true);
    const focusAnimationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // A row's tail work, run once the picker sheet's Modal is off the screen:
    // a prompt raised under a sheet still sliding out comes up behind it.
    const afterPickerSheetRef = React.useRef<(() => void) | null>(null);
    const focusPresentation = useSharedValue(0);
    const [isFocused, setIsFocused] = React.useState(false);
    const [focusModeVisible, setFocusModeVisible] = React.useState(false);
    const [focusedInputContentHeight, setFocusedInputContentHeight] = React.useState(0);
    const [sheetPage, setSheetPage] = React.useState<PickerPage | null>(null);
    const { selectedImages, pickImages, removeImage, clearImages } = useImagePicker();
    const agentType = useNewSessionDraft((state) => state.agentType);
    const selectedMachineId = useNewSessionDraft((state) => state.selectedMachineId);
    const selectedPath = useNewSessionDraft((state) => state.selectedPath);
    const sessionType = useNewSessionDraft((state) => state.sessionType);
    const worktreeKey = useNewSessionDraft((state) => state.worktreeKey);
    const permissionMode = useNewSessionDraft((state) => state.permissionMode);
    const modelMode = useNewSessionDraft((state) => state.modelMode);
    const effortLevel = useNewSessionDraft((state) => state.effortLevel);
    const setMachineId = useNewSessionDraft((state) => state.setMachineId);
    const renameMachineId = useNewSessionDraft((state) => state.renameMachineId);
    const setAgentType = useNewSessionDraft((state) => state.setAgentType);
    const setPath = useNewSessionDraft((state) => state.setPath);
    const setSessionType = useNewSessionDraft((state) => state.setSessionType);
    const setWorktreeKey = useNewSessionDraft((state) => state.setWorktreeKey);
    const setPermissionMode = useNewSessionDraft((state) => state.setPermissionMode);
    const setModelMode = useNewSessionDraft((state) => state.setModelMode);
    const setEffortLevel = useNewSessionDraft((state) => state.setEffortLevel);
    const draftReadAloud = useNewSessionDraft((state) => state.readAloud);
    const setDraftReadAloud = useNewSessionDraft((state) => state.setReadAloud);
    const defaultOverrides = useSetting('agentDefaultOverrides');
    const machines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();
    // A person picks a computer, not a daemon. Happy CLI and Happy Agent each register a machine
    // for the same laptop, so the pair is offered once and the agent settles which one runs.
    const machineChoices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const selectedChoice = React.useMemo(
        () => findMachineChoice(machineChoices, selectedMachineId),
        [machineChoices, selectedMachineId],
    );
    const machineOptions = React.useMemo<ModeOption[]>(() => (
        [...machineChoices]
            .sort((left, right) => Number(right.online) - Number(left.online))
            .map((choice) => ({
                key: choice.id,
                name: choice.name,
                description: choice.online
                    ? t('status.online')
                    : t('status.lastSeen', { time: formatLastSeen(choice.activeAt, false) }),
            }))
    ), [machineChoices]);
    const currentMachine = resolveOption(machineOptions, [selectedChoice?.id]);
    // A draft made before the pair was coalesced may still name Happy Agent's own machine, so the
    // selection is rewritten to the computer it belongs to rather than reset to the first one.
    const resolvedMachineId = resolveHomeDockMachineSelection(
        selectedChoice?.id ?? selectedMachineId,
        machineOptions.map((machine) => machine.key),
    );
    const selectedHomeDir = selectedChoice?.happyMachine?.metadata?.homeDir
        ?? selectedChoice?.rigMachine?.metadata?.homeDir;

    React.useEffect(() => {
        if (resolvedMachineId !== selectedMachineId) {
            renameMachineId(resolvedMachineId);
        }
    }, [resolvedMachineId, selectedMachineId, renameMachineId]);

    // The places on this computer belong to the pair rather than to whichever daemon opened them
    // first, so both machines are read for directories and for the catalogs they publish.
    const placeMachineIds = React.useMemo(
        () => selectedChoice?.machineIds ?? [],
        [selectedChoice],
    );
    const sessionList = React.useMemo<Session[]>(
        () => (sessions ?? []).filter((item): item is Session => typeof item !== 'string'),
        [sessions],
    );
    const places = React.useMemo(
        () => collectSessionPlaces({
            machineIds: placeMachineIds,
            selectedPath: selectedPath ?? '~',
            sessions: sessionList,
        }),
        [placeMachineIds, selectedPath, sessionList],
    );
    const projectOptions = React.useMemo<ModeOption[]>(() => {
        const homeDir = selectedHomeDir;
        return places.map((place) => {
            const relative = formatPathRelativeToHome(place.path, homeDir);
            // A project names itself; a bare directory is named by where it is.
            const name = place.projectId ? place.name : relative;
            return {
                key: place.key,
                name,
                description: name === place.path ? undefined : relative,
            };
        });
    }, [places, selectedHomeDir]);
    const selectedProjectId = React.useMemo(
        () => places.find((place) => place.path === selectedPath)?.projectId ?? null,
        [places, selectedPath],
    );
    const currentProject = resolveOption(projectOptions, [selectedPath, '~']);
    // Happy Agent's half of this computer, and only this computer's: a session asked for here is
    // never handed to a daemon somewhere else because that one happened to be reachable.
    const rigSelectionMachine = selectedChoice?.rigMachine ?? null;
    const rigSelectionCreation = React.useMemo(
        () => getRigMachineSessionCreation(rigSelectionMachine?.metadata),
        [rigSelectionMachine],
    );
    const rigCreation = agentType === 'rig' ? rigSelectionCreation : null;
    const happyCliVersion = selectedChoice?.happyMachine?.metadata?.happyCliVersion;
    const supportsWorktree = rigCreation?.supportsWorktrees
        ?? (agentType === 'rig' ? false : getSupportsWorktree(agentType));
    const selectedWorktreeKey = sessionType === 'worktree'
        ? worktreeKey ?? '__new__'
        : '__none__';
    const [existingWorktrees, setExistingWorktrees] = React.useState<ModeOption[]>([]);
    const agentWorkspaces = React.useMemo(
        () => collectSessionWorkspaces({
            machineIds: placeMachineIds,
            projectId: selectedProjectId,
            sessions: sessionList,
        }),
        [placeMachineIds, selectedProjectId, sessionList],
    );

    React.useEffect(() => {
        const path = resolveAbsolutePath(selectedPath ?? '~', selectedHomeDir);

        // A Happy Agent project keeps its own workspaces, each with a name somebody chose. Those
        // are better than the branches git reports, so git is only asked when nothing knows better.
        // Starting in one only needs its directory, so this does not wait on the worktree
        // capability the daemon advertises for making new ones.
        if (selectedProjectId) {
            setExistingWorktrees(agentWorkspaces.map((workspace) => ({
                key: workspace.key,
                name: workspace.name,
                description: workspace.path,
            })));
            return;
        }

        // Only Happy CLI's daemon answers the worktree RPC, so it is asked directly rather than
        // through whichever machine the draft happens to name.
        const happyMachine = selectedChoice?.happyMachine ?? null;
        if (!supportsWorktree || !happyMachine || !isMachineOnline(happyMachine) || !path) {
            setExistingWorktrees([]);
            return;
        }

        let cancelled = false;
        listWorktrees(happyMachine.id, path).then((worktrees) => {
            if (cancelled) return;
            setExistingWorktrees(worktrees.map((worktree) => ({
                key: worktree.path,
                name: worktree.branch,
                description: worktree.path,
            })));
        });
        return () => {
            cancelled = true;
        };
    }, [agentWorkspaces, selectedChoice, selectedHomeDir, selectedPath, selectedProjectId, supportsWorktree]);

    // Happy Agent calls these workspaces, and names them; git calls them worktrees.
    const picksWorkspaces = selectedProjectId !== null;
    const worktreeCreationMachine = React.useMemo(
        () => resolveWorktreeCreationMachine(selectedChoice, agentType, supportsWorktree),
        [agentType, selectedChoice, supportsWorktree],
    );
    // Happy Agent can ask its paired Happy CLI daemon to create the checkout
    // even when its own machine metadata does not advertise worktrees.
    const canCreateWorktree = supportsWorktree
        || (picksWorkspaces && worktreeCreationMachine !== null);

    React.useEffect(() => {
        if (!supportsWorktree && !picksWorkspaces && sessionType === 'worktree') {
            setSessionType('simple');
            setWorktreeKey(null);
        }
    }, [picksWorkspaces, sessionType, setSessionType, setWorktreeKey, supportsWorktree]);

    const worktreeOptions = React.useMemo<ModeOption[]>(() => {
        if (!supportsWorktree && !picksWorkspaces) {
            return [{
                key: '__none__',
                name: 'No worktree',
                description: `Not supported by ${getHarnessName(agentType)}`,
            }];
        }
        const options: ModeOption[] = [
            // Starting in no workspace means starting in the project's own
            // checkout, which is a place with a name rather than an absence.
            { key: '__none__', name: picksWorkspaces ? 'Main' : 'No worktree' },
            // Making one is a separate ability from starting in one that already exists.
            ...(canCreateWorktree
                ? [{ key: '__new__', name: picksWorkspaces ? 'Create New' : 'Create new worktree' }]
                : []),
            ...existingWorktrees,
        ];
        if (
            worktreeKey
            && !options.some((option) => option.key === worktreeKey)
        ) {
            options.push({ key: worktreeKey, name: worktreeKey });
        }
        return options;
    }, [agentType, canCreateWorktree, existingWorktrees, picksWorkspaces, supportsWorktree, worktreeKey]);
    const currentWorktree = resolveOption(worktreeOptions, [selectedWorktreeKey]);
    const availableAgents = React.useMemo<ModeOption[]>(
        () => homeHarnessOptions(selectedChoice, agentType),
        [agentType, selectedChoice],
    );
    const resolvedAgentType = resolveChoiceAgent(selectedChoice, agentType);
    const defaults = React.useMemo(() => rigCreation
        ? {
            permissionMode: rigCreation.defaultPermissionMode ?? '',
            modelMode: rigCreation.defaultModelKey ?? '',
            effortLevel: rigCreation.defaultEffortForModel(rigCreation.defaultModelKey),
        }
        : resolveAgentDefaultConfig(defaultOverrides, agentType, happyCliVersion), [agentType, defaultOverrides, happyCliVersion, rigCreation]);
    const permissionOptions = React.useMemo(
        // The CLI daemon on the picked computer is what will parse the mode;
        // older CLIs drop the whole prompt on modes they do not know (`auto`).
        () => rigCreation?.permissionModes ?? filterPermissionModesForCli(
            getHardcodedPermissionModes(agentType, t),
            happyCliVersion,
        ),
        [agentType, happyCliVersion, rigCreation],
    );
    const modelOptions = React.useMemo(
        () => rigCreation?.models ?? includeConfiguredModel(
            agentType,
            getHardcodedModelModes(agentType, t),
            defaults.modelMode,
        ),
        [agentType, defaults.modelMode, rigCreation],
    );
    // The code default last: when the saved and configured modes were both
    // filtered out for an old CLI, land there rather than on whichever mode
    // happens to lead the list.
    const currentPermission = resolveOption(permissionOptions, [
        permissionMode,
        defaults.permissionMode,
        rigCreation ? null : getCodeAgentDefaults(agentType, happyCliVersion).permissionMode,
    ]);
    const currentModel = resolveOption(modelOptions, [modelMode, defaults.modelMode]);
    const effortOptions = React.useMemo(
        () => rigCreation
            ? rigCreation.effortsForModel(currentModel?.key).map((key) => ({ key, name: key }))
            : getEffortLevelsForModel(agentType, currentModel?.key ?? 'default'),
        [agentType, currentModel?.key, rigCreation],
    );
    // The sheet lists one row more than the model can run: a level out of reach
    // on this model stays, disabled, with the models that do support it
    // (DROVE-101). Selection below stays on effortOptions.
    const effortPickerOptions = React.useMemo(
        () => rigCreation
            ? effortOptions
            : getEffortLevelsForPicker(agentType, currentModel?.key ?? 'default'),
        [agentType, currentModel?.key, rigCreation, effortOptions],
    );
    const currentEffortDefault = rigCreation?.defaultEffortForModel(currentModel?.key)
        ?? defaults.effortLevel;
    const currentEffort = resolveOption(effortOptions, [effortLevel, currentEffortDefault]);
    const currentAgent = availableAgents.find((agent) => agent.key === agentType)
        ?? availableAgents[0]
        ?? { key: agentType, name: getHarnessName(agentType) };
    /**
     * WHAT THE COMPOSER'S CAPSULE READS (DROVE-345, DROVE-394).
     *
     * Decided once in `homeComposerCapsule` and mounted twice: on the
     * sessions-list entry, disabled, and on the sheet. The speaker is the
     * fourth segment now, because the session composer draws one and this is
     * that composer: it arms reading for the session about to start.
     */
    const composerDiscFill = theme.dark ? COMPOSER_IN_FIELD_DISC.dark : COMPOSER_IN_FIELD_DISC.light;
    const capsule = homeComposerCapsule({
        agent: { key: currentAgent.key as NewSessionAgentType, name: currentAgent.name },
        permission: currentPermission,
        permissionOptions,
        model: currentModel,
        modelOptions,
        effort: currentEffort,
        effortOptions,
        effortPickerOptions,
    });
    const audioOut = audioOutButton({ readAloudEnabled: draftReadAloud });
    const readAloudSegment = {
        glyph: audioOut.glyph,
        fill: audioOut.fill,
        on: audioOut.on,
        accessibilityLabel: t(audioOut.labelKey),
        onPress: () => setDraftReadAloud(!draftReadAloud),
    };
    const focusedPromptPlaceholder = resolveHomeDockPromptPlaceholder(currentAgent.key, currentAgent.name);
    const canSubmit = !isSubmitting && (
        prompt.trim().length > 0 || selectedImages.length > 0
    );
    const startPhase = isSubmitting ? submitPhase ?? 'spawning' : null;
    const startProgressLabel = resolveNewSessionProgressLabel({
        phase: startPhase,
        agentName: currentAgent.name,
        picksWorkspaces,
    });
    const primaryAction = resolveNewSessionPrimaryAction({
        canSubmit,
        phase: startPhase,
        canCancel: !!onSubmitCancel,
    });
    const primaryActionFilled = primaryAction === 'send' || primaryAction === 'stop';
    const primaryActionIconColor = theme.dark ? '#111111' : theme.colors.button.primary.tint;
    const composerShakerRef = React.useRef<ShakeInstance>(null);
    // Anything refused points at the way out: the hint and the Stop button both
    // flash, so the answer to "this is blocked" is "here is the thing that
    // isn't". Two beats rather than one — a single fade is easy to miss on a
    // button that is already solid black.
    const refusalFlash = useSharedValue(0);
    const refuse = React.useCallback(() => {
        hapticsError();
        refusalFlash.value = withSequence(
            withTiming(1, { duration: 90 }),
            withTiming(0, { duration: 130 }),
            withTiming(1, { duration: 90 }),
            withTiming(0, { duration: 340 }),
        );
    }, [refusalFlash]);
    const refuseWithShake = React.useCallback((shaker: React.RefObject<ShakeInstance | null>) => {
        refuse();
        shaker.current?.shake();
    }, [refuse]);
    const startProgressHintStyle = useAnimatedStyle(() => ({
        color: interpolateColor(
            refusalFlash.value,
            [0, 1],
            [theme.colors.textSecondary, theme.colors.text],
        ),
    }));
    const primaryActionFlashStyle = useAnimatedStyle(() => ({
        transform: [{ scale: 1 + refusalFlash.value * 0.1 }],
    }));
    // The button is already the darkest thing on screen, so its flash is the
    // inverse of the hint's: a lighter wash over the fill, drawn under the glyph
    // so the glyph stays readable through it. Painting over the fill rather than
    // animating it keeps BubblePressable's own press scale untouched.
    const primaryActionFlashOverlayStyle = useAnimatedStyle(() => ({
        opacity: refusalFlash.value * 0.55,
    }));
    const focusedInputLayout = resolveMultiTextInputLayout({
        contentHeight: focusedInputContentHeight,
        hasText: prompt.length > 0,
        maxHeight: MOBILE_COMPOSER_METRICS.inputMaxHeight,
        lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    });
    /**
     * THE FIELD'S HEIGHT COMES FROM THE SAME RESOLVER THE SHELL'S DOES
     * (DROVE-375).
     *
     * This floored the field at `inputMinHeight`, 44 — the number the chat
     * stopped using when DROVE-214 gave the bubble a button row and
     * `MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT`'s 30 replaced it. DROVE-345 wrote
     * `resolveMobileHomeFieldHeight` for exactly this call and Home never
     * adopted it, so the two ends of one column disagreed by 14pt: the shell
     * is pinned to `resolveMobileHomeComposerHeight`, which budgets 30 for the
     * field, while the field asked for 44. The button row was pushed 14pt PAST
     * the bubble's bottom edge.
     *
     * It still DRAWS there — nothing in the composer is clipped on Liquid
     * Glass (DROVE-202, DROVE-328) — which is why Clay photographed a `+` and
     * a padlock cut by the bubble's rounded edge. And UIKit hit-tests a
     * subview against its parent's bounds, so a row drawn outside the shell
     * takes no touches at all: "when I tap submit nothing happens" was send
     * painted where it could not be pressed.
     */
    const focusedInputContainerHeight = resolveMobileHomeFieldHeight(focusedInputLayout.height);
    // Home's own resolver since DROVE-196. The chat composer's card lost its
    // control row to the strip below it and its block height went 104 -> 102;
    // Home's focused composer is still ONE card holding the field and the row,
    // and there is no status strip under it for the row to be furniture in
    // front of, so it keeps DROVE-153's arithmetic and its 104 exactly.
    const focusedComposerHeight = resolveMobileHomeComposerHeight(
        focusedInputLayout.height,
        selectedImages.length > 0,
    );
    const handleFocusedInputMeasurement = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = Math.ceil(event.nativeEvent.layout.height);
        setFocusedInputContentHeight((currentHeight) => (
            currentHeight === nextHeight ? currentHeight : nextHeight
        ));
    }, []);
    const keyboardStyle = useAnimatedStyle(() => ({
        // Keyboard height includes the bottom safe area on iOS. The resting
        // dock keeps that inset, then gives it back while the keyboard opens
        // so the composer stays the same 8px above either boundary.
        transform: [{
            translateY: keyboard.height.value + safeArea.bottom * keyboard.progress.value,
        }],
    }), [safeArea.bottom]);
    const focusBackdropStyle = useAnimatedStyle(() => ({
        opacity: interpolate(
            focusPresentation.value,
            [0, 0.35, 1],
            [0, 1, 1],
            Extrapolation.CLAMP,
        ),
    }));
    /**
     * NO OPACITY ON ANY ANCESTOR OF A GLASS SURFACE (DROVE-394).
     *
     * The shell, the button row and every control in it are
     * `UIVisualEffectView`s, and UIKit does not draw an effect under an alpha
     * below 1 on the view or any superview; one born under alpha 0 stays
     * blank. Clay's photograph of the sheet had a bare `+`, a bare padlock
     * and no capsule, all three inside a row that faded in from 0. So the
     * shell and the row move, and nothing on the way to a glass surface fades.
     * The resting dock already keeps this rule with `display` rather than
     * `opacity` (`safeAreaBehindFocus`).
     */
    const focusedComposerAnimationStyle = useAnimatedStyle(() => ({
        height: interpolate(
            focusPresentation.value,
            [0, 1],
            [MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT, focusedComposerHeight],
            Extrapolation.CLAMP,
        ),
        transform: [{
            scaleX: interpolate(
                focusPresentation.value,
                [0, 1],
                [0.96, 1],
                Extrapolation.CLAMP,
            ),
        }],
    }), [focusedComposerHeight]);
    const focusedInputRevealStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.22, 0.6],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 8 * (1 - reveal) }],
        };
    });
    const focusedActionsRevealStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.46, 0.82],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            transform: [{ translateY: 7 * (1 - reveal) }],
        };
    });

    React.useEffect(() => {
        if (!focusModeVisible) return;
        const timeout = setTimeout(() => focusedInputRef.current?.focus(), 50);
        return () => clearTimeout(timeout);
    }, [focusModeVisible]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (focusAnimationTimerRef.current) {
                clearTimeout(focusAnimationTimerRef.current);
            }
        };
    }, []);

    const openFocusMode = React.useCallback(() => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
        }
        focusPresentation.value = 0;
        setIsFocused(true);
        setFocusModeVisible(true);
        focusAnimationTimerRef.current = setTimeout(() => {
            focusPresentation.value = withTiming(1, {
                duration: 340,
                easing: Easing.out(Easing.cubic),
            });
            focusAnimationTimerRef.current = null;
        }, 16);
    }, [focusPresentation]);

    // A "+" in the session list prefills the draft and then asks the dock to
    // open. The last id seen is captured on mount so a remount after an earlier
    // request does not re-open the composer on its own.
    const focusRequestId = useHomeDockFocusStore((state) => state.requestId);
    const servedFocusRequestRef = React.useRef(focusRequestId);
    React.useEffect(() => registerHomeDockFocusListener(), []);
    React.useEffect(() => {
        if (focusRequestId === servedFocusRequestRef.current) return;
        servedFocusRequestRef.current = focusRequestId;
        openFocusMode();
    }, [focusRequestId, openFocusMode]);

    const finishCloseFocusMode = React.useCallback(() => {
        setIsFocused(false);
        setFocusModeVisible(false);
        setSheetPage(null);
    }, []);

    const closeFocusMode = React.useCallback(() => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
            focusAnimationTimerRef.current = null;
        }
        focusedInputRef.current?.blur();
        Keyboard.dismiss();
        focusPresentation.value = withTiming(0, {
            duration: 180,
            easing: Easing.in(Easing.cubic),
        }, (finished) => {
            if (finished) {
                runOnJS(finishCloseFocusMode)();
            }
        });
    }, [finishCloseFocusMode, focusPresentation]);

    const closePicker = React.useCallback(() => {
        setSheetPage(null);
    }, []);

    const handleFocusModeRequestClose = React.useCallback(() => {
        const action = resolveHomeDockPickerBackAction({
            hasPage: sheetPage !== null,
            starting: isSubmitting,
        });
        if (action === 'refuse') {
            refuse();
            return;
        }
        if (action === 'close-picker') {
            closePicker();
            return;
        }
        closeFocusMode();
    }, [closeFocusMode, closePicker, isSubmitting, refuse, sheetPage]);

    const selectAgent = React.useCallback((agent: NewSessionAgentType) => {
        const nextRigCreation = agent === 'rig' ? rigSelectionCreation : null;
        const nextDefaults = nextRigCreation
            ? {
                permissionMode: nextRigCreation.defaultPermissionMode ?? '',
                modelMode: nextRigCreation.defaultModelKey ?? '',
                effortLevel: nextRigCreation.defaultEffortForModel(nextRigCreation.defaultModelKey),
            }
            : resolveAgentDefaultConfig(defaultOverrides, agent, happyCliVersion);
        // Choosing Happy Agent no longer moves the machine selection: the computer already covers
        // both daemons, and switching it under the person was what made the picker show two.
        setAgentType(agent);
        setPermissionMode(nextDefaults.permissionMode);
        setModelMode(nextDefaults.modelMode);
        if (nextDefaults.effortLevel) setEffortLevel(nextDefaults.effortLevel);
    }, [defaultOverrides, happyCliVersion, rigSelectionCreation, setAgentType, setEffortLevel, setModelMode, setPermissionMode]);

    React.useEffect(() => {
        if (resolvedAgentType !== agentType) {
            selectAgent(resolvedAgentType);
        }
    }, [agentType, resolvedAgentType, selectAgent]);

    type SettingsRow = {
        page: string;
        label: string;
        value: string;
        icon: React.ComponentProps<typeof Ionicons>['name'];
    };

    // The rows stacked above the focused composer. The harness sits with
    // machine/project/worktree because all four say where and with what the
    // session runs, and all four are settled before anything is typed.
    const environmentRows: SettingsRow[] = [
        { page: 'machine', label: 'MACHINE', value: currentMachine?.name ?? 'Select machine', icon: 'desktop-outline' },
        { page: 'project', label: 'PROJECT', value: currentProject?.name ?? '~', icon: 'folder-outline' },
        {
            page: 'worktree',
            label: picksWorkspaces ? 'WORKSPACE' : 'WORKTREE',
            value: currentWorktree?.name ?? (picksWorkspaces ? 'Main' : 'No worktree'),
            icon: 'git-branch-outline',
        },
        { page: 'agent', label: 'HARNESS', value: currentAgent.name, icon: 'hardware-chip-outline' },
    ];
    const agentRows: SettingsRow[] = [
        ...(currentModel ? [{ page: 'model', label: t('agentInput.model.title'), value: currentModel.name, icon: 'cube-outline' as const }] : []),
        ...(currentPermission ? [{ page: 'permission', label: t('agentInput.permissionMode.title'), value: capsule.label.mode ?? currentPermission.name, icon: 'shield-outline' as const }] : []),
        ...(currentEffort ? [{ page: 'effort', label: t('agentInput.effort.title'), value: currentEffort.name, icon: 'speedometer-outline' as const }] : []),
    ];

    type PickerConfig = {
        title: string;
        options: ModeOption[];
        selectedKey: string | null | undefined;
        onSelect: (key: string) => void;
    };

    const requestCustomProjectPath = () => {
        Keyboard.dismiss();
        void (async () => {
            const path = await Modal.prompt(
                t('machineLauncher.enterCustomPath'),
                undefined,
                {
                    placeholder: '~/path/to/project',
                    defaultValue: selectedPath ?? '~',
                    confirmText: t('common.ok'),
                },
            );
            const selectedCustomPath = resolveCustomProjectPathSelection(path, mountedRef.current);
            if (selectedCustomPath) {
                setPath(selectedCustomPath);
            }
        })();
    };

    const getEnvironmentPickerConfig = (setting: EnvironmentSetting): PickerConfig => {
        if (setting === 'machine') {
            return { title: 'Machine', options: machineOptions, selectedKey: selectedMachineId, onSelect: setMachineId };
        }
        if (setting === 'project') {
            return {
                title: 'Project',
                options: [
                    ...projectOptions,
                    {
                        key: CUSTOM_PROJECT_PATH_KEY,
                        name: t('machineLauncher.enterCustomPath'),
                    },
                ],
                selectedKey: currentProject?.key,
                onSelect: (key) => {
                    if (key === CUSTOM_PROJECT_PATH_KEY) {
                        // After the sheet's Modal is gone, not under it.
                        afterPickerSheetRef.current = requestCustomProjectPath;
                        return;
                    }
                    setPath(key);
                },
            };
        }
        return {
            title: picksWorkspaces ? 'Workspace' : 'Worktree',
            options: worktreeOptions,
            selectedKey: selectedWorktreeKey,
            onSelect: (key) => {
                setSessionType(key === '__none__' ? 'simple' : 'worktree');
                setWorktreeKey(key === '__none__' || key === '__new__' ? null : key);
            },
        };
    };

    const getAgentPickerConfig = (setting: AgentSetting): PickerConfig => {
        if (setting === 'agent') {
            return {
                title: 'Harness',
                options: availableAgents,
                selectedKey: agentType,
                // A harness this computer cannot run is refused here, visibly,
                // rather than written and bounced by the availability effect
                // below (DROVE-394). See `resolveHarnessPick`.
                onSelect: (key) => {
                    const pick = resolveHarnessPick(availableAgents, key);
                    if (!pick) {
                        refuse();
                        return;
                    }
                    selectAgent(pick);
                },
            };
        }
        if (setting === 'model') {
            return { title: t('agentInput.model.title'), options: modelOptions, selectedKey: currentModel?.key, onSelect: setModelMode };
        }
        if (setting === 'permission') {
            return { title: t('agentInput.permissionMode.title'), options: permissionOptions, selectedKey: currentPermission?.key, onSelect: setPermissionMode };
        }
        return {
            title: t('agentInput.effort.title'),
            options: effortPickerOptions,
            selectedKey: currentEffort?.key,
            onSelect: (key: string) => {
                if (!effortOptions.some((option) => option.key === key)) return;
                setEffortLevel(key);
            },
        };
    };

    /*
     * `agentSettingsGroups` and the three `*SettingsGroup` lookups lived here
     * and are gone with the triggers they fed (DROVE-345). Whether a segment
     * of the capsule can be opened is a question about the OPTIONS, which is
     * what `canOpen` reads now, and `getAgentPickerConfig` is still where each
     * of the three gets its list.
     */

    const getPickerConfig = (page: PickerPage): PickerConfig => (
        page === 'machine' || page === 'project' || page === 'worktree'
            ? getEnvironmentPickerConfig(page)
            : getAgentPickerConfig(page)
    );
    /**
     * The three the COMPOSER opens are always sheets (DROVE-345, DROVE-242).
     *
     * They were native menus on iOS, which is what the capsule cannot use: a
     * menu UIKit places and UIKit dismisses is outside the picker's own
     * dismissal state, so a second tap on the segment could not close it
     * because the segment never saw the tap. Clay ruled on the chat's copy of
     * this in DROVE-242 — "Shouldn't these show in sheets like the effort does"
     * — and the capsule is the chat's control. Since DROVE-394 the environment
     * rows above open the same sheet; this predicate only names the pages the
     * capsule's segments report, so the open one shows on its segment.
     */
    const composerSheetPage = (page: PickerPage | null): page is ComposerSessionPicker => (
        page === 'permission' || page === 'model' || page === 'effort'
    );
    const composerPicker = composerSheetPage(sheetPage) ? sheetPage : null;
    const sheetVisible = sheetPage !== null;
    const handleFocusBackdropPress = React.useCallback(() => {
        const action = resolveHomeDockBackdropPressAction({
            nativeMenuOpen: false,
            pickerVisible: sheetVisible,
            starting: isSubmitting,
        });
        if (action === 'dismiss-menu') {
            return;
        }
        if (action === 'refuse') {
            refuse();
            return;
        }
        if (action === 'close-picker') {
            closePicker();
            return;
        }
        closeFocusMode();
    }, [closeFocusMode, closePicker, isSubmitting, refuse, sheetVisible]);

    // Stop is about this screen, not about the machine. It gives the composer
    // back immediately and lets the kill run unwatched, because a Stop that
    // waits on the thing that is already not answering is not a way out.
    const handleStopPress = React.useCallback(() => {
        onSubmitCancel?.();
        closeFocusMode();
    }, [closeFocusMode, onSubmitCancel]);

    const renderPickerRow = (row: SettingsRow) => (
        <Pressable
            key={row.page}
            onPress={() => setSheetPage(row.page as PickerPage)}
            accessibilityRole="button"
            accessibilityLabel={`${row.label}: ${row.value}`}
        >
            <View style={styles.focusConfigRow}>
                <View style={styles.focusConfigIcon}>
                    <Ionicons name={row.icon} size={21} color={theme.colors.text} />
                </View>
                <Text style={styles.focusConfigValue} numberOfLines={1}>{row.value}</Text>
            </View>
        </Pressable>
    );

    const renderEnvironmentPickers = () => environmentRows.map((row, index) => (
        <FocusConfigRevealRow
            key={row.page}
            progress={focusPresentation}
            index={index}
            refusing={isSubmitting}
            onRefuse={refuse}
        >
            {renderPickerRow(row)}
        </FocusConfigRevealRow>
    ));

    /**
     * EVERY PICKER ON THIS SCREEN IS THE COMPOSER'S PICKER SHEET (DROVE-394).
     *
     * Clay: "for the millionth time this input box needs to match all the
     * other input boxes; that should actually be a sheet that comes up." The
     * harness was an iOS context menu and the rest a glass card of Home's own;
     * both are gone. Machine, project, worktree, harness, model, permission
     * and effort all open `ComposerPickerSheet`, the list the session capsule
     * opens, and a row this computer cannot take is drawn disabled with its
     * reason instead of being offered and dropped.
     */
    const pickerConfig = sheetPage ? getPickerConfig(sheetPage) : null;
    const pickerOptions: ComposerPickerOption[] = (pickerConfig?.options ?? []).map((option) => ({
        key: option.key,
        name: option.name,
        description: option.description,
        disabled: option.disabled,
    }));
    const handlePickerSheetClosed = () => {
        const go = afterPickerSheetRef.current;
        afterPickerSheetRef.current = null;
        go?.();
    };

    /**
     * THE ENTRY IS THE SHEET'S COMPOSER, AT REST (DROVE-394).
     *
     * Clay, on the sessions list: it should look the SAME as the input box
     * inside a session, everything greyed out, and a tap anywhere on it
     * should open the new-session options. So it is the same `ComposerBubble`
     * with the same slots the sheet fills — the `+`, the capsule with the
     * harness's own segments, send — every control disabled, and the bubble
     * itself the one button. The placeholder stays "Plan, ask, build…".
     */
    const renderEntry = () => (
        <View style={styles.focusedComposerShadow}>
            <ComposerBubble
                style={styles.focusedComposerSurface}
                onPress={openFocusMode}
                accessibilityLabel="New session"
                leading={(
                    <ComposerControlButton
                        fill={composerDiscFill}
                        disabled
                        accessibilityRole="button"
                        accessibilityLabel="Add image"
                    >
                        <Ionicons
                            name="add"
                            size={MOBILE_COMPOSER_METRICS.addIconSize}
                            color={theme.colors.textSecondary}
                        />
                    </ComposerControlButton>
                )}
                controls={(
                    <ComposerSessionControls
                        label={capsule.label}
                        size={MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE}
                        segmentWidth={MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH}
                        verticalSlop={MOBILE_COMPOSER_METRICS.primaryActionSlop}
                        modeKey={capsule.modeKey}
                        effortIndex={capsule.effortIndex}
                        effortCount={capsule.effortCount}
                        canOpen={capsule.canOpen}
                        readAloud={readAloudSegment}
                        disabled
                    />
                )}
                trailing={[(
                    <ComposerControlButton
                        key="primary"
                        disabled
                        accessibilityRole="button"
                        accessibilityLabel="Send"
                    >
                        <Ionicons name="arrow-up" size={16} color={theme.colors.textSecondary} />
                    </ComposerControlButton>
                )]}
            >
                <View style={styles.focusedInputReveal}>
                    <Text
                        style={[styles.focusedInput, !prompt && styles.entryPlaceholder]}
                        numberOfLines={1}
                    >
                        {prompt || 'Plan, ask, build…'}
                    </Text>
                </View>
            </ComposerBubble>
        </View>
    );

    const submit = async () => {
        if (!canSubmit) return false;
        useNewSessionDraft.getState().setAttachments(selectedImages);
        const started = await onSubmit();
        if (started) clearImages();
        return started;
    };

    // The dock, the keyboard, and the scrim all stay put until the session
    // exists. Closing first left the session list with a spinner nowhere near
    // the composer, and a failure landed on a screen that had already moved on.
    const submitFromFocusMode = () => {
        if (!canSubmit) return;
        closePicker();
        void (async () => {
            const started = await submit();
            if (started) closeFocusMode();
        })();
    };

    /**
     * THE HOME COMPOSER, WHICH IS THE SESSION COMPOSER (DROVE-345).
     *
     * Clay, on this sheet: "on the homepage it's not properly using liquid
     * glass and this input is not using our liquid glass input that we have
     * everywhere else."
     *
     * It was a second implementation of one thing: a `frosted` surface with a
     * hairline border, a raw `TextInput`, a `BubblePressable` `+`, three words
     * for permission / model / effort, and a filled white send disc. It shared
     * `agentInputLayout.ts`'s numbers with the chat and nothing else, which is
     * why DROVE-153, DROVE-266, DROVE-328, DROVE-331 and DROVE-343 each landed
     * on the chat's composer and left this one flat.
     *
     * The shell, the field's glass and the button row are `ComposerBubble`'s
     * now, and the controls in it are the composer's own: `ComposerControlButton`
     * for the `+` and send, `ComposerSessionControls` for the capsule. What is
     * still Home's is what Home has and a session does not — the reveal timings
     * as the dock opens, the measurement text that drives the field's height,
     * and the refusal blocker while a session is being created.
     *
     * WHAT THE CAPSULE CARRIES HERE is the session composer's four
     * (DROVE-394): permission, read-aloud, effort where the harness has
     * levels, the model. Read-aloud arms reading for the session about to
     * start, which is DROVE-386's per-session switch reached one screen
     * earlier; `useStartSessionFromDraft` spends it.
     *
     * AND ALL THREE OPEN SHEETS, which is DROVE-242 reaching this screen. They
     * were native menus here; the capsule's segments report a picker and the
     * sheet is what draws it, so a second tap on a control can close it because
     * the control sees the tap. The environment rows above open the same
     * sheet since DROVE-394 (`renderPickerRow`).
     */
    const renderFocusedComposer = () => (
        <Shaker ref={composerShakerRef} style={styles.focusedComposerShadow}>
            <Animated.View style={[styles.focusedComposerAnimationShell, focusedComposerAnimationStyle]}>
                <ComposerBubble
                    style={[
                        styles.focusedComposerSurface,
                        styles.focusedComposerAnchored,
                        { height: focusedComposerHeight },
                    ]}
                    actionRowStyle={focusedActionsRevealStyle}
                    above={selectedImages.length > 0 ? (
                        <Animated.View style={focusedInputRevealStyle}>
                            <AgentInputAttachmentStrip images={selectedImages} onRemove={removeImage} />
                        </Animated.View>
                    ) : null}
                    /* Painted over the attachments and the input, and stopping
                       short of the action row. The controls keep their normal
                       appearance; only the touch is refused. */
                    overlay={isSubmitting ? (
                        <Pressable
                            style={styles.composerPressBlocker}
                            onPress={() => refuseWithShake(composerShakerRef)}
                        />
                    ) : null}
                    leading={(
                        <RefusableControl refusing={isSubmitting} onRefuse={refuse}>
                            <ComposerControlButton
                                fill={composerDiscFill}
                                onPress={() => void pickImages()}
                                accessibilityRole="button"
                                accessibilityLabel="Add image"
                            >
                                <Ionicons
                                    name="add"
                                    size={MOBILE_COMPOSER_METRICS.addIconSize}
                                    color={theme.colors.text}
                                />
                            </ComposerControlButton>
                        </RefusableControl>
                    )}
                    controls={(
                        <RefusableControl
                            refusing={isSubmitting}
                            onRefuse={refuse}
                            slot={COMPOSER_BUBBLE_CONTROLS_SLOT_GEOMETRY}
                        >
                            <ComposerSessionControls
                                label={capsule.label}
                                size={MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE}
                                segmentWidth={MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH}
                                verticalSlop={MOBILE_COMPOSER_METRICS.primaryActionSlop}
                                modeKey={capsule.modeKey}
                                effortIndex={capsule.effortIndex}
                                effortCount={capsule.effortCount}
                                openPicker={composerPicker}
                                canOpen={capsule.canOpen}
                                readAloud={readAloudSegment}
                                onPress={(picker) => setSheetPage(picker)}
                            />
                        </RefusableControl>
                    )}
                    trailing={[(
                        /* One button, read the same way as the session
                           composer's: it sends, and while the session is being
                           created it stops. Its FACES are the chat's too now —
                           a bare glyph at rest, because "the send button
                           shouldn't have a circle around it" (DROVE-264) was
                           never only about the chat, and a filled disc while it
                           is Stop. */
                        <Animated.View key="primary" style={primaryActionFlashStyle}>
                            <ComposerControlButton
                                fill={primaryAction === 'stop'
                                    ? (theme.dark ? '#F5F5F5' : theme.colors.button.primary.background)
                                    : undefined}
                                onPress={primaryAction === 'stop' ? handleStopPress : submitFromFocusMode}
                                disabled={primaryAction !== 'send' && primaryAction !== 'stop'}
                                accessibilityRole="button"
                                accessibilityLabel={primaryAction === 'stop' ? 'Stop' : 'Send'}
                            >
                                {primaryAction === 'stop' && (
                                    <Animated.View
                                        pointerEvents="none"
                                        style={[styles.primaryActionFlash, primaryActionFlashOverlayStyle]}
                                    />
                                )}
                                {primaryAction === 'busy' ? (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                ) : primaryAction === 'stop' ? (
                                    <Octicons name="stop" size={16} color={primaryActionIconColor} />
                                ) : (
                                    <Ionicons
                                        name="arrow-up"
                                        size={16}
                                        color={primaryAction === 'send'
                                            ? theme.colors.text
                                            : theme.colors.textSecondary}
                                    />
                                )}
                            </ComposerControlButton>
                        </Animated.View>
                    )]}
                >
                    <Animated.View style={[
                        styles.focusedInputReveal,
                        { height: focusedInputContainerHeight },
                        focusedInputRevealStyle,
                    ]}>
                        <Text
                            accessible={false}
                            pointerEvents="none"
                            onLayout={handleFocusedInputMeasurement}
                            style={styles.focusedInputMeasurement}
                        >
                            {prompt || ' '}
                        </Text>
                        <TextInput
                            ref={focusedInputRef}
                            value={prompt}
                            // `editable={false}` would take the keyboard down
                            // with it, and the keyboard is the thing this whole
                            // flow keeps up. The input is controlled, so
                            // refusing the change is what locks it: the value
                            // never moves off the prompt being sent.
                            onChangeText={(next) => {
                                if (isSubmitting) {
                                    refuseWithShake(composerShakerRef);
                                    return;
                                }
                                onPromptChange(next);
                            }}
                            onFocus={() => setIsFocused(true)}
                            placeholder={focusedPromptPlaceholder}
                            placeholderTextColor={theme.colors.textSecondary}
                            selectionColor={theme.colors.text}
                            autoCorrect
                            multiline
                            scrollEnabled={focusedInputLayout.scrollEnabled}
                            style={[styles.focusedInput, { height: focusedInputLayout.height }]}
                        />
                    </Animated.View>
                </ComposerBubble>
            </Animated.View>
        </Shaker>
    );

    return (
        <>
            <Animated.View
                pointerEvents="box-none"
                style={[styles.keyboardFollower, keyboardStyle]}
            >
                {showBottomBackdrop && (
                    <View pointerEvents="none" style={styles.bottomBackdrop}>
                        <MobileHeaderScrim
                            variant="strong"
                            edge="bottom"
                            overlayOpacity={MOBILE_HOME_SCRIM_OVERLAY_OPACITY}
                        />
                    </View>
                )}
                <View
                    pointerEvents={focusModeVisible ? 'none' : 'box-none'}
                    style={[
                        styles.safeArea,
                        { paddingBottom: isFocused ? 8 : Math.max(10, safeArea.bottom) },
                        focusModeVisible && styles.safeAreaBehindFocus,
                    ]}
                >
                    {renderEntry()}
                </View>
            </Animated.View>

            <RNModal
                visible={focusModeVisible}
                transparent
                animationType="none"
                onRequestClose={handleFocusModeRequestClose}
            >
                <View style={styles.modalRoot}>
                    <Animated.View
                        pointerEvents="box-none"
                        style={[styles.modalBackdrop, focusBackdropStyle]}
                    >
                        <BlurView
                            blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                            blurReductionFactor={2}
                            intensity={8}
                            pointerEvents="none"
                            tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                            style={styles.modalBackdrop}
                        />
                        <View
                            pointerEvents="none"
                            style={[styles.modalBackdrop, styles.focusBackdropDim]}
                        />
                        <Pressable
                            style={styles.modalBackdrop}
                            onPress={handleFocusBackdropPress}
                        />
                    </Animated.View>
                    {/* No back affordance here on purpose: tapping the backdrop
                        already closes focus mode, and a floating chevron over the
                        session list is redundant chrome. */}

                    <Animated.View style={[styles.focusDock, keyboardStyle]}>
                        <View style={styles.focusConfig}>
                            <View style={styles.focusConfigGroup}>
                                {renderEnvironmentPickers()}
                            </View>
                        </View>
                        <View style={[
                            styles.focusComposerArea,
                            { paddingBottom: safeArea.bottom + 8 },
                        ]}>
                            {/* Absolutely placed in the gap the dock already
                                leaves, so it appears without moving anything. */}
                            {startProgressLabel && (
                                <View pointerEvents="none" style={styles.startProgressRow}>
                                    <View style={styles.startProgressContent}>
                                        <StatusDot color={theme.colors.status.connecting} isPulsing size={6} />
                                        <Text style={styles.startProgressText} numberOfLines={1}>
                                            {startProgressLabel}
                                        </Text>
                                        {primaryAction === 'stop' && (
                                            <Animated.Text
                                                style={[styles.startProgressHint, startProgressHintStyle]}
                                                numberOfLines={1}
                                            >
                                                To interrupt press stop
                                            </Animated.Text>
                                        )}
                                    </View>
                                </View>
                            )}
                            {renderFocusedComposer()}
                        </View>
                    </Animated.View>
                    <ComposerPickerSheet
                        open={sheetVisible}
                        onClose={closePicker}
                        onClosed={handlePickerSheetClosed}
                        title={pickerConfig?.title ?? ''}
                        options={pickerOptions}
                        selectedKey={pickerConfig?.selectedKey}
                        onSelect={(key) => pickerConfig?.onSelect(key)}
                    />
                </View>
            </RNModal>

        </>
    );
});
