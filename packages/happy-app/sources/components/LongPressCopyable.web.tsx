import * as React from 'react';
import { View } from 'react-native';
import type { LongPressCopyableProps } from './LongPressCopyable';

/** Web keeps plain mouse selection and renders the children untouched. */
export function LongPressCopyable(props: LongPressCopyableProps) {
    return <View style={props.style}>{props.children}</View>;
}
