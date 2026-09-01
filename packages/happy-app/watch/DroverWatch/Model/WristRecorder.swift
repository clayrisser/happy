import AVFoundation
import Foundation
import WatchConnectivity

/// The wrist's microphone, held open (DROVE-130).
///
/// One press opens it and it STAYS open: Clay talks, pauses, thinks, and keeps
/// talking, and a second press closes it. That is the phone's latch
/// (DROVE-105, DROVE-140) on the wrist, and until now the wrist could not have
/// it, because watchOS's `TextFieldLink` sheet takes ONE utterance and closes.
///
/// This class does exactly half the job: it CAPTURES. It does not recognise,
/// and it could not if it wanted to — `Speech.framework` is absent from the
/// watchOS SDK entirely (see `WristHearing` for the check). So the audio goes
/// to the phone, whose recogniser already knows how to hold an utterance
/// across a pause without losing the words before it, and the transcript comes
/// back over the same wire. One recogniser, one place the DROVE-263 invariant
/// lives, nothing to drift.
///
/// HOW THE AUDIO TRAVELS, and why it is not a new transport. Every payload
/// between this app and the phone is a property-list dictionary through
/// `sendMessage`, and `Data` is a property-list type, so the PCM rides in the
/// dictionary under `pcm` beside its `capture` and `seq` rather than opening
/// the codebase's first `sendMessageData` path. That means no new delegate
/// method on the phone, no framing header to write twice and get subtly
/// different, and the existing `forward(_:)` dispatcher routes it by `kind`
/// like everything else. The dictionary IS the header.
///
/// AUDIO IS NEVER QUEUED. Every other watch-to-phone message falls back to
/// `transferUserInfo` when the phone is out of reach, because a gate answer is
/// worth delivering late. A second of speech delivered ten minutes late is
/// worth nothing and would be transcribed into the middle of whatever is being
/// said then, so an unreachable phone STOPS the capture and says so. Losing
/// the recorder loudly beats a recording that goes nowhere.
@MainActor
final class WristRecorder: NSObject {
    /// Whether the microphone is open right now. The store republishes it; a
    /// second `ObservableObject` nested inside one does not refresh a SwiftUI
    /// view, which is the trap this shape avoids.
    private(set) var isRecording = false
    /// What went wrong, for the banner. Read by the store on a failed start.
    private(set) var failure: String?
    /// Rough input loudness, 0...1. The wrist's proof that the microphone is
    /// actually hearing something, which matters more here than on the phone:
    /// there is no waveform and no system sheet to look at.
    var onLevel: ((Double) -> Void)?

    /// The capture the audio belongs to. Stamped here because the press that
    /// starts a capture happens here, and echoed by the phone on every partial
    /// so a straggler can be dropped structurally (see `WristHearing`).
    private(set) var captureId = ""

    private var engine: AVAudioEngine?
    private var tapInstalled = false
    /// The chunk accumulator. Lives OUTSIDE the actor because the audio thread
    /// writes it: a tap callback is not on the main actor and must never
    /// pretend it is.
    private var chunks: ChunkBuffer?
    /// Sends happen here, never on the audio thread.
    private let wire = DispatchQueue(label: "drover.wrist.audio")

    /// 16 kHz mono Int16 — what the phone rebuilds the buffer as, and what the
    /// recogniser wants anyway. The wrist's own input is 48 kHz float, which
    /// would be twelve times the bytes for no extra words.
    private static var wireFormat: AVAudioFormat? {
        AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: WristAudio.sampleRate,
            channels: AVAudioChannelCount(WristAudio.channels),
            interleaved: true
        )
    }

    /// Bytes that make one message. Int16 is two bytes a sample.
    nonisolated fileprivate static var chunkBytes: Int { WristAudio.chunkFrames * 2 }

    /// Ask for the microphone, then open it. `then` runs with whether the
    /// recorder is live, on the main actor.
    ///
    /// Permission is asked here rather than at launch on purpose: a watch app
    /// that demands the microphone before you have pressed anything is a watch
    /// app that gets the microphone denied.
    func start(captureId id: String, then: @escaping (Bool) -> Void) {
        guard !isRecording else {
            then(true)
            return
        }
        guard WCSession.default.isReachable else {
            fail("Your phone is not reachable, so it cannot hear you", then)
            return
        }
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                guard granted else {
                    self.fail("Drover cannot use the microphone. Allow it in Settings", then)
                    return
                }
                self.open(captureId: id, then: then)
            }
        }
    }

    private func open(captureId id: String, then: @escaping (Bool) -> Void) {
        let session = AVAudioSession.sharedInstance()
        do {
            // `.record`, not `.playAndRecord`: the wrist's speaker is not
            // wanted while it listens, and a category that claims the output
            // would duck whatever the phone is reading aloud.
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: [])
        } catch {
            fail(error.localizedDescription, then)
            return
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        // The same guard the phone learned the hard way (DROVE-96): a format
        // with no sample rate means the session is not really in a recording
        // category, and `installTap` on it raises an NSException that Swift
        // cannot catch — an abort, not an error.
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            release()
            fail("The microphone has no usable input format", then)
            return
        }
        guard let wireFormat = Self.wireFormat,
              let converter = AVAudioConverter(from: inputFormat, to: wireFormat) else {
            release()
            fail("This watch cannot convert its microphone to 16 kHz", then)
            return
        }

        captureId = id
        self.engine = engine
        let chunks = ChunkBuffer()
        self.chunks = chunks
        let wire = self.wire
        // The meter hops back to the main actor; nothing else in the tap does.
        let meter: (Double) -> Void = { [weak self] value in
            Task { @MainActor in self?.onLevel?(value) }
        }

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { buffer, _ in
            Self.take(buffer, converter, wireFormat, chunks, id, wire, meter)
        }
        tapInstalled = true

        engine.prepare()
        do {
            try engine.start()
        } catch {
            release()
            fail(error.localizedDescription, then)
            return
        }
        failure = nil
        isRecording = true
        then(true)
    }

    /// Convert one tap buffer and ship whole chunks of it.
    ///
    /// A FREE FUNCTION over explicit arguments, not a method. The tap runs on
    /// the audio thread, so everything it touches has to be handed to it when
    /// the tap is installed: reaching back for actor state from here would
    /// mean either a data race or an `assumeIsolated` that traps the first
    /// time Clay presses the button.
    private nonisolated static func take(
        _ buffer: AVAudioPCMBuffer,
        _ converter: AVAudioConverter,
        _ wireFormat: AVAudioFormat,
        _ chunks: ChunkBuffer,
        _ capture: String,
        _ wire: DispatchQueue,
        _ meter: @escaping (Double) -> Void
    ) {
        // Output capacity has to cover the rate change. The ratio plus a
        // frame of slack is enough for any resampler Apple ships.
        let ratio = wireFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        // `AVAudioPCMBuffer` is not `Sendable` and the input block is
        // `@Sendable`, so handing the buffer in directly warns. It is safe
        // here and the box says exactly why rather than hiding it behind a
        // `@preconcurrency import`, which would mute every other Sendable
        // warning in this file including a real one: `convert` calls this
        // block SYNCHRONOUSLY, on this thread, before it returns, so the
        // buffer never outlives the call and is never touched by two threads.
        let source = Unsendable(buffer)
        converter.convert(to: out, error: &error) { _, status in
            // The converter pulls until it is satisfied; this buffer is
            // offered exactly once and the pull after it ends the pass.
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return source.value
        }
        guard error == nil, out.frameLength > 0, let channel = out.int16ChannelData else { return }
        let frames = Int(out.frameLength)
        let chunk = Data(bytes: channel[0], count: frames * 2)

        // The level behind the meter: RMS of the converted samples, cheap
        // because they are already integers and already here.
        var sum = 0.0
        let samples = channel[0]
        for i in 0..<frames {
            let value = Double(samples[i]) / 32_768.0
            sum += value * value
        }
        meter(min(1, (sum / Double(frames)).squareRoot() * 4))

        let ready = chunks.append(chunk, whole: chunkBytes)
        guard !ready.isEmpty else { return }
        wire.async { for (number, payload) in ready { Self.ship(capture, number, payload) } }
    }

    /// One chunk to the phone. Reachable-only and never queued: see the class
    /// comment. An error is dropped rather than surfaced — a single lost fifth
    /// of a second costs a syllable, and a banner per chunk would be worse
    /// than the loss.
    private nonisolated static func ship(_ capture: String, _ number: UInt32, _ pcm: Data) {
        let session = WCSession.default
        guard session.isReachable else { return }
        session.sendMessage(
            ["kind": "wristaudio", "capture": capture, "seq": Int(number), "pcm": pcm],
            replyHandler: nil,
            errorHandler: nil
        )
    }

    /// Close the microphone, flushing whatever is left so the last half-word
    /// is transcribed rather than dropped on the floor.
    func stop() {
        guard isRecording else { return }
        let capture = captureId
        if let tail = chunks?.flush() {
            wire.async { Self.ship(capture, tail.0, tail.1) }
        }
        release()
        isRecording = false
        onLevel?(0)
    }

    /// Tear the audio down without ceremony. Used by `stop`, by every failure
    /// path, and by a cancel.
    private func release() {
        if let engine {
            if engine.isRunning { engine.stop() }
            if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
        }
        tapInstalled = false
        engine = nil
        chunks = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func fail(_ why: String, _ then: @escaping (Bool) -> Void) {
        release()
        isRecording = false
        onLevel?(0)
        failure = why
        then(false)
    }
}

/// A value carried into a `@Sendable` closure that is called synchronously.
///
/// Deliberately narrow. It exists for exactly one call — `AVAudioConverter`'s
/// input block — where the compiler cannot see that the closure runs and
/// finishes inside `convert`, so nothing escapes and nothing is shared.
private struct Unsendable<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}

/// The samples heard but not yet sent, and the number of the next message
/// (DROVE-130).
///
/// Its own class, outside the actor, because the audio thread fills it and the
/// send queue drains it. One lock, one short critical section: an append and
/// whatever whole chunks that append completed. The alternative — reaching
/// into `@MainActor` state from a tap callback — is a data race that Swift 6
/// will refuse and that traps under `assumeIsolated` today.
private final class ChunkBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = Data()
    private var seq: UInt32 = 0

    /// Take converted samples and hand back every WHOLE chunk they completed,
    /// each already numbered. Partial remainders stay for the next buffer.
    func append(_ bytes: Data, whole size: Int) -> [(UInt32, Data)] {
        lock.lock()
        defer { lock.unlock() }
        pending.append(bytes)
        var ready: [(UInt32, Data)] = []
        while pending.count >= size {
            ready.append((seq, Data(pending.prefix(size))))
            pending.removeFirst(size)
            seq &+= 1
        }
        return ready
    }

    /// Everything left over when the microphone closes, so the last half-word
    /// is transcribed rather than dropped on the floor. Nil when nothing is
    /// waiting.
    func flush() -> (UInt32, Data)? {
        lock.lock()
        defer { lock.unlock() }
        guard !pending.isEmpty else { return nil }
        let tail = (seq, pending)
        pending = Data()
        seq &+= 1
        return tail
    }
}
