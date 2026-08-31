/**
 * One picture, drawn the same way wherever it shows up (DROVE-151).
 *
 * Clay, pointing at a Read of a screenshot: "why don't you actually show the
 * image inline". It used to be two taps away in the tool detail screen, small,
 * left aligned and letterboxed in black, because the frame was 100% wide, capped
 * in height, and filled with contentFit contain: the leftover width became bars.
 *
 * Here the frame IS the picture's shape. The column is measured, the height
 * follows the aspect ratio, and a cap keeps a tall screenshot from swallowing
 * the scroll. Tap opens the full screen viewer, where the resolution lives.
 */
import * as React from 'react';
import { LayoutChangeEvent, Pressable, View } from 'react-native';
import { Image, type ImageSource } from 'expo-image';
import { StyleSheet } from 'react-native-unistyles';

import { imageAspect, imageDisplaySize } from '@/utils/imageResult';
import { ImageViewer } from './ImageViewer';

export const inlineImageMaxHeight = 360;

interface InlineImageProps {
    uri: string | undefined;
    /** Natural pixel size when the source reports it; drives the aspect ratio. */
    width?: number;
    height?: number;
    maxHeight?: number;
    /** A thumbhash or similar, shown until the real bytes land. */
    placeholder?: ImageSource;
    /**
     * Drawn instead of the frame when the file will not load, so a broken
     * source degrades to what was there before rather than an empty box.
     */
    fallback?: React.ReactNode;
}

export const InlineImage = React.memo<InlineImageProps>(({
    uri,
    width,
    height,
    maxHeight = inlineImageMaxHeight,
    placeholder,
    fallback,
}) => {
    const [columnWidth, setColumnWidth] = React.useState(0);
    const [failed, setFailed] = React.useState(false);
    const [viewerOpen, setViewerOpen] = React.useState(false);

    React.useEffect(() => {
        setFailed(false);
    }, [uri]);

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        setColumnWidth(event.nativeEvent.layout.width);
    }, []);

    const openViewer = React.useCallback(() => setViewerOpen(true), []);
    const closeViewer = React.useCallback(() => setViewerOpen(false), []);

    const box = React.useMemo(() => imageDisplaySize({
        containerWidth: columnWidth,
        aspect: imageAspect(width, height),
        maxHeight,
        maxWidth: typeof width === 'number' && width > 0 ? width : undefined,
    }), [columnWidth, width, height, maxHeight]);

    // Nothing to draw and nothing on the way: hand back whatever the caller
    // showed before rather than an empty frame.
    if (failed || (!uri && !placeholder)) {
        return <>{fallback ?? null}</>;
    }

    return (
        <View style={styles.column} onLayout={onLayout}>
            {box ? (
                <Pressable onPress={openViewer} accessibilityRole="imagebutton" disabled={!uri}>
                    <Image
                        source={uri ? { uri } : undefined}
                        placeholder={placeholder}
                        style={[styles.image, { width: box.width, height: box.height }]}
                        contentFit="cover"
                        transition={150}
                        onError={() => setFailed(true)}
                    />
                </Pressable>
            ) : null}
            {uri ? <ImageViewer uri={uri} visible={viewerOpen} onClose={closeViewer} /> : null}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    column: {
        width: '100%',
        alignItems: 'flex-start',
    },
    image: {
        borderRadius: 8,
    },
}));
