import * as React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

// The longhorn is 1.56:1, so it gets a wide box rather than the square one a
// letterform wanted: 26 across keeps the horns the same optical weight the old
// mark had at 19, and `contain` derives the 17 of height it actually uses.
const HEADER_LOGO_WIDTH = 26;
const HEADER_LOGO_HEIGHT = 19;

/**
 * Shared header logo component used across all main tabs.
 * Extracted to prevent flickering on tab switches - when each tab
 * had its own HeaderLeft, the component would unmount/remount.
 */
export const HeaderLogo = React.memo(() => {
    const { theme } = useUnistyles();
    return (
        <View style={{
            width: 32,
            height: 32,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            <Image
                source={require('@/assets/images/logo-drover.png')}
                contentFit="contain"
                style={{ width: HEADER_LOGO_WIDTH, height: HEADER_LOGO_HEIGHT }}
                tintColor={theme.colors.header.tint}
            />
        </View>
    );
});
