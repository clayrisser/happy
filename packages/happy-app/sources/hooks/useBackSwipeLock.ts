import * as React from 'react';
import { AppState } from 'react-native';
import { NavigationContext, NavigationRouteContext, type ParamListBase } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { createBackSwipeLockRegistry } from '@/navigation/backSwipeLock';

/**
 * The screen's swipe-back, held for the duration of a horizontal drag inside a
 * control (DROVE-216). See `sources/navigation/backSwipeLock.ts` for why this
 * is a lock on the navigator rather than a responder claim on the control, and
 * `sources/navigation/backSwipeOwners.ts` for which controls take it.
 *
 * Two shapes, one lock:
 *
 *   const backSwipe = useBackSwipeLock();
 *   ...
 *   onResponderGrant={() => { backSwipe.begin(); ... }}
 *   onResponderRelease={() => { backSwipe.end(); ... }}
 *
 *   <ScrollView horizontal {...backSwipe.scrollProps} />
 *
 * `scrollProps` hangs the hold on the touch rather than on the scroll, because
 * the pop recogniser decides at the first movement: by the time
 * `onScrollBeginDrag` fires the race is already over. Touch-down is the last
 * moment that is reliably early enough.
 *
 * The contexts are read directly rather than through `useNavigation` and
 * `useRoute`, which throw off a route. `ModalProvider` renders above the
 * navigator, so a markdown body inside a modal is genuinely off one, and a
 * throw there would be a crash in place of a gesture nicety. Off a route the
 * hook is simply inert.
 */

// One registry for the app. Keyed by route key, so every control on a screen
// shares that screen's lock and one control's release cannot hand the gesture
// back while another is still dragging.
const registry = createBackSwipeLockRegistry();

export interface BackSwipeLockHandle {
    /** Take the screen's back gesture. Repeat calls inside one drag are ignored. */
    begin(): void;
    /** Give it back. Idempotent, so release and terminate can both call it. */
    end(): void;
    /** Spread onto a horizontal ScrollView. */
    scrollProps: {
        onTouchStart(): void;
        onTouchEnd(): void;
        onTouchCancel(): void;
    };
}

export function useBackSwipeLock(): BackSwipeLockHandle {
    const navigation = React.useContext(NavigationContext) as
        | NativeStackNavigationProp<ParamListBase>
        | undefined;
    const routeKey = React.useContext(NavigationRouteContext)?.key ?? null;

    // The navigation object is stable for the life of the screen, but read it
    // through a ref anyway so the apply the registry keeps never goes stale.
    const navigationRef = React.useRef(navigation);
    navigationRef.current = navigation;

    const lock = React.useMemo(() => {
        if (!routeKey) return null;
        return registry.open(routeKey, (enabled) => {
            // Only `gestureEnabled`. `fullScreenGestureEnabled` is off across
            // the app, and writing `true` to it on release would hand the user
            // a full-screen back swipe no screen has ever had.
            navigationRef.current?.setOptions({ gestureEnabled: enabled });
        });
    }, [routeKey]);

    React.useEffect(() => {
        if (!routeKey) return;
        return () => registry.close(routeKey);
    }, [routeKey]);

    const held = React.useRef<null | (() => void)>(null);

    const end = React.useCallback(() => {
        const release = held.current;
        held.current = null;
        release?.();
    }, []);

    const begin = React.useCallback(() => {
        if (!lock || held.current) return;
        held.current = lock.acquire();
    }, [lock]);

    // Restore 1: the component goes away mid-drag.
    React.useEffect(() => end, [end]);

    // Restore 2: a call, a notification, or the app going to the background.
    // The touch that would have released never arrives in any of those.
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (status) => {
            if (status !== 'active') end();
        });
        return () => subscription.remove();
    }, [end]);

    // Restore 3: the screen loses focus, including a pop driven by the back
    // button or a deep link rather than by the gesture this lock holds off.
    React.useEffect(() => {
        if (!navigation) return;
        return navigation.addListener('blur', end);
    }, [navigation, end]);

    const scrollProps = React.useMemo(() => ({
        onTouchStart: begin,
        onTouchEnd: end,
        onTouchCancel: end,
    }), [begin, end]);

    return React.useMemo(() => ({ begin, end, scrollProps }), [begin, end, scrollProps]);
}
