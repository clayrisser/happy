/**
 * Attachment picker hook: what the composer's plus can reach.
 *
 * Still named for images because that is all it did until DROVE-128, when the
 * plus became an Add context sheet with three tiles. `pickImages` is the
 * library, unchanged and still the only thing the desktop composer calls;
 * `takePhoto` is the camera; `pickFiles` is the document picker.
 *
 * Wraps expo-image-picker and expo-document-picker with permission handling
 * and thumbhash generation. Enforces limits: max 20 attachments per message,
 * 10MB per file.
 *
 * A document has no dimensions, so its preview carries width and height 0.
 * That is not a gap: sync.ts only writes the `image` block of the file event
 * when both are above zero, so a PDF travels as a plain file and renders as a
 * filename row instead of an inline picture. A rig whose declared attachment
 * policy refuses the mime type is caught by isAttachmentAllowedByPolicy and
 * alerts, rather than uploading something the agent cannot read.
 *
 * Note: fileSize from expo-image-picker is optional — some platforms do not
 * provide it (returns undefined → size=0). Such files pass the client-side
 * size check; the server enforces the limit on upload. Phase 5 should handle
 * 413 responses gracefully.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { t } from '@/text';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const IOS_ATTACHMENT_JPEG_QUALITY = 0.92;

export type { AttachmentPreview };

type UseImagePickerResult = {
    selectedImages: AttachmentPreview[];
    /** The photo library. */
    pickImages: () => Promise<void>;
    /** The camera, and the shot it takes (DROVE-128). */
    takePhoto: () => Promise<void>;
    /** The document picker: anything, not only images (DROVE-128). */
    pickFiles: () => Promise<void>;
    removeImage: (id: string) => void;
    clearImages: () => void;
    addImages: (images: AttachmentPreview[]) => void;
};

function attachmentId(): string {
    return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * A picked document as an attachment, or null when it is over the limit.
 *
 * Pure, so the size rule and the fallbacks for a picker that reports neither
 * a mime type nor a size can be tested without a device. Width and height are
 * 0 deliberately; see the note at the top of the file.
 */
export function documentAssetToPreview(
    asset: { name: string; size?: number; uri: string; mimeType?: string },
): AttachmentPreview | null {
    const size = asset.size ?? 0;
    if (size > MAX_FILE_SIZE) {
        return null;
    }
    return {
        id: attachmentId(),
        uri: asset.uri,
        width: 0,
        height: 0,
        mimeType: asset.mimeType ?? 'application/octet-stream',
        size,
        name: asset.name || `file_${Date.now()}`,
    };
}

function withJpegExtension(fileName: string | null | undefined): string {
    const fallback = `image_${Date.now()}.jpg`;
    const name = fileName?.trim() || fallback;
    const extensionIndex = name.lastIndexOf('.');
    const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
    return `${stem}.jpg`;
}

export async function normalizePickedAssetForUpload(asset: ImagePicker.ImagePickerAsset): Promise<{
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    name: string;
}> {
    if (Platform.OS !== 'ios') {
        return {
            uri: asset.uri,
            width: asset.width,
            height: asset.height,
            mimeType: asset.mimeType ?? 'image/jpeg',
            name: asset.fileName ?? `image_${Date.now()}.jpg`,
        };
    }

    const converted = await manipulateAsync(asset.uri, [], {
        compress: IOS_ATTACHMENT_JPEG_QUALITY,
        format: SaveFormat.JPEG,
    });

    return {
        uri: converted.uri,
        width: converted.width || asset.width,
        height: converted.height || asset.height,
        mimeType: 'image/jpeg',
        name: withJpegExtension(asset.fileName),
    };
}

export function useImagePicker(): UseImagePickerResult {
    const [selectedImages, setSelectedImages] = useState<AttachmentPreview[]>([]);
    // Ref tracks current count to avoid stale closures on rapid taps.
    const selectedCountRef = useRef(0);
    useEffect(() => {
        selectedCountRef.current = selectedImages.length;
    }, [selectedImages]);

    const requestPermission = useCallback(async (): Promise<boolean> => {
        if (Platform.OS === 'web') return true;

        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            Modal.alert(
                t('imageUpload.permissionTitle'),
                t('imageUpload.permissionMessage'),
                [{ text: t('common.ok') }],
            );
            return false;
        }
        return true;
    }, []);

    const requestCameraPermission = useCallback(async (): Promise<boolean> => {
        if (Platform.OS === 'web') return true;

        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
            Modal.alert(
                t('imageUpload.cameraPermissionTitle'),
                t('imageUpload.cameraPermissionMessage'),
                [{ text: t('common.ok') }],
            );
            return false;
        }
        return true;
    }, []);

    /** Room left in this message, or null once it is full and the user has been told. */
    const roomLeft = useCallback((): number | null => {
        const remaining = MAX_IMAGES_PER_MESSAGE - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return null;
        }
        return remaining;
    }, []);

    const commit = useCallback((previews: AttachmentPreview[]) => {
        if (previews.length === 0) return;
        setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
    }, []);

    /**
     * Shared by the library and the camera: normalize, size-check, thumbhash.
     * The camera returns the same asset shape, so it must not grow a second
     * copy of this that drifts.
     */
    const absorbImageAssets = useCallback(async (
        assets: ImagePicker.ImagePickerAsset[],
    ): Promise<AttachmentPreview[]> => {
        const previews: AttachmentPreview[] = [];
        for (const asset of assets) {
            const size = asset.fileSize ?? 0;

            if (size > MAX_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.fileName ?? 'image', maxMb: 10 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }

            const normalized = await normalizePickedAssetForUpload(asset);

            // Skip thumbhash if dimensions are unavailable (prevents divide-by-zero).
            const thumbhash = (normalized.width > 0 && normalized.height > 0)
                ? await generateThumbhash(normalized.uri, normalized.width, normalized.height)
                : undefined;

            previews.push({
                id: attachmentId(),
                uri: normalized.uri,
                width: normalized.width,
                height: normalized.height,
                mimeType: normalized.mimeType,
                size,
                name: normalized.name,
                thumbhash,
            });
        }
        return previews;
    }, []);

    const pickImages = useCallback(async () => {
        const hasPermission = await requestPermission();
        if (!hasPermission) return;

        const remaining = roomLeft();
        if (remaining === null) return;

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'], // expo-image-picker ~55: MediaTypeOptions deprecated
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            quality: 1, // request full-resolution source; iOS upload is normalized below
            exif: false,
        });

        if (result.canceled || !result.assets.length) return;

        // On web, selectionLimit is not enforced by the browser — clamp here.
        commit(await absorbImageAssets(result.assets.slice(0, remaining)));
    }, [absorbImageAssets, commit, requestPermission, roomLeft]);

    const takePhoto = useCallback(async () => {
        const hasPermission = await requestCameraPermission();
        if (!hasPermission) return;

        if (roomLeft() === null) return;

        const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            quality: 1,
            exif: false,
        });

        if (result.canceled || !result.assets.length) return;

        // One shot at a time, whatever the platform hands back.
        commit(await absorbImageAssets(result.assets.slice(0, 1)));
    }, [absorbImageAssets, commit, requestCameraPermission, roomLeft]);

    const pickFiles = useCallback(async () => {
        // No permission prompt: the document picker hands back only what the
        // user reached for, which is why it needs no library access.
        const remaining = roomLeft();
        if (remaining === null) return;

        const result = await DocumentPicker.getDocumentAsync({
            type: '*/*',
            multiple: true,
            // The bytes have to be readable by readFileBytes before the send,
            // and a security-scoped URL is not.
            copyToCacheDirectory: true,
        });

        if (result.canceled || !result.assets?.length) return;

        const previews: AttachmentPreview[] = [];
        for (const asset of result.assets.slice(0, remaining)) {
            const preview = documentAssetToPreview(asset);
            if (!preview) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.name, maxMb: 10 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }
            previews.push(preview);
        }
        commit(previews);
    }, [commit, roomLeft]);

    const removeImage = useCallback((id: string) => {
        setSelectedImages(prev => prev.filter(img => img.id !== id));
    }, []);

    const clearImages = useCallback(() => {
        setSelectedImages([]);
    }, []);

    const addImages = useCallback((images: AttachmentPreview[]) => {
        setSelectedImages(prev => {
            const remaining = MAX_IMAGES_PER_MESSAGE - prev.length;
            if (remaining <= 0) return prev;
            return [...prev, ...images.slice(0, remaining)];
        });
    }, []);

    return { selectedImages, pickImages, takePhoto, pickFiles, removeImage, clearImages, addImages };
}
