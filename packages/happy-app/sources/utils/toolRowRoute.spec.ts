import { describe, expect, it, vi } from 'vitest';
import { ToolCallMessage } from '@/sync/typesMessage';
import { getToolRowFilePath, getToolRowRoute, isFileEditToolName } from './toolRowRoute';
import { groupSameToolRuns } from './toolRunGroups';

vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function call(id: string, name: string, createdAt: number, input: unknown = { command: id }): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name,
            state: 'completed',
            input,
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
            description: id,
        },
        children: [],
    };
}

function bash(command: string) {
    return { name: 'Bash', input: { command } };
}

describe('getToolRowRoute', () => {
    it('opens the message detail for the shell call the row stands for', () => {
        expect(getToolRowRoute({
            sessionId: 'sess1',
            messageId: 'msg7',
            tool: bash('git status'),
        })).toBe('/session/sess1/message/msg7');
    });

    it('gives each row of a run its own destination, not the group', () => {
        const rows = ['m1', 'm2', 'm3'].map((messageId) => getToolRowRoute({
            sessionId: 'sess1',
            messageId,
            tool: bash('echo hi'),
        }));
        expect(rows).toEqual([
            '/session/sess1/message/m1',
            '/session/sess1/message/m2',
            '/session/sess1/message/m3',
        ]);
    });

    it('opens a row whose call is still running, so the detail follows the stream', () => {
        expect(getToolRowRoute({
            sessionId: 'sess1',
            messageId: 'msg7',
            tool: { name: 'Bash', input: { command: 'pnpm build' }, state: 'running' } as never,
        })).toBe('/session/sess1/message/msg7');
    });

    it('sends an edit row to the file view, base64 encoded the way the file route decodes it', () => {
        const route = getToolRowRoute({
            sessionId: 'sess1',
            messageId: 'msg7',
            tool: { name: 'Edit', input: { file_path: '/tmp/a.ts' } },
        });
        expect(route).toBe(`/session/sess1/file?path=${btoa('/tmp/a.ts')}`);
        expect(atob(route!.split('path=')[1])).toBe('/tmp/a.ts');
    });

    it('covers every consolidated family, not just shell', () => {
        expect(getToolRowRoute({ sessionId: 's', messageId: 'r', tool: { name: 'Read', input: { file_path: '/a' } } }))
            .toBe('/session/s/message/r');
        expect(getToolRowRoute({ sessionId: 's', messageId: 'g', tool: { name: 'Grep', input: { pattern: 'x' } } }))
            .toBe('/session/s/message/g');
        expect(getToolRowRoute({ sessionId: 's', messageId: 'w', tool: { name: 'WebFetch', input: { url: 'https://x' } } }))
            .toBe('/session/s/message/w');
        expect(getToolRowRoute({ sessionId: 's', messageId: 'e', tool: { name: 'Write', input: { file_path: '/b' } } }))
            .toBe(`/session/s/file?path=${btoa('/b')}`);
    });

    it('falls back to the message detail when an edit call carries no usable path', () => {
        expect(getToolRowRoute({ sessionId: 's', messageId: 'm', tool: { name: 'Edit', input: {} } }))
            .toBe('/session/s/message/m');
        expect(getToolRowRoute({ sessionId: 's', messageId: 'm', tool: { name: 'Edit', input: { file_path: '   ' } } }))
            .toBe('/session/s/message/m');
    });

    it('has no destination without a session or a message', () => {
        expect(getToolRowRoute({ sessionId: '', messageId: 'm', tool: bash('ls') })).toBeNull();
        expect(getToolRowRoute({ sessionId: null, messageId: 'm', tool: bash('ls') })).toBeNull();
        expect(getToolRowRoute({ sessionId: 's', messageId: undefined, tool: bash('ls') })).toBeNull();
    });
});

describe('getToolRowFilePath', () => {
    it('trims the path and ignores non-edit tools', () => {
        expect(getToolRowFilePath({ name: 'Write', input: { file_path: ' /a/b.ts ' } })).toBe('/a/b.ts');
        expect(getToolRowFilePath({ name: 'Read', input: { file_path: '/a/b.ts' } })).toBeNull();
        expect(getToolRowFilePath({ name: 'Edit', input: { file_path: 7 } })).toBeNull();
    });
});

describe('isFileEditToolName', () => {
    it('names the three tools whose row opens a file instead of a transcript', () => {
        expect(['Edit', 'MultiEdit', 'Write'].every(isFileEditToolName)).toBe(true);
        expect(isFileEditToolName('Bash')).toBe(false);
    });
});

describe('a consolidated card routes each of its rows', () => {
    it('gives every row of a "Ran N shell commands" card its own detail', () => {
        const chronological = [
            call('b1', 'Bash', 1),
            call('b2', 'Bash', 2),
            call('b3', 'Bash', 3),
        ];
        const [group] = groupSameToolRuns([...chronological].reverse());
        expect(group.type).toBe('tool-group');
        if (group.type !== 'tool-group') return;

        const routes = group.messages.map((msg) => getToolRowRoute({
            sessionId: 'sess1',
            messageId: msg.id,
            tool: (msg as ToolCallMessage).tool,
        }));
        expect(routes).toEqual([
            '/session/sess1/message/b1',
            '/session/sess1/message/b2',
            '/session/sess1/message/b3',
        ]);
        // The card's own id keys the expanded state, so back lands on a card
        // that is still open. It is not a route.
        expect(group.id).toBe('group-b1');
        expect(routes).not.toContain(`/session/sess1/message/${group.id}`);
    });

    it('routes the rows of a read run and an edit run the same way', () => {
        const reads = [call('r1', 'Read', 1, { file_path: '/a' }), call('r2', 'Read', 2, { file_path: '/b' })];
        const [readGroup] = groupSameToolRuns([...reads].reverse());
        expect(readGroup.type === 'tool-group' && readGroup.messages.map((msg) => getToolRowRoute({
            sessionId: 's',
            messageId: msg.id,
            tool: (msg as ToolCallMessage).tool,
        }))).toEqual(['/session/s/message/r1', '/session/s/message/r2']);

        const edits = [call('e1', 'Edit', 1, { file_path: '/a' }), call('e2', 'Write', 2, { file_path: '/b' })];
        const [editGroup] = groupSameToolRuns([...edits].reverse());
        expect(editGroup.type === 'tool-group' && editGroup.messages.map((msg) => getToolRowRoute({
            sessionId: 's',
            messageId: msg.id,
            tool: (msg as ToolCallMessage).tool,
        }))).toEqual([`/session/s/file?path=${btoa('/a')}`, `/session/s/file?path=${btoa('/b')}`]);
    });
});
