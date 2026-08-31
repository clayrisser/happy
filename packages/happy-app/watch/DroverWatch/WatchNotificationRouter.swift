import Foundation
import SwiftUI
import UserNotifications

/// Where a tap on the watch-local gate notification lands (DROVE-94).
///
/// `WristBuzzer` posts a `UNNotificationRequest` when a gate arrives while the
/// app is not frontmost. Until this existed nothing in the watch app was the
/// notification center's delegate, so a tap on that alert opened the app at
/// its root list and left Clay to find the gate himself. The Apple-mirrored
/// PHONE pushes on the wrist open the phone app by Apple's rule; the local
/// notification is the one the watch owns, and this is where its tap goes.
///
/// The tap routes through the wall's own navigation: `GateListView` binds its
/// `NavigationStack` to `path`, so setting the path to one gate is the same
/// push a tap on the row makes, and `GateDetailView` pops itself when the
/// gate is answered elsewhere exactly as it does after a row tap. A gate the
/// phone no longer lists is settled, so its tap shows the wall rather than a
/// detail with live buttons for a decision already made.
///
/// A tap can arrive before the store exists: watchOS launches the process for
/// the tap and calls the delegate inside `applicationDidFinishLaunching`, and
/// the store is built in that same call. The gate id is held until `install`
/// hands over the store, then opened.
@MainActor
final class WatchNotificationRouter: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = WatchNotificationRouter()

    /// `userInfo` keys on the local notification, written by `WristBuzzer`.
    static let gateIdKey = "gateId"
    static let sessionIdKey = "sessionId"

    /// The wall's navigation path. Bound by `GateListView`, so a row tap and a
    /// notification tap drive the same stack.
    @Published var path = NavigationPath()

    private weak var store: GateStore?
    private var pendingGateId: String?

    private override init() { super.init() }

    /// Called once from the app delegate on launch, BEFORE the launch that a
    /// tap made finishes, which is the only window in which the delegate is
    /// handed the notification that launched the process.
    func install(store: GateStore) {
        self.store = store
        UNUserNotificationCenter.current().delegate = self
        if let gateId = pendingGateId {
            pendingGateId = nil
            open(gateId: gateId)
        }
    }

    /// Show one gate's detail, or the wall when the phone no longer lists it.
    func open(gateId: String) {
        guard let store else {
            pendingGateId = gateId
            droverLog.notice("notification tap held for gate \(gateId, privacy: .public) (no store yet)")
            return
        }
        if let gate = store.gates.first(where: { $0.id == gateId }) {
            droverLog.notice("notification tap opens gate \(gateId, privacy: .public)")
            path = NavigationPath([gate])
        } else {
            droverLog.notice("notification tap: gate \(gateId, privacy: .public) is settled, showing the wall")
            path = NavigationPath()
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    /// The tap. Anything but the default open (a dismiss, or a future action
    /// button) is left alone: dismissing an alert is not a request to see it.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let request = response.notification.request
        let userInfo = request.content.userInfo
        // The request identifier IS the cue id, which for a gate is the gate
        // id (WristBuzzer), so an alert posted before userInfo carried the key
        // still routes.
        let gateId = (userInfo[Self.gateIdKey] as? String) ?? request.identifier
        let action = response.actionIdentifier
        Task { @MainActor in
            defer { completionHandler() }
            guard action == UNNotificationDefaultActionIdentifier else {
                droverLog.notice("notification action \(action, privacy: .public) ignored for \(gateId, privacy: .public)")
                return
            }
            // A "session finished" cue has no gate to open; the wall is the
            // right place for it and the id will not be listed.
            self.open(gateId: gateId)
        }
    }
}
