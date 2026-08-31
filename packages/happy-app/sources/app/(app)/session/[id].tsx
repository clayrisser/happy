import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { SessionView } from '@/-session/SessionView';
import { gateOverlayFocus } from '@/components/sessionGateDeck';


export default React.memo(() => {
    const route = useRoute();
    const params = route.params as { id: string; gate?: string } | undefined;
    const sessionId = params!.id;
    // `?gate=` is a tap on a gate push asking for that card (DROVE-94). The
    // overlay is mounted deep inside SessionView and the same view draws in a
    // side panel with no route of its own, so the ask goes through a shared
    // request rather than a prop.
    const gateId = typeof params?.gate === 'string' && params.gate.trim() ? params.gate.trim() : null;
    React.useEffect(() => {
        if (gateId) gateOverlayFocus.request({ sessionId, gateId });
    }, [gateId, sessionId]);
    return (<SessionView id={sessionId} />);
});