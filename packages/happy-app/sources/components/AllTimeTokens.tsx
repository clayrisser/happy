/**
 * THE HOME PAGE'S ALL-TIME TOKEN COUNTER (DROVE-241).
 *
 * Clay: "Just for fun on the home page keep track of all tokens ever used. Of
 * course you can long press it to reset that counter. Have it breakdown when
 * single pressing by model."
 *
 * WHERE IT SITS. Under the header title, inside the centred column. That
 * column is absolutely positioned at left:64 / right:64 (Header.tsx), so it
 * takes no width from the logo on one side or the action pill on the other,
 * and a counter that only grows can never crowd either of them. The right
 * pill was the other candidate and it is the one place on this screen with a
 * width budget worth protecting, which is reason enough not to put a growing
 * number in it.
 *
 * CONFIRM, NOT UNDO, and the choice is deliberate. A long press on a header
 * is easy to trigger by accident, so something has to stand between it and a
 * number Clay has been collecting. The app has no undo affordance anywhere —
 * no snackbar, and its one toast is `pointerEvents="none"` and anchored to the
 * composer — so an undo here would mean inventing that primitive for a counter
 * he described as "just for fun". `Modal.confirm(..., { destructive: true })`
 * is what the app already uses to guard a destructive tap, so it guards this
 * one. The sheet then says the date it was reset, which is the part an undo
 * would really have been protecting: knowing it happened.
 */
import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { resetAllTimeTokens, useTokenLedger } from '@/sync/storage';
import { tokenLedgerTotal } from '@/sync/tokenLedger';
import { formatTokens } from '@/utils/liveStatus';
import { t } from '@/text';
import { AllTimeTokensSheet } from './AllTimeTokensSheet';

export function AllTimeTokens() {
    const { theme } = useUnistyles();
    const ledger = useTokenLedger();
    const [open, setOpen] = React.useState(false);
    const total = tokenLedgerTotal(ledger);

    const onLongPress = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('allTimeTokens.resetTitle'),
            t('allTimeTokens.resetMessage'),
            {
                confirmText: t('allTimeTokens.resetConfirm'),
                cancelText: t('allTimeTokens.resetCancel'),
                destructive: true,
            },
        );
        if (confirmed) resetAllTimeTokens();
    }, []);

    // Nothing spent yet is nothing to draw. A `0` under the title on a fresh
    // install is furniture, not information, and the counter appears on its
    // own the first time a session spends anything.
    if (total <= 0) return null;

    return (
        <>
            <Pressable
                onPress={() => setOpen(true)}
                onLongPress={onLongPress}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('allTimeTokens.accessibility', {
                    tokens: formatTokens(total),
                })}
                accessibilityHint={t('allTimeTokens.accessibilityHint')}
            >
                <Text
                    style={{
                        fontSize: 10,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    {t('allTimeTokens.strip', { tokens: formatTokens(total) })}
                </Text>
            </Pressable>
            <AllTimeTokensSheet
                ledger={ledger}
                open={open}
                onClose={() => setOpen(false)}
            />
        </>
    );
}
