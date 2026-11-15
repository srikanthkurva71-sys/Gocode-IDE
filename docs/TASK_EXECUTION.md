# Gocode IDE — Project Task Execution

## Purpose and scope

Project tasks are explicit, locally executed build/test commands selected from a fixed allowlist. They are not arbitrary shell input. The desktop UI requires confirmation before starting a detected task and exposes cancellation while it is running.

## Lifecycle

1. The frontend invokes `start_project_task` with a fixed task label or `start_source_file_task` with a validated project-relative source path.
2. The backend resolves project-task labels through `resolve_project_task`, or validates that a Run File path is a regular non-symlink file contained by the opened project.
3. The backend allocates a process-local task ID and cancellation token, registers the task, emits `task-progress: running`, and starts a worker thread.
4. Stdout and stderr are drained concurrently. Each received chunk is emitted as `task-output`; the combined retained output remains capped at 100,000 bytes.
5. The worker polls for process exit, cancellation, and the 15-minute wall-clock timeout.
6. Cancellation or timeout terminates the task process tree (Unix process group or Windows Job Object) and reaps the direct child.
7. The backend emits a terminal `task-progress` state and a `task-completed` result, then removes the task from the active registry.

## Event contracts

- `task-output`: `{ task_id, data }` — incremental UTF-8-decoded stdout/stderr text.
- `task-progress`: `{ task_id, state }` — one of `running`, `completed`, `failed`, `timed_out`, or `cancelled`. This is lifecycle progress, not a fabricated percentage.
- `task-completed`: `{ task_id, result }` — final `TaskResult`, including `success`, `timed_out`, and `cancelled`.

The UI permits one task at a time (project task or Run Current File), appends live output, and offers a Cancel Running Task action. Event delivery is correlated by task ID; early events are buffered until the start invocation returns its ID, and stale events from other task IDs are discarded. Cancellation is cooperative at the task-manager boundary and forceful at the process boundary: the token is polled by the runner, then the complete assigned process group/job is terminated.

## Security and resource bounds

- Only fixed task labels resolve; command arguments are stored as argument arrays and are never interpolated into a shell.
- Project execution remains gated by a user confirmation.
- Output retention is capped at 100,000 bytes while pipes continue to drain.
- Project task wall-clock timeout is 15 minutes.
- Unix tasks are placed in a dedicated process group. Windows tasks are assigned to a Job Object configured with kill-on-close.
- Windows Job Object assignment occurs immediately after spawn; a very small pre-assignment child-spawn race remains documented.
- Event payloads are scoped by task ID. The frontend currently runs one task at a time.

## Current limitations

- Interactive terminal sessions are separate PTY sessions and are not controlled by the task cancellation token.
- Progress is lifecycle and output streaming only. Arbitrary build tools do not expose a reliable shared percentage contract.
- Cancellation can race with natural process completion; if the process has already exited, the completed result wins.
- This is process lifecycle management, not an OS sandbox. A task executes with the current user's operating-system permissions.

## Validation

The native runner includes platform-specific cancellation regression tests. CI must pass Linux Rust tests, Windows Rust tests/MSI smoke test, and frontend type-check/build before this feature is treated as validated.
