import { describe, expect, it } from "vitest";
import { TaskEventBuffer, type TaskEvent } from "./taskEventBuffer";

const output = (task_id: string, data: string): TaskEvent => ({ kind: "output", task_id, data });

describe("TaskEventBuffer", () => {
  it("buffers events that arrive before the start invocation returns its task ID", () => {
    const buffer = new TaskEventBuffer();
    buffer.begin();
    buffer.push(output("task-1", "first"));
    buffer.push({ kind: "progress", task_id: "task-1", state: "running" });
    expect(buffer.activate("task-1").map(event => event.kind)).toEqual(["output", "progress"]);
  });

  it("does not deliver events belonging to another task after activation", () => {
    const buffer = new TaskEventBuffer();
    buffer.begin();
    expect(buffer.activate("task-2")).toEqual([]);
    expect(buffer.push(output("task-1", "stale"))).toEqual([]);
    expect(buffer.push(output("task-2", "current"))).toEqual([output("task-2", "current")]);
  });

  it("drops buffered events for stale task IDs when a different task is activated", () => {
    const buffer = new TaskEventBuffer();
    buffer.begin();
    buffer.push(output("old-task", "stale"));
    buffer.push(output("new-task", "current"));
    expect(buffer.activate("new-task")).toEqual([output("new-task", "current")]);
    expect(buffer.push(output("old-task", "late"))).toEqual([]);
  });

  it("bounds events received before activation", () => {
    const buffer = new TaskEventBuffer();
    buffer.begin();
    for (let index = 0; index < 300; index += 1) buffer.push(output("task-1", String(index)));
    expect(buffer.activate("task-1")).toHaveLength(256);
  });

  it("preserves terminal events when the early-event buffer is full", () => {
    const buffer = new TaskEventBuffer();
    buffer.begin();
    for (let index = 0; index < 256; index += 1) buffer.push(output("task-1", String(index)));
    buffer.push({ kind: "completed", task_id: "task-1", result: { command: "npm test", success: true, output: "ok" } });
    const events = buffer.activate("task-1");
    expect(events).toHaveLength(256);
    expect(events.at(-1)?.kind).toBe("completed");
  });

  it("ignores events after reset or completion", () => {
    const buffer = new TaskEventBuffer();
    buffer.begin();
    buffer.activate("task-1");
    buffer.finish("task-1");
    expect(buffer.push(output("task-1", "late"))).toEqual([]);
  });
});
