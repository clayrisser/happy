import type { Metadata } from '@/sync/storageTypes';
import { hackModes } from '@/sync/modeHacks';
import { sortPermissionModes } from '@/utils/permissionModeLabels';
import { compareVersionsWithPrerelease, isWellFormedVersion } from '@/utils/versionUtils';
import { CLI_VERSION_WITH_AUTO, getCodeAgentDefaults } from '@/sync/agentDefaults';
export { CLI_VERSION_WITH_AUTO } from '@/sync/agentDefaults';
import {
    getRigCurrentModel,
    getRigModels,
    getRigReasoningLevels,
    getRigSelectedModelKey,
    isRigMetadataV1,
} from '@/sync/rig';

export type ModeOption = {
    key: string;
    name: string;
    description?: string | null;
    semanticKind?: string | null;
    disabled?: boolean;
    // The happy-cli version that first parses this mode. Untagged modes are
    // offered to every CLI; tagged ones are hidden from CLIs known to be older
    // (see filterPermissionModesForCli).
    sinceCliVersion?: string;
};

export type PermissionMode = ModeOption;
export type ModelMode = ModeOption & {
    modelId?: string;
    providerId?: string;
    providerName?: string;
    providerKind?: string;
    contextWindow?: number;
    serviceTiers?: string[];
    thinkingLevels?: string[];
    defaultThinkingLevel?: string | null;
    unavailable?: boolean;
};

export type EffortLevel = ModeOption;
export type PermissionModeKey = string;
export type ModelModeKey = string;

export type AgentFlavor = 'claude' | 'codex' | 'gemini' | string | null | undefined;

type Translate = (key: any) => string;

type MetadataOption = {
    code: string;
    value: string;
    description?: string | null;
};

const GEMINI_MODEL_FALLBACKS: ModelMode[] = [
    { key: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'latest & most capable' },
    { key: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', description: 'latest & fast' },
    { key: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite', description: 'latest & fastest' },
    { key: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'most capable' },
    { key: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'fast & efficient' },
    { key: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', description: 'fastest' },
];

export function mapMetadataOptions(options?: MetadataOption[] | null): ModeOption[] {
    if (!options || options.length === 0) {
        return [];
    }

    return options.map((option) => ({
        key: option.code,
        name: option.value,
        description: option.description ?? null,
    }));
}

// Mode names are deliberately untranslated single words, because the composer
// chip that shows the current mode has room for one word — see
// permissionModeLabels.ts. They are Happy's own vocabulary, not a quote of each
// CLI's: Claude's UI calls our `default` "Manual". Every list below is ordered
// by that file's ranking so the modes line up across harnesses, with one
// documented exception at agy.

// Auto leads because it is the everyday mode: the harness reviews its own calls
// and stops only when it actually wants a human. Claude ships it in the Agent
// SDK's PermissionMode union, and it is carried end to end — the CLI's
// PermissionMode type, MessageMetaSchema, and the SDK adapter's QueryOptions.
// `dontAsk` stays absent: that one really is missing from MessageMetaSchema, so
// sending it fails UserMessageSchema.safeParse and drops the whole prompt.
export function getClaudePermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'auto', name: 'Auto', description: translate('agentInput.permissionMode.auto'), sinceCliVersion: CLI_VERSION_WITH_AUTO },
        { key: 'acceptEdits', name: 'Edits', description: translate('agentInput.permissionMode.acceptEdits') },
        { key: 'plan', name: 'Plan', description: translate('agentInput.permissionMode.plan') },
        { key: 'bypassPermissions', name: 'Yolo', description: translate('agentInput.permissionMode.bypassPermissions') },
        { key: 'default', name: 'Default', description: translate('agentInput.permissionMode.default') },
    ];
}

// Auto is Codex's own everyday preset, spelled `on-request` + workspace-write
// by resolveCodexExecutionPolicy: Codex runs what it can and asks when it wants
// more. `default` is Happy's stricter baseline — `untrusted` + workspace-write,
// which stops for anything off the trusted list — and is named Default because
// it is where you land having picked nothing. `safe-yolo` keeps the workspace
// sandbox but stops asking, so it is the one named for the sandbox.
export function getCodexPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'auto', name: 'Auto', description: translate('agentInput.codexPermissionMode.autoDescription'), sinceCliVersion: CLI_VERSION_WITH_AUTO },
        { key: 'safe-yolo', name: 'Workspace', description: translate('agentInput.codexPermissionMode.safeYoloDescription') },
        { key: 'read-only', name: 'Read', description: translate('agentInput.codexPermissionMode.readOnlyDescription') },
        { key: 'yolo', name: 'Yolo', description: translate('agentInput.codexPermissionMode.yoloDescription') },
        { key: 'default', name: 'Default', description: translate('agentInput.codexPermissionMode.defaultDescription') },
    ];
}

// Only the keys runGemini actually honours (its validModes list). Gemini is
// retired from the harness picker, but existing sessions still open this menu,
// and the two modes that used to be here were both broken: `auto_edit` is not
// in MessageMetaSchema at all, so picking it dropped the entire message, and
// `plan` passed the schema only to be ignored by runGemini — which left the
// session on whatever it had before, up to and including yolo.
export function getGeminiPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'yolo', name: 'Yolo', description: translate('agentInput.geminiPermissionMode.yolo') },
        { key: 'default', name: 'Default', description: translate('agentInput.geminiPermissionMode.default') },
    ];
}

// The current generation only. Older Claudes and the `default model` row are
// deliberately absent: picking a model is the point of this menu, and every
// entry here is a 5.
//
// Keys are full model IDs rather than the short aliases, because the aliases
// do not all mean what the row says. `sonnet` still resolves to Sonnet 4.6 in
// the CLI's alias table, and `opus-5` is not in that table at all (`claude
// --model opus-5` errors on 2.1.199). Full IDs pass straight through to the
// API, so they say exactly which model is meant. The `[1m]` suffix is part of
// the model ID Claude Code accepts (`claude --model 'claude-opus-5[1m]'`) and
// selects the 1M-context variant; unknown bracket models are rejected, so the
// suffix is honored rather than silently dropped (#1721).
export function getClaudeModelModes(): ModelMode[] {
    return [
        { key: 'claude-fable-5', name: 'Fable 5', description: null },
        { key: 'claude-opus-5', name: 'Opus 5', description: null },
        { key: 'claude-opus-5[1m]', name: 'Opus 5 [1M]', description: '1M context' },
        { key: 'claude-sonnet-5', name: 'Sonnet 5', description: null },
    ];
}

export function getCodexModelModes(): ModelMode[] {
    return [
        { key: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: null },
        { key: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: null },
        { key: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', description: null },
    ];
}

export function includeConfiguredModel(
    flavor: AgentFlavor,
    models: ModelMode[],
    configuredModelKey: string | null | undefined,
): ModelMode[] {
    if (
        flavor !== 'codex'
        || !configuredModelKey
        || configuredModelKey === 'default'
        || models.some((model) => model.key === configuredModelKey)
    ) {
        return models;
    }
    return [
        ...models,
        {
            key: configuredModelKey,
            name: configuredModelKey,
            description: 'custom model',
        },
    ];
}

export function getGeminiModelModes(): ModelMode[] {
    return GEMINI_MODEL_FALLBACKS;
}

// runOpenClaw never reads permissionMode, so neither of these changes what
// openclaw does. Both are kept so an existing session's saved mode still has a
// row to select, but the descriptions say plainly that the choice is inert.
export function getOpenClawPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'bypassPermissions', name: 'Yolo', description: translate('agentInput.permissionMode.openclawInert') },
        { key: 'default', name: 'Default', description: translate('agentInput.permissionMode.openclawInert') },
    ];
}

// agy --print only distinguishes --sandbox (default) from --dangerously-skip-permissions,
// so only these two modes are offered. Default gets its own wording because agy
// --print is one-shot and cannot prompt: it never asks, it just runs under agy's
// own sandbox settings.
//
// The one place the shared ranking is deliberately ignored. Default sorts last
// everywhere else because it means "ask me about everything", the choice you
// make when none of the others fit. Here it means the opposite: it is agy's own
// launch default, the only sandboxed option, and the one agentDefaults picks.
// Ranking it below Yolo would put the escape hatch at the top of a two-item
// list and read as the recommendation.
export function getAgyPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: 'Default', description: translate('agentInput.permissionMode.agyDefault') },
        { key: 'bypassPermissions', name: 'Yolo', description: translate('agentInput.permissionMode.bypassPermissions') },
    ];
}

// Before the release tagged above the CLI's MessageMetaSchema rejected `auto`,
// and a rejected mode dropped the whole prompt — the same failure mode
// `dontAsk` had.

/**
 * True when the CLI at `cliVersion` parses this mode. An untagged mode is
 * supported everywhere. An absent version stays permissive: every happy-cli
 * reports its version in both session and machine metadata, so no version
 * means the client is not happy-cli (e.g. a pre-catalog Rig session). A
 * version that is present but unparseable hides tagged modes instead — a
 * mangled happy-cli version is more likely old than new.
 */
export function modeSupportedByCli(
    mode: Pick<ModeOption, 'sinceCliVersion'>,
    cliVersion: string | null | undefined,
): boolean {
    if (!mode.sinceCliVersion || !cliVersion) {
        return true;
    }
    if (!isWellFormedVersion(cliVersion)) {
        return false;
    }
    return compareVersionsWithPrerelease(cliVersion, mode.sinceCliVersion) >= 0;
}

// The version tags by mode key, for callers that hold a bare key rather than
// a ModeOption — the option lists below and the outbound-message path both
// read from here so the two can never disagree.
const PERMISSION_MODE_SINCE_CLI_VERSION: Record<string, string> = {
    auto: CLI_VERSION_WITH_AUTO,
};

/**
 * True when the CLI at `cliVersion` parses this mode key. The bare-key twin of
 * modeSupportedByCli, for callers that hold a saved key rather than a
 * ModeOption. Picker filtering alone does not cover those: an existing session
 * or a saved agent default can carry a mode the session's older CLI never
 * offered, and the send path must refuse it loudly rather than substitute a
 * different mode behind the user's back.
 */
export function permissionModeSupportedByCli(
    modeKey: string | null | undefined,
    cliVersion: string | null | undefined,
): boolean {
    if (!modeKey) {
        return true;
    }
    return modeSupportedByCli(
        { sinceCliVersion: PERMISSION_MODE_SINCE_CLI_VERSION[modeKey] },
        cliVersion,
    );
}

/**
 * Drops modes the CLI on the receiving machine cannot parse, going by each
 * mode's own sinceCliVersion tag. Applies to the hardcoded flavor lists only —
 * a harness that publishes its own catalog (rig metadata) owns its codes and
 * already matches its own version.
 */
export function filterPermissionModesForCli<T extends ModeOption>(
    modes: T[],
    cliVersion: string | null | undefined,
): T[] {
    return modes.filter((mode) => modeSupportedByCli(mode, cliVersion));
}

/**
 * Harnesses drover drives as a PANE, whose own TUI owns the conversation
 * (DROVE-56/DROVE-57).
 *
 * They reach the phone through the drover bus rather than through a happy-cli
 * runner, and neither of them has a per-session mode or model switch to reach:
 *
 *   opencode  permissions are `permission: {bash: "ask"}` in opencode.json,
 *             read at startup. There is no route that changes them on a
 *             running session, so a mode pick has nowhere to land. The MODEL
 *             does have a route (`POST /api/session/{id}/model`, measured on
 *             1.18.20) but nothing carries a pick to it yet, so the picker
 *             stays off until something does.
 *   cursor    cursor-agent exposes no inbox at all, so nothing typed in the
 *             app reaches a running session, a mode pick least of all.
 *
 * The lists are EMPTY rather than Claude's, which is what they used to fall
 * through to. That fallback is why this function is not just a default: the
 * composer read Claude's five permission modes and four Claude models onto an
 * OpenCode session, drew the capsule and the model name, and every tap did
 * nothing. A control that cannot work has to be absent — an inert one that
 * looks live is the worse failure, because it is answered by waiting.
 *
 * An empty list is already the "absent" path everywhere downstream:
 * AgentInput hides the mode segment when no mode resolves, drops the whole
 * capsule when neither segment draws, and leaves the model off the status row
 * when there is no model to name.
 */
const PANE_HARNESSES_WITHOUT_MODE_CONTROLS = new Set(['opencode', 'cursor']);

export function harnessHasModeControls(flavor: AgentFlavor): boolean {
    return !PANE_HARNESSES_WITHOUT_MODE_CONTROLS.has(flavor ?? '');
}

export function getHardcodedPermissionModes(flavor: AgentFlavor, translate: Translate): PermissionMode[] {
    if (!harnessHasModeControls(flavor)) {
        return [];
    }
    if (flavor === 'codex') {
        return getCodexPermissionModes(translate);
    }
    if (flavor === 'gemini') {
        return getGeminiPermissionModes(translate);
    }
    if (flavor === 'openclaw') {
        return getOpenClawPermissionModes(translate);
    }
    if (flavor === 'agy') {
        return getAgyPermissionModes(translate);
    }
    return getClaudePermissionModes(translate);
}

export function getOpenClawModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'Default model', description: null },
    ];
}

// Keys are the exact display names `agy --model` accepts (as printed by `agy models`).
export function getAgyModelModes(): ModelMode[] {
    return [
        { key: 'Gemini 3.6 Flash (High)', name: 'Gemini 3.6 Flash (High)', description: null },
        { key: 'Gemini 3.6 Flash (Medium)', name: 'Gemini 3.6 Flash (Medium)', description: null },
        { key: 'Gemini 3.6 Flash (Low)', name: 'Gemini 3.6 Flash (Low)', description: null },
        { key: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)', description: null },
        { key: 'Gemini 3.1 Pro (Low)', name: 'Gemini 3.1 Pro (Low)', description: null },
        { key: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)', description: null },
        { key: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)', description: null },
        { key: 'Gemini 3.5 Flash (Low)', name: 'Gemini 3.5 Flash (Low)', description: null },
        { key: 'Claude Opus 4.6 (Thinking)', name: 'Claude Opus 4.6 (Thinking)', description: null },
        { key: 'Claude Sonnet 4.6 (Thinking)', name: 'Claude Sonnet 4.6 (Thinking)', description: null },
        { key: 'GPT-OSS 120B (Medium)', name: 'GPT-OSS 120B (Medium)', description: null },
    ];
}

export function getHardcodedModelModes(flavor: AgentFlavor, _translate: Translate): ModelMode[] {
    // Same reason as the permission modes above: an OpenCode or Cursor pane
    // read Claude's model list and every pick was silently dropped.
    if (!harnessHasModeControls(flavor)) {
        return [];
    }
    if (flavor === 'codex') {
        return getCodexModelModes();
    }
    if (flavor === 'gemini') {
        return getGeminiModelModes();
    }
    if (flavor === 'openclaw') {
        return getOpenClawModelModes();
    }
    if (flavor === 'agy') {
        return getAgyModelModes();
    }
    return getClaudeModelModes();
}

export function getAvailableModels(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
    selectedKey?: string | null,
): ModelMode[] {
    if (isRigMetadataV1(metadata)) {
        const models: ModelMode[] = getRigModels(metadata).map((model) => ({
            key: model.key,
            name: model.name,
            description: model.providerName,
            modelId: model.id,
            providerId: model.providerId,
            providerName: model.providerName,
            providerKind: model.providerKind,
            contextWindow: model.contextWindow,
            serviceTiers: model.serviceTiers,
            thinkingLevels: model.thinkingLevels,
            defaultThinkingLevel: model.defaultThinkingLevel,
        }));
        const current = getRigCurrentModel(metadata);
        if (current?.unavailable && !models.some((model) => model.key === current.key)) {
            models.unshift({
                key: current.key,
                name: current.name,
                description: `${current.providerName} · unavailable`,
                modelId: current.id,
                providerId: current.providerId,
                providerName: current.providerName,
                providerKind: current.providerKind,
                thinkingLevels: [],
                serviceTiers: [],
                unavailable: true,
                disabled: true,
            });
        }
        const locallySelectedKey = selectedKey ?? metadata?.modelMode;
        if (locallySelectedKey && locallySelectedKey.includes(':') && !models.some((model) => model.key === locallySelectedKey)) {
            const separator = locallySelectedKey.indexOf(':');
            const providerId = locallySelectedKey.slice(0, separator);
            const modelId = locallySelectedKey.slice(separator + 1);
            models.unshift({
                key: locallySelectedKey,
                name: modelId,
                description: `${providerId} · unavailable`,
                modelId,
                providerId,
                providerName: providerId,
                providerKind: 'custom',
                unavailable: true,
                disabled: true,
            });
        }
        return models;
    }
    const metadataModels = mapMetadataOptions(metadata?.models);
    if (metadataModels.length > 0) {
        if (flavor === 'codex' && !metadataModels.some((model) => model.key === 'default')) {
            return [{ key: 'default', name: 'default model', description: null }, ...metadataModels];
        }
        return metadataModels;
    }
    return includeConfiguredModel(
        flavor,
        getHardcodedModelModes(flavor, translate),
        selectedKey,
    );
}

export function getAvailablePermissionModes(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
    selectedKey?: string | null,
): PermissionMode[] {
    if (isRigMetadataV1(metadata)) {
        const modes: PermissionMode[] = sortPermissionModes((metadata?.operatingModes ?? []).map((mode) => ({
            key: mode.code,
            name: mode.value,
            description: mode.description ?? null,
            semanticKind: mode.kind ?? null,
        })));
        const current = selectedKey
            ?? metadata?.currentOperatingModeCode
            ?? metadata?.permissionMode
            ?? metadata?.session?.permissionMode;
        if (current && !modes.some((mode) => mode.key === current)) {
            modes.unshift({
                key: current,
                name: current,
                description: 'Unavailable in the current Happy mode catalog',
                semanticKind: null,
                disabled: true,
            });
        }
        return modes;
    }
    if (flavor === 'claude' || flavor === 'codex' || flavor === 'openclaw' || flavor === 'agy') {
        // metadata.version is the happy-cli version running this session
        // (createSessionMetadata.ts), which is what has to parse the mode.
        return hackModes(filterPermissionModesForCli(
            getHardcodedPermissionModes(flavor, translate),
            metadata?.version,
        ));
    }

    const metadataModes = mapMetadataOptions(metadata?.operatingModes);
    if (metadataModes.length > 0) {
        return sortPermissionModes(hackModes(metadataModes));
    }

    return hackModes(getHardcodedPermissionModes(flavor, translate));
}

export function findOptionByKey<T extends ModeOption>(options: T[], key: string | null | undefined): T | null {
    if (!key) {
        return null;
    }
    return options.find((option) => option.key === key) ?? null;
}

export function resolveCurrentOption<T extends ModeOption>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        const option = findOptionByKey(options, key);
        if (option) {
            return option;
        }
    }
    return null;
}

export function getDefaultModelKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).modelMode;
}

export function getDefaultPermissionModeKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).permissionMode;
}

// Effort levels per agent type

// Display capitalization only — the key is what the wire protocol accepts.
// `xhigh` keeps its camel-cased brand spelling instead of plain title case.
const EFFORT_DISPLAY_NAMES: Record<string, string> = {
    xhigh: 'xHigh',
};

export function effortDisplayName(key: string): string {
    return EFFORT_DISPLAY_NAMES[key] ?? (key.charAt(0).toUpperCase() + key.slice(1));
}

function effortLevels(keys: readonly string[]): EffortLevel[] {
    return keys.map((key) => ({ key, name: effortDisplayName(key) }));
}

// The Claude Agent SDK's own EffortLevel union, in order
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:546), plus
// `ultracode`, which the SDK does not declare but Claude Code's `/effort`
// and `--effort` both take: xhigh with dynamic workflow orchestration, for
// that session only. It needs workflows enabled and an xhigh-capable model;
// Claude Code downgrades rather than errors when either is missing, same as
// `max` on a model without it. There is no `off`: Claude's floor is `low`.
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;

// The scale above is per SDK. The CEILING is per model, and this is the one
// place that fact lives.
//
// DROVE-101 wrote this table from documentation and got it BACKWARDS for the
// only model Clay runs: it said Opus 5 could not reach ultracode, so the picker
// greyed the row out and he could not select the level he had been asking for
// since June. DROVE-164 measured Claude Code 2.1.251 instead, both in the
// binary and at a real prompt on `claude-opus-5[1m]`:
//
//     > /effort ultracode
//     Set effort level to ultracode (this session only): xhigh + dynamic
//     workflow orchestration
//
// The rule ultracode is really gated on is `Zu() && X2(model) && zue('xhigh')`
// — workflows enabled, the model reaches xhigh, the org allows it. `X2` is a
// DENY list, not an allow list, and its whole content is below. Everything not
// on it reaches xhigh, which is why Opus 5, Opus 4.7, Opus 4.8, Fable 5 and
// Sonnet 5 all take ultracode and Opus 4.6 — which DROVE-101 listed as
// supported — does not.
//
// A deny list is also the right shape for the thing this table kept getting
// wrong. An allow list cripples every model that ships after it; a deny list
// only ever goes stale in the direction of offering a level the pane will then
// refuse in words the app now relays (DROVE-164, claudeLocalLauncher).
const CLAUDE_NO_XHIGH_MODELS: ReadonlySet<string> = new Set([
    'claude-opus-4-0',
    'claude-opus-4-1',
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-sonnet-4-0',
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
]);

/** Every `claude-3-*` is below the xhigh line too, and there are many. */
const CLAUDE_LEGACY_PREFIX = 'claude-3-';

// Why a level is out of reach, for the disabled row that says so. Keyed by
// effort so a second gated level gets its own line rather than this one. The
// model list is Claude Code's own wording for the same set (`Ojt` in 2.1.251).
const CLAUDE_EFFORT_REQUIREMENT: Record<string, string> = {
    xhigh: 'needs Fable 5, Opus 4.7+ or Sonnet 5',
    ultracode: 'needs Fable 5, Opus 4.7+ or Sonnet 5',
};

// `claude-opus-5[1m]` is the 1M-context variant of `claude-opus-5`, not a
// different model, so the bracket comes off before the table is asked.
function claudeModelBaseKey(modelKey: string | null | undefined): string {
    if (!modelKey) return '';
    const bracket = modelKey.indexOf('[');
    return bracket > 0 ? modelKey.slice(0, bracket) : modelKey;
}

function claudeReachesXhigh(modelKey?: string | null): boolean {
    const base = claudeModelBaseKey(modelKey);
    // No model named is not a model that cannot: an unresolved pick keeps the
    // whole scale rather than being trimmed on a guess.
    if (base.length === 0) return true;
    if (base.startsWith(CLAUDE_LEGACY_PREFIX)) return false;
    return !CLAUDE_NO_XHIGH_MODELS.has(base);
}

function claudeEffortKeysForModel(modelKey?: string | null): readonly string[] {
    if (claudeReachesXhigh(modelKey)) return CLAUDE_EFFORTS;
    // A model below the xhigh line loses `ultracode` (which IS xhigh plus
    // workflows) and `xhigh` itself. `max` is gated separately by Claude Code
    // and left alone here.
    return CLAUDE_EFFORTS.filter((key) => key !== 'ultracode' && key !== 'xhigh');
}

// Exactly what each model publishes in Codex's own registry, in its order
// (codex-rs/models-manager/models.json, min client 0.144). This really is
// per-model: sol and terra reach `ultra`, luna stops at `max`. `ultra` is
// documented as maximum reasoning with automatic task delegation, so it is a
// different kind of run rather than one more notch — but it is a level these
// two models accept, so the picker offers it rather than deciding for you.
const CODEX_EFFORTS_BY_MODEL: Record<string, readonly string[]> = {
    'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
};
const CODEX_EFFORTS_FALLBACK = ['low', 'medium', 'high', 'xhigh'] as const;

export function getClaudeEffortLevels(): EffortLevel[] {
    return effortLevels(CLAUDE_EFFORTS);
}

/**
 * The Claude effort levels one model can actually reach.
 *
 * Pure: a model key in, its levels out, no metadata and no session. An unknown
 * or unrecognised key keeps the full scale rather than being trimmed by a table
 * that has not heard of it yet.
 */
export function getClaudeEffortLevelsForModel(modelKey?: string | null): EffortLevel[] {
    return effortLevels(claudeEffortKeysForModel(modelKey));
}

/**
 * The levels this model cannot reach, as disabled rows carrying the reason.
 *
 * A picker that can render a disabled row appends these, so `ultracode` on
 * Opus 5 is visibly out of reach with the models that do support it named,
 * rather than quietly missing from a list that had it a moment ago.
 */
export function getUnreachableClaudeEffortLevels(modelKey?: string | null): EffortLevel[] {
    const reachable = new Set(claudeEffortKeysForModel(modelKey));
    return CLAUDE_EFFORTS
        .filter((key) => !reachable.has(key))
        .map((key) => ({
            key,
            name: effortDisplayName(key),
            description: CLAUDE_EFFORT_REQUIREMENT[key] ?? 'not available on this model',
            disabled: true,
        }));
}

/**
 * Codex efforts for one model. An unknown model — a workspace's own, or one
 * newer than this table — gets the conservative set every gpt-5 accepts rather
 * than a guess at the top of its range.
 */
export function getCodexEffortLevels(modelKey?: string | null): EffortLevel[] {
    return effortLevels(
        (modelKey ? CODEX_EFFORTS_BY_MODEL[modelKey] : undefined) ?? CODEX_EFFORTS_FALLBACK,
    );
}

export function getHardcodedEffortLevels(flavor: AgentFlavor): EffortLevel[] {
    if (flavor === 'claude') return getClaudeEffortLevels();
    if (flavor === 'codex') return getCodexEffortLevels();
    return [];
}

export function getDefaultEffortKey(flavor: AgentFlavor): string | null {
    return getCodeAgentDefaults(flavor).effortLevel;
}

// Per-model effort: returns effort levels for a specific model, or empty if the model has no effort
export function getEffortLevelsForModel(
    flavor: AgentFlavor,
    modelKey: string,
    metadata?: Metadata | null,
): EffortLevel[] {
    if (isRigMetadataV1(metadata)) {
        return getRigReasoningLevels(metadata, modelKey).map((level) => ({
            key: level,
            name: effortDisplayName(level),
        }));
    }
    // Claude's effort SCALE is a property of the SDK: one union for every
    // model, and a level inside a model's range that it does not run is
    // silently downgraded rather than rejected (sdk.d.ts:174). The CEILING is
    // a property of the model, so the scale is trimmed to what this one can
    // reach (CLAUDE_ULTRACODE_BY_MODEL). Codex publishes its levels per model
    // too, so it is asked the same way.
    if (flavor === 'claude') {
        return getClaudeEffortLevelsForModel(modelKey);
    }
    if (flavor === 'codex') {
        return getCodexEffortLevels(modelKey);
    }
    return [];
}

/**
 * What an effort picker lists: the reachable levels, then any level this model
 * cannot reach as a disabled row with its reason. Selection paths keep using
 * getEffortLevelsForModel, so a disabled row is never resolved to or defaulted
 * onto.
 */
export function getEffortLevelsForPicker(
    flavor: AgentFlavor,
    modelKey: string,
    metadata?: Metadata | null,
): EffortLevel[] {
    const reachable = getEffortLevelsForModel(flavor, modelKey, metadata);
    if (flavor !== 'claude' || isRigMetadataV1(metadata) || reachable.length === 0) {
        return reachable;
    }
    return [...reachable, ...getUnreachableClaudeEffortLevels(modelKey)];
}

/**
 * The top of what this model can run. Where an effort stops being reachable
 * because the model changed, this is where it lands: the nearest thing to what
 * was asked for, rather than sticking at an impossible value or dropping to the
 * bottom of the scale.
 */
export function getHighestReachableEffortKey(
    flavor: AgentFlavor,
    modelKey: string,
    metadata?: Metadata | null,
): string | null {
    const levels = getEffortLevelsForModel(flavor, modelKey, metadata);
    return levels.length > 0 ? levels[levels.length - 1].key : null;
}

/**
 * The model key to SHOW for a session, given what the pane reports and what
 * was picked in this app (DROVE-45).
 *
 * For a pane session the pane wins: Clay's words are "if I /model from the
 * terminal it should always update the mobile app", and the pick is only ever a
 * request the terminal may not have taken yet.
 *
 * The one exception is the bracket variant. `claude-opus-5[1m]` is a model id
 * Claude Code accepts and the app offers as its own row, but the transcript
 * reports the plain `claude-opus-5` for it — the bracket selects the 1M-context
 * variant rather than a different model. Reading the pane literally there would
 * collapse "Opus 5 [1M]" into "Opus 5" the moment it was picked and never let
 * it back, which looks exactly like the pick failing. So a pick that is the
 * pane's own model plus a bracket suffix is kept: it does not contradict the
 * pane, it says more than the pane said.
 */
export function resolvePaneModelKey(
    paneModel: string | null | undefined,
    selectedKey: string | null | undefined,
): string | null {
    if (!paneModel) {
        return null;
    }
    if (selectedKey && selectedKey.startsWith(`${paneModel}[`) && selectedKey.endsWith(']')) {
        return selectedKey;
    }
    return paneModel;
}

/**
 * Make sure the model the pane is running has a row to be selected against
 * (DROVE-45).
 *
 * getClaudeModelModes offers the current generation only, on purpose — picking
 * a model is the point of that menu. But `/model opus-4-8` in the terminal is a
 * thing Clay can do, and without a row for it resolveCurrentOption finds
 * nothing and the chip falls back to the bare word "MODEL", which reads as the
 * session having no model at all. The row is disabled: it says what is running,
 * it is not an invitation to switch back to a generation the menu retired.
 */
export function includePaneModel(models: ModelMode[], paneModelKey: string | null | undefined): ModelMode[] {
    if (!paneModelKey || models.some((model) => model.key === paneModelKey)) {
        return models;
    }
    return [...models, { key: paneModelKey, name: paneModelKey, description: 'running in the terminal', disabled: true }];
}

/**
 * Make sure the permission mode the pane is in has a row to be selected
 * against (DROVE-36).
 *
 * The twin of includePaneModel, for the same reason. getClaudePermissionModes
 * offers the five modes worth picking; Claude Code's own cycle also has
 * `dontAsk`, and a session that reaches it from the keyboard would otherwise
 * leave resolveCurrentOption with nothing and the chip reading a bare
 * "PERMISSIONS" — which looks like the session having no policy at all, the
 * scariest possible way to be wrong about this particular setting. Disabled,
 * because it says what the terminal is doing rather than offering it.
 */
export function includePanePermissionMode(
    modes: PermissionMode[],
    paneModeKey: string | null | undefined,
): PermissionMode[] {
    if (!paneModeKey || modes.some((mode) => mode.key === paneModeKey)) {
        return modes;
    }
    return [...modes, { key: paneModeKey, name: paneModeKey, description: 'set in the terminal', disabled: true }];
}

export function getRigCurrentModelOptionKey(metadata: Metadata | null | undefined): string | null {
    return getRigSelectedModelKey(metadata);
}

// Default effort for a model — highest the model allows
export function getDefaultEffortKeyForModel(flavor: AgentFlavor, modelKey: string): string | null {
    const levels = getEffortLevelsForModel(flavor, modelKey);
    if (levels.length === 0) return null;
    return getCodeAgentDefaults(flavor).effortLevel ?? levels[levels.length - 1].key;
}

export function getSupportsWorktree(flavor: AgentFlavor): boolean {
    if (flavor === 'openclaw') return false;
    return true;
}
