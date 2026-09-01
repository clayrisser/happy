import Foundation

/// What the wrist is hearing RIGHT NOW, while the recorder is held open
/// (DROVE-130).
///
/// WHY THE WRIST HAS NO RECOGNISER, AND WHY THAT IS NOT A DESIGN CHOICE.
///
/// Clay asked for one press to open the recorder and HOLD IT OPEN, so he can
/// talk, pause, think and keep talking. watchOS's own `TextFieldLink` sheet
/// cannot do that: it takes one utterance and closes. The obvious fix — run a
/// recogniser on the watch and latch it the way the phone latches — is not
/// available at any price. `Speech.framework` is not in the watchOS SDK AT
/// ALL: there is no `Speech.framework` under `WatchOS26.2.sdk`, and no
/// `SpeechAnalyzer`/`SpeechTranscriber` either, so the iOS 26 replacement is
/// missing with it. `SFSpeechRecognizer` is declared
/// `API_AVAILABLE(ios(10.0), macos(10.15), tvos(18))` — no watchOS at any
/// version. Checked against the SDK on disk, not remembered.
///
/// `AVAudioEngine.inputNode` IS available (`watchos(4.0)`). So the wrist can
/// CAPTURE; it cannot RECOGNISE. That settles the architecture rather than
/// leaving it to taste: the watch streams PCM to the phone, the phone's
/// existing recogniser transcribes it, and the words come back here to be
/// drawn.
///
/// AND THAT IS ALSO THE ANSWER THAT LEAVES ONE IMPLEMENTATION INSTEAD OF TWO.
/// DROVE-263 was the on-device recogniser opening a new RESULT SEQUENCE after
/// a pause and reporting the next utterance from empty, and code that assigned
/// the incoming result over the held text destroyed everything said before the
/// pause. That fix lives in `DroverSpeechModule.absorb()` /
/// `startsNewUtterance()`. Because the phone does the recognising here too,
/// the wrist INHERITS that fix rather than copying it — there is no second
/// recogniser to drift, and a pause on the wrist is the same pause the phone
/// already handles correctly. Recognising a recorded FILE on the phone
/// instead (`SFSpeechURLRecognitionRequest`) would have been a second
/// recognition path with its own boundary rules, which is the drift this
/// deliberately avoids.
///
/// WHAT THIS TYPE IS FOR. The bug has one more place to come back, one layer
/// up: the wrist DRAWS partials that arrive over WatchConnectivity, and
/// `sendMessage` does not promise ordering. A partial that arrives late, or
/// twice, or belongs to a capture that has already ended, must not be allowed
/// to shorten what is on screen. So the same invariant Clay stated is enforced
/// again HERE, on arrival, with the same two guards as `absorb()` and keyed
/// the same structural way:
///
///   - `absorb()` ignores a result whose text is empty, because an empty
///     result is how a new sequence opens and is not a report that nothing
///     was said. So does this.
///   - `absorb()` decides revise-versus-append on Apple's segment clock
///     rather than by comparing strings, because strings cannot tell a
///     correction from a new sentence. This decides accept-versus-drop on a
///     monotonic `seq` stamped by the phone, for the same reason: the wrist
///     cannot tell a legitimate revision ("um hello" -> "hello", which is
///     SHORTER and correct) from a stale duplicate by looking at the words.
///
/// A blanket "text may never shrink" would have been the wrong guard and is
/// worth naming, because it looks like the safe one: the phone's transcript
/// legitimately shrinks when the live utterance is revised, so that rule would
/// freeze a wrong word on screen forever. Ordering is the thing that is
/// actually broken by the wire, so ordering is what is defended.
///
/// Pure, and in `Shared/`, so it is checked on the Mac in a second by
/// `watch/scripts/test-shared.sh` rather than needing a wrist and a phone.
struct WristHearing: Equatable {
    /// Which capture these words belong to. The wrist stamps it when it opens
    /// the recorder and the phone echoes it on every partial, so a straggler
    /// from a capture that has since been stopped is dropped structurally
    /// rather than by guessing from its content.
    private(set) var captureId: String
    /// Everything the phone has heard since this recorder opened. The phone's
    /// `latestTranscript`, verbatim: banked utterances plus the live one, so
    /// a pause has already been absorbed before it reaches the wire.
    private(set) var text: String
    /// The highest partial number accepted so far. -1 before the first one.
    private(set) var seq: Int
    /// The phone has said this is the last word on this capture.
    private(set) var settled: Bool

    /// Nothing is being heard. What the wrist holds when the recorder is shut.
    static let idle = WristHearing(captureId: "", text: "", seq: -1, settled: false)

    var isEmpty: Bool { text.isEmpty }

    /// Whether this is a live capture rather than the idle placeholder.
    var isOpen: Bool { !captureId.isEmpty && !settled }

    /// Open the recorder. The wrist owns the id, because the wrist owns the
    /// press that started it.
    static func opening(_ captureId: String) -> WristHearing {
        WristHearing(captureId: captureId, text: "", seq: -1, settled: false)
    }

    /// Take one partial from the phone, keeping every word already drawn
    /// (DROVE-130, and DROVE-263 one layer up).
    ///
    /// Returns the hearing unchanged when the partial is not one this capture
    /// should draw, so a caller can compare and skip a redraw.
    func absorbing(captureId incoming: String, seq next: Int, text heard: String, final: Bool) -> WristHearing {
        // A partial for a capture that is not this one. The recorder was
        // stopped and re-opened, or this is a straggler from the last press.
        // Structural, like the phone's task id: no amount of reading the words
        // would tell us this.
        guard incoming == captureId, !captureId.isEmpty else { return self }
        // Already said, or said out of order. `sendMessage` gives no ordering
        // promise, and re-drawing an older transcript over a newer one is
        // exactly the shape of the bug being defended against.
        guard next > seq else { return self }
        let words = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        // AN EMPTY PARTIAL NEVER TAKES WORDS BACK. The same guard, in the same
        // words, as `absorb()`: an empty result is how the on-device
        // recogniser opens a new sequence after a pause, and it is not a
        // report that nothing was said.
        //
        // A FINAL is different, and this is the one case the phone's guard
        // does not have to think about. "Final and empty" is the capture
        // ending, and the capture has to end even if the last thing on the
        // wire says nothing — but it ends with the words still on screen, not
        // with a blank. Ending while still claiming to be live is how a
        // latched mic looks open over a dead task.
        if words.isEmpty {
            guard final else { return self }
            return WristHearing(captureId: captureId, text: text, seq: next, settled: true)
        }
        return WristHearing(captureId: captureId, text: words, seq: next, settled: final)
    }

    /// Shut the recorder, keeping the words. What a stop press leaves behind
    /// while the phone settles the last partial.
    func settling() -> WristHearing {
        WristHearing(captureId: captureId, text: text, seq: seq, settled: true)
    }
}

/// The shape of the audio the wrist ships to the phone (DROVE-130).
///
/// One format, named once, because the watch encodes it and the phone decodes
/// it and a disagreement about sample rate is silent: recognition simply comes
/// back as nonsense rather than failing.
///
/// 16 kHz mono 16-bit is what `SFSpeechAudioBufferRecognitionRequest` wants
/// anyway and is 32 KB/s, which is the reason for the choice: the wrist's
/// native input format is 48 kHz float, and shipping that raw would be
/// 384 KB/s over a link that was built for property lists.
enum WristAudio {
    /// Hz. What the phone rebuilds the buffer at.
    static let sampleRate: Double = 16_000
    /// One channel. A watch has one microphone.
    static let channels: UInt32 = 1
    /// How much audio rides in one message. A fifth of a second is small
    /// enough that a dropped chunk costs a syllable rather than a sentence,
    /// and large enough that the wire is not carrying five messages a second
    /// of framing overhead.
    static let chunkSeconds: Double = 0.2
    /// Samples per chunk, which is what the converter is asked for.
    static var chunkFrames: Int { Int(sampleRate * chunkSeconds) }

    /// A latched wrist mic stops itself after this long with nothing new
    /// heard. The phone's own latch timeout (`DICTATION_LATCH_IDLE_MS`), to
    /// the millisecond, because the two ergonomics are meant to be the same
    /// one: long enough for a pause to think, short enough that a watch that
    /// slipped down a sleeve is not recording the afternoon.
    static let idleStopSeconds: TimeInterval = 15
}
