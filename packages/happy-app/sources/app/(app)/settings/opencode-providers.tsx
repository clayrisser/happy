/**
 * Adding and configuring OpenCode's custom providers, from the phone
 * (DROVE-276).
 *
 * Clay: "I typically use opencode for custom 3rd party model providers." That
 * is what OpenCode is FOR in this setup. DROVE-296 made them visible and left
 * the note "Editing any of this from the phone is not built yet" under them.
 * This is the editing.
 *
 * NO KEY IS TYPED HERE, and that is the whole design rather than a caveat.
 * The API key field takes the NAME of an environment variable —
 * `OPENAI_API_KEY`, not `sk-…` — and the machine writes OpenCode's own
 * `{env:NAME}` reference. The key is set on the computer, in Clay's shell, and
 * OpenCode reads it there at its own start. Anything shaped like an issued
 * credential is refused before the field is even sent (`providerInputRefusal`
 * in happy-wire), so a pasted key never leaves the handset.
 *
 * A SCREEN AND NOT A SHEET. A provider is five fields and a list of models,
 * and `Modal.prompt` is one field at a time. Four prompts in a row for one
 * object is the shape of an interrogation, not a form.
 *
 * WHAT DROVER OWNS IS WHAT SHOWS. The machine reports only the providers it
 * wrote, between its own markers in `opencode.jsonc`. One written by hand is
 * never listed here, never rewritten and never removable — it is on the
 * machine page beside the rest, where it is read and left alone.
 */

import * as React from 'react';
import { Platform, TextInput, View, Text } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/storage';
import {
    machineModelConfigure,
    machineProviderPut,
    machineProviderRemove,
    machineProviders,
} from '@/sync/machineProviders';
import type { ProviderWriteSummary } from '@slopus/happy-wire';

const amber = '#FF9500';
const grey = '#8E8E93';

/** One labelled text field. Local, because this screen is its only caller. */
function Field(props: {
    label: string;
    value: string;
    placeholder?: string;
    keyboard?: 'default' | 'numeric' | 'url';
    autoCapitalize?: 'none' | 'sentences';
    editable?: boolean;
    onChange: (next: string) => void;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginBottom: 4 }}>
                {props.label}
            </Text>
            <TextInput
                value={props.value}
                onChangeText={props.onChange}
                placeholder={props.placeholder}
                placeholderTextColor={grey}
                editable={props.editable !== false}
                autoCapitalize={props.autoCapitalize ?? 'none'}
                autoCorrect={false}
                keyboardType={props.keyboard === 'numeric' ? 'number-pad' : 'default'}
                style={{
                    color: props.editable === false ? theme.colors.textSecondary : theme.colors.text,
                    fontSize: 17,
                    padding: 0,
                }}
            />
        </View>
    );
}

interface ModelDraft {
    id: string;
    name: string;
    contextWindow: string;
    maxOutput: string;
    temperature: string;
    reasoning: boolean;
}

interface Draft {
    id: string;
    name: string;
    baseURL: string;
    apiKeyEnv: string;
    npm: string;
    models: ModelDraft[];
    /** False when this provider already exists on the machine: the id is its key. */
    isNew: boolean;
}

const blankModel = (): ModelDraft => ({
    id: '',
    name: '',
    contextWindow: '',
    maxOutput: '',
    temperature: '',
    reasoning: false,
});

const blankDraft = (): Draft => ({
    id: '',
    name: '',
    baseURL: '',
    apiKeyEnv: '',
    npm: '',
    models: [blankModel()],
    isNew: true,
});

/**
 * A summary carries names and model ids and nothing else — the machine refuses
 * to send back a base URL or a key variable, the same fields DROVE-296 refuses
 * to read. So an edit starts from what is known and leaves the rest blank; a
 * blank field is not sent, so it keeps whatever is in the config.
 */
const draftFrom = (provider: ProviderWriteSummary): Draft => ({
    id: provider.id,
    name: provider.name === provider.id ? '' : provider.name,
    baseURL: '',
    apiKeyEnv: '',
    npm: '',
    models: provider.models.map((m) => ({
        ...blankModel(),
        id: m.id,
        name: m.name === m.id ? '' : m.name,
    })),
    isNew: false,
});

const trimmed = (s: string): string | undefined => (s.trim() ? s.trim() : undefined);
const asInt = (s: string): number | undefined => (s.trim() ? Number(s.trim()) : undefined);

export default function OpencodeProvidersScreen() {
    const params = useLocalSearchParams<{ machineId?: string }>();
    const machines = useAllMachines({ includeOffline: true });
    const machineId = params.machineId ?? (machines.length === 1 ? machines[0].id : null);

    const [providers, setProviders] = React.useState<ProviderWriteSummary[] | null>(null);
    const [config, setConfig] = React.useState<string | null>(null);
    const [restartRequired, setRestartRequired] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [draft, setDraft] = React.useState<Draft | null>(null);

    const load = React.useCallback(async (id: string) => {
        const result = await machineProviders(id);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        setError(null);
        setProviders(result.providers);
        setConfig(result.config);
    }, []);

    React.useEffect(() => {
        if (!machineId) return;
        void load(machineId);
    }, [machineId, load]);

    const save = React.useCallback(async () => {
        if (!machineId || !draft) return;
        setBusy(true);
        setError(null);
        const models = draft.models
            .filter((m) => m.id.trim())
            .map((m) => ({
                id: m.id.trim(),
                name: trimmed(m.name),
                contextWindow: asInt(m.contextWindow),
                maxOutput: asInt(m.maxOutput),
                reasoning: m.reasoning || undefined,
                options: m.temperature.trim() ? { temperature: Number(m.temperature.trim()) } : undefined,
            }));
        const result = await machineProviderPut(machineId, {
            id: draft.id.trim(),
            name: trimmed(draft.name),
            baseURL: trimmed(draft.baseURL),
            apiKeyEnv: trimmed(draft.apiKeyEnv),
            npm: trimmed(draft.npm),
            models,
        });
        setBusy(false);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        setProviders(result.providers);
        setConfig(result.config);
        setRestartRequired(result.restartRequired);
        setDraft(null);
    }, [machineId, draft]);

    const remove = React.useCallback(async (id: string) => {
        if (!machineId) return;
        const ok = await Modal.confirm(`Remove ${id}?`, 'Its models go with it.', { destructive: true });
        if (!ok) return;
        setBusy(true);
        const result = await machineProviderRemove(machineId, id);
        setBusy(false);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        setError(null);
        setProviders(result.providers);
        setRestartRequired(result.restartRequired);
        setDraft(null);
    }, [machineId]);

    /**
     * One model, on its own, without resending the whole provider.
     *
     * The machine merges at the model level and replaces at the field level, so
     * a phone that sends only a context window keeps the cost somebody set last
     * week. That is why this is a separate call and not a re-save of the draft.
     */
    const configureModel = React.useCallback(async (providerId: string, model: ModelDraft) => {
        if (!machineId) return;
        setBusy(true);
        const result = await machineModelConfigure(machineId, providerId, {
            id: model.id.trim(),
            name: trimmed(model.name),
            contextWindow: asInt(model.contextWindow),
            maxOutput: asInt(model.maxOutput),
            reasoning: model.reasoning || undefined,
            options: model.temperature.trim() ? { temperature: Number(model.temperature.trim()) } : undefined,
        });
        setBusy(false);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        setError(null);
        setProviders(result.providers);
        setRestartRequired(result.restartRequired);
    }, [machineId]);

    const patchModel = (index: number, patch: Partial<ModelDraft>) => {
        setDraft((d) => (!d ? d : {
            ...d,
            models: d.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
        }));
    };

    const header = (
        <Stack.Screen options={{ title: draft ? (draft.isNew ? 'New provider' : draft.id) : 'Model providers' }} />
    );

    if (!machineId) {
        return (
            <>
                {header}
                <ItemList containerStyle={{ paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0 }}>
                    <ItemGroup title="Which machine">
                        {machines.length === 0 ? (
                            <Item title="No machines connected" showChevron={false} />
                        ) : machines.map((machine) => (
                            <Item
                                key={machine.id}
                                title={machine.metadata?.displayName || machine.metadata?.host || machine.id.substring(0, 8)}
                                subtitle={machine.active ? 'online' : 'offline'}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                </ItemList>
            </>
        );
    }

    const errorGroup = error && (
        <ItemGroup>
            <Item
                title="That machine refused"
                subtitle={error}
                subtitleLines={0}
                icon={<Ionicons name="warning-outline" size={29} color={amber} />}
                showChevron={false}
            />
        </ItemGroup>
    );

    if (draft) {
        return (
            <>
                {header}
                <ItemList containerStyle={{ paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0 }}>
                    {errorGroup}
                    <ItemGroup title="Provider">
                        <Field
                            label="Id"
                            value={draft.id}
                            placeholder="my-gateway"
                            editable={draft.isNew}
                            onChange={(id) => setDraft((d) => (d ? { ...d, id } : d))}
                        />
                        <Field
                            label="Name"
                            value={draft.name}
                            placeholder={draft.id || 'Corp Gateway'}
                            autoCapitalize="sentences"
                            onChange={(name) => setDraft((d) => (d ? { ...d, name } : d))}
                        />
                        <Field
                            label="Base URL"
                            value={draft.baseURL}
                            placeholder="https://gateway.example.com/v1"
                            keyboard="url"
                            onChange={(baseURL) => setDraft((d) => (d ? { ...d, baseURL } : d))}
                        />
                        <Field
                            label="npm package"
                            value={draft.npm}
                            placeholder="@ai-sdk/openai-compatible"
                            onChange={(npm) => setDraft((d) => (d ? { ...d, npm } : d))}
                        />
                    </ItemGroup>

                    <ItemGroup
                        title="API key"
                        footer="Named here, read from the environment."
                    >
                        <Field
                            label="Environment variable"
                            value={draft.apiKeyEnv}
                            placeholder="OPENAI_API_KEY"
                            onChange={(apiKeyEnv) => setDraft((d) => (d ? { ...d, apiKeyEnv } : d))}
                        />
                    </ItemGroup>

                    {draft.models.map((model, index) => (
                        <ItemGroup key={index} title={index === 0 ? 'Models' : undefined}>
                            <Field
                                label="Model id"
                                value={model.id}
                                placeholder="gpt-5"
                                onChange={(id) => patchModel(index, { id })}
                            />
                            <Field
                                label="Name"
                                value={model.name}
                                placeholder={model.id || 'GPT-5'}
                                autoCapitalize="sentences"
                                onChange={(name) => patchModel(index, { name })}
                            />
                            <Field
                                label="Context window"
                                value={model.contextWindow}
                                placeholder="200000"
                                keyboard="numeric"
                                onChange={(contextWindow) => patchModel(index, { contextWindow })}
                            />
                            <Field
                                label="Max output"
                                value={model.maxOutput}
                                placeholder="32000"
                                keyboard="numeric"
                                onChange={(maxOutput) => patchModel(index, { maxOutput })}
                            />
                            <Field
                                label="Temperature"
                                value={model.temperature}
                                placeholder="0.2"
                                keyboard="numeric"
                                onChange={(temperature) => patchModel(index, { temperature })}
                            />
                            <Item
                                title="Reasoning"
                                detail={model.reasoning ? 'yes' : 'no'}
                                showChevron={false}
                                onPress={() => patchModel(index, { reasoning: !model.reasoning })}
                            />
                            {!draft.isNew && model.id.trim() && (
                                <Item
                                    title="Apply to this model"
                                    subtitle="Leaves the rest of the provider alone"
                                    subtitleLines={0}
                                    showChevron={false}
                                    loading={busy}
                                    onPress={() => void configureModel(draft.id, model)}
                                />
                            )}
                        </ItemGroup>
                    ))}

                    <ItemGroup>
                        <Item
                            title="Add another model"
                            showChevron={false}
                            onPress={() => setDraft((d) => (d ? { ...d, models: [...d.models, blankModel()] } : d))}
                        />
                    </ItemGroup>

                    <ItemGroup footer="A running pane keeps the models it had.">
                        <Item
                            title={draft.isNew ? 'Add provider' : 'Save provider'}
                            loading={busy}
                            showChevron={false}
                            onPress={() => void save()}
                        />
                        <Item title="Cancel" showChevron={false} onPress={() => { setDraft(null); setError(null); }} />
                        {!draft.isNew && (
                            <Item
                                title="Remove provider"
                                destructive
                                showChevron={false}
                                onPress={() => void remove(draft.id)}
                            />
                        )}
                    </ItemGroup>
                </ItemList>
            </>
        );
    }

    return (
        <>
            {header}
            <ItemList containerStyle={{ paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0 }}>
                {errorGroup}

                {restartRequired && (
                    <ItemGroup>
                        <Item
                            title="Start OpenCode again to pick this up"
                            subtitle="A running pane keeps the models it had"
                            subtitleLines={0}
                            icon={<Ionicons name="refresh-outline" size={29} color={amber} />}
                            showChevron={false}
                        />
                    </ItemGroup>
                )}

                <ItemGroup title="Added from the phone" footer={config ?? undefined}>
                    {providers === null ? (
                        <Item title="Reading the machine…" showChevron={false} loading />
                    ) : providers.length === 0 ? (
                        <Item
                            title="None yet"
                            subtitle="Hand-written ones stay on the machine"
                            icon={<Ionicons name="ellipse-outline" size={29} color={grey} />}
                            showChevron={false}
                        />
                    ) : providers.map((provider) => (
                        <Item
                            key={provider.id}
                            title={provider.name}
                            subtitle={`${provider.modelCount} model${provider.modelCount === 1 ? '' : 's'}`}
                            subtitleLines={0}
                            onPress={() => setDraft(draftFrom(provider))}
                        />
                    ))}
                </ItemGroup>

                <ItemGroup>
                    <Item title="Add a provider" showChevron onPress={() => setDraft(blankDraft())} />
                </ItemGroup>
            </ItemList>
        </>
    );
}
