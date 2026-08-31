import * as React from 'react';
import { Text, View, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { highlight, highlightShell } from './syntax/highlight';
import { SyntaxSpans } from './syntax/SyntaxText';

interface CodeViewProps {
    code: string;
    /** A known language. Left off, the language is sniffed and often declined. */
    language?: string;
    /** The text is a shell command, so a heredoc gets its own grammar. */
    shell?: boolean;
}

/**
 * The monospace block behind the tool detail screens: raw tool JSON, a
 * structured field's raw value, session metadata, a Gemini shell call.
 *
 * It took a `language` prop and ignored it until DROVE-159. Now it honours it,
 * and sniffs when it is not given, which is what turns the JSON dumps from a
 * wall into something with shape. A sniff that does not land renders exactly
 * what this component drew before: one flat run of text.
 */
export const CodeView = React.memo<CodeViewProps>(({
    code,
    language,
    shell
}) => {
    const { theme } = useUnistyles();
    const spans = React.useMemo(
        () => (shell ? highlightShell(code) : highlight(code, language ?? null)),
        [code, language, shell],
    );

    return (
        <View style={styles.codeBlock}>
            <Text style={styles.codeText}>
                <SyntaxSpans spans={spans} palette={theme.colors.syntax} />
            </Text>
        </View>
    );
});

CodeView.displayName = 'CodeView';

const styles = StyleSheet.create((theme) => ({
    codeBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 6,
        padding: 12,
    },
    codeText: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
        fontSize: 12,
        color: theme.colors.syntax.plain,
        lineHeight: 18,
    },
}));
