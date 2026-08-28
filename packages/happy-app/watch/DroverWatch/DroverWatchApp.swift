import SwiftUI

@main
struct DroverWatchApp: App {
    @StateObject private var store = GateStore()

    var body: some Scene {
        WindowGroup {
            GateListView()
                .environmentObject(store)
        }
    }
}
