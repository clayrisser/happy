import Foundation

/// Which installed voice reads a reply when the user has not chosen one
/// (DROVE-390).
///
/// Foundation only, on purpose. DroverSpeechModule.swift maps each
/// AVSpeechSynthesisVoice into a candidate and hands the list here, and
/// `scripts/test-pick.sh` compiles this file on a Mac with plain swiftc and
/// runs it over a fixture list, the way watch/scripts/test-shared.sh proves
/// the wrist decisions. sources/voice/voicePick.ts is the same rule in JS for
/// the caller that passes an identifier, and voicePick.spec.ts parses this
/// file so the two cannot drift.
///
/// WHY. bestVoice ranked by quality and broke the tie by NAME. A phone with no
/// enhanced or premium en-US voice downloaded has only quality-default
/// voices, and since iOS 17 that set includes the MacinTalk novelty voices.
/// Alphabetically Albert comes first, so that is what read-aloud spoke with:
/// a joke voice, measured through the streamed path (DROVE-385) at -24.03
/// LUFS against Samantha's -16.16.
///
/// THE RULE, within the requested language (the exact tag when any voice has
/// it, else the same primary subtag), after every novelty voice is dropped:
///
///   1. the best natural voice: premium over enhanced, and inside one quality
///      the system default when it is one of them, else the first listed;
///   2. the language's system default, what AVSpeechSynthesisVoice(language:)
///      returns (Samantha for en-US on a stock phone);
///   3. the stock compact voice, `com.apple.voice.compact.<tag>.<Name>`;
///   4. whatever compact voice is left, in the order the phone listed them.
///
/// No name comparison anywhere: a tie goes to the listing order, and the spec
/// fails on `name <` or `name >` in this file.
///
/// A voice the user chose in settings is the caller's business and wins
/// whatever it is, novelty included: bestVoice returns it before asking here.

/// One installed voice, as much of it as the rule needs and nothing that
/// needs a device to build.
struct DroverVoiceCandidate: Equatable {
    let identifier: String
    let name: String
    /// BCP 47 tag as iOS reports it, e.g. `en-US`.
    let language: String
    /// 3 premium, 2 enhanced, 1 default: DroverSpeechModule.qualityRank.
    let quality: Int
    /// `voiceTraits.contains(.isNoveltyVoice)` where the OS has traits
    /// (iOS 17); false before that, where the list below does the work.
    let noveltyTrait: Bool
    /// `AVSpeechSynthesisVoice(language:)` for this voice's language is this
    /// voice.
    let systemDefault: Bool

    init(
        identifier: String,
        name: String,
        language: String,
        quality: Int,
        noveltyTrait: Bool = false,
        systemDefault: Bool = false
    ) {
        self.identifier = identifier
        self.name = name
        self.language = language
        self.quality = quality
        self.noveltyTrait = noveltyTrait
        self.systemDefault = systemDefault
    }
}

enum DroverVoicePick {
    /// The novelty voices as iOS 17 and 26 DISPLAY them, which is not always
    /// the identifier tail: Deranged shows as Wobble, Hysterical as Jester,
    /// Princess as Superstar. The same fifteen Settings files under Novelty,
    /// and the same fifteen that carry isNoveltyVoice on macOS 26 (measured
    /// 2026-09-02). voicePick.ts holds the identical list.
    static let noveltyNames: Set<String> = [
        "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos",
        "Good News", "Jester", "Organ", "Superstar", "Trinoids", "Whisper",
        "Wobble", "Zarvox",
    ]

    /// Every MacinTalk-era voice lives under this prefix, novelty or not:
    /// Fred, Junior, Kathy and Ralph are the same 1990s family without the
    /// joke, and none of them is a reading voice. This shape OR a name in the
    /// list is enough.
    static let noveltyIdentifierPrefix = "com.apple.speech.synthesis.voice."

    /// The compact voice iOS ships for a language, as against a Siri
    /// (`com.apple.ttsbundle.siri_*`), eloquence or super-compact one.
    static let stockCompactIdentifierPrefix = "com.apple.voice.compact."

    static func isNovelty(_ voice: DroverVoiceCandidate) -> Bool {
        if voice.noveltyTrait { return true }
        if voice.identifier.hasPrefix(noveltyIdentifierPrefix) { return true }
        return voice.quality == 1 && noveltyNames.contains(voice.name)
    }

    static func normalizedTag(_ tag: String) -> String {
        tag.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: "-").lowercased()
    }

    static func primarySubtag(_ tag: String) -> String {
        normalizedTag(tag).split(separator: "-").first.map(String.init) ?? ""
    }

    /// The voices that can speak `language`: the exact tag when any voice
    /// has it, else the whole language.
    static func forLanguage(_ voices: [DroverVoiceCandidate], _ language: String) -> [DroverVoiceCandidate] {
        let wanted = normalizedTag(language)
        let exact = voices.filter { normalizedTag($0.language) == wanted }
        if !exact.isEmpty { return exact }
        let primary = primarySubtag(language)
        return voices.filter { primarySubtag($0.language) == primary }
    }

    /// The voice to read with, or nil to let the synthesiser choose. The
    /// clauses ARE the tiers, in order; the spec reads them off this body.
    static func pick(_ voices: [DroverVoiceCandidate], language: String) -> DroverVoiceCandidate? {
        let candidates = forLanguage(voices, language).filter { !isNovelty($0) }
        if let natural = bestNatural(candidates) { return natural }
        if let standard = candidates.first(where: { $0.systemDefault }) { return standard }
        if let stock = stockCompact(candidates) { return stock }
        return candidates.first
    }

    /// Premium over enhanced; inside one quality the system default if it is
    /// there, else the first listed. Nil when only compact voices are
    /// installed.
    static func bestNatural(_ candidates: [DroverVoiceCandidate]) -> DroverVoiceCandidate? {
        let top = candidates.map { $0.quality }.max() ?? 1
        guard top > 1 else { return nil }
        let best = candidates.filter { $0.quality == top }
        return best.first(where: { $0.systemDefault }) ?? best.first
    }

    /// `com.apple.voice.compact.<tag>.<Name>`, the first listed.
    static func stockCompact(_ candidates: [DroverVoiceCandidate]) -> DroverVoiceCandidate? {
        candidates.first(where: { $0.identifier.hasPrefix(stockCompactIdentifierPrefix) })
    }
}
