import SwiftUI

/// One gate, the full preview, and the two buttons that are the whole point
/// of the wrist surface (BASED-98).
struct GateDetailView: View {
    let gate: DroverGate
    @EnvironmentObject private var store: GateStore
    @Environment(\.dismiss) private var dismiss

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
                    .textSelection(.enabled)

                // Deny sits first and Allow is the tinted one: a mis-tap on a
                // destructive command should land on the safe answer.
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

                if let account = gate.account {
                    Text("account: \(account)")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("Gate")
        .navigationBarTitleDisplayMode(.inline)
    }
}
