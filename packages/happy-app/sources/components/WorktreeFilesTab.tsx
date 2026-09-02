/**
 * The Files tab of the worktree sheet (DROVE-330): a read-only browser.
 *
 * Clay: "another tab that lets us browse the files ... or lets me browse the
 * files in that worktree." A crumb line, a list of one directory, and a file
 * view, backed by the drover's two file routes through the daemon. Nothing
 * writes, and nothing here decides what may be shown: a refused entry (.env,
 * a key, .git/) arrives marked and is drawn dimmed with a lock, never hidden,
 * because a `.env` that is simply absent reads as "you have no .env".
 *
 * Directories first, then names, as the bus sorted them. A file opens in the
 * same fixed-height box the Terminal tab uses, with what the drover did to it
 * (cut, binary, masked) said above the text.
 */
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import {
    machineDroverFileRead,
    machineDroverFilesList,
    type DroverFileEntry,
    type DroverFileRead,
    type DroverFilesList,
} from '@/sync/machineFiles';
import { breadcrumb, fileNotes, fileSizeLabel, joinRel, parentRel } from '@/utils/worktreeSheetTabs';
import {
    filesCrumbHeight,
    filesRowHeight,
    terminalBodyHeight,
    terminalLineHeight,
    terminalPadding,
} from './worktreeSheetLayout';

const stylesheet = StyleSheet.create((theme) => ({
    crumb: {
        height: filesCrumbHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
    },
    crumbText: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    back: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 16,
    },
    row: {
        height: filesRowHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
    },
    rowPressed: {
        opacity: 0.7,
    },
    rowRefused: {
        opacity: 0.45,
    },
    name: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    size: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        fontVariant: ['tabular-nums'],
    },
    empty: {
        paddingHorizontal: 20,
        paddingVertical: 24,
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    loading: {
        paddingVertical: 32,
        alignItems: 'center',
    },
    notes: {
        paddingHorizontal: 20,
        paddingBottom: 6,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    box: {
        marginHorizontal: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    boxContent: {
        paddingVertical: terminalPadding,
        paddingHorizontal: 12,
    },
    line: {
        fontSize: 12,
        lineHeight: terminalLineHeight,
        color: theme.colors.text,
        ...Typography.mono(),
    },
    trouble: {
        padding: 16,
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export interface WorktreeFilesTabProps {
    machineId: string | null;
    /** The worktree's absolute path on the machine: the root every request names. */
    root: string;
    /** The same, home collapsed, for the crumb. */
    scopeLabel: string;
}

function iconFor(entry: DroverFileEntry): React.ComponentProps<typeof Octicons>['name'] {
    if (entry.refused) return 'lock';
    if (entry.type === 'directory') return 'file-directory';
    return 'file';
}

export function WorktreeFilesTab(props: WorktreeFilesTabProps) {
    const { machineId, root, scopeLabel } = props;
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const window = useWindowDimensions();
    const safeArea = useSafeAreaInsets();
    const boxHeight = terminalBodyHeight({
        windowHeight: window.height,
        safeAreaTop: safeArea.top,
        safeAreaBottom: safeArea.bottom,
    });

    const [rel, setRel] = React.useState('');
    const [listing, setListing] = React.useState<DroverFilesList | null>(null);
    const [file, setFile] = React.useState<{ rel: string; read: DroverFileRead | null; trouble: string | null } | null>(null);
    const [trouble, setTrouble] = React.useState<string | null>(null);

    // A new root is a new browse: back to its top, no file open.
    React.useEffect(() => {
        setRel('');
        setFile(null);
    }, [root]);

    React.useEffect(() => {
        if (file) return;
        setListing(null);
        setTrouble(null);
        if (!machineId) {
            setTrouble('This session is not on a machine the app knows.');
            return;
        }
        let cancelled = false;
        void machineDroverFilesList(machineId, root, rel).then((result) => {
            if (cancelled) return;
            if (result.ok) setListing(result.listing);
            else setTrouble(result.error);
        });
        return () => { cancelled = true; };
    }, [machineId, root, rel, file]);

    const open = React.useCallback((entry: DroverFileEntry) => {
        if (entry.refused) return;
        const next = joinRel(rel, entry.name);
        if (entry.type === 'directory') {
            setRel(next);
            return;
        }
        if (entry.type !== 'file' || !machineId) return;
        setFile({ rel: next, read: null, trouble: null });
        void machineDroverFileRead(machineId, root, next).then((result) => {
            setFile((current) => {
                if (!current || current.rel !== next) return current;
                return result.ok
                    ? { rel: next, read: result.file, trouble: null }
                    : { rel: next, read: null, trouble: result.error };
            });
        });
    }, [machineId, rel, root]);

    const back = React.useCallback(() => {
        if (file) setFile(null);
        else setRel(parentRel(rel));
    }, [file, rel]);

    const atRoot = !file && rel === '';
    const crumb = breadcrumb(scopeLabel, file ? file.rel : rel);

    return (
        <View>
            <View style={styles.crumb}>
                <Pressable
                    onPress={back}
                    disabled={atRoot}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={file ? 'Back to the list' : 'Up one directory'}
                    style={({ pressed }) => [styles.back, atRoot && { opacity: 0.3 }, pressed && styles.rowPressed]}
                >
                    <Octicons name="chevron-left" size={16} color={theme.colors.text} />
                </Pressable>
                <Text style={styles.crumbText} numberOfLines={1} ellipsizeMode="head">{crumb}</Text>
            </View>
            {file ? (
                <FileView boxHeight={boxHeight} read={file.read} trouble={file.trouble} />
            ) : trouble ? (
                <Text style={styles.empty}>{trouble}</Text>
            ) : listing === null ? (
                <View style={styles.loading}><ActivityIndicator /></View>
            ) : listing.entries.length === 0 ? (
                <Text style={styles.empty}>An empty directory.</Text>
            ) : listing.entries.map((entry) => (
                <Pressable
                    key={entry.name}
                    onPress={() => open(entry)}
                    disabled={entry.refused || entry.type === 'other'}
                    accessibilityRole="button"
                    accessibilityLabel={entry.refused
                        ? `${entry.name}, not shown, it is secret-shaped`
                        : `${entry.name}, ${entry.type === 'directory' ? 'directory' : fileSizeLabel(entry.size) || 'file'}`}
                    style={({ pressed }) => [
                        styles.row,
                        pressed && styles.rowPressed,
                        (entry.refused || entry.type === 'other') && styles.rowRefused,
                    ]}
                >
                    <Octicons
                        name={iconFor(entry)}
                        size={15}
                        color={entry.type === 'directory' && !entry.refused ? theme.colors.text : theme.colors.textSecondary}
                    />
                    <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">{entry.name}</Text>
                    {entry.type === 'directory'
                        ? <Octicons name="chevron-right" size={13} color={theme.colors.textSecondary} />
                        : <Text style={styles.size}>{entry.refused ? 'hidden' : fileSizeLabel(entry.size)}</Text>}
                </Pressable>
            ))}
        </View>
    );
}

function FileView(props: { boxHeight: number; read: DroverFileRead | null; trouble: string | null }) {
    const styles = stylesheet;
    const { boxHeight, read, trouble } = props;
    const notes = read ? fileNotes(read) : [];
    const lines = React.useMemo(() => (read?.content ?? '').split('\n'), [read?.content]);
    return (
        <View>
            {notes.length > 0 ? <Text style={styles.notes}>{notes.join(' · ')}</Text> : null}
            <View style={[styles.box, { height: boxHeight }]}>
                {trouble ? (
                    <Text style={styles.trouble}>{trouble}</Text>
                ) : !read ? (
                    <View style={styles.loading}><ActivityIndicator /></View>
                ) : read.binary ? (
                    <Text style={styles.trouble}>A binary file. The drover does not send those.</Text>
                ) : (
                    <ScrollView style={{ height: boxHeight }} contentContainerStyle={styles.boxContent} nestedScrollEnabled>
                        {lines.map((line, i) => (
                            <Text key={i} style={styles.line} selectable>{line || ' '}</Text>
                        ))}
                    </ScrollView>
                )}
            </View>
        </View>
    );
}
