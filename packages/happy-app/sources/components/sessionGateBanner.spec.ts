import { describe, expect, it, vi } from 'vitest';

// storage.ts pulls in React Native, and droverGates only touches it for the
// default argument. Every test below passes sessions explicitly.
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
}));

import { gatesForSession, type GateSession } from '@/sync/droverGates';
import { describePendingGates } from './pendingGatesSummary';
import { sessionGateAction } from './sessionGateAction';
import { droverTodoCard } from './tools/views/droverTodoCard';
import { hasAnswerableOptions, questionCards } from './tools/views/askUserQuestionAnswers';

/**
 * DROVE-89. What the session banner draws for each request the bridge mirrors,
 * decided by the TOOL on the card.
 *
 * happy-app has no render harness for a component, so this pins the two pure
 * decisions the session gate card is built from (SessionGateBanner then, the
 * SessionGateOverlay since DROVE-88): sessionGateAction picks the card body
 * per entry, and describePendingGates writes the heading. The requests
 * below are the exact shapes happy-cli's requestForEvent writes for a to-do,
 * a question and a permission (packages/happy-cli/src/drover/droverBridge.ts),
 * fed through the same gatesForSession the banner's hook reads.
 *
 * The bug: a to-do fell through to the permission footer and read as
 * "1 permission waiting" with Deny / Allow. The bridge takes a to-do answer
 * only when it names Done or Drop it, so the Allow Clay pressed eight times
 * did nothing and the card never left.
 */

const claudeSessionId = '3e9d3a1c-6d7e-4a2f-9e44-0f9a2f9c1d11';
const bridge = 'bridge-session';
const pane = 'pane-session';

const todoRequest = {
    tool: 'DroverTodo',
    arguments: {
        title: 'Archive TestFlight build 8',
        reason: 'The watch work is Swift and can never ship over the air',
        command: 'pnpm prebuild:ios && make ios/beta',
        options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
    },
    createdAt: 1000,
    droverOrigin: { sessionId: claudeSessionId, cwd: '/w/happy' },
    droverEvent: { kind: 'todo' as const, title: 'Archive TestFlight build 8', createdAt: 1000 },
};

const questionRequest = {
    tool: 'AskUserQuestion',
    arguments: {
        questions: [{
            header: 'Flip?',
            question: 'Move this session to work-2?',
            options: [{ label: 'Yes, flip it' }, { label: 'Stay' }],
            multiSelect: false,
        }],
    },
    createdAt: 2000,
    droverOrigin: { sessionId: claudeSessionId, cwd: '/w/happy' },
    droverEvent: { kind: 'question' as const, title: 'Flip?', createdAt: 2000 },
};

const permissionRequest = {
    tool: 'Bash',
    arguments: { command: 'rm -rf dist', description: 'Clean the build' },
    createdAt: 3000,
    droverOrigin: { sessionId: claudeSessionId, cwd: '/w/happy' },
    droverEvent: { kind: 'permission' as const, title: 'Run Bash', createdAt: 3000 },
};

function sessionsWith(requests: Record<string, unknown>): Record<string, GateSession> {
    return {
        [bridge]: { agentState: { requests }, metadata: { path: '/w/happy' } },
        [pane]: { agentState: { requests: {} }, metadata: { path: '/w/happy', claudeSessionId } },
    };
}

function bannerFor(requests: Record<string, unknown>) {
    const entries = gatesForSession(sessionsWith(requests), pane);
    return {
        entries,
        summary: describePendingGates(entries.map((entry) => entry.gate)),
        actions: entries.map((entry) => sessionGateAction(entry.gate.kind, entry.args, entry.tool)),
    };
}

describe('SessionGateBanner, per tool', () => {
    it('draws a DroverTodo as a to-do with Done and Drop it, its title and its why', () => {
        const { entries, summary, actions } = bannerFor({ t1: todoRequest });
        expect(actions).toEqual(['todo']);
        expect(summary?.title).toBe('1 to-do for you');
        expect(summary?.kind).toBe('todo');
        // The body the banner hands DroverTodoBody: the same card the
        // transcript view and the inbox read, so the answer it sends names
        // one of these ids and the bridge takes it.
        expect(droverTodoCard(entries[0].args)).toEqual({
            title: 'Archive TestFlight build 8',
            reason: 'The watch work is Swift and can never ship over the air',
            command: 'pnpm prebuild:ios && make ios/beta',
            options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
        });
        // Never the permission footer, whatever the bus said about it.
        expect(actions).not.toContain('allow-deny');
    });

    it('draws an AskUserQuestion with its own options', () => {
        const { entries, summary, actions } = bannerFor({ q1: questionRequest });
        expect(actions).toEqual(['answer-question']);
        expect(summary?.title).toBe('1 question waiting');
        expect(summary?.kind).toBe('question');
        const cards = questionCards(entries[0].args);
        expect(hasAnswerableOptions(cards)).toBe(true);
        expect(cards[0].options.map((option) => option.label)).toEqual(['Yes, flip it', 'Stay']);
    });

    it('draws a real permission with Deny and Allow, and nothing else does', () => {
        const { summary, actions } = bannerFor({ p1: permissionRequest });
        expect(actions).toEqual(['allow-deny']);
        expect(summary?.title).toBe('1 permission waiting');
        expect(summary?.kind).toBe('permission');
    });

    it('keeps each card its own kind when they are mixed, and counts them in the title', () => {
        const { entries, summary, actions } = bannerFor({
            t1: todoRequest,
            q1: questionRequest,
            p1: permissionRequest,
        });
        // Oldest first, which is the order the fixtures were stamped in.
        expect(entries.map((entry) => entry.tool)).toEqual(['DroverTodo', 'AskUserQuestion', 'Bash']);
        expect(actions).toEqual(['todo', 'answer-question', 'allow-deny']);
        expect(summary?.title).toBe('3 waiting: 1 to-do, 1 question, 1 permission');
        expect(summary?.kind).toBe('mixed');

        expect(bannerFor({ t1: todoRequest, p1: permissionRequest }).summary?.title)
            .toBe('2 waiting: 1 to-do, 1 permission');
    });

    it('still reads a to-do off the tool when the bridge sent no bus event', () => {
        // A bridge that predates droverEvent on the card, or a card whose
        // event was stripped: the tool name alone is enough to keep Allow off
        // it.
        const { droverEvent, ...bare } = todoRequest;
        void droverEvent;
        const { summary, actions } = bannerFor({ t1: bare });
        expect(actions).toEqual(['todo']);
        expect(summary?.title).toBe('1 to-do for you');
    });

    it('gives a DroverAccountLogin its link and code field', () => {
        // It used to sit on the generic path, and this test pinned that.
        // DROVE-212 is what that looked like on the phone: "Run
        // DroverAccountLogin", Deny and Allow, and the raw JSON of these
        // arguments for a body. Allow sends no code, so the login on the Mac
        // went on waiting and Clay said "it's not doing anything".
        const { actions } = bannerFor({
            l1: {
                tool: 'DroverAccountLogin',
                arguments: { url: 'https://claude.ai/login', header: 'Log in', reason: '', cancelLabel: 'Cancel' },
                createdAt: 4000,
                droverOrigin: { sessionId: claudeSessionId },
            },
        });
        expect(actions).toEqual(['account-login']);
    });
});
