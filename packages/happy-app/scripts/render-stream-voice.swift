// Render the STREAMED voice to a wav, so its loudness can be measured.
//
// DROVE-385. DROVE-341 pinned the cue table against `say(1)`, and `say(1)` is
// not the voice Clay hears. The reader speaks through drover-speech, which
// builds an `AVSpeechUtterance` with `streamTalk.rate` (0.52), the pitch from
// settings, and the voice `pickVoice` chose -- the best-quality voice INSTALLED
// for the language, so an enhanced or premium one wherever there is one, never
// the compact default `say` reaches for. Those are different sounds at
// different levels, and the table was calibrated against the wrong one.
//
// So this renders through `AVSpeechSynthesizer.write`, which is the same
// synthesiser `DroverSpeechModule.speak` drives, with the same three
// parameters, and mirrors `voicePick.ts`'s rule for which voice.
//
// Usage: swift render-stream-voice.swift OUT.wav [language] [rate] [pitch]
//        swift render-stream-voice.swift --list

import AVFoundation
import Foundation

let args = Array(CommandLine.arguments.dropFirst())

func qualityRank(_ q: AVSpeechSynthesisVoiceQuality) -> Int {
    switch q {
    case .premium: return 3
    case .enhanced: return 2
    default: return 1
    }
}

func qualityName(_ q: AVSpeechSynthesisVoiceQuality) -> String {
    switch q {
    case .premium: return "premium"
    case .enhanced: return "enhanced"
    default: return "default"
    }
}

func normalize(_ tag: String) -> String {
    return tag.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: "-").lowercased()
}

func primary(_ tag: String) -> String {
    return normalize(tag).split(separator: "-").first.map(String.init) ?? normalize(tag)
}

/// `voicePick.ts`, in Swift: exact language tag if any voice has it, else the
/// same primary subtag; then best quality, then name so a tie is not random.
func pickVoice(_ language: String) -> AVSpeechSynthesisVoice? {
    let all = AVSpeechSynthesisVoice.speechVoices()
    let wanted = normalize(language)
    var candidates = all.filter { normalize($0.language) == wanted }
    if candidates.isEmpty {
        candidates = all.filter { primary($0.language) == primary(language) }
    }
    if candidates.isEmpty { return nil }
    return candidates.sorted {
        let r = qualityRank($1.quality) - qualityRank($0.quality)
        if r != 0 { return r < 0 }
        return $0.name < $1.name
    }.first
}

if args.first == "--list" {
    for voice in AVSpeechSynthesisVoice.speechVoices().sorted(by: { $0.identifier < $1.identifier }) {
        print("\(voice.identifier)\t\(voice.language)\t\(qualityName(voice.quality))\t\(voice.name)")
    }
    exit(0)
}

guard let outPath = args.first else {
    FileHandle.standardError.write("render-stream-voice: need an output path\n".data(using: .utf8)!)
    exit(2)
}
let language = args.count > 1 ? args[1] : "en-US"
let rate = args.count > 2 ? Float(args[2]) ?? 0.52 : 0.52
let pitch = args.count > 3 ? Float(args[3]) ?? 1.0 : 1.0

// The same sentence measure-cue-loudness.sh speaks, long enough to give the
// loudness meter several complete gating blocks.
let text = ProcessInfo.processInfo.environment["VOICE_TEXT"]
    ?? "The heartbeat should be roughly the same level as the voice that talks back, so he does not have to blast the audio just to hear the beeping. This sentence is long enough to give the loudness meter several complete gating blocks to chew on."

let utterance = AVSpeechUtterance(string: text)
utterance.rate = min(max(rate, 0.0), 1.0)
utterance.pitchMultiplier = min(max(pitch, 0.5), 2.0)
// DroverSpeechModule never sets `volume`, so the voice speaks at 1.0. That is
// the whole reason the cue table needs a reference at all.
let forced = ProcessInfo.processInfo.environment["VOICE_ID"]
let chosen = forced.flatMap { AVSpeechSynthesisVoice(identifier: $0) } ?? pickVoice(language)
if let voice = chosen {
    utterance.voice = voice
    FileHandle.standardError.write(
        "render-stream-voice: \(voice.name) (\(voice.identifier), \(qualityName(voice.quality))) rate \(utterance.rate) pitch \(utterance.pitchMultiplier)\n"
            .data(using: .utf8)!)
} else {
    FileHandle.standardError.write("render-stream-voice: no voice for \(language); the synthesiser picks\n".data(using: .utf8)!)
}

let synthesizer = AVSpeechSynthesizer()
var file: AVAudioFile?
var failure: String?
var finished = false

// The callback comes back on the main queue, so the main thread has to be
// RUNNING A RUNLOOP rather than blocked on a semaphore waiting for it. A
// semaphore here deadlocks and the render times out with an empty file.
synthesizer.write(utterance) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    if pcm.frameLength == 0 {
        // A zero-length buffer is how `write` says it is finished.
        finished = true
        return
    }
    do {
        if file == nil {
            file = try AVAudioFile(
                forWriting: URL(fileURLWithPath: outPath),
                settings: pcm.format.settings,
                commonFormat: pcm.format.commonFormat,
                interleaved: pcm.format.isInterleaved)
        }
        try file?.write(from: pcm)
    } catch {
        failure = "\(error)"
        finished = true
    }
}

let deadline = Date().addingTimeInterval(60)
while !finished && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
}
if let failure {
    FileHandle.standardError.write("render-stream-voice: \(failure)\n".data(using: .utf8)!)
    exit(1)
}
if !finished || file == nil {
    FileHandle.standardError.write("render-stream-voice: rendered nothing\n".data(using: .utf8)!)
    exit(1)
}
file = nil
exit(0)
