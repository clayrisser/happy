import * as React from 'react';
import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/**
 * The Cattle Drover wordmark: the longhorn above the product name.
 *
 * There is no drawn wordmark to ship, so this is set live rather than
 * imported: the mark (assets/images/logo-drover.png, an alpha mask so it takes
 * the theme's text colour) over Bricolage Grotesque, the face
 * Typography already reserves for branding. One component, so the welcome
 * screen and Settings cannot drift apart.
 *
 * `width` sizes the mark; everything else is derived from it, so a caller
 * picks one number.
 */
export const Wordmark = React.memo((props: { width?: number }) => {
    const { theme } = useUnistyles();
    const width = props.width ?? 200;
    return (
        <View style={{ alignItems: 'center' }}>
            <Image
                source={require('@/assets/images/logo-drover.png')}
                contentFit="contain"
                style={{ width, height: Math.round(width / 1.564) }}
                tintColor={theme.colors.text}
            />
            <Text
                style={{
                    marginTop: Math.round(width * 0.06),
                    fontSize: Math.round(width * 0.15),
                    lineHeight: Math.round(width * 0.19),
                    letterSpacing: width * 0.004,
                    color: theme.colors.text,
                    ...Typography.logo(),
                }}
            >
                Cattle Drover
            </Text>
        </View>
    );
});

Wordmark.displayName = 'Wordmark';
