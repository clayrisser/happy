import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'ios' },
    requestMediaLibraryPermissionsAsync: vi.fn(),
    launchImageLibraryAsync: vi.fn(),
    manipulateAsync: vi.fn(),
    generateThumbhash: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: mocks.platform,
}));

vi.mock('expo-image-picker', () => ({
    requestMediaLibraryPermissionsAsync: mocks.requestMediaLibraryPermissionsAsync,
    requestCameraPermissionsAsync: vi.fn(),
    launchImageLibraryAsync: mocks.launchImageLibraryAsync,
    launchCameraAsync: vi.fn(),
}));

vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));

vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: mocks.manipulateAsync,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/utils/thumbhash', () => ({
    generateThumbhash: mocks.generateThumbhash,
}));

import { documentAssetToPreview, normalizePickedAssetForUpload } from './useImagePicker';

describe('normalizePickedAssetForUpload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.platform.OS = 'ios';
    });

    it('normalizes iOS image picker assets to JPEG before upload', async () => {
        mocks.manipulateAsync.mockResolvedValue({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            width: 4032,
            height: 3024,
        });

        const normalized = await normalizePickedAssetForUpload({
            uri: 'file:///tmp/IMG_9824.HEIC',
            width: 4032,
            height: 3024,
            fileName: 'IMG_9824.HEIC',
            fileSize: 2_701_533,
        });

        expect(mocks.manipulateAsync).toHaveBeenCalledWith(
            'file:///tmp/IMG_9824.HEIC',
            [],
            { compress: expect.any(Number), format: 'jpeg' },
        );
        expect(normalized).toEqual({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            mimeType: 'image/jpeg',
            name: 'IMG_9824.jpg',
            width: 4032,
            height: 3024,
        });
    });
});

/**
 * The Files tile (DROVE-128). A document has no dimensions, and that is the
 * whole difference: sync.ts writes the file event's `image` block only when
 * both are above zero, so zero is what makes a PDF travel as a file rather
 * than as a picture that will not render.
 */
describe('documentAssetToPreview', () => {
    it('carries the name, size and mime type, and no dimensions', () => {
        const preview = documentAssetToPreview({
            name: 'lease.pdf',
            size: 244_000,
            uri: 'file:///tmp/lease.pdf',
            mimeType: 'application/pdf',
        });
        expect(preview).toMatchObject({
            uri: 'file:///tmp/lease.pdf',
            name: 'lease.pdf',
            size: 244_000,
            mimeType: 'application/pdf',
            width: 0,
            height: 0,
        });
        expect(preview?.thumbhash).toBeUndefined();
        expect(preview?.id).toBeTruthy();
    });

    it('falls back rather than guessing when the picker reports neither type nor size', () => {
        const preview = documentAssetToPreview({ name: 'notes', uri: 'file:///tmp/notes' });
        // Size 0 is what the image path already means by "the platform did not
        // say"; the server enforces the real limit on upload.
        expect(preview).toMatchObject({ size: 0, mimeType: 'application/octet-stream', name: 'notes' });
    });

    it('refuses a file over the 10MB limit instead of failing at upload', () => {
        expect(documentAssetToPreview({
            name: 'huge.zip',
            size: 11 * 1024 * 1024,
            uri: 'file:///tmp/huge.zip',
        })).toBeNull();
    });
});
