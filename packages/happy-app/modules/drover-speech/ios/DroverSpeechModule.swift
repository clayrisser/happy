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
    /// What the CURRENT task has heard, revised in place while it runs.
    private var taskTranscript = ""
    /// Tasks replaced in a row without hearing a word. A recogniser that
    /// finalises instantly over silence would otherwise be restarted forever.
    private var emptyRestarts = 0
    private var pendingStop: Promise?
    /// When the last `onDictationLevel` went out. The tap fires around ninety
    /// times a second; JS wants at most twenty (DROVE-74).
    private var lastLevelSentAt: TimeInterval = 0

    /// The AVAudioSession route-change observer, held so it can be removed
    /// (DROVE-119). Registered for the whole life of the module, not only
    /// while speech is running: JS keeps the last route it saw, and a change
    /// that lands between two replies still has to be remembered.
    private var routeObserver: NSObjectProtocol?

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

        Events("onDictationPartial", "onDictationEnded", "onDictationLevel", "onAudioRouteChange")

        OnCreate {
            self.synthesizer.delegate = self.speechDelegate
            self.startWatchingAudioRoute()
        }

        OnDestroy {
            self.synthesizer.stopSpeaking(at: .immediate)
            self.teardownDictation()
            self.stopWatchingAudioRoute()
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
            // The session belongs to the microphone while dictation runs;
            // dropping it here would stop the engine under a live tap.
            if !self.isDictating {
                self.deactivateSession()
            }
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
            self.sendEvent("onAudioRouteChange", [
                "outputs": outputs,
                "reason": Self.routeChangeReasonName(raw)
            ])
        }
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
        recognitionRequest = request
        tapTarget.set(request)

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            // A callback after teardown (the cancel itself reports an error),
            // or from a task that has since been replaced, belongs to a task
            // that is already gone.
            guard self.recognitionTaskId == taskId, self.recognitionTask != nil else { return }
            if let result {
                self.taskTranscript = result.bestTranscription.formattedString
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
        releaseSession()
    }
}
