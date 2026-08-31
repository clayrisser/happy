import SwiftUI

/// What the sessions are still working through, on the wrist (DROVE-167).
///
/// Clay, three times, the last one with a photo of a black watch face: "Why
/// when I click on the drover icon it doesn't show the todo", "When I press the
/// Longhorn button nothing happens", "why does this not let me see my fucking
/// tasks". Claude Code has kept a task list per session the whole time and the
/// wrist had nowhere to put it.
///
/// UNFINISHED ONLY. A wrist is a scroll of short lines read at arm's length,
/// and the finished half of a list is exactly the half that does not need
/// reading. The counts still say what was done, so nothing is hidden — the
/// whole list, ticks and all, is on the phone.
///
/// Nothing here derives anything. The phone trimmed, sorted and picked the
/// subset in `utils/sessionTasks.ts`, and it is the same derivation the phone's
/// own sheet reads (DROVE-129).
struct TasksView: View {
    @EnvironmentObject private var store: GateStore

    var body: some View {
        Group {
            let sessions = store.snapshot.sessionsWithTasks
            if sessions.isEmpty {
                // A sentence, never a blank screen. The screenshot on this
                // ticket is what nothing at all looks like on a wrist, and it
                // is indistinguishable from a broken app.
                VStack(spacing: 6) {
                    Image(systemName: "checklist")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("No tasks")
                        .font(.headline)
                    Text("No session is keeping a list right now")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            } else {
                List {
                    ForEach(sessions) { session in
                        Section {
                            ForEach(Array(session.openTasks.enumerated()), id: \.offset) { _, task in
                                TaskLine(text: task)
                            }
                        } header: {
                            // The session's name and its score, so a scroll
                            // through three sessions never loses which one a
                            // line belongs to.
                            VStack(alignment: .leading, spacing: 0) {
                                Text(session.title)
                                    .font(.caption2)
                                    .lineLimit(1)
                                Text(session.taskHeadline)
                                    .font(.system(size: 9))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .listStyle(.carousel)
            }
        }
        .navigationTitle("Tasks")
    }
}

/// One session's list, off its own detail screen.
struct SessionTasksView: View {
    let session: DroverSession
    @EnvironmentObject private var store: GateStore

    /// The store's copy, not the one captured when the row was tapped: the
    /// phone republishes as tasks tick over, and a screen left open must move
    /// with it rather than freeze at whatever was true when it opened.
    private var live: DroverSession {
        store.snapshot.sessions.first { $0.id == session.id } ?? session
    }

    var body: some View {
        Group {
            let tasks = live.openTasks
            if tasks.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "checklist")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(live.taskHeadline)
                        .font(.headline)
                        .multilineTextAlignment(.center)
                    Text("Nothing left in this session's list")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            } else {
                List {
                    Text(live.taskHeadline)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                    ForEach(Array(tasks.enumerated()), id: \.offset) { _, task in
                        TaskLine(text: task)
                    }
                }
                .listStyle(.carousel)
            }
        }
        .navigationTitle(live.title)
    }
}

/// One unfinished task. A hollow circle, the same mark the phone draws for a
/// task nobody has started.
private struct TaskLine: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: "circle")
                .font(.system(size: 8))
                .foregroundStyle(.secondary)
                .padding(.top, 3)
            Text(text)
                .font(.caption2)
                // Four lines, not one: a task is a sentence, and a wrist that
                // truncates it to "Wire the derivation into the…" has told him
                // nothing he did not already know.
                .lineLimit(4)
        }
    }
}

/// The door to the task list, at the foot of the gate wall and under its empty
/// state. A value link like every other push in this stack (DROVE-10), quiet
/// on purpose: a task blocks nothing and must not read as a gate.
struct TasksRow: View {
    let label: String

    var body: some View {
        NavigationLink(value: DroverRoute.tasks) {
            Label(label, systemImage: "checklist")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
