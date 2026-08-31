import AVFoundation
import Foundation

/// Speaks reply sentences on the wrist's own audio route (DROVE-92).
///
/// The phone's read-aloud queue is the one that decides what is said and in
/// what order; this only voices the sentences it is handed, one utterance
/// each, and reports each one over when it ends so the phone can pace the
/// next. Apple's rule is followed rather than fought: audio plays on the
/// device the headphones are paired to, so headphones paired to this watch
/// hear the reply from here, through this watch's AVAudioSession, and the
/// phone stays silent. `headphonesConnected` is how the phone learns which
/// way round it is.
///
/// AVSpeechSynthesizerDelegate wants an NSObject and calls back off the main
/// actor, so the delegate is its own small object, the split WristBuzzer and
/// the phone's DroverSpeechModule already make.
final class WatchSpeakerDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onEnded: ((AVSpeechUtterance, Bool) -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onEnded?(utterance, true)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onEnded?(utterance, false)
    }
}

@MainActor
final class WatchSpeaker {
    /// Called once per sentence with the phone's id and whether it was spoken
    /// to the end (`true`) or cut (`false`).
    var onUtteranceEnded: ((String, Bool) -> Void)?
    /// Called when the audio route changes, with whether it now has headphones.
    var onRouteChanged: ((Bool) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    private let delegate = WatchSpeakerDelegate()
    /// The phone's id for each utterance in flight, keyed by the utterance.
    private var ids: [ObjectIdentifier: String] = [:]
    private var sessionActive = false
    private var routeObserver: NSObjectProtocol?

    /// Output ports that mean something is on the ears. The same list the
    /// phone reads (modules/drover-speech/index.ts, headphonePortTypes), so
    /// both devices agree on what "headphones" means.
    private static let headphonePorts: Set<AVAudioSession.Port> = [
        .headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
    ]

    init() {
        synthesizer.delegate = delegate
        delegate.onEnded = { [weak self] utterance, finished in
            Task { @MainActor in self?.ended(utterance, finished: finished) }
        }
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.onRouteChanged?(self.headphonesConnected)
            }
        }
    }

    /// Whether this wrist's current route has headphones on it.
    var headphonesConnected: Bool {
        Self.hasHeadphones(AVAudioSession.sharedInstance().currentRoute)
    }

    static func hasHeadphones(_ route: AVAudioSessionRouteDescription) -> Bool {
        route.outputs.contains { headphonePorts.contains($0.portType) }
    }

    var isSpeaking: Bool { synthesizer.isSpeaking }

    /// Queue one sentence. The synthesiser speaks utterances in the order
    /// they are given, which is the order the phone sends them.
    func speak(id: String, text: String) {
        activateSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.prefersAssistiveTechnologySettings = false
        ids[ObjectIdentifier(utterance)] = id
        synthesizer.speak(utterance)
    }

    /// Cut whatever is speaking, mid-word, and drop the queue. Every utterance
    /// in flight reports back as cut, so the phone's queue does not wait.
    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        // stopSpeaking cancels each queued utterance through the delegate,
        // but not necessarily before this returns; anything still mapped is
        // reported now, once, and the late delegate call finds nothing.
        let pending = ids
        ids = [:]
        for id in pending.values { onUtteranceEnded?(id, false) }
        deactivateSession()
    }

    private func ended(_ utterance: AVSpeechUtterance, finished: Bool) {
        guard let id = ids.removeValue(forKey: ObjectIdentifier(utterance)) else { return }
        onUtteranceEnded?(id, finished)
        if ids.isEmpty && !synthesizer.isSpeaking { deactivateSession() }
    }

    /// `.playback` with the default route policy: the wrist's own speaker
    /// when nothing is paired, the paired headphones when they are. The
    /// long-form policy would insist on Bluetooth and put up the route
    /// picker, which is right for a podcast and wrong for a sentence.
    private func activateSession() {
        guard !sessionActive else { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, policy: .default, options: [])
            try session.setActive(true, options: [])
            sessionActive = true
        } catch {
            // The synthesiser can still speak on the session as it stands;
            // a route it cannot take is heard as silence, and the phone's
            // deadline moves the queue on.
            droverLog.notice("speaker: audio session not activated: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func deactivateSession() {
        guard sessionActive else { return }
        sessionActive = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
