import * as React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { CommandView } from '@/components/CommandView';
import { useSetting } from '@/sync/storage';
import { isCodeWrapOn } from '@/sync/settings';
import { readBashResult } from './bashResult';

interface BashViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const BashViewFull = React.memo<BashViewFullProps>(({ tool, metadata }) => {
    const { input } = tool;
    // One reader shared with the compact card (DROVE-95): stdout renders
    // whenever the result has any, whatever shape it arrived in.
    const { stdout, stderr, error } = readBashResult(tool);
    // With wrap on there is no horizontal ScrollView: the card is as wide as
    // the screen and the text breaks inside it. The double-tap that flips
    // this lives in CommandView.
    const codeWrap = useSetting('codeWrap');
    const wrap = isCodeWrapOn({ codeWrap }, 'terminal');

    const card = (
        <View style={wrap ? styles.wrappedCommand : styles.commandWrapper}>
            <CommandView
                command={input.command}
                stdout={stdout}
                stderr={stderr}
                error={error}
                fullWidth
            />
        </View>
    );

    return (
        <View style={styles.container}>
            <View style={styles.terminalContainer}>
                {wrap ? card : (
                    <ScrollView 
                        horizontal
                        showsHorizontalScrollIndicator={true}
                        contentContainerStyle={styles.scrollContent}
                    >
                        {card}
                    </ScrollView>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: 0,
        paddingTop: 32,
        paddingBottom: 64,
        marginBottom: 0,
        flex: 1,
    },
    terminalContainer: {
        flex: 1,
    },
    scrollContent: {
        flexGrow: 1,
    },
    commandWrapper: {
        flex: 1,
        minWidth: '100%',
    },
    wrappedCommand: {
        width: '100%',
    },
});