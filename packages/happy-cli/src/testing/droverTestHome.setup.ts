/**
 * vitest setupFile for every integration project: the real claude these
 * suites start writes its transcripts under the harness's own config dir,
 * never into the shared session store (DROVE-81). See droverTestHome.ts.
 */

import { applyDroverTestHome, isClaudeConfigDirLoggedIn } from './droverTestHome';

const home = applyDroverTestHome();

if (!isClaudeConfigDirLoggedIn(home.claudeConfigDir)) {
    console.log(
        `[drover-test-home] ${home.claudeConfigDir} has no Claude login; suites that need a real claude will skip.\n`
        + `  Log it in once: CLAUDE_CONFIG_DIR=${home.claudeConfigDir} claude auth login`,
    );
}
