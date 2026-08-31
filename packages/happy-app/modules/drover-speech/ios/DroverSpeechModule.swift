import AVFoundation
import ExpoModulesCore
import Speech

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
/// Speech IN is SFSpeechRecognizer with `requiresOnDeviceRecognition = true`.
/// When a locale has no on-device model this FAILS, loudly, rather than
/// quietly shipping the microphone to Apple's servers — the alternative is a
/// silent fallback that sends audio off the device without anyone deciding to.

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

public final class DroverSpeechModule: Module {
    private let synthesizer = AVSpeechSynthesizer()
    private let speechDelegate = DroverSpeechDelegate()

    private var audioEngine: AVAudioEngine?
    /// True between `installTap` and `removeTap` on the input bus. AVFAudio
    /// raises an NSException on a second tap for the same bus, and Swift
    /// cannot catch one, so the tap is tracked rather than assumed.
    private var inputTapInstalled = false
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var latestTranscript = ""
    private var pendingStop: Promise?

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

    public func definition() -> ModuleDefinition {
        Name("DroverSpeech")

        Events("onDictationPartial")

        OnCreate {
            self.synthesizer.delegate = self.speechDelegate
        }

        OnDestroy {
            self.synthesizer.stopSpeaking(at: .immediate)
            self.teardownDictation()
        }

        /// Speak one utterance and resolve when it is over — finished or cut.
        /// One at a time: the JS queue speaks sentence by sentence so that
        /// stopping lands mid-sentence instead of at the end of a paragraph.
        AsyncFunction("speak") { (text: String, rate: Double, promise: Promise) in
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
            utterance.rate = Float(rate)
            utterance.prefersAssistiveTechnologySettings = true
            self.synthesizer.speak(utterance)
        }

        /// Cut whatever is speaking, mid-word, and hand the audio session back
        /// so ducked music comes up again. Idempotent — the reader calls it
        /// both on interruption and when the queue drains.
        AsyncFunction("stop") { () -> Void in
            self.synthesizer.stopSpeaking(at: .immediate)
            // The session belongs to the microphone while dictation runs;
            // dropping it here would stop the engine under a live tap.
            if !self.isDictating {
                self.deactivateSession()
            }
        }

        Function("isSpeaking") { () -> Bool in
            self.synthesizer.isSpeaking
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
            self.latestTranscript = ""
            self.pendingStop = nil
        }
    }

    //
    // Audio session
    //

    /// `.playback` is what keeps speech alive with the screen locked, and
    /// `.duckOthers` makes music dip rather than stop. `.spokenAudio` tells iOS
    /// this is speech, so it interacts with CarPlay and AirPods the way a
    /// podcast does rather than the way a game sound effect does.
    private func activatePlayback() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
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
        try? AVAudioSession.sharedInstance()
            .setActive(false, options: [.notifyOthersOnDeactivation])
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
        try activateRecording()
    }

    /// Hand the session back to whoever had it before dictation took it over:
    /// a paused utterance gets its playback category and carries on, anything
    /// else gets the session released the way `stop` releases it.
    private func releaseSession() {
        let previous = sessionBeforeDictation
        sessionBeforeDictation = nil
        let resume = speechPausedForDictation
        speechPausedForDictation = false

        if resume, let previous, synthesizer.isPaused {
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(previous.category, mode: previous.mode, options: previous.options)
                try session.setActive(true, options: [])
                synthesizer.continueSpeaking()
                return
            } catch {
                // Cutting it settles the utterance's promise (didCancel), so
                // the reader moves on rather than waiting on a paused voice.
                synthesizer.stopSpeaking(at: .immediate)
            }
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

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true

        self.latestTranscript = ""
        self.recognitionRequest = request
        self.audioEngine = engine

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.latestTranscript = result.bestTranscription.formattedString
                self.sendEvent("onDictationPartial", ["text": self.latestTranscript])
                if result.isFinal {
                    self.settleStop(with: self.latestTranscript)
                }
            }
            if error != nil {
                self.settleStop(with: self.latestTranscript)
            }
        }

        // A second tap on a bus is the other thing AVFAudio raises on. The
        // engine is fresh so there is none, but the removal is free and the
        // alternative is an abort.
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
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
        if let engine = audioEngine {
            if engine.isRunning { engine.stop() }
            removeInputTap()
        }
        audioEngine = nil
        releaseSession()
    }
}
