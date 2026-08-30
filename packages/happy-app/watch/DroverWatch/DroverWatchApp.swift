import SwiftUI

@main
struct DroverWatchApp: App {
    @StateObject private var store = GateStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            GateListView()
                .environmentObject(store)
        }
        // Bringing the app to the front is the moment Clay wants a current
        // snapshot, and until DROVE-22 it was the moment the wrist re-applied
        // the oldest one it had. Activation alone is not enough: WCSession
        // activates once per launch, so a watch woken from the dock hours later
        // never asked again.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.refresh(force: true) }
        }
    }
}
