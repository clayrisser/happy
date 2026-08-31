import { describe, expect, it } from 'vitest';
import { en } from './_default';

/**
 * A settings row with a switch on its right has room for about 21 characters
 * of 17pt title on a 375pt phone before the ellipsis (DROVE-175: "Show Line
 * Numbers in T..." and two "Show Harness Icon in S..." rows that could not be
 * told apart). The subtitle carries the rest of the sentence.
 */
const switchRowTitleMaxChars = 21;

const switchRowTitles: Record<string, string> = {
    usageLimitShowRemaining: en.settingsAppearance.usageLimitShowRemaining,
    avatarMonochrome: en.settingsAppearance.avatarMonochrome,
    alwaysShowContextSize: en.settingsAppearance.alwaysShowContextSize,
    compactToolCalls: en.settingsAppearance.compactToolCalls,
    groupToolCalls: en.settingsFeatures.groupToolCalls,
    showLineNumbersInToolViews: en.settingsAppearance.showLineNumbersInToolViews,
    showHarnessIconInSessionHeader: en.settingsAppearance.showHarnessIconInSessionHeader,
    showHarnessIconsInSessionList: en.settingsAppearance.showHarnessIconsInSessionList,
    readReplies: en.agentInput.channels.readReplies,
    talkButton: en.agentInput.dictate.settingsTitle,
    phoneHaptics: en.agentInput.channels.phoneHaptics,
    audioCuesOn: en.settingsVoice.cues.on,
    heartbeat: en.settingsVoice.cues.heartbeat,
    speakTitles: en.settingsVoice.cues.speakTitles,
    toolTitles: en.settingsVoice.cues.toolTitles,
    bypassToken: en.settingsVoice.bypassToken,
};

describe('settings switch-row titles', () => {
    for (const [key, title] of Object.entries(switchRowTitles)) {
        it(`${key} fits a 375pt row: "${title}"`, () => {
            expect(title.length).toBeLessThanOrEqual(switchRowTitleMaxChars);
        });
    }

    it('the two harness rows can be told apart at a glance', () => {
        const header = en.settingsAppearance.showHarnessIconInSessionHeader;
        const list = en.settingsAppearance.showHarnessIconsInSessionList;
        expect(header.slice(0, 12)).not.toBe(list.slice(0, 12));
    });
});
