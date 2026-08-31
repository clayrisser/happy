import { describe, expect, it, vi } from 'vitest';
import { ToolCall } from '@/sync/typesMessage';
import {
    getToolActivityLabel,
    getTerminalToolCommand,
    getToolSummaryCategory,
    getToolSummaryDetail,
    isGateToolName,
    isTerminalToolName,
    shouldRenderToolCardHeader,
    shouldUseCompactToolRow,
} from './toolDisplay';

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function tool(name: string, input: unknown): ToolCall {
    return {
        name,
        state: 'completed',
        input,
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
    };
}

describe('terminal tool display helpers', () => {
    it('detects command-like terminal tools', () => {
        expect(isTerminalToolName('Bash')).toBe(true);
        expect(isTerminalToolName('CodexBash')).toBe(true);
        expect(isTerminalToolName('GeminiBash')).toBe(true);
        expect(isTerminalToolName('execute')).toBe(true);
        expect(isTerminalToolName('Read')).toBe(false);
    });

    it('extracts one-line command summaries from shell tools', () => {
        expect(getTerminalToolCommand(tool('Bash', { command: 'pnpm test' }))).toBe('pnpm test');

        expect(getTerminalToolCommand(tool(
            'CodexBash',
            {
                command: ['/usr/bin/zsh', '-lc', 'git status --short'],
                parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
            },
        ))).toBe('git status --short');
    });

    it('extracts Gemini execute titles without cwd metadata', () => {
        expect(getTerminalToolCommand(tool(
            'execute',
            { toolCall: { title: 'rm tmp.txt [current working directory /repo] (cleanup)' } },
        ))).toBe('rm tmp.txt');
    });

    it('hides Codex patch card headers on web only', () => {
        expect(shouldRenderToolCardHeader('CodexPatch', 'web')).toBe(false);
        expect(shouldRenderToolCardHeader('CodexPatch', 'ios')).toBe(true);
        expect(shouldRenderToolCardHeader('CodexPatch', 'android')).toBe(true);
        expect(shouldRenderToolCardHeader('CodexBash', 'web')).toBe(true);
    });

    it('classifies tools for compact transcript rows', () => {
        expect(getToolSummaryCategory('CodexBash')).toBe('terminal');
        expect(getToolSummaryCategory('exec_command')).toBe('terminal');
        expect(getToolSummaryCategory('CodexPatch')).toBe('edit');
        expect(getToolSummaryCategory('apply_patch')).toBe('edit');
        expect(getToolSummaryCategory('Read')).toBe('read');
        expect(getToolSummaryCategory('read_agent_history')).toBe('read');
        expect(getToolSummaryCategory('Grep')).toBe('search');
        expect(getToolSummaryCategory('list_workspaces')).toBe('search');
        expect(getToolSummaryCategory('WebFetch')).toBe('web');
        expect(getToolSummaryCategory('spawn_agent')).toBe('task');
    });

    it('extracts compact transcript row details', () => {
        expect(getToolSummaryDetail(tool('CodexBash', {
            command: ['/usr/bin/zsh', '-lc', 'git status --short'],
            parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
        }))).toBe('git status --short');

        expect(getToolSummaryDetail(tool('CodexPatch', {
            changes: {
                'README-RU.md': { kind: { type: 'update' } },
            },
        }))).toBe('README-RU.md');

        expect(getToolSummaryDetail(tool('MultiEdit', {
            file_path: '/repo/src/app.tsx',
        }))).toBe('/repo/src/app.tsx');

        expect(getToolSummaryDetail(tool('exec_command', {
            cmd: 'pnpm test',
        }))).toBe('pnpm test');

        expect(getToolSummaryDetail(tool('read_file', {
            target_file: '/repo/src/app.tsx',
        }))).toBe('/repo/src/app.tsx');
    });

    it('builds one human-readable label for compact activity rows', () => {
        expect(getToolActivityLabel(tool('CodexBash', {
            command: ['/usr/bin/zsh', '-lc', 'git status --short'],
            parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
        }))).toBe('toolGroup.ranCommands:1: git status --short');

        expect(getToolActivityLabel(tool('Read', {
            file_path: '/repo/src/app.tsx',
        }))).toBe('toolGroup.readFiles:1: /repo/src/app.tsx');

        const describedTool = tool('CodexPatch', {
            changes: { 'README.md': { kind: { type: 'update' } } },
        });
        describedTool.description = 'Updated the README';
        expect(getToolActivityLabel(describedTool)).toBe('Updated the README');

        expect(getToolActivityLabel(tool('mcp__linear__create_issue', {})))
            .toBe('MCP: Linear Create Issue');

        const rigCommand = tool('exec_command', { cmd: 'git status --short' });
        rigCommand.description = 'Running Exec Command';
        expect(getToolActivityLabel(rigCommand))
            .toBe('toolGroup.ranCommands:1: git status --short');

        const rigCoordination = tool('spawn_agent', {});
        rigCoordination.description = 'Running Spawn Agent';
        expect(getToolActivityLabel(rigCoordination)).toBe('Spawn Agent');

        const futureTool = tool('brand_new_rig_tool', {});
        futureTool.description = 'Running Brand New Rig Tool';
        expect(getToolActivityLabel(futureTool)).toBe('Brand New Rig Tool');
    });

    it('uses compact rows for current and future non-interactive tools', () => {
        expect(shouldUseCompactToolRow(tool('exec_command', {}), true)).toBe(true);
        expect(shouldUseCompactToolRow(tool('brand_new_rig_tool', {}), true)).toBe(true);
        expect(shouldUseCompactToolRow(tool('brand_new_rig_tool', {}), false)).toBe(false);
        expect(shouldUseCompactToolRow(tool('file', {}), true)).toBe(false);
        expect(shouldUseCompactToolRow(tool('AskUserQuestion', {}), true)).toBe(false);
        expect(shouldUseCompactToolRow(tool('request_user_input', {}), true)).toBe(false);

        const pendingPlan = tool('ExitPlanMode', {});
        pendingPlan.permission = {
            id: 'permission-1',
            status: 'pending',
        };
        expect(shouldUseCompactToolRow(pendingPlan, true)).toBe(false);
        pendingPlan.permission.status = 'approved';
        expect(shouldUseCompactToolRow(pendingPlan, true)).toBe(true);
    });

    // The Compact Tool Calls switch (DROVE-175). ToolView already draws
    // terminal calls and minimal tools as one line whatever the switch says;
    // what the switch decides is whether the tools that have a card fold too,
    // and which cards are gates that never do.
    it('folds edit diffs and agent cards with the switch on, and none with it off', () => {
        for (const name of ['Edit', 'Write', 'Task', 'SendMessage']) {
            expect(shouldUseCompactToolRow(tool(name, {}), true)).toBe(true);
            expect(shouldUseCompactToolRow(tool(name, {}), false)).toBe(false);
        }
    });

    it('keeps a gate card expanded under compact, whether or not it is waiting', () => {
        for (const name of ['DroverAccountLogin', 'DroverTodo', 'TodoWrite']) {
            expect(shouldUseCompactToolRow(tool(name, {}), true)).toBe(false);
        }
        expect(['TodoWrite', 'DroverTodo', 'DroverAccountLogin', 'ExitPlanMode', 'exit_plan_mode'].every(isGateToolName)).toBe(true);
        expect(isGateToolName('Bash')).toBe(false);
    });
});
