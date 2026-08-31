/**
 * What the in-session gate banner can offer for one gate (DROVE-19).
 *
 * Split out of the component for the reason every other decision here is: a
 * banner that renders the wrong control is a prompt you cannot answer, and
 * mounting a React tree to find that out is not a test anyone runs.
 */

import { hasAnswerableOptions, questionCards } from './tools/views/askUserQuestionAnswers';
import { accountLoginCard } from './tools/views/droverAccountLogin';

export type SessionGateAction =
    | 'todo'
    | 'account-login'
    | 'answer-question'
    | 'allow-deny'
    | 'read-only';

/**
 * A to-do offers its own buttons; a question offers its own options; a
 * permission offers Allow and Deny.
 *
 * A to-do is never given Allow/Deny (DROVE-89). The bridge takes a to-do
 * answer only when it names one of the card's options (Done / Drop it), so a
 * bare Allow travels the whole way and is refused: Clay pressed it eight times
 * on todo 19fddae5 and the card never left. The kind is read off the gate,
 * which droverGates derives from the tool (`DroverTodo`) or the bus event, and
 * the tool is checked too so a card that carries one without the other still
 * gets the right buttons.
 *
 * A question is never given Allow/Deny either. Denying one resolves it for
 * every other surface with no answer to hand back, and the bus refuses a bare
 * allow on a question for the same reason, so a question that arrived without
 * options is readable here and answered where it was raised.
 */
export function sessionGateAction(kind: string, args: unknown, tool?: string): SessionGateAction {
    if (kind === 'todo' || tool === 'DroverTodo') return 'todo';
    // An account login is never Allow / Deny, and this is measured, not
    // theoretical (DROVE-212). The mirrored card carries `{ url, header,
    // reason, cancelLabel }` and no `questions[]`, so it fell straight through
    // to 'allow-deny' and Clay got Deny and Allow under a body that was the
    // literal JSON of that object. He pressed Allow and nothing happened,
    // because a bare allow carries no code and the login on the Mac was
    // waiting for one.
    //
    // The TOOL NAME is what decides it, never the shape of the arguments.
    // `WebFetch` carries a `url` too, and a permission to fetch a page that
    // offered a sign-in link and a code field instead of Allow and Deny would
    // be the same bug pointing the other way. The card is still read, because
    // one without a usable https link has nothing to draw.
    if (tool === 'DroverAccountLogin' && accountLoginCard(args)) return 'account-login';
    if (kind !== 'question') return 'allow-deny';
    return hasAnswerableOptions(questionCards(args)) ? 'answer-question' : 'read-only';
}

/**
 * What a question with no options says.
 *
 * The gates SCREEN says "Open the session to answer this one", which is right
 * there and wrong here: you are already in the session. Saying it again is how
 * you send someone hunting for a screen they are standing on, which is the
 * whole complaint this banner answers.
 */
export const sessionGateReadOnlyHint = 'Answer this one in the terminal. It arrived without options.';
