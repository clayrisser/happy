/**
 * Which tool cards answer for themselves, and therefore get no permission
 * footer (DROVE-238).
 *
 * `PermissionFooter` draws Yes / Yes-don't-ask-again / No-and-provide-feedback
 * under any card carrying a pending permission. A few cards are not permissions
 * at all — they are questions wearing the permission transport, and each one
 * ships its OWN answer widget. Drawing both stacks two unrelated sets of
 * buttons in one card, and the wrong ones are the easier to hit.
 *
 * That is what Clay was looking at in DROVE-238. His login card had "Open the
 * sign-in page", a code field, "Cancel the login" and "Send code" — and then,
 * inside the same box, "Yes", "Yes, don't ask again for this tool" and "No, and
 * provide feedback". It is not two pending events. It is one event drawn twice.
 *
 * And the second set is worse than clutter: `Yes` calls `sessionAllow` with no
 * `updatedInput`, so the waiting `claude auth login` on the Mac is handed an
 * approval with no code in it — the exact failure DROVE-212 wrote up when the
 * card had only the generic buttons ("he pressed Allow and said it's not doing
 * anything"). `No, and provide feedback` denies it, which ends the login.
 *
 * `AskUserQuestion` was already exempt, hard-coded in ToolView with a comment
 * saying it has its own Submit button. It was never the only one: the drover
 * bridge mirrors THREE cards that own their answers, and two of them were
 * carrying a permission footer they had no use for.
 *
 * A list, not a heuristic. Owning your answer is a property of the view, and a
 * view is written on purpose — there is nothing to infer from the arguments.
 */
const ownsItsAnswer = new Set([
    /** Its own Submit button, per question. */
    'AskUserQuestion',
    /** A link out and a code field, with Cancel and Send code (DROVE-61). */
    'DroverAccountLogin',
    /** Done and Drop it, because any generic approve used to close it (DROVE-69). */
    'DroverTodo',
]);

export function toolOwnsItsAnswer(toolName: string | null | undefined): boolean {
    return !!toolName && ownsItsAnswer.has(toolName);
}
