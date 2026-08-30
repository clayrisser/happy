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
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var latestTranscript = ""
    private var pendingStop: Promise?

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
            if self.recognitionTask != nil {
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
            self.deactivateSession()
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
            if self.recognitionTask != nil {
                promise.reject("DroverSpeech", "dictation is already running")
                return
            }
            self.synthesizer.stopSpeaking(at: .immediate)

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
            self.audioEngine?.inputNode.removeTap(onBus: 0)

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

    private func activateRecording() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true, options: [])
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance()
            .setActive(false, options: [.notifyOthersOnDeactivation])
    }

    //
    // Dictation
    //

    private func beginDictation(localeTag: String?, promise: Promise) {
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

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        do {
            try activateRecording()
        } catch {
            promise.reject("DroverSpeech", error.localizedDescription)
            return
        }

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

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

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

    private func teardownDictation() {
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        if let engine = audioEngine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
        audioEngine = nil
        deactivateSession()
    }
}
