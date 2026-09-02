export type ImageAttachmentFlavor = string | null | undefined;

export type ImageAttachmentSendPlan = {
    supportsAttachments: boolean;
    shouldUseAttachments: boolean;
    shouldShowUnsupportedAlert: boolean;
    shouldSendText: boolean;
};

/**
 * Every harness the CLI actually delivers an image to (DROVE-378).
 *
 * This used to be `claude` and `codex` alone, and everything else fell through
 * to false — which SessionView turned into no picker handlers, which AgentInput
 * turned into no plus disc at all. On an OpenCode session that reads as the
 * phone refusing to take an image with no refusal anywhere: the affordance is
 * simply missing.
 *
 * The list is what the CLI can carry, measured per harness rather than assumed:
 * `opencode` and `gemini` take real ACP image blocks when they advertise
 * `promptCapabilities.image` (OpenCode 1.18.20 does) and a staged file path when
 * they do not; `codex` takes `localImage` input items; `claude` takes SDK image
 * blocks remotely and a staged path in a pane; `pi`, `cursor`, `agy` and
 * `openclaw` carry a turn as text, so they get the image on disk and the path in
 * the words, which each of them can then read with its own read tool.
 *
 * An UNKNOWN flavor stays false on purpose. A rig or a harness this app has
 * never heard of has no delivery behind it, and the honest answer there is the
 * refusal fragment on the plus, not a picker that leads nowhere.
 */
const flavorsWithImageDelivery = new Set([
    'claude',
    'codex',
    'cursor',
    'gemini',
    'opencode',
    'openclaw',
    'agy',
    'pi',
    'acp',
]);

export function supportsImageAttachmentsForFlavor(flavor: ImageAttachmentFlavor): boolean {
    return !flavor || flavorsWithImageDelivery.has(flavor);
}

export function getImageAttachmentSendPlan(opts: {
    flavor: ImageAttachmentFlavor;
    text: string;
    attachmentCount: number;
    supportsAttachments?: boolean;
}): ImageAttachmentSendPlan {
    const hasAttachments = opts.attachmentCount > 0;
    const supportsAttachments = opts.supportsAttachments ?? supportsImageAttachmentsForFlavor(opts.flavor);
    const shouldShowUnsupportedAlert = hasAttachments && !supportsAttachments;

    return {
        supportsAttachments,
        shouldUseAttachments: hasAttachments && supportsAttachments,
        shouldShowUnsupportedAlert,
        shouldSendText: !shouldShowUnsupportedAlert || opts.text.trim().length > 0,
    };
}

export function isAttachmentAllowedByPolicy(
    attachment: { mimeType: string; size: number },
    policy: { maxBytes: number; mediaTypes: string[] },
): boolean {
    const sizeAllowed = attachment.size <= 0 || attachment.size <= policy.maxBytes;
    const mediaAllowed = policy.mediaTypes.some((allowed) => (
        allowed === attachment.mimeType
        || (allowed.endsWith('/*') && attachment.mimeType.startsWith(allowed.slice(0, -1)))
    ));
    return sizeAllowed && mediaAllowed;
}

export type ComposerAttachmentAffordance = 'sheet' | 'refuse';

/**
 * What the composer's plus does on this session (DROVE-378).
 *
 * `sheet` opens Add context. `refuse` draws the same disc and says the harness
 * cannot take an image. There is deliberately no third answer: "not drawn" was
 * the bug, and a control that disappears is indistinguishable from an app that
 * is broken.
 */
export function resolveComposerAttachmentAffordance(opts: {
    supportsAttachments: boolean;
    /** Whether any of the three Add context tiles has a handler behind it. */
    hasAnyPicker: boolean;
}): ComposerAttachmentAffordance {
    return opts.supportsAttachments && opts.hasAnyPicker ? 'sheet' : 'refuse';
}
