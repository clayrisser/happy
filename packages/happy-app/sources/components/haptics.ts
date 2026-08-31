import * as Haptics from 'expo-haptics';

export function hapticsError() {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}

export function hapticsLight() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** The short tick of a picker moving one notch; the wrap toggle uses it (DROVE-95). */
export function hapticsSelection() {
    Haptics.selectionAsync();
}
