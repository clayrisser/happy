import SwiftUI

/// One gate, the full preview, and the buttons that are the whole point of the
/// wrist surface (BASED-98).
///
/// What those buttons ARE depends on the kind. A permission is allow/deny; a
/// question is answered by picking one of its options and can never be
/// allow/denied; an idle ding and an expiry warning are acknowledged. Getting
/// that wrong is not cosmetic — see `answer` below.
struct GateDetailView: View {
    let gate: DroverGate
    @EnvironmentObject private var store: GateStore
    @Environment(\.dismiss) private var dismiss

    /// The phone's snapshot is the authoritative pending set, so a gate missing
    /// from it is settled — answered in tmux, on the phone, or expired.
    ///
    /// The LIST has always dropped those. This screen did not: it holds the
    /// gate by value, so a prompt answered elsewhere stayed on the wrist with
    /// its buttons live, which is Clay's "a real failure even though the
    /// session continued fine". Our own answer does not trip this, because the
    /// gate stays in the snapshot until the phone says otherwise and we dismiss
    /// on the tap regardless.
    private var stillPending: Bool {
        store.snapshot.gates.contains { $0.id == gate.id }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(gate.title)
                    .font(.headline)
                if !gate.reason.isEmpty {
                    Text(gate.reason)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(gate.preview)
                    .font(.system(.caption, design: .monospaced))
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))

                actions

                // Shown HERE and not only on the wall: a refused answer — a
                // dictation that heard nothing, a send with the phone app gone
                // — leaves you standing on this screen, and a banner one level
                // up is a banner you never see.
                if let message = store.lastError {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.system(size: 9))
                        .foregroundStyle(.red)
                }

                if let account = gate.account {
                    Text("account: \(account)")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: stillPending) { _, pending in
            if !pending { dismiss() }
        }
    }

    private var title: String {
        switch gate.classification {
        case .question: return "Question"
        case .permission, .unknown: return "Gate"
        case .idle: return "Waiting"
        case .expiry: return "Account"
        }
    }

    /// Exhaustive over `DroverGate.Kind` on purpose: a kind added to the bus
    /// has to be given an answer here rather than quietly inheriting whichever
    /// branch happened to be the default.
    @ViewBuilder
    private var actions: some View {
        switch gate.classification {
        case .question: questionActions
        // An unknown kind gets the permission pair: it is what the phone
        // already renders anything it does not recognise as, and allow/deny is
        // the pair that carries a real answer either way.
        case .permission, .unknown: permissionActions
        case .idle, .expiry: acknowledgeAction
        }
    }

    /// A question is ANSWERED, never approved, so there is no allow button here
    /// and no deny either — denying one would settle it for every other surface
    /// with nothing to hand back to the harness.
    ///
    /// Every question gets the typing path, not only the ones with no options:
    /// a list of options is the harness's guess at what you might say, and the
    /// answer that is not on it is exactly the one worth reaching a wrist for.
    @ViewBuilder
    private var questionActions: some View {
        let options = gate.answerableOptions
        ForEach(options) { option in
            Button {
                if store.answer(gate, allow: true, optionId: option.id) { dismiss() }
            } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(option.label)
                        .font(.caption)
                        .multilineTextAlignment(.leading)
                    if let detail = option.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        typedAnswerAction(hasOptions: !options.isEmpty)
    }

    /// Type, scribble or dictate an answer.
    ///
    /// `TextFieldLink` is watchOS's own input sheet, so the keyboard, Scribble
    /// and dictation all arrive together and none of them has to be built here.
    ///
    /// A question with no options used to say "Answer this one on the phone",
    /// which was true of the wrist and useless in the moment it mattered: the
    /// session is blocked, the watch is what is on you, and the phone is
    /// wherever it was left. `action: "text"` has been on the bus the whole
    /// time (schema/event.json, server.js's resolve, the pretooluse adapter's
    /// `.resolution.optionId // .resolution.text`) — the wrist was the only
    /// piece missing.
    private func typedAnswerAction(hasOptions: Bool) -> some View {
        TextFieldLink(prompt: Text(gate.title)) {
            Label(hasOptions ? "Something else" : "Answer", systemImage: "keyboard")
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
        } onSubmit: { typed in
            // No dismiss on a refusal: the store rejects a blank answer, and
            // leaving the screen up is what puts its message in front of you.
            if store.answer(gate, allow: true, text: typed) { dismiss() }
        }
    }

    private var permissionActions: some View {
        // Deny sits first and Allow is the tinted one: a mis-tap on a
        // destructive command should land on the safe answer.
        Group {
            Button(role: .destructive) {
                if store.answer(gate, allow: false) { dismiss() }
            } label: {
                Label("Deny", systemImage: "xmark")
                    .frame(maxWidth: .infinity)
            }
            Button {
                if store.answer(gate, allow: true) { dismiss() }
            } label: {
                Label("Allow", systemImage: "checkmark")
                    .frame(maxWidth: .infinity)
            }
            .tint(.green)
        }
    }

    /// Idle and expiry ask nothing — they say a session is waiting or an
    /// account is running out. One button, so the card can be cleared from the
    /// wrist without pretending a choice was made.
    private var acknowledgeAction: some View {
        Button {
            if store.answer(gate, allow: true) { dismiss() }
        } label: {
            Label("Got it", systemImage: "checkmark")
                .frame(maxWidth: .infinity)
        }
        .tint(.blue)
    }
}
