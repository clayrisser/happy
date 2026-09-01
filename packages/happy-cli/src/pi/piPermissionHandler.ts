/**
 * Permission requests for a pi session (DROVE-316).
 *
 * Everything the app side needs — raise the card, hold the promise, move it to
 * completedRequests when somebody answers, and `resolveExternally` for a bus
 * surface that answered first — now lives on BasePermissionHandler, so this is
 * the whole of pi's part.
 *
 * NOTHING IS AUTO-APPROVED HERE. Codex has an allowlist because its own
 * `change_title` tool would otherwise raise a card for a housekeeping call the
 * human has no opinion about. pi's read-only built-ins are already filtered one
 * layer down, inside adapters/pi-gate.mjs, which never raises a dialog for
 * `read`, `ls`, `grep` or `find` in the first place — so anything that reaches
 * this class is a call that a human is meant to see. A second allowlist here
 * would be a silent way to widen the first.
 */

import {
    BasePermissionHandler,
    type PermissionResult,
    type PendingRequest,
} from '@/utils/BasePermissionHandler';

export type { PermissionResult, PendingRequest };

export class PiPermissionHandler extends BasePermissionHandler {
    protected getLogPrefix(): string {
        return '[pi]';
    }
}
