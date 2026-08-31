/**
 * The all-time count, broken down by model (DROVE-241).
 *
 * Clay: "Have it breakdown when single pressing by model." A single press on
 * the home page's counter opens this; the long press resets it and is the
 * counter's own business, not this sheet's.
 *
 * Same shell as every other sheet in the app (ComposerSheet), so it is
 * dismissed the two ways the others are and grows to its content.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ComposerSheet } from './ComposerSheet';
import { formatTokens } from '@/utils/liveStatus';
import { tokenLedgerRows, tokenLedgerTotal, type TokenLedger } from '@/sync/tokenLedger';
import { t } from '@/text';

export function AllTimeTokensSheet(props: {
    ledger: TokenLedger;
    open: boolean;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const rows = tokenLedgerRows(props.ledger, t('allTimeTokens.unattributed'));
    const total = tokenLedgerTotal(props.ledger);
    return (
        <ComposerSheet open={props.open} onClose={props.onClose}>
            <View style={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 16 }}>
                <Text
                    style={{
                        fontSize: 13,
                        color: theme.colors.text,
                        marginBottom: 2,
                        ...Typography.default('semiBold'),
                    }}
                >
                    {t('allTimeTokens.title')}
                </Text>
                <Text
                    style={{
                        fontSize: 11,
                        color: theme.colors.textSecondary,
                        marginBottom: 12,
                        ...Typography.default(),
                    }}
                >
                    {t('allTimeTokens.total', { tokens: formatTokens(total) })}
                </Text>
                {rows.length === 0 ? (
                    <Text
                        style={{
                            fontSize: 12,
                            color: theme.colors.textSecondary,
                            ...Typography.default(),
                        }}
                    >
                        {t('allTimeTokens.empty')}
                    </Text>
                ) : null}
                {rows.map((row) => (
                    <View
                        key={row.model || 'unattributed'}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingVertical: 6,
                        }}
                    >
                        <Text
                            numberOfLines={1}
                            style={{
                                flexShrink: 1,
                                fontSize: 13,
                                color: theme.colors.text,
                                ...Typography.default(),
                            }}
                        >
                            {row.label}
                        </Text>
                        <Text
                            style={{
                                fontSize: 13,
                                color: theme.colors.textSecondary,
                                marginLeft: 12,
                                ...Typography.mono(),
                            }}
                        >
                            {formatTokens(row.tokens)}
                        </Text>
                    </View>
                ))}
                {/* Two footnotes, both of which stop a reasonable person
                    filing a bug. The parts add to the whole only because the
                    unattributed row is drawn, and this counts what the phone
                    was connected for rather than what the estate spent. */}
                <Text
                    style={{
                        fontSize: 10,
                        color: theme.colors.textSecondary,
                        marginTop: 12,
                        ...Typography.default(),
                    }}
                >
                    {t('allTimeTokens.footer')}
                </Text>
                {props.ledger.resetAt ? (
                    <Text
                        style={{
                            fontSize: 10,
                            color: theme.colors.textSecondary,
                            marginTop: 4,
                            ...Typography.default(),
                        }}
                    >
                        {t('allTimeTokens.since', {
                            when: new Date(props.ledger.resetAt).toLocaleDateString(),
                        })}
                    </Text>
                ) : null}
            </View>
        </ComposerSheet>
    );
}
