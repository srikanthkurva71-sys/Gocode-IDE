export type TaskEvent =
  | { kind: "output"; task_id: string; data: string }
  | { kind: "progress"; task_id: string; state: string }
  | { kind: "completed"; task_id: string; result: { command: string; success: boolean; output: string; timed_out?: boolean; cancelled?: boolean } };

const MAX_PENDING_EVENTS = 256;

/**
 * Correlates native task events with the invocation that started the task.
 * Tauri can emit output or completion before invoke() resolves with the ID,
 * so events are buffered until activate(). Events from older tasks are ignored
 * after the matching ID is selected.
 */
export class TaskEventBuffer {
  private accepting = false;
  private activeId: string | null = null;
  private pending = new Map<string, TaskEvent[]>();
  private pendingCount = 0;

  begin(): void {
    this.accepting = true;
    this.activeId = null;
    this.pending.clear();
    this.pendingCount = 0;
  }

  push(event: TaskEvent): TaskEvent[] {
    if (!this.accepting || !event.task_id) return [];
    if (this.activeId !== null) return event.task_id === this.activeId ? [event] : [];
    if (this.pendingCount >= MAX_PENDING_EVENTS) return [];
    const events = this.pending.get(event.task_id) ?? [];
    events.push(event);
    this.pending.set(event.task_id, events);
    this.pendingCount += 1;
    return [];
  }

  activate(taskId: string): TaskEvent[] {
    if (!this.accepting || !taskId) return [];
    this.activeId = taskId;
    const events = this.pending.get(taskId) ?? [];
    this.pending.clear();
    this.pendingCount = 0;
    return events;
  }

  finish(taskId: string): void {
    if (this.activeId !== taskId) return;
    this.reset();
  }

  reset(): void {
    this.accepting = false;
    this.activeId = null;
    this.pending.clear();
    this.pendingCount = 0;
  }
}
