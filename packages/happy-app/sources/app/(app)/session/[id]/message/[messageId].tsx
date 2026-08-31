import * as React from 'react';
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { Text, View, ActivityIndicator } from "react-native";
import { useMessage, useSession, useSessionMessages } from "@/sync/storage";
import { useSubagentMessage, useSubagentScopeLoaded } from '@/sync/subagentMessages';
import { sync } from '@/sync/sync';
import { Deferred } from "@/components/Deferred";
import { ToolFullView } from '@/components/tools/ToolFullView';
import { ToolHeader } from '@/components/tools/ToolHeader';
import { ToolStatusIndicator } from '@/components/tools/ToolStatusIndicator';
import { Message } from '@/sync/typesMessage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    fullViewContainer: {
        flex: 1,
        padding: 16,
    },
    messageText: {
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
        ...Typography.default(),
    },
}));

export default React.memo(() => {
    const { id: sessionId, messageId, agentId } = useLocalSearchParams<{ id: string; messageId: string; agentId?: string }>();
    const router = useRouter();
    const session = useSession(sessionId!);
    const { isLoaded: sessionMessagesLoaded } = useSessionMessages(sessionId!);
    const sessionMessage = useMessage(sessionId!, messageId!);
    // Opened from an agent screen, the id is the AGENT's and is not in the
    // session's map. The agent screen publishes what it draws, so the row and
    // this screen read the same object (DROVE-166). Nothing published means no
    // agent screen is behind this one, so it is a stale link: fall back to the
    // session and end the way it always did rather than spin forever.
    const agentScope = agentId && agentId.length > 0 ? agentId : null;
    const agentMessage = useSubagentMessage(sessionId, agentScope, messageId);
    const scoped = useSubagentScopeLoaded(sessionId, agentScope);
    const message = scoped ? agentMessage : sessionMessage;
    const messagesLoaded = scoped ? true : sessionMessagesLoaded;
    const { theme } = useUnistyles();
    const styles = stylesheet;

    // Trigger session visibility when component mounts
    React.useEffect(() => {
        if (sessionId) {
            sync.onSessionVisible(sessionId);
        }
    }, [sessionId]);
    
    // Navigate back if message doesn't exist after messages are loaded
    React.useEffect(() => {
        if (messagesLoaded && !message) {
            router.back();
        }
    }, [messagesLoaded, message, router]);
    
    // Configure header for tool messages
    React.useLayoutEffect(() => {
        if (message && message.kind === 'tool-call' && message.tool) {
            // Header is configured in the Stack.Screen options
        }
    }, [message]);
    
    // Show loader while waiting for session and messages to load
    if (!session || !messagesLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    
    // If messages are loaded but specific message not found, show loader briefly
    // The useEffect above will navigate back
    if (!message) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    
    return (
        <>
            {message && message.kind === 'tool-call' && message.tool && (
                <Stack.Screen
                    options={{
                        headerTitle: () => <ToolHeader tool={message.tool} />,
                        headerRight: () => <ToolStatusIndicator tool={message.tool} />,
                        headerTintColor: theme.colors.header.tint,
                        headerShadowVisible: false,
                    }}
                />
            )}
            <Deferred>
                <FullView message={message} />
            </Deferred>
        </>
    );
});

function FullView(props: { message: Message }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    
    if (props.message.kind === 'tool-call') {
        return <ToolFullView tool={props.message.tool} messages={props.message.children} />
    }
    if (props.message.kind === 'agent-text') {
        return (
            <View style={styles.fullViewContainer}>
                <Text style={styles.messageText}>{props.message.text}</Text>
            </View>
        )
    }
    if (props.message.kind === 'user-text') {
        return (
            <View style={styles.fullViewContainer}>
                <Text style={styles.messageText}>{props.message.text}</Text>
            </View>
        )
    }
    return null;
}
