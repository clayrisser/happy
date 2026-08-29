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
    @ViewBuilder
    private var questionActions: some View {
        let options = gate.answerableOptions
        if options.isEmpty {
            // The honest empty state, not a button that loses the answer.
            //
            // This was once what EVERY question showed: collectGates in
            // sources/sync/droverWatchFeed.ts built a gate with no `options`
            // key at all, so this screen — already written to render them —
            // had nothing to offer and a question could not be answered from
            // the wrist however it looked. The phone forwards them now, so
            // this is left for the case it was always the right answer to: a
            // question that genuinely carries none, answerable only with free
            // text, which a watch has no way to enter.
            Label("Answer this one on the phone", systemImage: "iphone")
                .font(.caption2)
                .foregroundStyle(.secondary)
        } else {
            ForEach(options) { option in
                Button {
                    store.answer(gate, allow: true, optionId: option.id)
                    dismiss()
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
        }
    }

    private var permissionActions: some View {
        // Deny sits first and Allow is the tinted one: a mis-tap on a
        // destructive command should land on the safe answer.
        Group {
            Button(role: .destructive) {
                store.answer(gate, allow: false)
                dismiss()
            } label: {
                Label("Deny", systemImage: "xmark")
                    .frame(maxWidth: .infinity)
            }
            Button {
                store.answer(gate, allow: true)
                dismiss()
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
            store.answer(gate, allow: true)
            dismiss()
        } label: {
            Label("Got it", systemImage: "checkmark")
                .frame(maxWidth: .infinity)
        }
        .tint(.blue)
    }
}
