import { describe, expect, it } from 'vitest';

import {
    getImageAttachmentSendPlan,
    isAttachmentAllowedByPolicy,
    resolveComposerAttachmentAffordance,
    supportsImageAttachmentsForFlavor,
} from './attachmentSupport';

describe('supportsImageAttachmentsForFlavor', () => {
    it('supports legacy sessions, Claude, and Codex', () => {
        expect(supportsImageAttachmentsForFlavor(undefined)).toBe(true);
        expect(supportsImageAttachmentsForFlavor(null)).toBe(true);
        expect(supportsImageAttachmentsForFlavor('claude')).toBe(true);
        expect(supportsImageAttachmentsForFlavor('codex')).toBe(true);
    });

    // DROVE-378. Every one of these has a delivery behind it in the CLI:
    // opencode and gemini over ACP, the rest as a staged file path.
    it.each(['opencode', 'gemini', 'pi', 'cursor', 'agy', 'openclaw', 'acp'])(
        'supports %s, which the CLI now delivers an image to',
        (flavor) => {
            expect(supportsImageAttachmentsForFlavor(flavor)).toBe(true);
        },
    );

    it('still refuses a flavor with no delivery behind it', () => {
        expect(supportsImageAttachmentsForFlavor('custom-agent')).toBe(false);
        expect(supportsImageAttachmentsForFlavor('some-future-rig')).toBe(false);
    });
});

describe('resolveComposerAttachmentAffordance', () => {
    it('opens the sheet when the harness takes images and a picker is wired', () => {
        expect(resolveComposerAttachmentAffordance({
            supportsAttachments: true,
            hasAnyPicker: true,
        })).toBe('sheet');
    });

    // The bug: an unsupported harness used to leave the plus undrawn, so the
    // phone read as refusing an image without ever saying so.
    it('refuses out loud rather than vanishing when the harness cannot take one', () => {
        expect(resolveComposerAttachmentAffordance({
            supportsAttachments: false,
            hasAnyPicker: false,
        })).toBe('refuse');
    });

    it('refuses rather than opening an empty sheet when no picker is wired', () => {
        expect(resolveComposerAttachmentAffordance({
            supportsAttachments: true,
            hasAnyPicker: false,
        })).toBe('refuse');
    });
});

describe('getImageAttachmentSendPlan', () => {
    it('uses attachments and sends text for Codex', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'codex',
            text: '',
            attachmentCount: 1,
        })).toEqual({
            supportsAttachments: true,
            shouldUseAttachments: true,
            shouldShowUnsupportedAlert: false,
            shouldSendText: true,
        });
    });

    it('warns but still sends non-empty text for unsupported agents', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'some-future-rig',
            text: 'describe this',
            attachmentCount: 1,
        })).toEqual({
            supportsAttachments: false,
            shouldUseAttachments: false,
            shouldShowUnsupportedAlert: true,
            shouldSendText: true,
        });
    });

    it('warns and sends nothing for unsupported image-only messages', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'some-future-rig',
            text: '   ',
            attachmentCount: 2,
        })).toEqual({
            supportsAttachments: false,
            shouldUseAttachments: false,
            shouldShowUnsupportedAlert: true,
            shouldSendText: false,
        });
    });
});

describe('Rig attachment policy', () => {
    it('lets capability metadata override provider flavor inference', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'custom',
            text: '',
            attachmentCount: 1,
            supportsAttachments: true,
        }).shouldUseAttachments).toBe(true);
    });

    it('honors media type wildcards and max bytes', () => {
        const policy = { maxBytes: 10, mediaTypes: ['image/*'] };
        expect(isAttachmentAllowedByPolicy({ mimeType: 'image/png', size: 10 }, policy)).toBe(true);
        expect(isAttachmentAllowedByPolicy({ mimeType: 'image/png', size: 11 }, policy)).toBe(false);
        expect(isAttachmentAllowedByPolicy({ mimeType: 'application/pdf', size: 5 }, policy)).toBe(false);
    });
});
