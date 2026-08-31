import * as React from 'react';
import { Text, View, StyleSheet, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DoubleTap, WrapGlyph } from './CodeWrapToggle';
import { useCodeWrap } from './useCodeWrap';

interface CommandViewProps {
    command: string;
    prompt?: string;
    stdout?: string | null;
    stderr?: string | null;
    error?: string | null;
    // Legacy prop for backward compatibility
    output?: string | null;
    maxHeight?: number;
    fullWidth?: boolean;
    hideEmptyOutput?: boolean;
}

export const CommandView = React.memo<CommandViewProps>(({
    command,
    prompt = '$',
    stdout,
    stderr,
    error,
    output,
    maxHeight,
    fullWidth,
    hideEmptyOutput,
}) => {
    const { theme } = useUnistyles();
    // Double-tap flips soft wrap for every terminal card (DROVE-95). With
    // wrap on, the text shrinks to the card and long tokens break at any
    // character; with it off the card lays out as it always did, and the
    // full view puts it in a horizontal ScrollView.
    const [wrap, toggleWrap] = useCodeWrap('terminal');
    // Use legacy output if new props aren't provided
    const hasNewProps = stdout !== undefined || stderr !== undefined || error !== undefined;

    const styles = StyleSheet.create({
        container: {
            backgroundColor: theme.colors.terminal.background,
            borderRadius: 8,
            overflow: 'hidden',
            padding: 16,
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
        },
        line: {
            alignItems: 'baseline',
            flexDirection: 'row',
            flexWrap: 'wrap',
            // Keeps the first line clear of the wrap glyph in the corner.
            paddingRight: 20,
        },
        wrapped: {
            flexShrink: 1,
            alignSelf: 'stretch',
        },
        promptText: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 14,
            lineHeight: 20,
            color: theme.colors.terminal.prompt,
            fontWeight: '600',
        },
        commandText: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 14,
            color: theme.colors.terminal.command,
            lineHeight: 20,
            flex: 1,
        },
        stdout: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.stdout,
            lineHeight: 18,
            marginTop: 8,
        },
        stderr: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.stderr,
            lineHeight: 18,
            marginTop: 8,
        },
        error: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.error,
            lineHeight: 18,
            marginTop: 8,
        },
        emptyOutput: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.emptyOutput,
            lineHeight: 18,
            marginTop: 8,
            fontStyle: 'italic',
        },
    });

    const wrapped = wrap ? styles.wrapped : undefined;

    return (
        <DoubleTap onDoubleTap={toggleWrap} style={fullWidth ? { width: '100%' } : undefined}>
            <View style={[
                styles.container, 
                maxHeight ? { maxHeight } : undefined,
                fullWidth ? { width: '100%' } : undefined
            ]}>
                {/* Command Line */}
                <View style={[styles.line, wrapped]}>
                    <Text style={styles.promptText}>{prompt} </Text>
                    <Text style={[styles.commandText, wrapped]}>{command}</Text>
                </View>

                {hasNewProps ? (
                    <>
                        {/* Standard Output */}
                        {stdout && stdout.trim() && (
                            <Text style={[styles.stdout, wrapped]}>{stdout}</Text>
                        )}

                        {/* Standard Error */}
                        {stderr && stderr.trim() && (
                            <Text style={[styles.stderr, wrapped]}>{stderr}</Text>
                        )}

                        {/* Error Message */}
                        {error && (
                            <Text style={[styles.error, wrapped]}>{error}</Text>
                        )}

                        {/* Empty output indicator */}
                        {!stdout && !stderr && !error && !hideEmptyOutput && (
                            <Text style={styles.emptyOutput}>[Command completed with no output]</Text>
                        )}
                    </>
                ) : (
                    /* Legacy output format */
                    output && (
                        <Text style={[styles.commandText, wrapped]}>{'\n---\n' + output}</Text>
                    )
                )}

                <WrapGlyph on={wrap} color={theme.colors.terminal.prompt} />
            </View>
        </DoubleTap>
    );
});

