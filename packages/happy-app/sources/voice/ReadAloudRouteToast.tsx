import * as React from 'react';
import { ComposerToast } from '@/components/ComposerToast';
import { readAloudRouteToast, subscribeReadAloudRouteToast } from './audioRouteGuardService';

/**
 * The line that says why read-aloud went quiet (DROVE-119).
 *
 * The composer's own toast is state inside AgentInput and only a tap on the
 * speaker button can raise it. This one is raised from outside React, by the
 * route guard, so it carries its own subscription and draws the same
 * component (DROVE-98) in the same place: just above the composer.
 */
export const ReadAloudRouteToast = React.memo(() => {
    const text = React.useSyncExternalStore(
        subscribeReadAloudRouteToast,
        readAloudRouteToast,
        readAloudRouteToast,
    );
    return <ComposerToast text={text} />;
});
