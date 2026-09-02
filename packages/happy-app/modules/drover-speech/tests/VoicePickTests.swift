import Foundation

/// The voice pick over a fixture list, checked without a phone (DROVE-390).
///
/// DroverVoicePick.swift imports Foundation and nothing else, so this runs on
/// the Mac in about a second through scripts/test-pick.sh. The one claim that
/// matters is the first: a phone with nothing but compact en-US voices reads
/// with Samantha, not Albert. The rest pin the tiers and that no name ever
/// decides.
@main
struct VoicePickTests {
    static var failures: [String] = []

    static func check(_ condition: Bool, _ what: String) {
        if condition {
            print("ok   \(what)")
        } else {
            failures.append(what)
            print("FAIL \(what)")
        }
    }

    static func voice(
        _ identifier: String,
        _ name: String,
        _ language: String = "en-US",
        quality: Int = 1,
        novelty: Bool = false,
        systemDefault: Bool = false
    ) -> DroverVoiceCandidate {
        DroverVoiceCandidate(
            identifier: identifier,
            name: name,
            language: language,
            quality: quality,
            noveltyTrait: novelty,
            systemDefault: systemDefault)
    }

    static let albert = voice("com.apple.speech.synthesis.voice.Albert", "Albert")
    static let samantha = voice("com.apple.voice.compact.en-US.Samantha", "Samantha")
    static let nicky = voice("com.apple.ttsbundle.siri_Nicky_en-US_compact", "Nicky")
    static let eddy = voice("com.apple.eloquence.en-US.Eddy", "Eddy")

    /// A stock iPhone with no downloads, Albert listed first so the listing
    /// order alone cannot save it. No flags: what a build before 22 reports.
    static let compactPhone: [DroverVoiceCandidate] = [
        albert,
        voice("com.apple.speech.synthesis.voice.BadNews", "Bad News"),
        voice("com.apple.speech.synthesis.voice.Fred", "Fred"),
        nicky,
        samantha,
        eddy,
        voice("com.apple.speech.synthesis.voice.Deranged", "Wobble"),
        voice("com.apple.speech.synthesis.voice.Zarvox", "Zarvox"),
        voice("com.apple.voice.compact.en-GB.Daniel", "Daniel", "en-GB"),
    ]

    static func main() {
        let pick = DroverVoicePick.pick

        check(pick(compactPhone, "en-US")?.identifier == samantha.identifier,
              "a phone with only compact en-US voices reads with Samantha, not Albert")

        let flagged = compactPhone.map { candidate -> DroverVoiceCandidate in
            voice(candidate.identifier, candidate.name, candidate.language,
                  novelty: candidate.identifier.hasPrefix("com.apple.speech.synthesis.voice."),
                  systemDefault: candidate.identifier == samantha.identifier)
        }
        check(pick(flagged, "en-US")?.identifier == samantha.identifier,
              "with build 22's flags it is still Samantha, now as the system default")

        let renamed = compactPhone.map { candidate -> DroverVoiceCandidate in
            DroverVoicePick.isNovelty(candidate)
                ? candidate
                : voice(candidate.identifier, "Zzz " + candidate.name, candidate.language)
        }
        check(pick(renamed, "en-US")?.identifier == samantha.identifier,
              "the pick does not move when the names change")

        let nickyDefault = compactPhone.map { candidate -> DroverVoiceCandidate in
            voice(candidate.identifier, candidate.name, candidate.language,
                  systemDefault: candidate.identifier == nicky.identifier)
        }
        check(pick(nickyDefault, "en-US")?.identifier == nicky.identifier,
              "the language's system default beats the stock compact voice")

        let enhanced = voice("com.apple.voice.enhanced.en-US.Samantha", "Samantha", quality: 2)
        check(pick(compactPhone + [enhanced], "en-US")?.identifier == enhanced.identifier,
              "an enhanced voice beats every compact voice, the default included")

        let zoe = voice("com.apple.voice.premium.en-US.Zoe", "Zoe", quality: 3)
        let ava = voice("com.apple.voice.premium.en-US.Ava", "Ava", quality: 3)
        check(pick([zoe, ava, enhanced] + compactPhone, "en-US")?.identifier == zoe.identifier,
              "two premium voices: the first listed wins, not the first by name")
        check(pick([zoe, ava] + compactPhone, "en-US")?.quality == 3,
              "premium beats enhanced")

        let noveltyOnly = compactPhone.filter { DroverVoicePick.isNovelty($0) }
        check(pick(noveltyOnly, "en-US") == nil,
              "a language with nothing but novelty voices gets nil, never one of them")

        check(pick([albert, eddy, nicky], "en-US")?.identifier == eddy.identifier,
              "no stock compact and no default: the first non-novelty listed")

        check(pick(compactPhone, "en-AU")?.identifier == samantha.identifier,
              "a region with no voice widens to the language and still lands on Samantha")

        check(DroverVoicePick.isNovelty(voice("com.apple.voice.compact.en-US.Whisper", "Whisper")),
              "a novelty name is enough, whatever the identifier")
        check(DroverVoicePick.isNovelty(voice("com.apple.voice.compact.en-US.Nova", "Nova", novelty: true)),
              "the OS trait is enough, whatever the name")
        check(DroverVoicePick.isNovelty(voice("com.apple.speech.synthesis.voice.Fred", "Fred")),
              "the MacinTalk identifier shape is enough, Fred included")
        check(!DroverVoicePick.isNovelty(samantha) && !DroverVoicePick.isNovelty(eddy),
              "Samantha and the eloquence voices are not novelty")

        if failures.isEmpty {
            print("\nall voice pick checks passed")
            exit(0)
        }
        print("\n\(failures.count) failed")
        exit(1)
    }
}
