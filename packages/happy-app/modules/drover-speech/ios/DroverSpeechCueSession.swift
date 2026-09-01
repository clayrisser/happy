import AVFoundation
import ExpoModulesCore

/// The audio cues ride the voice's session, not the app's default one
/// (DROVE-341).
///
/// A separate file on purpose. DroverSpeechModule.swift is being edited by two
/// other lanes (DROVE-301's native-module state, DROVE-300's remote next-track),
/// and this needs exactly one line inside `definition()` and nothing else in
/// there.
///
/// WHAT IT FIXES. Cues are expo-audio players, and since DROVE-174 every one is
/// built with `keepAudioSessionActive: true` so the library never touches the
/// shared AVAudioSession. That was the right call and it left one hole: expo
/// does not SET the category either, so a cue plays under whatever category
/// happens to be current. Once the reader has spoken, that is `.playback` at
/// `.spokenAudio` and everything is well. Before it has, it is the app's
/// default `.soloAmbient` — which the Ring/Silent switch mutes outright and
/// which mixes differently from the voice. The microphone acknowledgements
/// (DROVE-225) are the cues that actually land there, because a press can come
/// long before read-aloud has said a word.
///
/// WHAT IT DELIBERATELY DOES NOT DO.
///
///   - It does not ACTIVATE. Activation is what ducks and interrupts other
///     audio, and expo-audio does it when a cue actually sounds. Setting a
///     category on an inactive session changes nothing anybody can hear until
///     then, which is why this is safe to call on every cue.
///   - It does not touch a session that is already right, and it does not touch
///     `.playAndRecord` at all. Dictation owns the session while it runs
///     (`claimSessionForDictation`), and stealing it back mid-capture is
///     DROVE-146's failure with a new author.
///   - It never throws. A cue that cannot be routed is a cue nobody hears,
///     which is what the volume slider at zero already means. It is never worth
///     taking the reader down for.
extension DroverSpeechModule {
    /// Put the shared session in the voice's category if it is not already in a
    /// category that can play. Answers whether it is now in one.
    func ensureCueSessionCategory() -> Bool {
        let session = AVAudioSession.sharedInstance()
        switch session.category {
        case .playback, .playAndRecord, .multiRoute:
            // Read-aloud's own category, dictation's, or something explicitly
            // routed. All three can already play a cue, and all three belong to
            // somebody else.
            return true
        default:
            do {
                try session.setCategory(.playback, mode: .spokenAudio, options: [])
                return true
            } catch {
                return false
            }
        }
    }
}
