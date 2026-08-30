import * as React from 'react';
import { EditView } from './EditView';
import { BashView } from './BashView';
import { Message, ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { WriteView } from './WriteView';
import { TodoView } from './TodoView';
import { ExitPlanToolView } from './ExitPlanToolView';
import { MultiEditView } from './MultiEditView';
import { TaskView } from './TaskView';
import { BashViewFull } from './BashViewFull';
import { EditViewFull } from './EditViewFull';
import { MultiEditViewFull } from './MultiEditViewFull';
import { CodexBashView } from './CodexBashView';
import { CodexPatchView } from './CodexPatchView';
import { CodexDiffView } from './CodexDiffView';
import { AskUserQuestionView } from './AskUserQuestionView';
import { DroverAccountLoginView } from './DroverAccountLoginView';
import { RequestUserInputView } from './RequestUserInputView';
import { GeminiEditView } from './GeminiEditView';
import { GeminiExecuteView } from './GeminiExecuteView';
import { FileView } from './FileView';
import { SendMessageView } from './SendMessageView';
import { WorkflowView } from './WorkflowView';
import { HulyToolView } from './HulyToolView';
import { isHulyTool } from '@/utils/hulyTool';

export type ToolViewProps = {
    tool: ToolCall;
    metadata: Metadata | null;
    messages: Message[];
    sessionId?: string;
    permissionFooter?: React.ReactNode;
}

// Type for tool view components
export type ToolViewComponent = React.ComponentType<ToolViewProps>;

// Registry of tool-specific view components
export const toolViewRegistry: Record<string, ToolViewComponent> = {
    Edit: EditView,
    Bash: BashView,
    CodexBash: CodexBashView,
    CodexPatch: CodexPatchView,
    CodexDiff: CodexDiffView,
    Write: WriteView,
    TodoWrite: TodoView,
    ExitPlanMode: ExitPlanToolView,
    exit_plan_mode: ExitPlanToolView,
    MultiEdit: MultiEditView,
    Task: TaskView,
    Agent: TaskView,
    AskUserQuestion: AskUserQuestionView,
    // The drover bridge's account-login card: a link out and a code back, which
    // the options-only question card cannot render (DROVE-61).
    DroverAccountLogin: DroverAccountLoginView,
    request_user_input: RequestUserInputView,
    // Gemini tools (lowercase)
    edit: GeminiEditView,
    execute: GeminiExecuteView,
    // File attachment events
    file: FileView,
    // The tools a drover session actually shows Clay (DROVE-51)
    SendMessage: SendMessageView,
    Workflow: WorkflowView,
};

export const toolFullViewRegistry: Record<string, ToolViewComponent> = {
    Bash: BashViewFull,
    CodexBash: CodexBashView,
    Edit: EditViewFull,
    MultiEdit: MultiEditViewFull,
    Task: TaskView,
    Agent: TaskView,
};

/**
 * A view chosen by name prefix rather than by exact name. An MCP server names
 * every one of its tools `mcp__<server>__<op>`, so a per-name registry entry
 * would need one line per op; the card is the same for all of them (DROVE-51).
 */
function getPrefixedToolViewComponent(toolName: string): ToolViewComponent | null {
    return isHulyTool(toolName) ? HulyToolView : null;
}

// Helper function to get the appropriate view component for a tool
export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    return toolViewRegistry[toolName] || getPrefixedToolViewComponent(toolName) || null;
}

/**
 * The detail screen deliberately does NOT take the inline cards. It has halves
 * the cards do not — the error banner, and the honest "no output" — and its
 * generic path already lays the input out as the same labelled rows. A card
 * that renders nothing when it has nothing (TodoWrite) would leave the screen
 * blank, and AskUserQuestion's form cannot submit without a sessionId, which
 * this screen does not pass (DROVE-51).
 */
export function getToolFullViewComponent(toolName: string): ToolViewComponent | null {
    return toolFullViewRegistry[toolName] || null;
}

// Export individual components
export { EditView } from './EditView';
export { BashView } from './BashView';
export { CodexBashView } from './CodexBashView';
export { CodexPatchView } from './CodexPatchView';
export { CodexDiffView } from './CodexDiffView';
export { BashViewFull } from './BashViewFull';
export { EditViewFull } from './EditViewFull';
export { MultiEditViewFull } from './MultiEditViewFull';
export { ExitPlanToolView } from './ExitPlanToolView';
export { MultiEditView } from './MultiEditView';
export { TaskView } from './TaskView';
export { AskUserQuestionView } from './AskUserQuestionView';
export { DroverAccountLoginView } from './DroverAccountLoginView';
export { RequestUserInputView } from './RequestUserInputView';
export { GeminiEditView } from './GeminiEditView';
export { GeminiExecuteView } from './GeminiExecuteView';
export { FileView } from './FileView';
export { SendMessageView } from './SendMessageView';
export { WorkflowView } from './WorkflowView';
export { HulyToolView } from './HulyToolView';
export { GenericToolView } from './GenericToolView';
