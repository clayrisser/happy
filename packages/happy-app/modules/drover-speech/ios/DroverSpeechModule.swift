import AVFoundation
import ExpoModulesCore
import MediaPlayer
import Speech
import UIKit

/// On-device speech for Cattle Drover (DROVE-30).
///
/// Two halves, one module because they share the one thing that has to be
/// arbitrated: the app's AVAudioSession category. Reading aloud wants
/// `.playback`, dictation wants `.record`, and a phone cannot hold both.
///
/// Speech OUT is AVSpeechSynthesizer, not a cloud voice. It costs nothing per
/// character, adds no network latency to a sentence that has to start
/// immediately, needs no key, and the reply never leaves the phone. If the OS
/// voice turns out too robotic the same speak/stop pair fronts a cloud voice
/// later; nothing above this file would change.
///
/// Which voice speaks is not left to the OS (DROVE-97): unasked, iOS uses the
/// compact voice for the locale, the robotic one. `speak` takes a voice
/// identifier from JS, which picks over `listVoices()`, and when none is
/// given or the one given is not installed it falls back to the best quality
/// installed for the language: premium, then enhanced, then compact.
///
/// Speech IN is SFSpeechRecognizer with `requiresOnDeviceRecognition = true`.
/// When a locale has no on-device model this FAILS, loudly, rather than
/// quietly shipping the microphone to Apple's servers — the alternative is a
/// silent fallback that sends audio off the device without anyone deciding to.

/// The recognition request the audio tap appends to (DROVE-140).
///
/// A pause makes Apple finalise the current task, and the next words belong to
/// a NEW request, so the tap cannot capture one request for the life of the
/// engine the way it used to. The tap runs on the audio thread and the swap
/// happens on the main one, so the reference is held behind a lock rather than
/// raced on. The critical section is one load, which is short enough that a
/// lock on the audio thread is the lesser evil against a torn read.
/// What read-aloud is doing, as JS reports it (DROVE-233).
///
/// Three playback states of one session, not three reasons to publish a card.
/// `off` is also what a binary looks like before JS has said anything, which
/// is why every fallback below reads it as "the DROVE-189 behaviour".
enum ReadingState: String {
    /// Read-aloud is disabled. No card, no commands.
    case off
    /// On: speaking, or resting between sentences with more to come.
    case reading
    /// On and holding its place. Silent, and the card says so with rate 0.
    case paused
}

final class RequestBox {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ next: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        request = next
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let target = request
        lock.unlock()
        target?.append(buffer)
    }
}

/// AVSpeechSynthesizerDelegate needs NSObjectProtocol, which Expo's `Module`
/// is not, so the delegate is its own object and the module owns it — the same
/// split DroverWatchModule already makes for WCSessionDelegate.
final class DroverSpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    /// Called once per utterance with `true` when it was spoken to the end and
    /// `false` when it was cut. JS treats both as "this one is over".
    var onUtteranceEnded: ((Bool) -> Void)?

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        let ended = onUtteranceEnded
        onUtteranceEnded = nil
        ended?(true)
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        let ended = onUtteranceEnded
        onUtteranceEnded = nil
        ended?(false)
    }
}

/// What JS passes with each utterance. Defaults match the JS side so an old
/// bundle that sends fewer fields still speaks.
struct SpeakOptions: Record {
    /// AVSpeechUtterance.rate, 0 to 1. 0.5 is AVSpeechUtteranceDefaultSpeechRate.
    @Field var rate: Double = 0.52
    /// AVSpeechUtterance.pitchMultiplier, 0.5 to 2.0.
    @Field var pitch: Double = 1.0
    /// An identifier from `listVoices()`; nil or unknown falls back by quality.
    @Field var voiceId: String? = nil
    /// BCP 47 tag the text is in; nil means the synthesiser's current language.
    @Field var language: String? = nil
}

public final class DroverSpeechModule: Module {
    /// How the watch bridge hands this module a chunk of wrist audio
    /// (DROVE-130). `userInfo` carries `capture: String`, `seq: Int` and
    /// `pcm: Data` (16 kHz mono Int16).
    ///
    /// THE NAME IS THE CONTRACT and it is written down in exactly two places:
    /// here and in `DroverWatchModule.swift`, which posts it. They are
    /// separate pods, so a shared constant would mean a dependency between
    /// them; a mistyped string would mean a microphone that records and is
    /// never transcribed, so it is spelled out at both ends on purpose.
    static let wristAudioNotification = Notification.Name("DroverWristAudio")

    private let synthesizer = AVSpeechSynthesizer()
    private let speechDelegate = DroverSpeechDelegate()

    private var audioEngine: AVAudioEngine?
    /// True between `installTap` and `removeTap` on the input bus. AVFAudio
    /// raises an NSException on a second tap for the same bus, and Swift
    /// cannot catch one, so the tap is tracked rather than assumed.
    private var inputTapInstalled = false
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    /// The request the audio tap is feeding, behind a lock: the tap runs on the
    /// audio thread while a restart swaps the request on the main one
    /// (DROVE-140).
    private let tapTarget = RequestBox()
    /// The recogniser this dictation was opened with, kept so a task that
    /// finalises after a pause can be replaced with another one (DROVE-140).
    private var dictationRecognizer: SFSpeechRecognizer?
    /// Bumped for every recognition task. JS keys accumulation on it: the same
    /// id REVISES what it already said, a new id APPENDS to it (DROVE-140).
    private var recognitionTaskId = 0
    /// What tasks that already ENDED inside this dictation heard. Apple
    /// finalises on its own after a pause and the next task reports from
    /// empty, so its words are banked here rather than written over.
    private var bankedTranscript = ""
    /// What the CURRENT UTTERANCE has heard, revised in place while it runs.
    /// An utterance is not a task: one on-device task reports many of them,
    /// each from empty, which is DROVE-263.
    private var taskTranscript = ""
    /// Where the live utterance starts in this capture's audio, on Apple's own
    /// segment clock. A revision re-reports its utterance from the SAME
    /// offset; a new one starts later. -1 before the first result names it.
    private var liveUtteranceStart: TimeInterval = -1
    /// Whether this capture has ever seen a non-zero segment timestamp. The
    /// on-device recogniser reports a dead clock on some builds, and the
    /// boundary then has only the words to go on (DROVE-263).
    private var segmentClockSeen = false
    /// Tasks replaced in a row without hearing a word. A recogniser that
    /// finalises instantly over silence would otherwise be restarted forever.
    private var emptyRestarts = 0
    private var pendingStop: Promise?
    /// Whether THIS capture took the audio session over (DROVE-130).
    ///
    /// A capture from the WRIST never does: the watch holds its own
    /// microphone and the phone only recognises, so there is nothing here to
    /// claim and nothing to hand back. Releasing a session it never took would
    /// deactivate one that read-aloud is using, which is a phone that goes
    /// silent because a watch stopped listening.
    private var sessionClaimedForDictation = false
    /// The wrist capture this recogniser is transcribing, or nil when the
    /// audio is coming from the phone's own microphone (DROVE-130).
    private var wristCapture: String?
    /// The wrist-audio observer, held so teardown can remove it.
    private var wristAudioObserver: NSObjectProtocol?
    /// The next chunk number expected from the wrist, and the ones that
    /// arrived early. `sendMessage` gives no ordering promise, and audio fed
    /// out of order is not merely late — it is transcribed as different words.
    private var wristExpectedSeq = 0
    private var wristHeld: [Int: Data] = [:]
    /// When the last `onDictationLevel` went out. The tap fires around ninety
    /// times a second; JS wants at most twenty (DROVE-74).
    private var lastLevelSentAt: TimeInterval = 0

    /// The AVAudioSession route-change observer, held so it can be removed
    /// (DROVE-119). Registered for the whole life of the module, not only
    /// while speech is running: JS keeps the last route it saw, and a change
    /// that lands between two replies still has to be remembered.
    private var routeObserver: NSObjectProtocol?

    /// The AVAudioSession interruption observer (DROVE-189).
    ///
    /// Until this ticket there was NONE, which is why read-aloud died on a
    /// phone call and never came back: iOS deactivates the session under the
    /// synthesiser, the utterance cancels, and nothing ever reactivates. From
    /// the outside that is indistinguishable from "it stopped when I locked
    /// the screen", which is how the two halves of this bug hid each other.
    /// It is also the same family as DROVE-146's wedge: a session change under
    /// a running utterance, arriving from the OS instead of from us.
    private var interruptionObserver: NSObjectProtocol?
    /// Set when an interruption paused a live utterance, so `.ended` resumes it.
    private var speechPausedByInterruption = false

    /// JS is holding the session open (DROVE-189).
    ///
    /// `stop()` normally deactivates so ducked music comes back up. That is
    /// right in the foreground and fatal in the BACKGROUND: an app with the
    /// audio background mode stays alive only while its session is active, so
    /// releasing it on a drained queue let iOS suspend the process, and the
    /// next reply arrived at an app that was not running. While this is set,
    /// `stop` cuts the voice and keeps the session.
    private var sessionHeld = false
    /// The near-silent loop that plays while the session is HELD (DROVE-259).
    /// `UIBackgroundModes: ["audio"]` keeps a backgrounded app alive only
    /// while it is ACTUALLY PRODUCING AUDIO, so an active session that says
    /// nothing between two replies is a suspended app a minute later. Non-nil
    /// only while the hold is on.
    private var keepalive: AVAudioPlayer?
    /// Remote commands are registered once, lazily, on the first utterance.
    private var remoteCommandsWired = false
    /// What JS says read-aloud is doing (DROVE-233). See `setReadingState`.
    private var readingState: ReadingState = .off
    /// The sentence the card is titled with, kept across a republish.
    private var lastNowPlayingTitle: String?

    /// The session as it was before dictation took it over, put back when
    /// dictation lets go. Nil while nobody is dictating.
    private var sessionBeforeDictation: (
        category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    )?
    /// Set when `beginDictation` paused an utterance mid-word so the
    /// microphone could have the session; the utterance resumes on release.
    private var speechPausedForDictation = false

    /// Dictation holds the engine from `beginDictation` until teardown, and the
    /// task from slightly later; either one means the microphone is spoken for.
    private var isDictating: Bool {
        audioEngine != nil || recognitionTask != nil
    }

    /// Everything heard since the microphone opened, across every recognition
    /// task inside it (DROVE-140). This is the contract JS relies on: the
    /// final transcript covers the WHOLE capture, not merely the last task, so
    /// a stop after a pause never resolves with less than what was shown.
    private var latestTranscript: String {
        Self.joinedTranscript(bankedTranscript, taskTranscript)
    }

    private func resetTranscript() {
        bankedTranscript = ""
        taskTranscript = ""
        emptyRestarts = 0
        liveUtteranceStart = -1
        segmentClockSeen = false
    }

    /// Take one transcription from the live recognition task, keeping every
    /// word said before it (DROVE-263).
    ///
    /// WHAT 070819ab MISSED, because a second fix that misses the same way is
    /// the real risk here. That commit treated an utterance boundary as a TASK
    /// boundary: Apple finalises after a pause, the module starts another task
    /// on the same engine, and `continueAfterFinal` banks across the swap.
    /// That is what the SERVER recogniser does. This request sets
    /// `requiresOnDeviceRecognition = true`, and the on-device recogniser does
    /// not finalise on a pause at all — it keeps ONE task running and opens a
    /// NEW RESULT SEQUENCE, reporting the next utterance from empty. No final
    /// arrives, so `continueAfterFinal` never runs, `bankedTranscript` stays
    /// empty, and the bare `taskTranscript = result...formattedString` that
    /// used to live at the call site wrote the second utterance straight over
    /// the first. The task-id machinery is real and still needed for the
    /// server path; it simply never fires on the path he is actually using,
    /// which is exactly why the fix looked good and shipped broken.
    ///
    /// So the boundary is found HERE, between two results of ONE task, and the
    /// invariant is the one Clay stated: no incoming partial may shorten what
    /// he has already said.
    private func absorb(_ transcription: SFTranscription) {
        let text = transcription.formattedString
        let incoming = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty result never takes words back. A new sequence opens with
        // one, and writing it over the live utterance is the whole bug.
        guard !incoming.isEmpty else { return }
        let start = transcription.segments.first?.timestamp ?? 0
        if start > 0 { segmentClockSeen = true }
        if startsNewUtterance(incoming, at: start) {
            bankedTranscript = latestTranscript
            taskTranscript = ""
        }
        liveUtteranceStart = start
        taskTranscript = text
    }

    /// Whether this result opens a LATER utterance rather than revising the
    /// live one (DROVE-263).
    private func startsNewUtterance(_ incoming: String, at start: TimeInterval) -> Bool {
        let live = taskTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        // Nothing said yet in this utterance, so there is nothing to protect.
        guard !live.isEmpty else { return false }
        // Apple's clock decides it whenever Apple winds one. A revision
        // re-reports the same utterance from the same offset, so only a
        // STRICTLY later start is a new utterance; ties and rewinds are
        // revisions. This is the path that carries a real device.
        if segmentClockSeen, liveUtteranceStart >= 0 {
            return start > liveUtteranceStart + 0.01
        }
        // No clock, so only the words are left. A revision restates the
        // utterance it revises and therefore shares its opening; the first
        // words of a new sentence against a finished one do not.
        if live.hasPrefix(incoming) || incoming.hasPrefix(live) { return false }
        // And only an utterance with real substance behind it is banked this
        // way. Early on, a revision legitimately replaces the little that is
        // there ("um hello" -> "hello") and must not become a sentence of its
        // own, so the guard is deliberately deaf until a sentence has been
        // said and the incoming result is a fraction of it.
        guard live.count >= 24 else { return false }
        return incoming.count * 2 <= live.count
    }

    /// Two stretches of speech with one space between them, and no space when
    /// either side is empty. The same join JS makes, so the two agree on what
    /// the transcript reads as.
    private static func joinedTranscript(_ base: String, _ next: String) -> String {
        let left = base.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = next.trimmingCharacters(in: .whitespacesAndNewlines)
        if left.isEmpty { return right }
        if right.isEmpty { return left }
        return left + " " + right
    }

    public func definition() -> ModuleDefinition {
        Name("DroverSpeech")

        Events("onDictationPartial", "onDictationEnded", "onDictationLevel", "onAudioRouteChange", "onSpeechInterruption", "onRemoteCommand")

        OnCreate {
            self.synthesizer.delegate = self.speechDelegate
            self.startWatchingAudioRoute()
            self.startWatchingInterruptions()
        }

        OnDestroy {
            self.synthesizer.stopSpeaking(at: .immediate)
            self.stopSilenceKeepalive()
            self.teardownDictation()
            self.stopWatchingAudioRoute()
            self.stopWatchingInterruptions()
            self.teardownRemoteCommands()
        }

        /// Speak one utterance and resolve when it is over — finished or cut.
        /// One at a time: the JS queue speaks sentence by sentence so that
        /// stopping lands mid-sentence instead of at the end of a paragraph.
        AsyncFunction("speak") { (text: String, options: SpeakOptions, promise: Promise) in
            if self.isDictating {
                promise.reject(
                    "DroverSpeech",
                    "cannot read aloud while dictation is running"
                )
                return
            }
            do {
                try self.activatePlayback()
            } catch {
                promise.reject("DroverSpeech", error.localizedDescription)
                return
            }

            // A previous utterance is cut rather than queued behind: the reader
            // above only ever asks for the next sentence once the last one
            // ended, so anything still speaking here is a leak.
            if self.synthesizer.isSpeaking {
                self.synthesizer.stopSpeaking(at: .immediate)
            }

            var settled = false
            self.speechDelegate.onUtteranceEnded = { finished in
                guard !settled else { return }
                settled = true
                promise.resolve(finished)
            }

            let utterance = AVSpeechUtterance(string: text)
            utterance.rate = Float(min(max(options.rate, 0.0), 1.0))
            utterance.pitchMultiplier = Float(min(max(options.pitch, 0.5), 2.0))
            utterance.voice = self.bestVoice(language: options.language, chosenId: options.voiceId)
            // With this on, iOS swaps in the Spoken Content voice and rate from
            // Accessibility and ignores the ones set here, which is how build
            // 10 ended up in the compact voice whatever was picked.
            utterance.prefersAssistiveTechnologySettings = false
            self.synthesizer.speak(utterance)
            // The card is titled with what is being said. It EXISTS because
            // read-aloud is on (`setReadingState`), not because this utterance
            // started, which is what DROVE-233 changed: an audio player whose
            // card comes and goes with each sentence has no play/pause to
            // press between them. On a binary JS has not called
            // `setReadingState` on, `readingState` is `.off` and the old
            // held-session rule stands unchanged (DROVE-189).
            if self.readingState != .off || self.sessionHeld {
                self.wireRemoteCommands()
                self.updateNowPlaying(title: String(text.prefix(60)))
            }
        }

        /// Read-aloud is on, paused, or off (DROVE-233).
        ///
        /// THE CARD'S LIFETIME, and it is the reason this function exists.
        /// Clay, on build 14, photographed a lock screen with nothing on it:
        /// no title, no transport, nothing between the clock and the torch. He
        /// had read-aloud on and the session idle. Before this, the now-playing
        /// entry was published from exactly two places — the start of an
        /// utterance, and `holdSession(true)` — so it existed only while a
        /// sentence was in flight or while JS had asked for a BACKGROUND hold.
        /// Read-aloud on with nothing to read produced no card, and with no
        /// card there is no play/pause button, so the pause state this ticket
        /// is about had nowhere to live on that surface.
        ///
        /// Speaking, paused and waiting for the next reply are three PLAYBACK
        /// STATES of one session, not three reasons to publish or withdraw a
        /// card. `MPNowPlayingInfoPropertyPlaybackRate` is the field that
        /// carries the difference; the card's existence carries only "read
        /// aloud is on".
        ///
        /// SEPARATE FROM `holdSession`, deliberately. Those two were welded
        /// and they cost different things:
        ///
        ///   `holdSession` keeps the AVAudioSession ACTIVE so iOS does not
        ///   suspend the app in the background (DROVE-189). It costs ducked
        ///   music for as long as it is held, which is why JS only asks for it
        ///   while backgrounded and drops it on the way to the foreground.
        ///
        ///   This one publishes a dictionary and registers command targets.
        ///   It activates NOTHING, so it ducks nothing and keeps nothing
        ///   alive, and it is therefore safe to leave on for as long as
        ///   read-aloud is on — foreground included.
        ///
        /// THE COST, named rather than shipped quietly: while read-aloud is on
        /// Drover holds the Now Playing card, so it is in the Control Centre
        /// and on the lock screen even in the foreground with nothing being
        /// said, and the next-track glyph that opens the microphone
        /// (DROVE-225) is on it the whole time. That is what an audio player
        /// looks like and it is what was asked for. Battery is not part of the
        /// cost: no session is activated here.
        ///
        /// The rate is taken from what JS says the READER is doing, never from
        /// `synthesizer.isSpeaking`, because the synthesiser is idle between
        /// two sentences of ordinary reading and a card that flickered to
        /// "paused" in every gap would be worse than no card.
        AsyncFunction("setReadingState") { (state: String) -> Void in
            let next = ReadingState(rawValue: state) ?? .off
            self.readingState = next
            if next == .off {
                // Read-aloud off is the outer release (DROVE-259): whatever JS
                // does with the hold, nothing keeps playing for a reader that
                // has been switched off.
                self.stopSilenceKeepalive()
                self.teardownRemoteCommands()
                return
            }
            self.wireRemoteCommands()
            self.updateNowPlaying(title: nil)
        }

        /// Put the shared session in read-aloud's category before a cue plays
        /// (DROVE-341). One line here; the whole of it is in
        /// DroverSpeechCueSession.swift. Optional on the JS side, so a build
        /// without it simply keeps today's behaviour.
        Function("ensureCueSession") { () -> Bool in
            self.ensureCueSessionCategory()
        }

        /// Name the card after the session that just took the voice
        /// (DROVE-300).
        ///
        /// THE CARD FOLLOWS THE SENTENCE, and that is the gap this closes. The
        /// title is set at the synthesiser — `String(text.prefix(60))` on every
        /// utterance — which is right while a session is talking and wrong the
        /// moment the voice MOVES. A double press pauses one session and hands
        /// the voice to another, and until the new one says its first sentence
        /// the lock screen and the CarPlay head unit still name the old one.
        /// The new session may be waiting on a reply, so "until" is not a
        /// flicker; it can be a minute of the dashboard naming a conversation
        /// he skipped away from.
        ///
        /// So JS says who has the voice now, and the next sentence overwrites
        /// it in the ordinary way. A session NAME rather than a sentence, on
        /// purpose: in the gap there is no sentence to show, and the one thing
        /// the surface has to answer is which conversation the press landed
        /// on.
        ///
        /// GUARDED BY THE CARD'S OWN LIFETIME, the same condition the
        /// synthesiser's title update carries. Publishing a title while
        /// read-aloud is off would CREATE a card for a reader that has been
        /// switched off, which is the one thing `setReadingState(.off)` exists
        /// to prevent.
        AsyncFunction("setNowPlayingTitle") { (title: String) -> Void in
            guard self.readingState != .off || self.sessionHeld else { return }
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            self.updateNowPlaying(title: String(trimmed.prefix(60)))
        }

        /// Whether this binary owns the card's lifetime (DROVE-233).
        ///
        /// Its own stamp, like `handlesInterruptions` and `handlesMicCommand`,
        /// because it ships in a different build from both. False means build
        /// 14 or earlier: the card still comes and goes with `holdSession`, so
        /// the lock screen has controls only while the app is backgrounded and
        /// read-aloud is on. JS keeps calling `holdSession` either way.
        Function("handlesReadingState") { () -> Bool in
            true
        }

        /// Every voice installed on the device, with the fields JS picks on.
        /// Quality is the string JS types against: "default", "enhanced" or
        /// "premium". A Personal Voice (iOS 17) is flagged so the picker can
        /// label it; it is listed only once the user has authorised it.
        AsyncFunction("listVoices") { () -> [[String: Any]] in
            AVSpeechSynthesisVoice.speechVoices().map { voice in
                var entry: [String: Any] = [
                    "identifier": voice.identifier,
                    "name": voice.name,
                    "language": voice.language,
                    "quality": DroverSpeechModule.qualityName(voice.quality),
                ]
                if #available(iOS 17.0, *), voice.voiceTraits.contains(.isPersonalVoice) {
                    entry["personal"] = true
                }
                return entry
            }
        }

        /// Cut whatever is speaking, mid-word, and hand the audio session back
        /// so ducked music comes up again. Idempotent — the reader calls it
        /// both on interruption and when the queue drains.
        AsyncFunction("stop") { () -> Void in
            self.synthesizer.stopSpeaking(at: .immediate)
            self.speechPausedByInterruption = false
            // A drained queue under a HELD session is the gap itself
            // (DROVE-259): the reader has stopped talking and is waiting for
            // the next reply, which is exactly when iOS reclaims a
            // backgrounded app that has gone quiet. Start the loop rather
            // than let the silence stand.
            if self.sessionHeld && !self.isDictating {
                self.startSilenceKeepalive()
            }
            // The session belongs to the microphone while dictation runs;
            // dropping it here would stop the engine under a live tap. And it
            // belongs to BACKGROUND READING while JS is holding it: releasing
            // a drained queue's session in the background lets iOS suspend the
            // app, and a suspended app never speaks the next reply (DROVE-189).
            if !self.isDictating && !self.sessionHeld {
                self.deactivateSession()
                // The card outlives the sentence while read-aloud is on
                // (DROVE-233): a drained queue is an audio player waiting for
                // the next track, and withdrawing its card is what left Clay's
                // lock screen empty. Only `setReadingState(.off)` takes it
                // away, and on a binary JS never calls that on this is exactly
                // the old behaviour.
                if self.readingState == .off {
                    self.clearNowPlaying()
                }
            }
        }

        /// Keep the audio session even when nothing is speaking (DROVE-189).
        ///
        /// JS sets this while read-aloud is on and the app is in the
        /// background, and clears it on the way back to the foreground or when
        /// read-aloud goes off, so ducked music comes up again exactly when it
        /// used to. Releasing it here rather than letting JS guess means the
        /// session is dropped the moment the hold ends, not on the next stop.
        AsyncFunction("holdSession") { (hold: Bool) -> Void in
            self.sessionHeld = hold
            if hold {
                try? self.activatePlayback()
                // An ACTIVE session is not a living process (DROVE-259). The
                // hold has to keep something PLAYING through the gap between
                // two replies, or iOS reclaims the app in the quiet.
                self.startSilenceKeepalive()
                self.wireRemoteCommands()
                self.updateNowPlaying(title: nil)
            } else {
                // Released the moment the hold ends, whatever else is going
                // on. A loop left running over a foregrounded app is a battery
                // draw nobody asked for, and this is the one place that knows
                // the hold is over.
                self.stopSilenceKeepalive()
                if !self.synthesizer.isSpeaking && !self.isDictating {
                    self.deactivateSession()
                    // Coming back to the foreground hands the SESSION back so
                    // ducked music comes up exactly when it used to. It no
                    // longer takes the card with it (DROVE-233): the card
                    // belongs to read-aloud being on, and `setReadingState` is
                    // the only thing that ends it. Still cleared here on a
                    // binary that has no reading state, which is the DROVE-189
                    // behaviour unchanged.
                    if self.readingState == .off {
                        self.clearNowPlaying()
                    }
                }
            }
        }

        /// Whether this binary handles interruptions and takes `holdSession`.
        /// The same build-stamp trick `watchesAudioRoute` uses (DROVE-119): a
        /// bundle running on build 12 or earlier gets false and keeps the old
        /// behaviour rather than assuming a protection it does not have.
        Function("handlesInterruptions") { () -> Bool in
            true
        }

        /// Whether this binary sends the DOUBLE PRESS up as `next`
        /// (DROVE-225).
        ///
        /// Its own stamp rather than a reuse of `handlesInterruptions`,
        /// because the two ship in different builds: build 13 has the
        /// interruption handling and explicitly DISABLES `nextTrackCommand`,
        /// so on that binary a double press reaches nothing at all and no
        /// amount of JS can hear it. A settings row reads this and says
        /// "needs a newer build" rather than offering a gesture the phone in
        /// his pocket cannot deliver.
        Function("handlesMicCommand") { () -> Bool in
            true
        }

        /// Whether this binary sends the TRIPLE PRESS up as `previous`
        /// (DROVE-300).
        ///
        /// Its own stamp, and it has to be, because the microphone MOVED
        /// gestures in this ticket. Build 15 answers `handlesMicCommand` true
        /// and still sets `previousTrackCommand.isEnabled = false`, so on that
        /// binary a triple press reaches nothing at all and no amount of JS
        /// can hear it. A bundle shipped over the air onto build 15 therefore
        /// gets the new double press — `nextTrackCommand` has been enabled
        /// since DROVE-225, so the next-session skip works with no new build —
        /// and no headphone microphone until this binary is installed. That is
        /// the honest degradation, and it is why the mic's subscription reads
        /// THIS stamp rather than the older one.
        Function("handlesTriplePress") { () -> Bool in
            true
        }

        Function("isSpeaking") { () -> Bool in
            self.synthesizer.isSpeaking
        }

        /// The output ports of the phone's current audio route, by the names
        /// AVAudioSession gives them ("Headphones", "BluetoothA2DPOutput",
        /// "Speaker", ...). JS decides which of those count as headphones and
        /// therefore whether this phone or the watch speaks (DROVE-92);
        /// nothing here does.
        Function("audioRoute") { () -> [String] in
            AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }
        }

        /// Whether this binary posts `onAudioRouteChange`. There is no way to
        /// ask a module which events it declares, so JS asks for the function
        /// that shipped in the same binary (DROVE-119). A build without it
        /// gets no event, and the JS guard says so rather than claiming a
        /// protection it does not have.
        Function("watchesAudioRoute") { () -> Bool in
            true
        }

        /// Whether this device can transcribe WITHOUT sending audio anywhere.
        /// JS asks before offering the talk button, so an unsupported locale
        /// says so up front instead of failing on the first press.
        AsyncFunction("dictationSupport") { (localeTag: String?, promise: Promise) in
            let locale = localeTag.map { Locale(identifier: $0) } ?? Locale.current
            guard let recognizer = SFSpeechRecognizer(locale: locale) else {
                promise.resolve([
                    "supported": false,
                    "reason": "no recognizer for \(locale.identifier)"
                ])
                return
            }
            promise.resolve([
                "supported": recognizer.supportsOnDeviceRecognition,
                "available": recognizer.isAvailable,
                "locale": locale.identifier,
                "reason": recognizer.supportsOnDeviceRecognition
                    ? ""
                    : "no on-device model for \(locale.identifier)"
            ])
        }

        /// Start listening. Resolves once the microphone is actually running,
        /// so the UI does not tell the user to talk before anything is being
        /// heard. Partial transcripts arrive as `onDictationPartial`.
        AsyncFunction("startDictation") { (localeTag: String?, promise: Promise) in
            if self.isDictating {
                promise.reject("DroverSpeech", "dictation is already running")
                return
            }

            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    guard status == .authorized else {
                        promise.reject(
                            "DroverSpeech",
                            "speech recognition is not authorised (\(status.rawValue))"
                        )
                        return
                    }
                    AVAudioSession.sharedInstance().requestRecordPermission { granted in
                        DispatchQueue.main.async {
                            guard granted else {
                                promise.reject("DroverSpeech", "microphone access was denied")
                                return
                            }
                            self.beginDictation(localeTag: localeTag, promise: promise)
                        }
                    }
                }
            }
        }

        /// Recognise audio captured on the WRIST (DROVE-130).
        ///
        /// `stopDictation` and `cancelDictation` end it, exactly as they end a
        /// capture from this phone's microphone: from here on it IS an
        /// ordinary capture, and the only difference is where the buffers come
        /// from. No microphone permission is asked for, because this phone
        /// does not record.
        AsyncFunction("startWristDictation") { (capture: String, localeTag: String?, promise: Promise) in
            if self.isDictating {
                promise.reject("DroverSpeech", "dictation is already running")
                return
            }
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    guard status == .authorized else {
                        promise.reject(
                            "DroverSpeech",
                            "speech recognition is not authorised (\(status.rawValue))"
                        )
                        return
                    }
                    self.beginWristDictation(capture: capture, localeTag: localeTag, promise: promise)
                }
            }
        }

        /// Stop listening and resolve with what was heard. The final result
        /// lands slightly after the audio ends, so this waits for it and falls
        /// back to the last partial after two seconds rather than hanging.
        AsyncFunction("stopDictation") { (promise: Promise) in
            guard self.recognitionTask != nil else {
                promise.resolve(self.latestTranscript)
                return
            }
            self.pendingStop = promise
            self.recognitionRequest?.endAudio()
            self.audioEngine?.stop()
            self.removeInputTap()

            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                self.settleStop(with: self.latestTranscript)
            }
        }

        /// Throw away the recording without transcribing — the user let go
        /// somewhere that is not the button, or left the session.
        AsyncFunction("cancelDictation") { () -> Void in
            self.teardownDictation()
            self.resetTranscript()
            self.pendingStop = nil
        }
    }

    //
    // Voice choice (DROVE-97)
    //

    private static func qualityName(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        if #available(iOS 16.0, *), quality == .premium { return "premium" }
        if quality == .enhanced { return "enhanced" }
        return "default"
    }

    private static func qualityRank(_ quality: AVSpeechSynthesisVoiceQuality) -> Int {
        if #available(iOS 16.0, *), quality == .premium { return 3 }
        if quality == .enhanced { return 2 }
        return 1
    }

    private static func normalizedTag(_ tag: String) -> String {
        tag.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: "-").lowercased()
    }

    private static func primarySubtag(_ tag: String) -> String {
        normalizedTag(tag).split(separator: "-").first.map(String.init) ?? ""
    }

    /// The audio route changing, forwarded to JS (DROVE-119).
    ///
    /// Polling `audioRoute()` on a timer leaves up to a poll's worth of a
    /// private reply playing out of the phone's speaker after an AirPod comes
    /// out, which is exactly the thing the feature exists to stop. The
    /// notification fires as the route moves, so JS can cut the utterance
    /// mid-word. Nothing is decided here: the port names go up and the JS
    /// side works out whether headphones just became the room.
    private func startWatchingAudioRoute() {
        guard routeObserver == nil else { return }
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: nil
        ) { [weak self] notification in
            guard let self else { return }
            let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
            let outputs = AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }
            // A route change stops the loop as surely as an interruption does
            // (DROVE-275). Headphones coming out is the ordinary case: iOS
            // pauses playback on `oldDeviceUnavailable` so nothing blasts out
            // of the speaker, and it does not care that this player is ninety
            // dB down. The hold outlives the route, so the loop has to come
            // back or the next gap is silent and the app is reclaimed in it.
            // This is a no-op unless the hold is on AND the player it has is
            // actually stopped, so the common route change costs one bool.
            if self.sessionHeld && !self.isDictating {
                self.startSilenceKeepalive()
            }
            // Same reason as the interruption handler: iOS pauses playback on
            // `oldDeviceUnavailable`, and a paused player is not the Now
            // Playing app for long (DROVE-275).
            self.republishNowPlayingIfActive()
            self.sendEvent("onAudioRouteChange", [
                "outputs": outputs,
                "reason": Self.routeChangeReasonName(raw)
            ])
        }
    }

    /// Pause on an interruption and resume after it (DROVE-189).
    ///
    /// `.began` means something else took the route — a call, a timer, Siri.
    /// The synthesiser is PAUSED rather than stopped, so the sentence resumes
    /// where it left off instead of the reader losing it; the utterance's
    /// promise never settles meanwhile, which is exactly right, because the
    /// reader must not pump the next sentence into a session it does not have.
    ///
    /// `.ended` with `.shouldResume` reactivates `.playback` and continues. On
    /// an `.ended` WITHOUT `.shouldResume` (the other app is still playing)
    /// the utterance is cut, which settles its promise and lets the reader
    /// move on rather than waiting forever on a voice that will never speak.
    /// Silence there was the old behaviour and it was permanent.
    private func startWatchingInterruptions() {
        guard interruptionObserver == nil else { return }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            guard let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            switch type {
            case .began:
                if self.synthesizer.isSpeaking && !self.synthesizer.isPaused {
                    self.synthesizer.pauseSpeaking(at: .word)
                    self.speechPausedByInterruption = true
                }
                // iOS has already stopped the loop; this drops the corpse so
                // `.ended` can build a live one (DROVE-275).
                self.stopSilenceKeepalive()
                self.sendEvent("onSpeechInterruption", ["state": "began"])
            case .ended:
                let optionsRaw = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let resume = AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume)
                let wasPaused = self.speechPausedByInterruption
                self.speechPausedByInterruption = false
                if wasPaused {
                    if resume, (try? self.activatePlayback()) != nil {
                        self.synthesizer.continueSpeaking()
                    } else {
                        // Settles the promise (didCancel), so the reader takes
                        // the next sentence instead of hanging on a dead one.
                        self.synthesizer.stopSpeaking(at: .immediate)
                    }
                } else if resume && self.sessionHeld {
                    try? self.activatePlayback()
                }
                // THE LOOP HAS TO COME BACK, and this is the half that decides
                // whether the app is still alive ten minutes later (DROVE-275).
                //
                // iOS stops every player it interrupts, so the keepalive is
                // dead here whether or not a sentence was in flight — and the
                // gap between two replies is the case where none was, which is
                // the one that put the phone in his pocket back to silence. A
                // call, an alarm, a timer, a Siri question: each one used to
                // leave a HELD session with nothing playing under it, which is
                // the exact condition DROVE-259 wrote the loop to prevent.
                //
                // The session is reactivated first, because an `.ended`
                // WITHOUT `.shouldResume` reactivated nothing at all and a
                // player needs somewhere to play. Read-aloud takes the session
                // back as PRIMARY audio now (DROVE-233, no `.duckOthers`); if
                // reactivation fails, `startSilenceKeepalive` builds a player
                // that cannot start and the reader is over until the next
                // `speak`, which is the honest answer rather than a pretended
                // one.
                if self.sessionHeld && !self.isDictating {
                    try? self.activatePlayback()
                    self.startSilenceKeepalive()
                }
                // The app came back; the card has to come back with it
                // (DROVE-275). Whatever interrupted us took Now Playing, and
                // nothing gives it back unasked.
                self.republishNowPlayingIfActive()
                self.sendEvent("onSpeechInterruption", [
                    "state": "ended",
                    "resumed": wasPaused && resume
                ])
            @unknown default:
                break
            }
        }
    }

    private func stopWatchingInterruptions() {
        guard let interruptionObserver else { return }
        NotificationCenter.default.removeObserver(interruptionObserver)
        self.interruptionObserver = nil
    }

    //
    // Lock screen
    //

    /// Play/pause and the microphone, from the lock screen and from an AirPod
    /// squeeze (DROVE-189, DROVE-225).
    ///
    /// iOS counts the presses; nothing here has any timing in it. A SINGLE
    /// press arrives as `togglePlayPauseCommand`, a DOUBLE as
    /// `nextTrackCommand`, a TRIPLE as `previousTrackCommand`. Press-and-hold
    /// arrives as nothing at all: MPRemoteCommandCenter has no held-button
    /// command in any SDK, and on every AirPods model with a stem the hold is
    /// claimed by Siri or the listening-mode switch before an app is
    /// consulted. That is why push-to-talk from the headphones is a double
    /// press and not a hold, and the argument is written out in full in
    /// sources/voice/headphonePress.ts.
    ///
    /// NEXT TRACK IS THE NEXT SESSION (DROVE-300), not a sentence skip and no
    /// longer the microphone. Clay chose it: "double press would be just like
    /// playing YouTube, it skips to the next track — in this case the next
    /// session." A skip that jumped a SENTENCE would be a second way to move
    /// the playhead and DROVE-146 settled that there is exactly one, a
    /// deliberate tap; a skip that moves the VOICE to another session is not
    /// that, and it is what a ⏭ means everywhere else.
    ///
    /// PREVIOUS TRACK IS THE MICROPHONE, and it is enabled from this build on.
    /// DROVE-225 left it disabled and reserved for DROVE-73's audio menus,
    /// which was right while nothing was behind it. Something is behind it
    /// now, and DROVE-73 is not harmed: the audio menu is a different OWNER in
    /// sources/voice/headphonePress.ts and keeps all three presses to itself
    /// while it is up.
    ///
    /// BOTH SKIP COMMANDS STILL STAY OFF, and enabling previousTrack is what
    /// makes that reasoning stronger rather than weaker. iOS falls a press
    /// through to skipForward when nextTrack is off, and to skipBackward when
    /// previousTrack is off. With BOTH track commands enabled and BOTH skip
    /// commands disabled, each press class has exactly one route to this
    /// module and cannot arrive twice under two names. Enabling previousTrack
    /// CLOSES the fallback the triple press would otherwise have had; it does
    /// not open a second one.
    ///
    /// THE COST, written down rather than discovered: enabling a command IS
    /// how it appears on the lock screen, so the card carries both arrows and
    /// there is no way to have either press without its button.
    /// MPRemoteCommandCenter has one switch per command and it drives both the
    /// hardware press and the on-screen button, and MPNowPlayingInfoCenter
    /// cannot relabel a glyph. DROVE-225 had to write the ⏭ off as a button
    /// "simply wearing the wrong icon"; after DROVE-300 the ⏭ is right — on
    /// the lock screen and in a CAR it skips to the next session — and the ⏮
    /// is the one wearing the wrong icon, because it opens the microphone.
    /// That is the price of having the mic on the headphones at all. Neither
    /// is a sentence skip, which DROVE-146 settled has exactly one route.
    ///
    /// Nothing here decides anything. The command goes up as an event and JS
    /// decides what it means, so the queue, the buttons and the microphone
    /// cannot disagree about what a press did.
    ///
    /// WHEN THIS RUNS CHANGED IN DROVE-233. It used to run only while the
    /// audio session was HELD, which is read-aloud on AND the app backgrounded,
    /// so a locked phone with an idle session had no card and therefore no
    /// buttons — the empty lock screen Clay photographed on build 14. It now
    /// runs whenever read-aloud is ON, and `setReadingState` says when that is.
    private func wireRemoteCommands() {
        guard !remoteCommandsWired else { return }
        remoteCommandsWired = true
        beginReceivingRemoteControlEvents()
        let centre = MPRemoteCommandCenter.shared()
        // Both skip commands stay off. A press falls through to skipForward
        // when nextTrack is disabled and to skipBackward when previousTrack
        // is, so leaving either enabled beside its enabled track command is a
        // second route for the same press to arrive by, under a different
        // name. With both track commands on and both skips off, each press
        // class has exactly one route.
        centre.skipForwardCommand.isEnabled = false
        centre.skipBackwardCommand.isEnabled = false
        centre.playCommand.isEnabled = true
        centre.pauseCommand.isEnabled = true
        centre.togglePlayPauseCommand.isEnabled = true
        centre.nextTrackCommand.isEnabled = true
        centre.previousTrackCommand.isEnabled = true
        centre.playCommand.addTarget { [weak self] _ in
            self?.sendEvent("onRemoteCommand", ["command": "play"])
            return .success
        }
        centre.pauseCommand.addTarget { [weak self] _ in
            self?.sendEvent("onRemoteCommand", ["command": "pause"])
            return .success
        }
        centre.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.sendEvent("onRemoteCommand", ["command": "toggle"])
            return .success
        }
        centre.nextTrackCommand.addTarget { [weak self] _ in
            self?.sendEvent("onRemoteCommand", ["command": "next"])
            return .success
        }
        centre.previousTrackCommand.addTarget { [weak self] _ in
            self?.sendEvent("onRemoteCommand", ["command": "previous"])
            return .success
        }
    }

    /// Apple's documented half of becoming a Now Playing app.
    ///
    /// HONEST ABOUT WHAT THIS DID: it is not what fixed the missing card. Held
    /// against the shipped call sequence on iOS 26.2, adding it alone changed
    /// nothing measurable — the app was already `canBeNowPlayingApplication=YES`
    /// without it, with an active session and without one, and SpringBoard
    /// still resolved the player path to us. `playbackState` in
    /// `updateNowPlaying` is what moved. It is here because Apple's own
    /// "Becoming a Now Playable App" sample calls it at session start and its
    /// absence kept being the first suspect every time the card did not draw;
    /// one main-thread line ends that argument permanently.
    ///
    /// MAIN THREAD, because `AsyncFunction` runs off it. Every caller of
    /// `wireRemoteCommands` arrives on the module queue, and `UIApplication` is
    /// main-thread only.
    ///
    /// PAIRED, and the pairing is `wireRemoteCommands`/`teardownRemoteCommands`
    /// rather than the audio session, deliberately: the card's lifetime is
    /// read-aloud being ON (DROVE-233), not the session's, so ending the
    /// registration when the session deactivates would withdraw it in every
    /// gap between two sentences.
    private func beginReceivingRemoteControlEvents() {
        DispatchQueue.main.async {
            UIApplication.shared.beginReceivingRemoteControlEvents()
        }
    }

    private func endReceivingRemoteControlEvents() {
        DispatchQueue.main.async {
            UIApplication.shared.endReceivingRemoteControlEvents()
        }
    }

    private func teardownRemoteCommands() {
        guard remoteCommandsWired else { return }
        remoteCommandsWired = false
        endReceivingRemoteControlEvents()
        let centre = MPRemoteCommandCenter.shared()
        centre.playCommand.removeTarget(nil)
        centre.pauseCommand.removeTarget(nil)
        centre.togglePlayPauseCommand.removeTarget(nil)
        centre.nextTrackCommand.removeTarget(nil)
        centre.nextTrackCommand.isEnabled = false
        centre.previousTrackCommand.removeTarget(nil)
        centre.previousTrackCommand.isEnabled = false
        clearNowPlaying()
    }

    /// The lock screen needs SOMETHING to name, or the controls are dead even
    /// when the commands are wired. No duration and no elapsed time: speech is
    /// a stream of sentences, not a track, and a fake scrubber would be worse
    /// than none.
    /// `title` nil means "keep the one that is up". A pause has to republish
    /// the card to move the rate, and republishing it under the generic
    /// "Reading" would wipe the sentence he stopped on off the lock screen.
    private func updateNowPlaying(title: String?) {
        if let title { lastNowPlayingTitle = title }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: lastNowPlayingTitle ?? "Reading",
            MPMediaItemPropertyArtist: "Cattle Drover",
            MPNowPlayingInfoPropertyIsLiveStream: true,
            MPNowPlayingInfoPropertyPlaybackRate: nowPlayingRate
        ]
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        // THE CARD DID NOT DRAW WITHOUT THIS, and the rate alone never said so
        // (DROVE-275). `MPNowPlayingInfoPropertyPlaybackRate` is a field IN the
        // dictionary; `playbackState` is what iOS actually answers with when
        // SpringBoard asks "is this app playing". Publishing rate 1 and leaving
        // the state unset makes the system answer PAUSED for an app that is
        // speaking, and MediaRemoteUI — the process that renders the lock
        // screen and the island — never binds to the player at all.
        //
        // Measured on an iPhone 17 Pro simulator, iOS 26.2, same binary, one
        // flag apart, over the module's own call sequence:
        //
        //   shipped today          -> resolved Paused,  MediaRemoteUI:  0 lines
        //   + beginReceiving...    -> resolved Paused,  MediaRemoteUI:  0 lines
        //   + playbackState        -> resolved PLAYING, MediaRemoteUI: 34 lines
        //
        // So this is the line the card was missing, and the remote-control
        // registration below is NOT (it moved nothing; it is kept because
        // Apple's contract asks for it, not because it fixed this).
        //
        // Same source as the rate: the READER, never `synthesizer.isSpeaking`,
        // so waiting for the next reply stays PLAYING and only a real pause is
        // paused (DROVE-233).
        MPNowPlayingInfoCenter.default().playbackState = nowPlayingRate > 0 ? .playing : .paused
    }

    /// Say the card is still ours, after something took the route off us
    /// (DROVE-275).
    ///
    /// A call, an alarm, a Siri question or an AirPod coming out hands Now
    /// Playing to whatever interrupted, and iOS does not hand it back on its
    /// own. The keepalive was already restarted on both of those paths, so the
    /// APP survived the interruption while the CARD did not, and the gap after
    /// a phone call was the one that looked exactly like the app had died.
    ///
    /// `title: nil` keeps the sentence he stopped on rather than reverting to
    /// the generic "Reading", and the rate and state come off the reader, so
    /// this re-asserts the same card rather than inventing a new one.
    ///
    /// It publishes NOTHING when read-aloud is off and no hold is on, which is
    /// the same question `speak` asks: a card for a reader that has been
    /// switched off is worse than no card.
    private func republishNowPlayingIfActive() {
        guard readingState != .off || sessionHeld else { return }
        wireRemoteCommands()
        updateNowPlaying(title: nil)
    }

    /// What the lock screen's play/pause glyph reads as (DROVE-233).
    ///
    /// The READER's state, not the synthesiser's. `synthesizer.isSpeaking` is
    /// false in the gap between two sentences of perfectly ordinary reading,
    /// so driving the glyph from it made the card flicker to "paused" several
    /// times a paragraph. Reading and waiting-for-the-next-reply are both
    /// playing, at rate 1; only a pause is 0. A binary JS has not called
    /// `setReadingState` on falls back to the old question, which is the
    /// DROVE-189 behaviour it already had.
    private var nowPlayingRate: Double {
        switch readingState {
        case .reading: return 1.0
        case .paused: return 0.0
        case .off: return synthesizer.isSpeaking && !synthesizer.isPaused ? 1.0 : 0.0
        }
    }

    private func clearNowPlaying() {
        lastNowPlayingTitle = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        // Withdrawing the dictionary without withdrawing the state leaves the
        // system holding "playing" for an app with nothing to play (DROVE-275).
        MPNowPlayingInfoCenter.default().playbackState = .stopped
    }

    private func stopWatchingAudioRoute() {
        guard let routeObserver else { return }
        NotificationCenter.default.removeObserver(routeObserver)
        self.routeObserver = nil
    }

    /// AVAudioSession's reason code as a name JS can log. `oldDeviceUnavailable`
    /// is the one that means "the headphones went away"; the guard does not
    /// depend on it (the port names are enough and are the same on every
    /// build), it is carried so a log line says what happened.
    private static func routeChangeReasonName(_ raw: UInt) -> String {
        switch AVAudioSession.RouteChangeReason(rawValue: raw) ?? .unknown {
        case .newDeviceAvailable: return "newDeviceAvailable"
        case .oldDeviceUnavailable: return "oldDeviceUnavailable"
        case .categoryChange: return "categoryChange"
        case .override: return "override"
        case .wakeFromSleep: return "wakeFromSleep"
        case .noSuitableRouteForCategory: return "noSuitableRouteForCategory"
        case .routeConfigurationChange: return "routeConfigurationChange"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }

    /// The same rule as pickVoice in sources/voice/voicePick.ts: the chosen
    /// voice when it is installed, else the best quality for the language,
    /// exact region first and the wider language when the region has none.
    /// Nil hands the choice back to the synthesiser, which is what happened
    /// for every utterance before DROVE-97.
    private func bestVoice(language: String?, chosenId: String?) -> AVSpeechSynthesisVoice? {
        if let chosenId, !chosenId.isEmpty, let chosen = AVSpeechSynthesisVoice(identifier: chosenId) {
            return chosen
        }
        let wanted = language ?? AVSpeechSynthesisVoice.currentLanguageCode()
        let all = AVSpeechSynthesisVoice.speechVoices()
        let exact = all.filter { Self.normalizedTag($0.language) == Self.normalizedTag(wanted) }
        let primary = Self.primarySubtag(wanted)
        let candidates = exact.isEmpty
            ? all.filter { Self.primarySubtag($0.language) == primary }
            : exact
        return candidates.max { a, b in
            let rank = Self.qualityRank(a.quality) - Self.qualityRank(b.quality)
            // max() wants "a < b"; on a tie the name decides so a pick is stable.
            return rank != 0 ? rank < 0 : a.name > b.name
        }
    }

    //
    // Audio session
    //

    /// `.playback` is what keeps speech alive with the screen locked, and
    /// `.spokenAudio` tells iOS this is speech, so it interacts with CarPlay and
    /// AirPods the way a podcast does rather than the way a game sound effect
    /// does.
    ///
    /// NO `.duckOthers` (DROVE-233). Ducking declares this app's audio SECONDARY,
    /// the way a navigation prompt dips music without taking it over, and iOS
    /// never promotes a ducking app to the Now Playing app however its
    /// `playbackState` reads — so the lock-screen / Dynamic Island card never
    /// drew even though build 18 reported the app <Playing>. Without the option
    /// read-aloud is PRIMARY audio: it interrupts other players rather than
    /// ducking them, which is how an audio player behaves and what Clay asked
    /// for ("an audio player I can pause and resume"), and it is the app iOS
    /// hands the card to.
    private func activatePlayback() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [])
        try session.setActive(true, options: [])
    }

    /// `.playAndRecord` rather than `.record`: the synthesiser may be paused
    /// mid-utterance on this same session and gets it back afterwards, and
    /// `.record` alone would also drop AirPods to the built-in microphone.
    private func activateRecording() throws {
        let session = AVAudioSession.sharedInstance()
        #if compiler(>=6.2)
        let bluetooth: AVAudioSession.CategoryOptions = .allowBluetoothHFP
        #else
        let bluetooth: AVAudioSession.CategoryOptions = .allowBluetooth
        #endif
        try session.setCategory(
            .playAndRecord,
            mode: .measurement,
            options: [.defaultToSpeaker, bluetooth, .duckOthers]
        )
        try session.setActive(true, options: [])
    }

    private func deactivateSession() {
        stopSilenceKeepalive()
        try? AVAudioSession.sharedInstance()
            .setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// Keep the process alive through the gaps by never going properly silent
    /// (DROVE-259).
    ///
    /// WHY HOLDING THE SESSION WAS NOT ENOUGH. `holdSession(true)` keeps the
    /// AVAudioSession ACTIVE, and DROVE-189 read that as keeping the app
    /// alive. It is not the same thing. The audio background mode is a licence
    /// to GO ON PLAYING, not a licence to exist, and iOS reclaims a
    /// backgrounded app that holds an active session and emits nothing.
    /// Read-aloud emits nothing between two sentences and nothing at all while
    /// it waits for the next reply, which is the gap he actually hits: it
    /// played in the bathroom and then stopped.
    ///
    /// THE COST, named rather than shipped quietly. This keeps the audio
    /// hardware awake for as long as it runs, and that is a real battery draw.
    /// So it runs in exactly one window and no wider: from `holdSession(true)`
    /// to `holdSession(false)`. JS asks for the hold only while read-aloud is
    /// ON and the app is BACKGROUNDED, and drops it on the way back to the
    /// foreground and when read-aloud is switched off, so an idle phone in his
    /// pocket is not holding audio. `deactivateSession` stops it too, so no
    /// path can leave it looping over a session that has gone.
    ///
    /// It is stopped for the whole of a dictation as well: the microphone runs
    /// the session in `.playAndRecord` at `.measurement`, and a loop playing
    /// into that is something for the recogniser to hear.
    private func startSilenceKeepalive() {
        // Never into a live recogniser. `stop` and `claimSessionForDictation`
        // each asked this at their own call site and `holdSession` did not, so
        // a hold taken mid-capture started the loop under the microphone. One
        // guard here answers it for every caller.
        guard sessionHeld, !isDictating else { return }
        // A player that is STILL PLAYING is the only reason to keep the one
        // that is there. `keepalive == nil` used to be the whole test, and a
        // non-nil player that iOS had already STOPPED — which is what every
        // interruption leaves behind — therefore blocked every restart for the
        // rest of the hold. Nothing could notice, because the field it checks
        // was exactly as non-nil as a healthy one (DROVE-275).
        if let existing = keepalive, existing.isPlaying { return }
        keepalive?.stop()
        keepalive = nil
        guard let player = try? AVAudioPlayer(data: Self.silentLoopData()) else { return }
        player.numberOfLoops = -1
        keepalive = player
        player.prepareToPlay()
        player.play()
    }

    private func stopSilenceKeepalive() {
        keepalive?.stop()
        keepalive = nil
    }

    /// One second of mono 16-bit PCM, built here rather than shipped as a
    /// bundle resource so the podspec needs no asset.
    ///
    /// The samples are ONE LSB rather than digital zero. A buffer of pure
    /// zeros is the thing an audio path is most likely to shortcut, and the
    /// whole point is to be playing; at 1/32768 of full scale it is ninety dB
    /// down and inaudible. The player's own volume is left at 1 for the same
    /// reason: what has to be quiet is the CONTENT, not the level iOS sees.
    private static func silentLoopData() -> Data {
        let sampleRate = 44_100
        let frames = sampleRate
        let bytesPerSample = 2
        let dataBytes = frames * bytesPerSample

        func le32(_ value: UInt32) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
        func le16(_ value: UInt16) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }

        var wav = Data()
        wav.append(Data("RIFF".utf8))
        wav.append(le32(UInt32(36 + dataBytes)))
        wav.append(Data("WAVE".utf8))
        wav.append(Data("fmt ".utf8))
        wav.append(le32(16))
        wav.append(le16(1))                                   // PCM
        wav.append(le16(1))                                   // mono
        wav.append(le32(UInt32(sampleRate)))
        wav.append(le32(UInt32(sampleRate * bytesPerSample)))  // byte rate
        wav.append(le16(UInt16(bytesPerSample)))               // block align
        wav.append(le16(16))                                   // bits per sample
        wav.append(Data("data".utf8))
        wav.append(le32(UInt32(dataBytes)))
        let samples = [Int16](repeating: 1, count: frames)
        samples.withUnsafeBufferPointer { wav.append(Data(buffer: $0)) }
        return wav
    }

    /// Take the shared session for the microphone. Speech out and speech in
    /// share one AVAudioSession, and with stream-talk on it is in `.playback`
    /// whenever the mic is pressed, so the synthesiser is paused first and
    /// what it had is remembered for `releaseSession`.
    private func claimSessionForDictation() throws {
        let session = AVAudioSession.sharedInstance()
        if synthesizer.isSpeaking && !synthesizer.isPaused {
            synthesizer.pauseSpeaking(at: .immediate)
            speechPausedForDictation = true
        }
        if sessionBeforeDictation == nil {
            sessionBeforeDictation = (session.category, session.mode, session.categoryOptions)
        }
        sessionClaimedForDictation = true
        // The loop is playback, and the microphone is about to take the
        // session to `.playAndRecord` at `.measurement`. Something for the
        // recogniser to hear is the last thing it needs (DROVE-259);
        // `releaseSession` starts it again if the hold is still on.
        stopSilenceKeepalive()
        try activateRecording()
    }

    /// Hand the session back to whoever had it before dictation took it over:
    /// a paused utterance gets its playback category and carries on, anything
    /// else gets the session released the way `stop` releases it.
    private func releaseSession() {
        let previous = sessionBeforeDictation
        sessionBeforeDictation = nil
        sessionClaimedForDictation = false
        let resume = speechPausedForDictation
        speechPausedForDictation = false

        if resume, let previous, synthesizer.isPaused {
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(previous.category, mode: previous.mode, options: previous.options)
                try session.setActive(true, options: [])
                synthesizer.continueSpeaking()
                // The utterance carries on, but it ends, and the hold outlives
                // it (DROVE-259). Starting here means the gap after it is
                // covered rather than waiting on the next `stop`.
                startSilenceKeepalive()
                return
            } catch {
                // Cutting it settles the utterance's promise (didCancel), so
                // the reader moves on rather than waiting on a paused voice.
                synthesizer.stopSpeaking(at: .immediate)
            }
        }
        // A HELD session belongs to background reading, not to the microphone
        // that just finished with it (DROVE-259). `stop` and `holdSession`
        // both check this and this did not, so a capture in the background
        // ended by deactivating the session out from under the hold: the flip
        // to `.playAndRecord` and back left NO active session at all, and a
        // backgrounded app with no session is one iOS suspends. Going back to
        // `.playback` is also what takes the microphone off a backgrounded app
        // rather than leaving it wedged in `.playAndRecord`.
        if sessionHeld {
            try? activatePlayback()
            startSilenceKeepalive()
            return
        }
        deactivateSession()
    }

    //
    // Dictation
    //

    private func beginDictation(localeTag: String?, promise: Promise) {
        // The permission callbacks in startDictation are asynchronous, so two
        // presses can both pass its guard and arrive here in turn. The second
        // must not build a second engine on the one input.
        if isDictating {
            promise.reject("DroverSpeech", "dictation is already running")
            return
        }
        let locale = localeTag.map { Locale(identifier: $0) } ?? Locale.current
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            promise.reject("DroverSpeech", "no speech recogniser for \(locale.identifier)")
            return
        }
        guard recognizer.isAvailable else {
            promise.reject("DroverSpeech", "speech recogniser is not available right now")
            return
        }
        // No silent fallback to the network recogniser. If this device cannot
        // transcribe locally the user gets told, not quietly uploaded.
        guard recognizer.supportsOnDeviceRecognition else {
            promise.reject(
                "DroverSpeech",
                "this device has no on-device model for \(locale.identifier), "
                    + "so dictation would have to upload your audio"
            )
            return
        }

        // The session comes FIRST, before anything reads the input node. Build
        // 9 read the format while the session was still in the synthesiser's
        // `.playback` category, got 0 Hz / 0 channels because that category has
        // no input route, and `installTap` raised an NSException on it, which
        // Swift cannot catch: SIGABRT on the main queue, twice in a row
        // (DROVE-96). Every guard below is a rejected promise instead.
        do {
            try claimSessionForDictation()
        } catch {
            releaseSession()
            promise.reject("DroverSpeech", error.localizedDescription)
            return
        }

        let session = AVAudioSession.sharedInstance()

        // The category is CHECKED here, not merely set above (DROVE-143).
        // Pausing the synthesiser does not stop the read-aloud queue from
        // starting the next sentence, and every `speak` puts the session back
        // into `.playback`, where the input node reports 0 Hz / 0 channels and
        // installing a tap on it aborts the app. That fight is a race, not a
        // permanent state, so one retry first and a refusal only if it will
        // not hold. JS keeps the reader silent for the whole capture, which is
        // the real fix; this is the belt under it.
        if session.category != .playAndRecord {
            try? activateRecording()
        }
        guard session.category == .playAndRecord else {
            releaseSession()
            promise.reject(
                "DroverSpeech",
                "something else is holding the audio session in "
                    + "\(session.category.rawValue); the microphone cannot open over it"
            )
            return
        }

        guard session.isInputAvailable else {
            releaseSession()
            promise.reject("DroverSpeech", "no microphone is available on the current audio route")
            return
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = inputNode.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            releaseSession()
            promise.reject(
                "DroverSpeech",
                "microphone input has no usable format ("
                    + "\(format.sampleRate) Hz, \(format.channelCount) ch, "
                    + "session category \(session.category.rawValue)); "
                    + "installing a tap on it would crash the app"
            )
            return
        }

        self.resetTranscript()
        self.audioEngine = engine
        self.dictationRecognizer = recognizer

        guard self.startRecognitionTask(recognizer) else {
            self.teardownDictation()
            promise.reject("DroverSpeech", "the speech recogniser refused to start a task")
            return
        }

        // A second tap on a bus is the other thing AVFAudio raises on. The
        // engine is fresh so there is none, but the removal is free and the
        // alternative is an abort.
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            // The CURRENT request, not the one that was live when the tap went
            // on: a pause starts a new recognition task and the audio has to
            // follow it there (DROVE-140).
            self.tapTarget.append(buffer)
            // The level behind the waveform (DROVE-74): RMS of the first
            // channel, at most twenty a second. The tap runs on the audio
            // thread, so the event hops to main.
            let now = Date().timeIntervalSinceReferenceDate
            guard now - self.lastLevelSentAt >= 0.05 else { return }
            self.lastLevelSentAt = now
            let frames = Int(buffer.frameLength)
            guard frames > 0, let channel = buffer.floatChannelData?[0] else { return }
            var sum: Float = 0
            for i in 0..<frames {
                let sample = channel[i]
                sum += sample * sample
            }
            let rms = Double((sum / Float(frames)).squareRoot())
            DispatchQueue.main.async {
                self.sendEvent("onDictationLevel", ["level": rms])
            }
        }
        inputTapInstalled = true

        engine.prepare()
        do {
            try engine.start()
        } catch {
            self.teardownDictation()
            promise.reject("DroverSpeech", error.localizedDescription)
            return
        }
        promise.resolve(true)
    }

    /// Recognise audio captured on the WRIST instead of by this phone's
    /// microphone (DROVE-130).
    ///
    /// Clay asked for one press on the watch to open the recorder and hold it
    /// open across pauses. watchOS cannot do the recognising — `Speech.framework`
    /// is absent from the watchOS SDK entirely — so the watch captures and
    /// this transcribes.
    ///
    /// WHAT THIS DELIBERATELY DOES NOT DO IS RECOGNISE DIFFERENTLY. It builds
    /// the same `SFSpeechAudioBufferRecognitionRequest` through the same
    /// `startRecognitionTask`, so the buffers land in the same `absorb()` and
    /// the same `startsNewUtterance()` that DROVE-263 fixed. A pause on the
    /// wrist is therefore the pause this module already handles: the on-device
    /// recogniser opens a new result sequence from empty, `absorb` banks what
    /// came before it, and nothing said before the pause is lost. Transcribing
    /// a recorded FILE instead would have meant a second recognition path with
    /// its own boundary rules — a second place for that bug to come back.
    ///
    /// NO AUDIO SESSION IS CLAIMED. Nothing here records; the microphone is on
    /// the other device. That is why this can run while the phone is reading
    /// a reply aloud without the two fighting over the session.
    private func beginWristDictation(capture: String, localeTag: String?, promise: Promise) {
        if isDictating {
            promise.reject("DroverSpeech", "dictation is already running")
            return
        }
        let locale = localeTag.map { Locale(identifier: $0) } ?? Locale.current
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            promise.reject("DroverSpeech", "no speech recogniser for \(locale.identifier)")
            return
        }
        guard recognizer.isAvailable else {
            promise.reject("DroverSpeech", "speech recogniser is not available right now")
            return
        }
        // The same refusal as the phone's own capture: no silent fallback to
        // the network recogniser. The watch's audio is no less private for
        // having crossed the wrist.
        guard recognizer.supportsOnDeviceRecognition else {
            promise.reject(
                "DroverSpeech",
                "this device has no on-device model for \(locale.identifier), "
                    + "so dictation would have to upload your audio"
            )
            return
        }

        resetTranscript()
        wristCapture = capture
        wristExpectedSeq = 0
        wristHeld = [:]
        dictationRecognizer = recognizer
        guard startRecognitionTask(recognizer) else {
            teardownDictation()
            promise.reject("DroverSpeech", "the speech recogniser refused to start a task")
            return
        }
        startTakingWristAudio()
        promise.resolve(true)
    }

    /// Listen for chunks the watch bridge posts (DROVE-130).
    ///
    /// A NotificationCenter post rather than a direct call because the watch
    /// bridge and this module are separate Expo modules in separate pods, and
    /// making one depend on the other to move a buffer is a build-system
    /// change for no gain. The audio never reaches JS: five messages a second
    /// of PCM across the bridge would be pure overhead, and JS has no use for
    /// samples. Only the CONTROL — which session, start, stop — goes through
    /// JS, where it can be changed without a native build.
    private func startTakingWristAudio() {
        stopTakingWristAudio()
        wristAudioObserver = NotificationCenter.default.addObserver(
            forName: Self.wristAudioNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self else { return }
            guard let capture = note.userInfo?["capture"] as? String,
                  let seq = note.userInfo?["seq"] as? Int,
                  let pcm = note.userInfo?["pcm"] as? Data else { return }
            self.takeWristAudio(capture: capture, seq: seq, pcm: pcm)
        }
    }

    private func stopTakingWristAudio() {
        if let wristAudioObserver { NotificationCenter.default.removeObserver(wristAudioObserver) }
        wristAudioObserver = nil
        wristCapture = nil
        wristHeld = [:]
        wristExpectedSeq = 0
    }

    /// One chunk from the wrist, put back in order before it is recognised.
    ///
    /// Out-of-order audio is not merely late: the recogniser hears the
    /// syllables in the wrong order and reports different words, which would
    /// look exactly like it mishearing him. So a chunk that arrives early
    /// waits, and one that arrives after its slot has passed is dropped rather
    /// than fed in the wrong place.
    private func takeWristAudio(capture: String, seq: Int, pcm: Data) {
        // A chunk from a capture that has ended, or from one this module is
        // not transcribing. Same structural guard as the recognition task id.
        guard capture == wristCapture else { return }
        guard seq >= wristExpectedSeq else { return }
        wristHeld[seq] = pcm
        // A gap that never fills would stall the capture forever, so after
        // about a second and a half of waiting the missing chunk is written
        // off and the queue moves on. A syllable lost beats a microphone that
        // has silently stopped transcribing.
        if wristHeld.count > 8, wristHeld[wristExpectedSeq] == nil, let earliest = wristHeld.keys.min() {
            wristExpectedSeq = earliest
        }
        while let next = wristHeld.removeValue(forKey: wristExpectedSeq) {
            wristExpectedSeq += 1
            if let buffer = Self.buffer(from: next) { tapTarget.append(buffer) }
        }
    }

    /// Rebuild one chunk as the buffer the recogniser takes.
    ///
    /// 16 kHz mono Int16, which is what `WristAudio` on the watch converts to.
    /// The two constants have to agree and a disagreement is SILENT — the
    /// recogniser returns nonsense rather than failing — which is why the
    /// watch asserts its own numbers in `watch/tests/SharedWireTests.swift`.
    private static func buffer(from pcm: Data) -> AVAudioPCMBuffer? {
        guard !pcm.isEmpty, pcm.count % 2 == 0 else { return nil }
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
        ) else { return nil }
        let frames = AVAudioFrameCount(pcm.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buffer.frameLength = frames
        guard let channel = buffer.int16ChannelData else { return nil }
        pcm.withUnsafeBytes { raw in
            guard let base = raw.bindMemory(to: Int16.self).baseAddress else { return }
            channel[0].update(from: base, count: Int(frames))
        }
        return buffer
    }

    /// Open one recognition task on the request the tap will feed, and report
    /// its id with every partial (DROVE-140).
    ///
    /// A task is not the capture. Apple ends one after a pause and the words
    /// that follow belong to the next, so the id is the only thing that tells
    /// JS whether a transcript REVISES the last one or CONTINUES it. Comparing
    /// the strings cannot: "yes" after "no" is a correction when the
    /// recogniser changed its mind and a new sentence when he said them a
    /// breath apart.
    @discardableResult
    private func startRecognitionTask(_ recognizer: SFSpeechRecognizer) -> Bool {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true

        recognitionTaskId += 1
        let taskId = recognitionTaskId
        taskTranscript = ""
        // A new task restarts Apple's segment clock, so the live utterance's
        // offset is meaningless across the swap (DROVE-263).
        liveUtteranceStart = -1
        segmentClockSeen = false
        recognitionRequest = request
        tapTarget.set(request)

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            // A callback after teardown (the cancel itself reports an error),
            // or from a task that has since been replaced, belongs to a task
            // that is already gone.
            guard self.recognitionTaskId == taskId, self.recognitionTask != nil else { return }
            if let result {
                // NOT a bare assignment (DROVE-263): one on-device task
                // reports each utterance from empty, so the words before the
                // pause are banked here rather than written over.
                self.absorb(result.bestTranscription)
                self.sendEvent("onDictationPartial", ["text": self.latestTranscript, "task": taskId])
            }
            let final = result?.isFinal ?? false
            guard final || error != nil else { return }
            if self.pendingStop != nil {
                self.settleStop(with: self.latestTranscript)
                return
            }
            // Apple finalised on its own after a pause, and nobody asked it
            // to. The microphone is still open and he is probably still
            // talking, so bank what this task heard and start ANOTHER one on
            // the same engine rather than ending the capture under him
            // (DROVE-140). Only a clean final is continued: an error is the
            // recogniser saying it cannot go on.
            if final, error == nil, self.continueAfterFinal() { return }
            // Nothing more is coming: it gave up, or the restart failed. Tell
            // JS, or a latched mic looks live over a dead task (DROVE-30).
            let transcript = self.latestTranscript
            let reason = final ? "final" : (error?.localizedDescription ?? "error")
            self.teardownDictation()
            self.resetTranscript()
            self.sendEvent("onDictationEnded", ["text": transcript, "reason": reason, "task": taskId])
        }
        return recognitionTask != nil
    }

    /// Replace a task that finalised with a fresh one on the same running
    /// engine, so a pause does not end the capture (DROVE-140). False when
    /// there is nothing left to continue on, and the caller then ends it.
    private func continueAfterFinal() -> Bool {
        guard let engine = audioEngine, engine.isRunning, inputTapInstalled else { return false }
        guard let recognizer = dictationRecognizer, recognizer.isAvailable else { return false }
        // A task that heard nothing and finalised anyway is the shape of a
        // restart loop, so a run of them ends the capture instead of spinning.
        // One that heard something resets the count: a long pause between two
        // sentences is the case this whole path exists for.
        if taskTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            emptyRestarts += 1
            if emptyRestarts > 3 { return false }
        } else {
            emptyRestarts = 0
        }
        bankedTranscript = latestTranscript
        taskTranscript = ""
        liveUtteranceStart = -1
        // Let go of the finished task before making the next one, so
        // `isDictating` never sees two and the old callback stops here.
        recognitionTask = nil
        recognitionRequest = nil
        tapTarget.set(nil)
        return startRecognitionTask(recognizer)
    }

    /// Resolve the outstanding `stopDictation` exactly once — the final result
    /// and the two-second timeout race, and whichever lands first wins.
    private func settleStop(with transcript: String) {
        guard let promise = pendingStop else { return }
        pendingStop = nil
        teardownDictation()
        promise.resolve(transcript)
    }

    private func removeInputTap() {
        guard inputTapInstalled, let engine = audioEngine else { return }
        engine.inputNode.removeTap(onBus: 0)
        inputTapInstalled = false
    }

    private func teardownDictation() {
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        tapTarget.set(nil)
        dictationRecognizer = nil
        if let engine = audioEngine {
            if engine.isRunning { engine.stop() }
            removeInputTap()
        }
        audioEngine = nil
        stopTakingWristAudio()
        // Only hand back a session this capture took. A wrist capture never
        // took one (DROVE-130).
        if sessionClaimedForDictation { releaseSession() }
    }
}
