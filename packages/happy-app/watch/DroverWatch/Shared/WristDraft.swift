import Foundation

/// What the wrist has said to a session so far, before it is sent (DROVE-130).
///
/// WHY THIS EXISTS, AND WHY IT IS NOT A RECOGNISER.
///
/// Clay asked for the phone's latch on the wrist: "why can't a single press
/// [of] the microphone hold open the recorder". On the phone (DROVE-105,
/// DROVE-140) a tap opens the mic and it STAYS open, the words accumulate in
/// the composer across the recogniser finalising and restarting, and a second
/// tap stops it with everything still there.
///
/// watchOS cannot do the recogniser half of that, and this was checked against
/// the SDK rather than assumed. Speech.framework is not in the watchOS SDK AT
/// ALL — there is no `Speech.framework` under WatchOS.platform, and
/// `SFSpeechRecognizer` is declared `API_AVAILABLE(ios(10.0), macos(10.15),
/// tvos(18))` with no watchOS at any version. So there is no in-app speech
/// recognition on a watch: no continuous session to latch, and no partial
/// results to draw. `AVAudioEngine.inputNode` IS available (watchos(4.0)), so
/// raw capture is possible, but recognising it would mean shipping PCM to the
/// phone over WatchConnectivity and back — a different and much larger job
/// than this, and not one to start by accident.
///
/// What the wrist has is `TextFieldLink`, which opens watchOS's own input
/// sheet (dictation, Scribble or the keyboard) and hands back ONE phrase. That
/// sheet is where the one-shot feeling comes from: it takes a phrase, closes,
/// and the next one starts from empty.
///
/// So the latch moves up a level. The RECORDER cannot be held open; the
/// COMPOSER can. A tap opens the sheet and what comes back stays on the wrist
/// as a draft, unsent, with the mic still armed. Another tap opens the sheet
/// again and APPENDS. Send goes, Clear discards. That is DROVE-140's gesture
/// table as far as the hardware allows it:
///
///   phone                              wrist
///   tap latches, words wait            tap opens the sheet, the phrase waits
///   speak again after a pause, appends tap again, the next phrase appends
///   second tap stops, keeps the words  Send sends the draft
///   slide off cancels                  Clear discards the draft
///   press and hold sends on lift       no hold: watchOS offers no press
///                                      gesture on TextFieldLink, and there is
///                                      no recogniser to hold open
///
/// And the append rule is DROVE-140's, keyed the same way. That ticket's
/// second fault was that a new recognition task after a silence began from
/// empty and OVERWROTE what was already transcribed, and its fix was to decide
/// revise-versus-append on the TASK rather than by comparing strings. Here
/// every sheet return is its own task by construction — the sheet hands back
/// one finished phrase and then it is gone — so every return is a
/// continuation, and appending is the only correct move. There is no revision
/// case to tell apart, which is the one way the wrist has it easier.
///
/// Pure, and in Shared/, so the accumulation has a test that runs on the Mac
/// in a second (watch/scripts/test-shared.sh) rather than needing a wrist.
struct WristDraft: Equatable {
    /// The phrases in the order they were said, each already trimmed and never
    /// empty. Kept as a list rather than one string so the count can be shown
    /// and the last one dropped without re-parsing prose for its own joins.
    private(set) var phrases: [String] = []

    static let empty = WristDraft()

    var isEmpty: Bool { phrases.isEmpty }

    /// How many separate times the sheet has been opened for this draft. What
    /// the wrist shows instead of a live level meter, which it cannot have.
    var count: Int { phrases.count }

    /// The whole draft as one message, which is what gets sent.
    ///
    /// Joined with a single space. Not a newline: the phone sends this through
    /// the composer's own path and a newline mid-message reads as a deliberate
    /// break, when all it means here is that the sheet closed.
    var text: String { phrases.joined(separator: " ") }

    /// Add what the sheet handed back.
    ///
    /// A blank or whitespace-only return is DROPPED rather than appended: the
    /// sheet is dismissed with nothing in it far more often than it hands back
    /// a real empty phrase, and a draft that grows a run of spaces every time
    /// Clay changes his mind is a draft that cannot be read. Returns a new
    /// draft rather than mutating, so a view can hold the old one while the
    /// sheet is up.
    func appending(_ heard: String) -> WristDraft {
        let phrase = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !phrase.isEmpty else { return self }
        var next = self
        next.phrases.append(phrase)
        return next
    }

    /// Drop the last phrase. The wrist's undo: dictation misheard the last
    /// thing said, and re-saying it should not mean re-saying the paragraph.
    func droppingLast() -> WristDraft {
        guard !phrases.isEmpty else { return self }
        var next = self
        next.phrases.removeLast()
        return next
    }
}
