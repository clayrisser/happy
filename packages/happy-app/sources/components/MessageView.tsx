import * as React from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { useCrossSessionMessage, useSetting } from '@/sync/storage';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage, isUserSlashCommandEcho } from './parseLocalCommandMessage';
import { resolveUserMessageBubbleColor } from '@/utils/userMessageBubbleColor';
import { LongPressCopyable } from './LongPressCopyable';
import { extractThinkingText, isEmptyThinking } from '@/utils/thinkingText';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { useSpokenSentence } from '@/voice/readAloudPlayhead';
import { readAloudSentenceFromHere, readAloudSubagentSentenceFromHere } from '@/voice/readAloudService';
import { useSubagentScope } from '@/sync/subagentMessages';
import { formatWorkDuration } from '@/hooks/useGroupedMessages';
import { agentLongPressCopyText } from '@/utils/agentTurnCopy';
import { DisclosureFooter, useInlineDisclosure } from './DisclosureFooter';
import { edgeClearance, tapSlopFor } from './scrollIndicatorInset';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { thumbhashToDataUri } from '@/utils/thumbhash';
import { InlineImage } from './InlineImage';
import type { CrossSessionImage, CrossSessionRender } from '@/utils/crossSessionAttachments';


export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  copyText?: string;
  /** This is the newest message and the agent is still working on it. */
  live?: boolean;
  /** subagent id -> the Task/Agent tool-call message that owns its transcript. */
  subagentTaskMessageIds?: ReadonlyMap<string, string>;
}) => {
  // Claude Code stores most thinking as a signature with no words, so this row
  // would open onto nothing. Fold what exists, draw nothing for what does not,
  // and two such blocks in a row leave no trace instead of two blank rows
  // (DROVE-46). The grouping layer filters these too; this is the backstop for
  // every other path that renders a message directly.
  if (props.message.kind === 'agent-text' && props.message.isThinking && isEmptyThinking(props.message.text)) {
    return null;
  }

  return (
    <View
      style={styles.messageContainer}
      renderToHardwareTextureAndroid={Platform.OS !== 'web'}
    >
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          copyText={props.copyText}
          live={props.live}
          subagentTaskMessageIds={props.subagentTaskMessageIds}
        />
      </View>
    </View>
  );
});

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  copyText?: string;
  live?: boolean;
  subagentTaskMessageIds?: ReadonlyMap<string, string>;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
        />
      );

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} copyText={props.copyText} live={props.live} />;

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return (
        <AgentEventBlock
          event={props.message.event}
          metadata={props.metadata}
          sessionId={props.sessionId}
          subagentTaskMessageIds={props.subagentTaskMessageIds}
        />
      );


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
  sessionId: string;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  // The envelope a phone message arrives in, already read apart (DROVE-234).
  // Null for every message that is not exactly that envelope, which is nearly
  // all of them.
  const crossSession = useCrossSessionMessage(props.sessionId, props.message.id);

  const userMessageBubbleColor = useSetting('userMessageBubbleColor');
  const { theme } = useUnistyles();
  const bubblePalette = resolveUserMessageBubbleColor(userMessageBubbleColor, theme.dark);
  const bubbleStyle = {
    backgroundColor: bubblePalette.background,
    borderColor: bubblePalette.border,
  };
  // Claude Agent SDK emits synthetic user messages wrapped in tags like
  // <local-command-caveat>…</local-command-caveat> and
  // <command-message>…</command-message><command-name>/foo</command-name>
  // whenever a slash command runs. The plain MarkdownView renders these as
  // literal text, which looks broken. Collapse them into chips or hide
  // them entirely depending on what kind of wrapper this is.
  // The user's own slash-command input is shown optimistically (carries a
  // localId); the SDK then injects the canonical wrapper chip. Hide the raw
  // echo so we don't render the command twice. Gated to Claude flavor only:
  // Codex/Gemini don't reliably emit the <command-*> wrapper, so hiding the
  // echo there would drop the command with nothing to replace it. (Absent
  // flavor == Claude, matching the convention used elsewhere.)
  const isClaudeFlavor = !props.metadata?.flavor || props.metadata.flavor === 'claude';
  if (isClaudeFlavor && isUserSlashCommandEcho(props.message.text, props.message.localId != null)) {
    return null;
  }

  if (crossSession) {
    return (
      <CrossSessionBlock
        render={crossSession}
        sessionId={props.sessionId}
        bubbleStyle={bubbleStyle}
        onOptionPress={handleOptionPress}
      />
    );
  }

  const parsed = parseLocalCommandMessage(props.message.displayText || props.message.text);
  if (parsed.kind === 'caveat') {
    return null;
  }
  if (parsed.kind === 'goal-confirmation') {
    return null;
  }
  if (parsed.kind === 'goal-run') {
    return (
      <View style={styles.userMessageContainer}>
        <LongPressCopyable style={styles.userCopyTarget} text={parsed.goal}>
          <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, bubbleStyle, styles.goalMessageBubble]}>
            <MarkdownView externalCopyHandler markdown={parsed.goal} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
          </View>
          <View style={styles.goalSentRow}>
            <Ionicons name="locate-outline" size={16} color={styles.goalSentText.color} />
            <Text style={styles.goalSentText}>{t('message.sentAsGoal')}</Text>
          </View>
        </LongPressCopyable>
      </View>
    );
  }
  if (parsed.kind === 'command-run') {
    const commandText = parsed.args ? `/${parsed.commandName} ${parsed.args}` : `/${parsed.commandName}`;
    return (
      <View style={styles.userMessageContainer}>
        <LongPressCopyable style={styles.userCopyTarget} text={commandText}>
          {parsed.args ? (
            <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, bubbleStyle, styles.commandMessageBubble]}>
              <MarkdownView externalCopyHandler markdown={parsed.args} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
            </View>
          ) : null}
          <View style={[styles.commandChip, styles.userMessageBubbleSolid, bubbleStyle]}>
            <Text style={styles.commandChipText}>/{parsed.commandName}</Text>
          </View>
        </LongPressCopyable>
      </View>
    );
  }

  return (
    <View style={styles.userMessageContainer}>
      {/* Hold raises the platform context menu at the finger. Rewind remains in
          session actions. */}
      <LongPressCopyable style={styles.userCopyTarget} text={parsed.text}>
        <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, bubbleStyle]}>
          <MarkdownView externalCopyHandler markdown={parsed.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
        </View>
      </LongPressCopyable>
    </View>
  );
}

/**
 * A message the phone sent, drawn as what it means (DROVE-234).
 *
 * The wrapper becomes a line of attribution under the bubble, the "read it
 * with the Read tool" sentence is gone because it was addressed to the model,
 * and each `[Image N: ...]` marker draws its picture. Everything else in the
 * body is still ordinary markdown, angle brackets and all.
 */
function CrossSessionBlock(props: {
  render: CrossSessionRender;
  sessionId: string;
  bubbleStyle: { backgroundColor: string; borderColor: string };
  onOptionPress: (option: Option) => void;
}) {
  const { render, sessionId } = props;
  const attribution = render.sender
    ? (render.sender.mode
      ? t('message.sentFromWithMode', { name: render.sender.name, mode: render.sender.mode })
      : t('message.sentFrom', { name: render.sender.name }))
    : null;

  // The pictures and the attribution sit OUTSIDE the copy target, as siblings
  // of the bubble. The copy target's width is its content, and a picture asked
  // to fill it would measure zero on a message that is nothing but pictures.
  return (
    <View style={styles.userMessageContainer}>
      {render.body.length > 0 ? (
        <LongPressCopyable style={styles.userCopyTarget} text={render.body}>
          <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, props.bubbleStyle]}>
            <MarkdownView externalCopyHandler markdown={render.body} onOptionPress={props.onOptionPress} sessionId={sessionId} />
          </View>
        </LongPressCopyable>
      ) : null}
      {render.images.map((image) => (
        <CrossSessionImageView key={`${image.marker.index}:${image.marker.path}`} image={image} sessionId={sessionId} />
      ))}
      {attribution ? (
        <View style={styles.crossSessionRow}>
          <Ionicons name="phone-portrait-outline" size={14} color={styles.crossSessionText.color} />
          <Text style={styles.crossSessionText}>{attribution}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * One marker, drawn.
 *
 * The bytes come back the way they went out: the app uploaded this image
 * encrypted and the blob is still on the server, so the ref off the matching
 * `file` event is all that is needed. The absolute Mac path in the marker is
 * never opened. The phone could not open it, and after a `/flip` it does not
 * even name the directory it used to.
 *
 * A marker nothing matched keeps its literal line. Losing a picture silently
 * would be worse than showing the text that was there before.
 */
function CrossSessionImageView(props: { image: CrossSessionImage; sessionId: string }) {
  const attachment = props.image.attachment;
  const { uri, error } = useAttachmentImage(props.sessionId, attachment?.ref);
  const { theme } = useUnistyles();

  const placeholder = React.useMemo(() => {
    if (!attachment?.thumbhash) return undefined;
    const dataUri = thumbhashToDataUri(attachment.thumbhash);
    return dataUri ? { uri: dataUri } : undefined;
  }, [attachment?.thumbhash]);

  if (!attachment) {
    return (
      <View style={styles.crossSessionMarkerRow}>
        <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, styles.crossSessionMarkerBubble]}>
          <Text style={styles.crossSessionMarkerText}>{props.image.marker.raw}</Text>
        </View>
      </View>
    );
  }

  const broken = (
    <Ionicons name="alert-circle-outline" size={18} color={theme.colors.textSecondary} />
  );

  return (
    <View style={styles.crossSessionImage}>
      {error && !uri ? broken : (
        <InlineImage
          uri={uri ?? undefined}
          width={attachment.width}
          height={attachment.height}
          placeholder={placeholder}
          fallback={broken}
          align="flex-end"
        />
      )}
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  copyText?: string;
  live?: boolean;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  // The sentence read-aloud is speaking out of THIS message, or null
  // (DROVE-114). A primitive, so a row only re-renders when its own sentence
  // changes, and read above the early return below because hooks are hooks.
  const spokenSentence = useSpokenSentence(props.message.id);

  // Double tap a sentence and reading starts there (DROVE-146, DROVE-163,
  // DROVE-235). The one way the voice is steered now that scrolling does not
  // touch it, and it resolves to the sentence under the finger rather than to
  // the top of this block. TWO taps, because one is what a finger does by
  // accident on body text. The reasoning is written out in readAloudTap.ts,
  // the counting in doubleTapPress.ts.
  //
  // On a SUBAGENT screen the same tap means the same thing and cannot take
  // the same route (DROVE-195). Every row there carries the session's id, so
  // both of the tap's guards pass, but the transcript came from the agent
  // screen's own RPC poll and none of it is in the reader's timeline. The
  // sentence lookup therefore missed and the block fallback seeked the
  // SESSION by createdAt, landing the reading on whatever unrelated reply
  // shared that minute. So the subagent's tap hands its sentences over
  // instead, and the reader reads them as a detour and gives the session
  // back. The scope comes from a context because this component is several
  // memoized layers below the screen that knows.
  //
  const sessionId = props.sessionId;
  const messageId = props.message.id;
  const createdAt = props.message.createdAt;
  const agentId = useSubagentScope();
  const readFromSentence = React.useCallback((sentence: string) => {
    if (agentId !== null) {
      readAloudSubagentSentenceFromHere(sessionId, agentId, messageId, sentence);
      return;
    }
    readAloudSentenceFromHere(sessionId, messageId, sentence, createdAt);
  }, [agentId, sessionId, messageId, createdAt]);

  // The model's reasoning is folded, never dropped — one muted row that opens
  // to the whole of what the CLI sent.
  if (props.message.isThinking) {
    return (
      <ThinkingBlock
        messageId={props.message.id}
        text={props.message.text}
        startedAt={props.message.createdAt}
        live={props.live === true}
        sessionId={props.sessionId}
        onSentencePress={readFromSentence}
      />
    );
  }

  // Hold to copy, and no glyph (DROVE-121). The copy button under every reply
  // cost a line of the transcript for something the hold already does, and it
  // is the same gesture user messages have had all along.
  const copyText = agentLongPressCopyText(props.copyText, props.message.text);
  const body = (
    <MarkdownView
      markdown={props.message.text}
      onOptionPress={handleOptionPress}
      sessionId={props.sessionId}
      highlightSentence={spokenSentence}
      onSentencePress={readFromSentence}
      externalCopyHandler={copyText !== null}
    />
  );

  // The tap sits on the PROSE itself, one sentence at a time, and never on the
  // code and terminal cards, which keep their own double tap for wrapping
  // (DROVE-95, DROVE-149) and are rendered by their own components. Both are
  // two taps now, and they still cannot race: MarkdownView hands a code block
  // no sentence press, so a fence holds no sentence run for a finger to land
  // on. The two are told apart by what was touched, not by how many times.
  //
  // DROVE-146's block-level double tap is gone rather than kept alongside
  // this, which is what leaves exactly one route to the playhead: two taps on
  // a sentence would have seeked to it and then been undone by a third seek to
  // the top of the block.
  return (
    <View style={styles.agentMessageContainer}>
      {copyText !== null ? (
        <LongPressCopyable fill style={styles.agentCopyTarget} text={copyText}>
          {body}
        </LongPressCopyable>
      ) : body}
    </View>
  );
}

/**
 * The folded reasoning row, and the reading mark inside it (DROVE-181).
 *
 * READING A THINKING BLOCK DOES NOT EXPAND IT. That was the open question on
 * the ticket and this is the answer, with the reason: the block is collapsed
 * by default, and expanding it under the voice would move every row below it
 * while he is reading — sometimes for a minute of reasoning, sometimes with
 * his thumb already on the screen. DROVE-146 settled that reading must not
 * move the view, and an auto-expand is the view moving itself.
 *
 * So the mark lands in two places instead. The collapsed HEADER lights while
 * any sentence of this block is being read, which is the visible answer to
 * "what is it saying?" without a layout change; and if he opens the block the
 * sentence itself is marked exactly as a reply's is, because the same
 * `highlightSentence` goes through. Tapping a sentence inside an open block
 * seeks to it, the same as anywhere else.
 */
function ThinkingBlock(props: {
  messageId: string;
  text: string;
  startedAt: number;
  live: boolean;
  sessionId: string;
  onSentencePress: (sentence: string) => void;
}) {
  const { theme } = useUnistyles();
  const { expanded, toggle, collapse, headerRef, footerRef } = useInlineDisclosure();
  const thinking = React.useMemo(() => extractThinkingText(props.text), [props.text]);
  const elapsedSeconds = useElapsedTime(props.live ? props.startedAt : null);
  const spokenSentence = useSpokenSentence(props.messageId);
  const label = props.live
    ? `${t('message.thinkingNow')} ${formatWorkDuration(elapsedSeconds * 1000)}`
    : t('message.thoughtProcess');

  return (
    <View style={styles.disclosureContainer}>
      <Pressable
        ref={headerRef}
        collapsable={false}
        accessibilityRole="button"
        onPress={toggle}
        hitSlop={tapSlopFor(disclosureHeaderHeight)}
        style={({ pressed }) => [styles.disclosureHeader, pressed && styles.disclosurePressed]}
      >
        <Ionicons
          name="sparkles-outline"
          size={13}
          color={spokenSentence !== null ? theme.colors.text : theme.colors.textSecondary}
        />
        <Text
          style={[styles.disclosureLabel, spokenSentence !== null && styles.disclosureLabelReading]}
          numberOfLines={1}
        >
          {label}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={13}
          color={theme.colors.textSecondary}
        />
      </Pressable>
      {expanded ? (
        <>
          <View style={styles.disclosureBody}>
            <MarkdownView
              markdown={thinking}
              sessionId={props.sessionId}
              highlightSentence={spokenSentence}
              onSentencePress={props.onSentencePress}
            />
          </View>
          <DisclosureFooter
            label={label}
            onPress={collapse}
            innerRef={footerRef}
            textStyle={styles.disclosureLabel}
            style={styles.disclosureFooter}
          />
        </>
      ) : null}
    </View>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
  sessionId?: string;
  subagentTaskMessageIds?: ReadonlyMap<string, string>;
}) {
  if (props.event.type === 'subagent') {
    return (
      <SubagentRow
        event={props.event}
        sessionId={props.sessionId}
        taskMessageId={props.subagentTaskMessageIds?.get(props.event.subagent) ?? null}
      />
    );
  }
  if (props.event.type === 'subagent-stop') {
    // The reducer folds every stop into the row its start opened, so one
    // reaching the renderer means the row is already showing that state.
    return null;
  }
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
    </View>
  );
}

function SubagentRow(props: {
  event: Extract<AgentEvent, { type: 'subagent' }>;
  sessionId?: string;
  taskMessageId: string | null;
}) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { event } = props;
  const running = event.state === 'running';
  const runningSeconds = useElapsedTime(running ? event.startedAt : null);
  const durationMs = running
    ? runningSeconds * 1000
    : Math.max(0, (event.completedAt ?? event.startedAt) - event.startedAt);
  const status = running
    ? t('message.agentRunning', { duration: formatWorkDuration(durationMs) })
    : t('message.agentFinished', { duration: formatWorkDuration(durationMs) });
  const label = event.title ? `${event.title} · ${status}` : status;
  const sessionId = props.sessionId;
  const taskMessageId = props.taskMessageId;
  const canOpenTranscript = Boolean(sessionId && taskMessageId);
  const handlePress = React.useCallback(() => {
    if (!sessionId || !taskMessageId) {
      return;
    }
    router.push(`/session/${sessionId}/message/${taskMessageId}`);
  }, [router, sessionId, taskMessageId]);

  const content = (
    <>
      <Octicons name="rocket" size={13} color={theme.colors.textSecondary} />
      <Text style={styles.disclosureLabel} numberOfLines={1}>{label}</Text>
      {canOpenTranscript ? (
        <Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} />
      ) : null}
    </>
  );

  if (!canOpenTranscript) {
    // No Task card to open — Claude's own Task tool is suppressed before it
    // reaches the app, so the row stands on its own as information.
    return (
      <View style={styles.disclosureContainer}>
        <View style={styles.disclosureHeader}>{content}</View>
      </View>
    );
  }

  return (
    <View style={styles.disclosureContainer}>
      <Pressable
        accessibilityRole="button"
        onPress={handlePress}
        style={({ pressed }) => [styles.disclosureHeader, pressed && styles.disclosurePressed]}
      >
        {content}
      </Pressable>
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) {
  if (!props.message.tool) {
    return null;
  }
  return (
    <View style={styles.toolContainer}>
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.message.id}
      />
    </View>
  );
}

const disclosureContainerMargin = 16;
const disclosureHeaderHeight = 28;

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    maxWidth: layout.maxWidth,
    overflow: 'hidden',
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 4,
    maxWidth: '100%',
  },
  userMessageBubbleSolid: {
    borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
    overflow: 'hidden',
  },
  goalMessageBubble: {
    marginBottom: 6,
  },
  commandMessageBubble: {
    marginBottom: 6,
  },
  crossSessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
    maxWidth: '100%',
    opacity: 0.72,
  },
  crossSessionText: {
    color: theme.colors.agentEventText,
    fontSize: 13,
  },
  crossSessionImage: {
    width: '100%',
    alignItems: 'flex-end',
    marginBottom: 6,
  },
  crossSessionMarkerRow: {
    width: '100%',
    alignItems: 'flex-end',
  },
  crossSessionMarkerBubble: {
    backgroundColor: 'transparent',
    borderColor: theme.colors.divider,
    marginBottom: 6,
  },
  crossSessionMarkerText: {
    color: theme.colors.agentEventText,
    fontSize: 13,
    paddingVertical: 4,
  },
  goalSentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
    maxWidth: '100%',
    opacity: 0.72,
  },
  goalSentText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  commandChip: {
    backgroundColor: theme.colors.userMessageBackground,
    borderColor: theme.colors.divider,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 10,
    marginBottom: 4,
    maxWidth: '100%',
    opacity: 0.65,
  },
  commandChipText: {
    color: theme.colors.input.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  agentMessageContainer: {
    // Symmetric, so a tool row reads the same distance from the text whether
    // it lands above or below it. Total rhythm matches the old 4 + 16.
    marginHorizontal: 16,
    marginVertical: 10,
    borderRadius: 16,
    maxWidth: '100%',
  },
  // The whole reply is the hold target, and it adds no height of its own, so
  // removing the copy glyph gave the line back rather than leaving a gap.
  agentCopyTarget: {
    width: '100%',
  },
  userCopyTarget: {
    alignItems: 'flex-end',
    maxWidth: '100%',
  },
  // One muted disclosure row, sized like ToolGroupView's CollapseHeader so a
  // thought process, an agent and a "Ran N commands" row all read as one family.
  disclosureContainer: {
    marginHorizontal: disclosureContainerMargin,
    marginVertical: 4,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  disclosureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'stretch',
    minHeight: disclosureHeaderHeight,
    paddingVertical: 4,
    borderRadius: 4,
    // The container's own 16pt margin already clears the indicator's lane.
    paddingRight: edgeClearance(disclosureContainerMargin),
  },
  disclosurePressed: {
    opacity: 0.6,
  },
  disclosureLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.textSecondary,
  },
  /**
   * The collapsed thinking row while its reasoning is being read (DROVE-181).
   * Weight and colour rather than a background: the block stays the muted
   * thing it is, and nothing about the row's size changes, so the list does
   * not reflow under the voice.
   */
  disclosureLabelReading: {
    color: theme.colors.text,
    fontWeight: '600',
  },
  disclosureFooter: {
    // The container's margin already clears the indicator, as on the header.
    paddingRight: edgeClearance(disclosureContainerMargin),
  },
  disclosureBody: {
    marginTop: 2,
    opacity: 0.85,
  },
  agentEventContainer: {
    marginHorizontal: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  toolContainer: {
    marginHorizontal: 8,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
}));
