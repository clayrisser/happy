/**
 * Which session-header control opens what (DROVE-205).
 *
 * Clay: "clicking the middle button that has the title of the session and the
 * name of the worktree below it should open up the list of the worktrees in a
 * sheet. If you want to go to the settings you use the right hand profile
 * icon, not the name of your session."
 *
 * The rule under it is that a control does what it looks like it does. The
 * pill draws the session name over its worktree, so the pill is about the
 * worktree. The avatar is the profile control, so the avatar carries settings.
 * Before this, both went to the session settings screen and the worktrees hid
 * behind the branch text inside the pill, which is a tap target nobody finds.
 *
 * Kept as data so the routing is a spec rather than a pair of inline
 * callbacks in a 700-line screen.
 */

/** The two controls that open something. The back chevron goes back. */
export type SessionHeaderControl = 'title' | 'avatar';

/** Both are sheets: anything expanding off the chrome slides up (DROVE-147). */
export type SessionHeaderSheet = 'worktrees' | 'settings';

export function sessionHeaderSheet(control: SessionHeaderControl): SessionHeaderSheet {
    return control === 'title' ? 'worktrees' : 'settings';
}

/**
 * The settings sheet is three rows, not a jump straight to one screen.
 *
 * Session settings has to land somewhere now that the pill has stopped
 * carrying it, and the avatar is the only header control left. Clay calls it
 * "the profile icon", so the account belongs on it too, and that screen
 * already exists: DROVE-165's Accounts, grouped by the machine each login
 * lives on. This LINKS to it. Nothing about accounts is drawn here.
 */
export type SessionSettingsRowKey = 'session' | 'app' | 'accounts';

export type SessionSettingsRow = {
    key: SessionSettingsRowKey;
    title: string;
    /** What the row is for, shown where the picker rows show their value. */
    value: string;
    icon: 'information-circle-outline' | 'settings-outline' | 'people-outline';
    route: string;
};

export function sessionSettingsRows(sessionId: string): SessionSettingsRow[] {
    return [
        {
            key: 'session',
            title: 'Session settings',
            value: 'This session',
            icon: 'information-circle-outline',
            route: `/session/${sessionId}/info`,
        },
        {
            key: 'app',
            title: 'App settings',
            value: 'Cattle Drover',
            icon: 'settings-outline',
            route: '/settings',
        },
        {
            key: 'accounts',
            title: 'Accounts',
            value: 'By machine',
            icon: 'people-outline',
            route: '/settings/accounts',
        },
    ];
}
