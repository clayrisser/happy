/**
 * The kitchen-sink demo, and the onboarding, in one screen (DROVE-75).
 *
 * Every announce channel from the DROVE-72 taxonomy, on demand: each wrist
 * buzz as the phone approximates it, the two voices, every card shape, and a
 * real push. Shown once on the first authenticated launch so the first thing
 * a new phone learns is which buzz means what; reachable from Settings after.
 *
 * NOTHING HERE ANSWERS A REAL EVENT. Every card carries a `demo:` id, and
 * sessionAllow / sessionDeny turn that id into the sink registered below
 * instead of an RPC (sync/droverDemo.ts says where the walls are). The cards
 * are the app's own components, so their buttons are the real buttons.
 */

import * as React from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';

import { GateCard } from '@/app/(app)/gates';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { ToolView } from '@/components/tools/ToolView';
import { layout } from '@/components/layout';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Typography } from '@/constants/Typography';
import { hapticsConfirm, playPhoneTaptic, playWristCue } from '@/components/haptics';
import {
    canBuzzWatch,
    describeWristFidelity,
    wristCueDurationMs,
    wristCues,
    type WristCueSpec,
} from '@/utils/wristCues';
import { phoneTaptics } from '@/utils/phoneTaptics';
import { channelReadout, findDroverSettings, readoutIsEmpty } from '@/utils/channelReadout';
import { useAllMachines, useAllSessions } from '@/sync/storage';
import { buzzDroverWatch, type DemoBuzzOutcome } from '@/sync/droverDemoBuzz';
import { machineDroverPolicy, type DroverPolicyResponse } from '@/sync/droverPolicy';
import { getDroverWatchStatus, isDroverWatchAvailable } from 'drover-watch';
import type { DroverGateEntry } from '@/sync/droverGates';
import {
    DEMO_SESSION_ID,
    demoInboxEntries,
    demoLog,
    demoSampleReply,
    demoTranscriptCards,
    setDemoAnswerSink,
    spokenQuestion,
    type DemoAnswer,
    type DemoCard,
} from '@/sync/droverDemo';
import { machineDemoPush } from '@/sync/droverDemoPush';
import { getCurrentExpoPushToken, getCurrentPushDeviceMetadata } from '@/sync/pushRegistration';
import type { ToolCall } from '@/sync/typesMessage';
import { canReadAloud, speechEngine } from '@/voice/speechEngine';
import { splitIntoSentences, stripToSpeakableProse } from '@/voice/speakable';

/**
 * How long the push waits before it is sent. The app suppresses banners while
 * it is in the foreground (app/_layout.tsx setNotificationHandler), so a push
 * sent the instant the row is tapped arrives silently into the list and looks
 * like nothing happened. Five seconds is enough to lock the phone.
 */
const PUSH_DELAY_SECONDS = 5;

/** The pause between two patterns when they play back to back. */
const BETWEEN_CUES_MS = 900;

type PushPhase =
    | { phase: 'idle' }
    | { phase: 'countdown'; seconds: number }
    | { phase: 'sending' }
    | { phase: 'done'; line: string; ok: boolean };

export default function DroverDemoScreen() {
    const params = useLocalSearchParams<{ onboarding?: string }>();
    const onboarding = params.onboarding === '1';
    const topContentInset = Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0;

    return (
        <>
            <Stack.Screen options={{ title: onboarding ? 'Welcome to Drover' : 'Demo every channel' }} />
            <ItemList containerStyle={{ paddingTop: topContentInset }}>
                <ItemGroup
                    footer={
                        (onboarding
                            ? 'This phone and your watch will tell you when a session needs you. Try each channel now so you know what it means when it happens for real. '
                            : '')
                        + 'Nothing here touches a real session: every tap stays on this device, and every log line it writes starts with [drover-demo].'
                    }
                >
                    <Item
                        title={onboarding ? 'Learn the signals' : 'Every channel, on demand'}
                        subtitle="Haptic, audio and visual announce; push proves the path from the Mac"
                        subtitleLines={0}
                        icon={<Ionicons name="pulse-outline" size={29} color="#AF52DE" />}
                        showChevron={false}
                    />
                </ItemGroup>
                <ChannelsSection />
                <HapticSection />
                <WatchSection />
                <PhoneTapticSection />
                <AudioSection />
                <PushSection />
                <CardsSection />
            </ItemList>
        </>
    );
}

// ---- channels -------------------------------------------------------------

/**
 * The live readout of the announce channels and the mode (DROVE-72), read
 * defensively: the keys are not on today's tip, so every row says "not set"
 * until the lanes that add them merge. Two sources, freshest first: the Mac's
 * own settings through the `drover-policy get` RPC, then the bridge session's
 * mirror in the store.
 */
function ChannelsSection() {
    const machines = useAllMachines();
    const sessions = useAllSessions();
    const machineId = machines.length > 0 ? machines[0].id : null;
    const [policy, setPolicy] = React.useState<DroverPolicyResponse | null>(null);
    const [loading, setLoading] = React.useState(false);
    const alive = React.useRef(true);
    React.useEffect(() => () => { alive.current = false; }, []);

    const refresh = React.useCallback(async () => {
        if (!machineId) return;
        setLoading(true);
        const result = await machineDroverPolicy(machineId, { scope: 'defaults', action: 'get', by: 'demo' });
        demoLog(`channels read from ${machineId.slice(0, 8)}: ${result.ok ? 'ok' : result.error ?? 'failed'}`);
        if (!alive.current) return;
        setPolicy(result);
        setLoading(false);
    }, [machineId]);
    React.useEffect(() => { void refresh(); }, [refresh]);

    const readout = channelReadout(
        policy?.policy?.effective,
        policy?.policy?.defaults,
        findDroverSettings(sessions),
    );
    const empty = readoutIsEmpty(readout);
    const source = !machineId
        ? 'No Mac online to read from.'
        : policy === null
            ? 'Reading the Mac\u2019s settings\u2026'
            : policy.ok
                ? (empty ? 'The Mac answered, but no channel key is on this build yet (DROVE-72).' : 'Read from the Mac\u2019s drover settings.')
                : policy.error ?? 'The Mac did not answer.';

    const row = (title: string, value: string, icon: React.ComponentProps<typeof Ionicons>['name']) => (
        <Item
            key={title}
            title={title}
            detail={value}
            icon={<Ionicons name={icon} size={29} color={value === 'not set' ? '#8E8E93' : '#5856D6'} />}
            showChevron={false}
        />
    );

    return (
        <ItemGroup
            title="Channels right now"
            footer={`${source} Announce is what tells you; answer is how you reply. Haptic is announce-only. A mode is a saved combination of the four.`}
        >
            {row('Visual announce', readout.visual, 'eye-outline')}
            {row('Haptic announce', readout.haptic, 'watch-outline')}
            {row('Audio announce', readout.audio, 'volume-medium-outline')}
            {row('Audio answer', readout.answerAudio, 'mic-outline')}
            {row('Mode', readout.mode, 'options-outline')}
            <Item
                title="Read again"
                subtitle={machineId ? 'Asks the Mac for its current settings' : 'Start the drover daemon and come back'}
                icon={<Ionicons name="refresh-outline" size={29} color="#5856D6" />}
                loading={loading}
                disabled={!machineId || loading}
                showChevron={false}
                onPress={() => void refresh()}
            />
        </ItemGroup>
    );
}

// ---- watch ----------------------------------------------------------------

/**
 * Buzz the WRIST with each pattern, through the real path: a demo gate of
 * that kind in a snapshot, which WristCueDiff turns into the cue (see
 * sync/droverDemoBuzz.ts). The first tap on a sleeping watch says it would
 * cost a background wake; the second spends one.
 */
function WatchSection() {
    const available = isDroverWatchAvailable();
    const [busy, setBusy] = React.useState<string | null>(null);
    const [last, setLast] = React.useState<{ cue: string; outcome: DemoBuzzOutcome } | null>(null);
    const [armWake, setArmWake] = React.useState(false);
    const alive = React.useRef(true);
    React.useEffect(() => () => { alive.current = false; }, []);

    // What the wrist will ACTUALLY feel, read rather than assumed (DROVE-124).
    // It swings on whether the watch app happens to be on screen this second,
    // so it is read on mount, whenever the phone comes back to the foreground,
    // and after every buzz. A stale verdict here would be the same confident
    // wrong answer this row exists to stop giving.
    const readStatus = React.useCallback(() => {
        if (!isDroverWatchAvailable()) return null;
        const status = getDroverWatchStatus();
        return status.supported ? status : null;
    }, []);
    const [status, setStatus] = React.useState(readStatus);
    React.useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') setStatus(readStatus());
        });
        return () => sub.remove();
    }, [readStatus]);
    const fidelity = describeWristFidelity(status);

    const buzz = React.useCallback(async (spec: WristCueSpec) => {
        if (busy) return;
        setBusy(spec.cue);
        const outcome = await buzzDroverWatch(spec, armWake);
        if (!alive.current) return;
        setLast({ cue: spec.cue, outcome });
        setArmWake(!outcome.ok && outcome.why.includes('spend one background wake'));
        setStatus(readStatus());
        setBusy(null);
    }, [busy, armWake, readStatus]);

    const line = (spec: WristCueSpec): string => {
        if (last?.cue !== spec.cue) return `${spec.beats.length} ${spec.beats.length === 1 ? 'beat' : 'beats'} on the wrist`;
        if (last.outcome.ok) return last.outcome.how === 'wake' ? 'Sent with a background wake' : 'Sent; the watch app was open';
        return last.outcome.why;
    };

    return (
        <ItemGroup
            title="Watch"
            footer={available
                ? 'Each row puts one demo gate on the wall for a few seconds, by the same path a real gate takes. The card is a demo: answering it sends nothing. "Session finished" is not a gate and plays when a session stops.'
                : 'No watch module on this build; nothing here can reach a wrist.'}
        >
            {available ? (
                <Item
                    title={fidelity.headline}
                    subtitle={fidelity.detail}
                    subtitleLines={0}
                    icon={<Ionicons
                        name={fidelity.fidelity === 'pattern' ? 'watch' : 'watch-outline'}
                        size={29}
                        color={fidelity.fidelity === 'pattern' ? '#34C759' : '#FF9500'}
                    />}
                    showChevron={false}
                />
            ) : null}
            {wristCues.filter(canBuzzWatch).map((spec) => (
                <Item
                    key={spec.cue}
                    title={`Buzz the watch: ${spec.headline}`}
                    subtitle={line(spec)}
                    subtitleLines={0}
                    icon={<Ionicons name="watch-outline" size={29} color="#AF52DE" />}
                    loading={busy === spec.cue}
                    disabled={!available || busy !== null}
                    showChevron={false}
                    onPress={() => void buzz(spec)}
                />
            ))}
        </ItemGroup>
    );
}

// ---- phone taptics --------------------------------------------------------

/** The phone's own one-shot feedbacks, beside the wrist patterns for contrast. */
function PhoneTapticSection() {
    return (
        <ItemGroup
            title="Phone taptics"
            footer="What the app itself taps for. Different engine from the wrist, listed so a composer tick is never mistaken for a gate."
        >
            {phoneTaptics.map((spec) => (
                <Item
                    key={spec.id}
                    title={spec.title}
                    subtitle={spec.meaning}
                    subtitleLines={0}
                    icon={<Ionicons name="radio-button-on-outline" size={29} color="#AF52DE" />}
                    showChevron={false}
                    onPress={() => {
                        demoLog(`phone taptic ${spec.id}`);
                        playPhoneTaptic(spec.id);
                    }}
                />
            ))}
        </ItemGroup>
    );
}

// ---- haptic ---------------------------------------------------------------

function HapticSection() {
    const [playing, setPlaying] = React.useState<string | null>(null);
    const alive = React.useRef(true);
    React.useEffect(() => () => { alive.current = false; }, []);

    const playOne = React.useCallback(async (spec: WristCueSpec) => {
        if (playing) return;
        setPlaying(spec.cue);
        demoLog(`phone haptic ${spec.cue}: ${spec.beats.join(' ')}`);
        await playWristCue(spec);
        if (alive.current) setPlaying(null);
    }, [playing]);

    // Most urgent first, the wrist's own order, with a pause long enough that
    // the end of one pattern is not mistaken for the start of the next.
    const playAll = React.useCallback(async () => {
        if (playing) return;
        setPlaying('all');
        demoLog('phone haptic: every cue back to back');
        for (const spec of wristCues) {
            if (!alive.current) return;
            demoLog(`phone haptic ${spec.cue}: ${spec.beats.join(' ')}`);
            await playWristCue(spec);
            await new Promise<void>((resolve) => setTimeout(resolve, wristCueDurationMs(spec) + BETWEEN_CUES_MS));
        }
        if (alive.current) setPlaying(null);
    }, [playing]);

    return (
        <ItemGroup
            title="Haptic"
            footer={Platform.OS === 'web'
                ? 'No taptic engine on the web. The rows say what each pattern is.'
                : 'The phone approximates the watch: the same beats and gaps, on a different engine. The Watch rows below play the real patterns on the wrist.'}
        >
            <Item
                title="Play all, back to back"
                subtitle="Most urgent first, a pause between each"
                icon={<Ionicons name="play-outline" size={29} color="#AF52DE" />}
                loading={playing === 'all'}
                disabled={playing !== null}
                showChevron={false}
                onPress={() => void playAll()}
            />
            {wristCues.map((spec) => (
                <Item
                    key={spec.cue}
                    title={spec.headline}
                    subtitle={`${spec.meaning}\n${spec.beats.map(beatWord).join(' · ')}`}
                    subtitleLines={0}
                    icon={<Ionicons name={cueIcon(spec)} size={29} color="#AF52DE" />}
                    loading={playing === spec.cue}
                    disabled={playing !== null}
                    showChevron={false}
                    onPress={() => void playOne(spec)}
                />
            ))}
        </ItemGroup>
    );
}

function beatWord(beat: WristCueSpec['beats'][number]): string {
    switch (beat) {
        case 'notification': return 'tap';
        case 'directionUp': return 'tick';
        case 'retry': return 'thud';
        case 'success': return 'soft';
        case 'failure': return 'rough';
    }
}

function cueIcon(spec: WristCueSpec): React.ComponentProps<typeof Ionicons>['name'] {
    switch (spec.cue) {
        case 'needsYou': return 'checkbox-outline';
        case 'question': return 'help-circle-outline';
        case 'permission': return 'lock-closed-outline';
        case 'expiry': return 'battery-dead-outline';
        case 'finished': return 'checkmark-done-outline';
    }
}

// ---- audio ----------------------------------------------------------------

type Speaking = 'question' | 'reply' | 'confirm' | null;

function AudioSection() {
    const available = canReadAloud();
    const [speaking, setSpeaking] = React.useState<Speaking>(null);
    // Bumped on stop so a queue of sentences from the sample reply does not
    // carry on after the row that started it was cancelled.
    const generation = React.useRef(0);
    React.useEffect(() => () => { void speechEngine.stop(); }, []);

    const question = demoTranscriptCards()[1].tool.input.questions[0];
    const questionText = spokenQuestion(question);

    const say = React.useCallback(async (what: Exclude<Speaking, null>, utterances: string[]) => {
        if (!available) return;
        const mine = ++generation.current;
        await speechEngine.stop();
        setSpeaking(what);
        demoLog(`speak ${what}: ${utterances.length} utterance(s)`);
        for (const utterance of utterances) {
            if (generation.current !== mine) return;
            await speechEngine.speak(utterance);
        }
        if (generation.current === mine) setSpeaking(null);
    }, [available]);

    const stop = React.useCallback(async () => {
        generation.current++;
        await speechEngine.stop();
        setSpeaking(null);
    }, []);

    const confirm = React.useCallback(async () => {
        hapticsConfirm();
        await say('confirm', ['Got it.']);
    }, [say]);

    return (
        <ItemGroup
            title="Audio"
            footer={available
                ? 'The question is the DROVE-73 shape: header, body, options numbered. The reply goes through the DROVE-30 read-aloud stripper, so the code block is skipped and the bullets are read as sentences. The confirmation is a success tap and a spoken "Got it"; there is no sound asset yet.'
                : 'This build has no speech module, so nothing here can talk. The rows say what would be said.'}
        >
            <Item
                title="Speak a question"
                subtitle={questionText}
                subtitleLines={0}
                icon={<Ionicons name="help-circle-outline" size={29} color="#34C759" />}
                loading={speaking === 'question'}
                disabled={!available || (speaking !== null && speaking !== 'question')}
                showChevron={false}
                onPress={() => speaking === 'question' ? void stop() : void say('question', [questionText])}
            />
            <Item
                title="Read a sample reply"
                subtitle={splitIntoSentences(stripToSpeakableProse(demoSampleReply)).join(' ')}
                subtitleLines={0}
                icon={<Ionicons name="volume-high-outline" size={29} color="#34C759" />}
                loading={speaking === 'reply'}
                disabled={!available || (speaking !== null && speaking !== 'reply')}
                showChevron={false}
                onPress={() => speaking === 'reply'
                    ? void stop()
                    : void say('reply', splitIntoSentences(stripToSpeakableProse(demoSampleReply)))}
            />
            <Item
                title="Confirmation after a pick"
                subtitle='A success tap, then "Got it"'
                icon={<Ionicons name="checkmark-circle-outline" size={29} color="#34C759" />}
                loading={speaking === 'confirm'}
                disabled={!available || speaking !== null}
                showChevron={false}
                onPress={() => void confirm()}
            />
        </ItemGroup>
    );
}

// ---- push -----------------------------------------------------------------

function PushSection() {
    const machines = useAllMachines();
    const [chosen, setChosen] = React.useState<string | null>(null);
    const machineId = chosen ?? (machines.length === 1 ? machines[0].id : null);
    const [state, setState] = React.useState<PushPhase>({ phase: 'idle' });
    const alive = React.useRef(true);
    React.useEffect(() => () => { alive.current = false; }, []);

    const send = React.useCallback(async () => {
        if (!machineId || state.phase !== 'idle') return;
        const token = await getCurrentExpoPushToken();
        if (!token) {
            setState({ phase: 'done', ok: false, line: 'This phone has no push token. Allow notifications first.' });
            return;
        }
        const { deviceLabel } = getCurrentPushDeviceMetadata();
        for (let seconds = PUSH_DELAY_SECONDS; seconds > 0; seconds--) {
            if (!alive.current) return;
            setState({ phase: 'countdown', seconds });
            await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        }
        if (!alive.current) return;
        setState({ phase: 'sending' });
        demoLog(`push: asking machine ${machineId.slice(0, 8)} to send to this phone (${deviceLabel})`);
        const result = await machineDemoPush(machineId, { token, deviceLabel });
        demoLog(`push: ${result.ok ? 'sent' : 'failed'} sent=${result.sent} failed=${result.failed}${result.error ? ` ${result.error}` : ''}`);
        if (!alive.current) return;
        setState({
            phase: 'done',
            ok: result.ok,
            line: result.ok
                ? `Expo accepted it. If nothing showed, the phone was unlocked with this app open; try again and lock it.`
                : result.error ?? `Expo rejected it (${result.failed} failed).`,
        });
    }, [machineId, state.phase]);

    const subtitle = (() => {
        if (Platform.OS === 'web') return 'Push is for the phone; nothing to send on the web.';
        if (machines.length === 0) return 'No Mac is online to send from. Start the drover daemon and come back.';
        if (!machineId) return 'Pick the Mac below that should send it.';
        switch (state.phase) {
            case 'idle': return `Sends in ${PUSH_DELAY_SECONDS} s so you can lock the phone. Titled as a demo; opens nothing.`;
            case 'countdown': return `Lock the phone. Sending in ${state.seconds}…`;
            case 'sending': return 'Asking the Mac…';
            case 'done': return state.line;
        }
    })();

    return (
        <ItemGroup
            title="Push"
            footer="The Mac sends one message to this phone's own token through the same push client a gate uses. That is the DROVE-70 path, proven without waiting for a to-do."
        >
            <Item
                title="Send a test push to this phone"
                subtitle={subtitle}
                subtitleLines={0}
                icon={<Ionicons
                    name={state.phase === 'done' ? (state.ok ? 'checkmark-circle-outline' : 'warning-outline') : 'notifications-outline'}
                    size={29}
                    color={state.phase === 'done' && !state.ok ? '#FF9500' : '#007AFF'}
                />}
                loading={state.phase === 'countdown' || state.phase === 'sending'}
                disabled={Platform.OS === 'web' || !machineId || (state.phase !== 'idle' && state.phase !== 'done')}
                showChevron={false}
                onPress={() => {
                    if (state.phase === 'done') {
                        setState({ phase: 'idle' });
                        return;
                    }
                    void send();
                }}
            />
            {machines.length > 1 && machines.map((machine) => (
                <Item
                    key={machine.id}
                    title={machine.metadata?.displayName || machine.metadata?.host || machine.id.substring(0, 8)}
                    subtitle={machine.id === machineId ? 'sends the push' : 'tap to send from this one'}
                    selected={machine.id === machineId}
                    showChevron={false}
                    onPress={() => setChosen(machine.id)}
                />
            ))}
        </ItemGroup>
    );
}

// ---- cards ----------------------------------------------------------------

/**
 * What a card looks like once its demo answer landed: the permission moves to
 * the status the bridge would have written, and the reason carries the pick
 * with a " · demo" suffix in the slot where a real card says " · by watch".
 */
function settle(card: DemoCard, answer: DemoAnswer | undefined): ToolCall {
    if (!answer || !card.tool.permission) return card.tool;
    const status = answer.verdict === 'deny' ? 'denied' : answer.verdict === 'cancel' ? 'canceled' : 'approved';
    return {
        ...card.tool,
        state: 'completed',
        completedAt: Date.now(),
        permission: {
            ...card.tool.permission,
            status,
            reason: `${answer.detail ?? answer.verdict} · demo`,
        },
    };
}

function CardsSection() {
    const [cards, setCards] = React.useState<DemoCard[]>(() => demoTranscriptCards());
    const [inbox, setInbox] = React.useState<DroverGateEntry[]>(() => demoInboxEntries());
    const [answered, setAnswered] = React.useState<Record<string, DemoAnswer>>({});
    // A key that changes on reset, so every card remounts with fresh local
    // state; the question form and the to-do view remember their own submit.
    const [generation, setGeneration] = React.useState(0);

    // The sink is where sessionAllow / sessionDeny deliver a demo answer. It
    // is registered for as long as this screen is mounted and nowhere else;
    // with it gone a demo id is still refused, only nobody draws the result.
    React.useEffect(() => {
        setDemoAnswerSink((answer) => {
            setAnswered((previous) => ({ ...previous, [answer.requestId]: answer }));
            // The inbox retires a card the moment it is answered, because the
            // bus would have resolved it. Same here, or the demo inbox would
            // show a state the real one never does.
            setInbox((previous) => previous.filter((entry) => entry.requestId !== answer.requestId));
        });
        return () => setDemoAnswerSink(null);
    }, []);

    const reset = React.useCallback(() => {
        demoLog('cards reset');
        setAnswered({});
        setCards(demoTranscriptCards());
        setInbox(demoInboxEntries());
        setGeneration((g) => g + 1);
    }, []);

    return (
        <>
            <ItemGroup
                title="Cards, as the transcript shows them"
                footer="Every button is the real one. Answers land in the demo sink and in the log, never on the Mac."
            >
                <Item
                    title="Reset the cards"
                    subtitle={Object.keys(answered).length === 0
                        ? 'Nothing answered yet'
                        : `${Object.keys(answered).length} answered, none sent`}
                    icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                    showChevron={false}
                    onPress={reset}
                />
            </ItemGroup>
            <View style={styles.cards} key={`transcript-${generation}`}>
                {cards.map((card) => (
                    <View key={card.id} style={styles.card}>
                        <Text style={styles.cardLabel}>{card.label}</Text>
                        <Text style={styles.cardNote}>{card.note}</Text>
                        <ToolView
                            tool={settle(card, answered[card.id])}
                            metadata={null}
                            sessionId={DEMO_SESSION_ID}
                        />
                    </View>
                ))}
            </View>
            <ItemGroup
                title="Cards, as the inbox shows them"
                footer="The same three kinds the inbox groups: prompts that block a session, and a to-do that never expires. A card leaves when it is answered, the way the inbox does it."
            >
                <Item
                    title={inbox.length === 0 ? 'All answered' : `${inbox.length} in the demo inbox`}
                    subtitle={inbox.length === 0 ? 'Reset above to bring them back' : 'Oldest first, like the real one'}
                    icon={<Ionicons name="mail-unread-outline" size={29} color="#007AFF" />}
                    showChevron={false}
                />
            </ItemGroup>
            <View style={styles.cards} key={`inbox-${generation}`}>
                {inbox.map((entry) => (
                    <GateCard key={entry.gate.id} entry={entry} focused={false} />
                ))}
            </View>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    cards: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: 16,
        paddingBottom: 8,
        gap: 16,
    },
    card: {
        gap: 2,
    },
    cardLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    cardNote: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
}));
