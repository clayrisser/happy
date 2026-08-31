import Foundation
import os
import SwiftUI
import WatchConnectivity
import WatchKit

/// One log for the whole watch app. Read it from Console.app (or
/// `log stream --predicate 'subsystem == "com.bitspur.drover"'`) to prove a
/// background launch happened without a screen to look at (DROVE-86).
let droverLog = Logger(subsystem: "com.bitspur.drover", category: "watch")

@main
struct DroverWatchApp: App {
    /// The delegate is what makes a launch with NO scene still activate
    /// WatchConnectivity (DROVE-86). It also owns the store: see
    /// `DroverWatchAppDelegate.store`.
    @WKApplicationDelegateAdaptor(DroverWatchAppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            GateListView()
                .environmentObject(delegate.store)
        }
    }
}

/// Runs on EVERY launch of this process, including the one watchOS makes in
/// the background to hand over a `transferCurrentComplicationUserInfo`
/// (DROVE-86). Before this existed the session was activated only by
/// `GateStore.init`, and the store lived only as a `@StateObject` on the
/// scene, which SwiftUI need not build for a launch with no screen. So the
/// transfer that was meant to buzz the wrist could arrive into a process
/// with no delegate to receive it.
@MainActor
final class DroverWatchAppDelegate: NSObject, WKApplicationDelegate {
    /// Built here, not as a `@StateObject` on the scene, so that a background
    /// launch has a store to apply the arrival to and a buzzer to play it.
    /// The scene borrows the same instance.
    private(set) lazy var store = GateStore()

    func applicationDidFinishLaunching() {
        droverLog.notice("app didFinishLaunching state=\(WKApplication.shared().applicationState.rawValue, privacy: .public)")
        WatchSessionBridge.shared.activate()
        // Touching it is what constructs it, which attaches it to the bridge
        // and replays anything the bridge has already been handed.
        _ = store
    }
}

/// Owns the one `WCSession` and its delegate for the life of the process.
///
/// WatchConnectivity allows a single delegate, and it has to be set BEFORE
/// `activate()` for the callbacks of that activation to reach anyone. Owning
/// it here rather than on a view model means it is set on every launch,
/// whatever SwiftUI decides to build. Whatever arrives before a `GateStore`
/// has attached is kept and replayed to the first one that does, so the
/// arrival that launched the process is never dropped on the floor between
/// activation and the store existing.
final class WatchSessionBridge: NSObject, WCSessionDelegate {
    static let shared = WatchSessionBridge()

    /// One WatchConnectivity delegate callback, as the store sees it.
    enum Arrival {
        case activated(WCSessionActivationState, Error?)
        case applicationContext([String: Any])
        case message([String: Any])
        case userInfo([String: Any])

        var name: String {
            switch self {
            case .activated: return "activationDidComplete"
            case .applicationContext: return "didReceiveApplicationContext"
            case .message: return "didReceiveMessage"
            case .userInfo: return "didReceiveUserInfo"
            }
        }
    }

    /// Nil when this watch cannot talk to a phone at all
    /// (`WCSession.isSupported()` is false), and until `activate()` has run.
    private(set) var session: WCSession?

    private let lock = NSLock()
    private var activated = false
    private var receiver: (@MainActor (Arrival) -> Void)?
    private var buffered: [Arrival] = []

    private override init() { super.init() }

    /// Idempotent: the delegate calls it on launch and the store calls it on
    /// construction, and whichever runs first does the work.
    func activate() {
        lock.lock()
        let first = !activated
        activated = true
        lock.unlock()
        guard first else { return }
        guard WCSession.isSupported() else {
            droverLog.notice("wcsession unsupported on this watch")
            return
        }
        let session = WCSession.default
        session.delegate = self
        self.session = session
        droverLog.notice("wcsession activate")
        session.activate()
    }

    /// Hand every arrival, past and future, to `receiver` on the main actor.
    /// Replaces any earlier receiver: there is one store per process.
    func attach(_ receiver: @escaping @MainActor (Arrival) -> Void) {
        lock.lock()
        self.receiver = receiver
        let replay = buffered
        buffered = []
        lock.unlock()
        guard !replay.isEmpty else { return }
        // One task for the whole backlog so it lands in the order it arrived.
        Task { @MainActor in
            for arrival in replay {
                droverLog.notice("wcsession replay \(arrival.name, privacy: .public) to store")
                receiver(arrival)
            }
        }
    }

    private func deliver(_ arrival: Arrival) {
        lock.lock()
        let receiver = self.receiver
        if receiver == nil { buffered.append(arrival) }
        lock.unlock()
        guard let receiver else {
            droverLog.notice("wcsession buffered \(arrival.name, privacy: .public) (no store attached)")
            return
        }
        Task { @MainActor in receiver(arrival) }
    }

    // MARK: WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith state: WCSessionActivationState,
        error: Error?
    ) {
        droverLog.notice("wcsession activationDidComplete state=\(state.rawValue, privacy: .public) error=\(error?.localizedDescription ?? "none", privacy: .public)")
        deliver(.activated(state, error))
    }

    func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
        droverLog.notice("wcsession didReceiveApplicationContext keys=\(context.count, privacy: .public)")
        deliver(.applicationContext(context))
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        droverLog.notice("wcsession didReceiveMessage keys=\(message.count, privacy: .public)")
        deliver(.message(message))
    }

    /// The background transfer, in practice the one the phone sends with
    /// `transferCurrentComplicationUserInfo`, which is the only documented
    /// phone-to-watch call that LAUNCHES this app in the background
    /// (DROVE-62). This line in Console is the proof that the launch happened.
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        droverLog.notice("wcsession didReceiveUserInfo keys=\(userInfo.count, privacy: .public)")
        deliver(.userInfo(userInfo))
    }
}
