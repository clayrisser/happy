/**
 * The flip and model-fallback policy, as rows you can tap (DROVE-3).
 *
 * Shared by the per-session screen and the machine-defaults screen because the
 * two show the SAME five keys with one difference: a session row has a "use the
 * default" choice above the real ones, and a defaults row does not — a default
 * has nothing above it to inherit from.
 *
 * Every row says which layer its value came from. That is the point of showing
 * `overrides` apart from `machine` and `builtIn`: "Auto-flip · you set this for
 * this session" and "Auto-flip · the default on this Mac" are different answers
 * to "why did it move without asking me", and a merged value cannot tell them
 * apart.
 *
 * FOLD, NEVER DROP. All five keys the store takes are here, including the two
 * that only matter once a prompt is standing (how long it stands, and what
 * happens when it is never answered), under a section that is quiet rather than
 * absent. The fallback chain is read-only here — it is a map of family to a
 * list, which is an editor, not a toggle, and the terminal already has one in
 * `drover settings fallback`.
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Typography } from '@/constants/Typography';
import type { DroverPolicy } from '@/sync/storageTypes';
import {
    defaultValue,
    effectiveValue,
    sourceOf,
    type PolicyKey,
    type PolicyPatch,
    type PolicySource,
} from '@/utils/droverPolicyLayers';

/** The one string that says where a value came from, in Clay's own terms. */
export function sourceLabel(source: PolicySource, scope: 'session' | 'defaults'): string {
    if (scope === 'defaults') {
        return source === 'machine' ? 'set on this Mac' : 'the shipped default';
    }
    switch (source) {
        case 'session': return 'you set this for this session';
        case 'machine': return 'the default on this Mac';
        case 'builtIn': return 'the shipped default';
        default: return '';
    }
}

interface Choice<V extends string> {
    value: V;
    title: string;
    subtitle: string;
}

const onLimitChoices: Choice<'prompt' | 'auto'>[] = [
    {
        value: 'prompt',
        title: 'Ask me which account',
        subtitle: 'Raises a question listing every account, most headroom first. The session moves only where you say.',
    },
    {
        value: 'auto',
        title: 'Switch on its own',
        subtitle: 'Moves straight to the account with the most headroom and says in the transcript where it went and why.',
    },
];

/**
 * What happens when the model runs out (DROVE-187).
 *
 * Four values, in the order they escalate. `flip-then-downgrade` is the default
 * and the one that keeps an unattended session working: try the same model on
 * another account first, because that changes nothing about the answers, and
 * drop a rung only when no account can carry it.
 *
 * The two values this key shipped with — `stop` and `fallback` — are still
 * accepted by the store and read as `flip-only` and `flip-then-downgrade`, so a
 * Mac that set one before this shipped keeps the behaviour it chose.
 */
type FamilyPolicy = 'flip-then-downgrade' | 'flip-only' | 'downgrade-only' | 'nothing';

const onFamilyExhaustedChoices: Choice<FamilyPolicy>[] = [
    {
        value: 'flip-then-downgrade',
        title: 'Switch account, then drop a model',
        subtitle: 'Tries the same model on another account first. Only when no account has it does the model drop a rung — Fable to Opus to Sonnet, never Haiku.',
    },
    {
        value: 'flip-only',
        title: 'Switch account only',
        subtitle: 'Moves to an account that has the model. If none has it, the session stops and says so rather than answering an Opus question on Sonnet.',
    },
    {
        value: 'downgrade-only',
        title: 'Drop a model only',
        subtitle: 'Stays on this account and moves down the chain. For when the account matters more than the model.',
    },
    {
        value: 'nothing',
        title: 'Do nothing',
        subtitle: 'Neither the account nor the model changes. The session waits for you.',
    },
];

const onLimitTimeoutChoices: Choice<'auto' | 'stop'>[] = [
    {
        value: 'auto',
        title: 'Switch anyway',
        subtitle: 'Keeps an unattended session working when nobody sees the question.',
    },
    {
        value: 'stop',
        title: 'Stay put',
        subtitle: 'Refuses to move a session nobody steered.',
    },
];

interface RowsProps {
    policy: DroverPolicy | undefined;
    scope: 'session' | 'defaults';
    /** null while a write for that key is in flight, so the row can show it. */
    busyKey: PolicyKey | null;
    onChange: (patch: PolicyPatch) => void;
    disabled?: boolean;
}

function ChoiceRows<V extends string>(props: RowsProps & {
    policyKey: PolicyKey;
    choices: Choice<V>[];
}) {
    const { policy, scope, busyKey, onChange, disabled, policyKey, choices } = props;
    const chosen = scope === 'session'
        ? (policy?.overrides?.[policyKey] ?? null)
        : (policy?.machine?.[policyKey] ?? null);
    const acting = scope === 'session'
        ? effectiveValue(policy, policyKey)
        : defaultValue(policy, policyKey);
    const busy = busyKey === policyKey;

    return (
        <>
            {scope === 'session' && (
                <Item
                    title="Use the default"
                    subtitle={acting ? `Today that means "${labelFor(choices, acting as V)}".` : undefined}
                    selected={chosen == null}
                    showChevron={false}
                    loading={busy && chosen != null}
                    disabled={disabled}
                    onPress={() => onChange({ [policyKey]: null } as PolicyPatch)}
                />
            )}
            {choices.map((choice) => (
                <Item
                    key={choice.value}
                    title={choice.title}
                    subtitle={choice.subtitle}
                    subtitleLines={0}
                    selected={chosen === choice.value}
                    showChevron={false}
                    loading={busy && chosen !== choice.value}
                    disabled={disabled}
                    onPress={() => onChange({ [policyKey]: choice.value } as PolicyPatch)}
                />
            ))}
        </>
    );
}

function labelFor<V extends string>(choices: Choice<V>[], value: V): string {
    return choices.find((c) => c.value === value)?.title ?? value;
}

/** One line under a group heading naming the value in force and where it came from. */
function InForce(props: { policy: DroverPolicy | undefined; policyKey: PolicyKey; scope: 'session' | 'defaults'; choices: Choice<string>[] }) {
    const { theme } = useUnistyles();
    const { policy, policyKey, scope, choices } = props;
    const value = scope === 'session' ? effectiveValue(policy, policyKey) : defaultValue(policy, policyKey);
    if (value == null) return null;
    const where = sourceLabel(sourceOf(policy, policyKey), scope);
    return (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                {`Now: ${labelFor(choices, String(value))}${where ? ` · ${where}` : ''}`}
            </Text>
        </View>
    );
}

export function DroverPolicyGroups(props: RowsProps) {
    const { policy, scope } = props;
    const { theme } = useUnistyles();

    if (policy?.unavailable) {
        return (
            <ItemGroup title="Account switching">
                <Item
                    title="The drover bus is not answering"
                    subtitle={policy.unavailable}
                    subtitleLines={0}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    const fallback = (scope === 'session' ? policy?.effective?.familyFallback : policy?.defaults?.familyFallback) ?? null;
    const ttl = scope === 'session' ? effectiveValue(policy, 'onLimitPromptTtlMs') : defaultValue(policy, 'onLimitPromptTtlMs');

    return (
        <>
            <ItemGroup
                title="When this account runs out"
                footer={scope === 'session'
                    ? 'This session only.'
                    : 'Every new session on this Mac starts here.'}
            >
                <InForce policy={policy} policyKey="onLimit" scope={scope} choices={onLimitChoices} />
                <ChoiceRows {...props} policyKey="onLimit" choices={onLimitChoices} />
            </ItemGroup>

            <ItemGroup
                title="When no account has your model"
                footer="A family with no chain below it cannot drop."
            >
                <InForce policy={policy} policyKey="onFamilyExhausted" scope={scope} choices={onFamilyExhaustedChoices} />
                <ChoiceRows {...props} policyKey="onFamilyExhausted" choices={onFamilyExhaustedChoices} />
            </ItemGroup>

            <ItemGroup
                title="If nobody answers the question"
                footer="Only when the setting above is Ask me."
            >
                <InForce policy={policy} policyKey="onLimitTimeout" scope={scope} choices={onLimitTimeoutChoices} />
                <ChoiceRows {...props} policyKey="onLimitTimeout" choices={onLimitTimeoutChoices} />
                <Item
                    title="How long it stands"
                    detail={ttl == null ? '—' : `${Math.round(Number(ttl) / 60000)} min`}
                    subtitle="set from the terminal"
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title="The fallback chain"
                footer="Edited from the terminal."
            >
                {fallback && Object.keys(fallback).length > 0 ? (
                    Object.entries(fallback).map(([family, chain]) => (
                        <Item
                            key={family}
                            title={family}
                            detail={(chain ?? []).join(' → ') || 'nothing'}
                            showChevron={false}
                        />
                    ))
                ) : (
                    <Item title="No chain" subtitle="Nothing can drop a rung." showChevron={false} />
                )}
            </ItemGroup>

            {policy?.updatedAt != null && scope === 'session' && (
                <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 }}>
                    <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {`Last changed ${new Date(policy.updatedAt).toLocaleString()}${policy.updatedBy ? ` from ${policy.updatedBy}` : ''}`}
                    </Text>
                </View>
            )}
        </>
    );
}
