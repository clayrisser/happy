import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    detectHarnessImageMime,
    downloadFileEventAttachment,
    resolveHarnessAttachmentDir,
    stageHarnessAttachments,
    textWithHarnessAttachments,
    withStagedAttachmentNote,
} from './harnessAttachments';

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9]);

const dirs: string[] = [];
function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-attach-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fileEvent(ref: string, name: string, mimeType?: string) {
    return {
        content: { data: { ev: { t: 'file' as const, ref, name, size: 3, mimeType } } },
    } as never;
}

describe('detectHarnessImageMime', () => {
    it('reads the format off the magic bytes, not the claimed mime type', () => {
        expect(detectHarnessImageMime(pngBytes)).toBe('image/png');
        expect(detectHarnessImageMime(jpegBytes)).toBe('image/jpeg');
        expect(detectHarnessImageMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    });
});

describe('downloadFileEventAttachment', () => {
    it('returns the decrypted bytes with the event name', async () => {
        const session = { downloadAndDecryptAttachment: async () => pngBytes };
        await expect(downloadFileEventAttachment(session as never, fileEvent('r1', 'shot.png', 'image/png'), 'opencode'))
            .resolves.toEqual({ data: pngBytes, mimeType: 'image/png', name: 'shot.png' });
    });

    it('never throws the turn away when the download fails', async () => {
        const session = { downloadAndDecryptAttachment: async () => { throw new Error('boom'); } };
        await expect(downloadFileEventAttachment(session as never, fileEvent('r1', 'shot.png'), 'pi'))
            .resolves.toBeNull();
    });
});

describe('resolveHarnessAttachmentDir', () => {
    it('never writes into the Claude Code uploads directory', () => {
        const dir = resolveHarnessAttachmentDir({ sessionId: 's1', harness: 'opencode', homeDir: '/home/x/.happy' });
        expect(dir).toBe('/home/x/.happy/harness-attachments/opencode/s1');
        expect(dir).not.toContain('.claude');
    });

    it('cannot be walked out of by a hostile session id', () => {
        const dir = resolveHarnessAttachmentDir({ sessionId: '../../etc', harness: 'pi', homeDir: '/home/x/.happy' });
        expect(dir.startsWith('/home/x/.happy/harness-attachments/pi/')).toBe(true);
        expect(dir).not.toContain('..');
    });
});

describe('stageHarnessAttachments', () => {
    it('writes the bytes and reports where they landed', () => {
        const dir = scratch();
        const staged = stageHarnessAttachments({
            attachments: [{ data: pngBytes, mimeType: 'image/png', name: 'shot.png' }],
            dir,
        });

        expect(staged).toHaveLength(1);
        expect(staged[0].mimeType).toBe('image/png');
        expect(staged[0].path.endsWith('.png')).toBe(true);
        expect(new Uint8Array(readFileSync(staged[0].path))).toEqual(pngBytes);
    });

    it('is idempotent for identical bytes', () => {
        const dir = scratch();
        const att = [{ data: pngBytes, mimeType: 'image/png', name: 'shot.png' }];
        const first = stageHarnessAttachments({ attachments: att, dir });
        const second = stageHarnessAttachments({ attachments: att, dir });
        expect(second[0].path).toBe(first[0].path);
    });

    it('skips a blob that is not an image rather than writing it', () => {
        const dir = scratch();
        const staged = stageHarnessAttachments({
            attachments: [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', name: 'lie.png' }],
            dir,
        });
        expect(staged).toEqual([]);
        expect(existsSync(join(dir, 'lie.png'))).toBe(false);
    });
});

describe('withStagedAttachmentNote', () => {
    const one = [{ path: '/tmp/a.png', mimeType: 'image/png' as const, bytes: 1 }];
    const two = [...one, { path: '/tmp/b.png', mimeType: 'image/png' as const, bytes: 1 }];

    it('leaves the text alone when nothing was staged', () => {
        expect(withStagedAttachmentNote('hi', [])).toBe('hi');
    });

    it('spells the path out so a read tool can open it', () => {
        expect(withStagedAttachmentNote('look', one)).toContain('[Image 1: /tmp/a.png]');
    });

    it('names every path when several were attached', () => {
        const text = withStagedAttachmentNote('', two);
        expect(text).toContain('[Image 1: /tmp/a.png]');
        expect(text).toContain('[Image 2: /tmp/b.png]');
    });
});

describe('textWithHarnessAttachments', () => {
    it('stages then names the path, which is the whole delivery for a text-only harness', () => {
        const sessionId = `spec-${Date.now()}`;
        const text = textWithHarnessAttachments({
            text: 'describe this',
            attachments: [{ data: jpegBytes, mimeType: 'image/jpeg', name: 'photo.jpg' }],
            sessionId,
            harness: 'pi',
        });
        const dir = resolveHarnessAttachmentDir({ sessionId, harness: 'pi' });
        dirs.push(dir);

        // The words the harness receives name a file that is really on disk.
        expect(text.startsWith('describe this')).toBe(true);
        const match = /\[Image 1: (.+)\]/.exec(text);
        expect(match).not.toBeNull();
        const path = match![1];
        expect(path.startsWith(dir)).toBe(true);
        expect(new Uint8Array(readFileSync(path))).toEqual(jpegBytes);
    });

    it('returns the text untouched when the turn carried no attachments', () => {
        expect(textWithHarnessAttachments({
            text: 'plain',
            attachments: undefined,
            sessionId: 's1',
            harness: 'cursor',
        })).toBe('plain');
    });
});
