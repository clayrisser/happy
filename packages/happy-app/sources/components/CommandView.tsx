import * as React from 'react';
import { Text, View, StyleSheet, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DoubleTap, WrapGlyph } from './CodeWrapToggle';
import { useCodeWrap } from './useCodeWrap';
import { highlight, highlightShell } from './syntax/highlight';
import { detectOutputLanguage } from './syntax/detect';
import { SyntaxSpans } from './syntax/SyntaxText';

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
    // Terminal cards arrive wrapped (DROVE-149): the text shrinks to the card
    // and long tokens break at any character. A double-tap turns wrapping off
    // for every terminal card, which lays the text out on one line and puts
    // the full view back in a horizontal ScrollView; a second brings it back.
    const [wrap, toggleWrap] = useCodeWrap('terminal');
    // Use legacy output if new props aren't provided
    const hasNewProps = stdout !== undefined || stderr !== undefined || error !== undefined;

    // The command is bash by construction, so this is not a guess. What is a
    // guess, and the reason this ticket exists, is what a heredoc body holds:
    // `python3 - <<'PY'` is a shell call carrying Python, and colouring the
    // Python as shell is worse than leaving it grey (DROVE-159).
    const commandSpans = React.useMemo(() => highlightShell(command), [command]);
    // Output is not code. A stack trace, a test report and a paragraph of
    // English all match a shell rule or two, so nothing here is sniffed: only
    // a payload that actually parses as JSON gets colour, everything else
    // renders exactly as it did before.
    const stdoutSpans = React.useMemo(() => {
        if (!stdout) return [];
        const language = detectOutputLanguage(stdout);
        return language ? highlight(stdout, language) : [];
    }, [stdout]);

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
                    <Text style={[styles.commandText, wrapped]}>
                        <SyntaxSpans spans={commandSpans} palette={theme.colors.terminal.syntax} />
                    </Text>
                </View>

                {hasNewProps ? (
                    <>
                        {/* Standard Output */}
                        {stdout && stdout.trim() && (
                            <Text style={[styles.stdout, wrapped]}>
                                {stdoutSpans.length > 0
                                    ? <SyntaxSpans spans={stdoutSpans} palette={theme.colors.terminal.syntax} />
                                    : stdout}
                            </Text>
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

