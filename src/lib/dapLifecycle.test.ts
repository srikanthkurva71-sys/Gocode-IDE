import { describe, expect, it } from "vitest";
import { transitionDapLifecycle, type DapLifecycleEvent, type DapLifecycleState } from "./dapLifecycle";

function apply(state: DapLifecycleState, ...events: DapLifecycleEvent[]): DapLifecycleState {
  return events.reduce((current, event) => {
    const result = transitionDapLifecycle(current, event);
    expect(result.accepted, `transition ${current} -> ${event}`).toBe(true);
    return result.state;
  }, state);
}

describe("DAP lifecycle state machine", () => {
  it("tracks the initialize, launch, configure, run, stop, continue and terminate path", () => {
    const state = apply(
      "idle",
      "start",
      "processStarted",
      "initializeSucceeded",
      "initialized",
      "configurationDone",
      "stopped",
      "continued",
      "stopped",
      "terminated",
    );
    expect(state).toBe("terminated");
  });

  it("does not mark the debuggee running if it stops before configurationDone response", () => {
    const state = apply("idle", "start", "processStarted", "initializeSucceeded", "initialized", "stopped");
    expect(state).toBe("stopped");
    expect(transitionDapLifecycle(state, "configurationDone")).toEqual({ state: "stopped", accepted: false });
  });

  it("handles adapter startup failure and allows a clean retry", () => {
    const failed = apply("idle", "start", "failure");
    expect(failed).toBe("failed");
    expect(apply(failed, "start", "processStarted", "initializeSucceeded")).toBe("launching");
  });

  it("handles process exit during initialization and termination", () => {
    expect(apply("idle", "start", "processStarted", "processExited")).toBe("terminated");
    expect(apply("idle", "start", "processStarted", "initializeSucceeded", "stopRequested", "processExited")).toBe("terminated");
  });

  it("rejects out-of-order events without corrupting the current state", () => {
    expect(transitionDapLifecycle("idle", "stopped")).toEqual({ state: "idle", accepted: false });
    expect(transitionDapLifecycle("initializing", "configurationDone")).toEqual({ state: "initializing", accepted: false });
    expect(transitionDapLifecycle("terminated", "continued")).toEqual({ state: "terminated", accepted: false });
  });

  it("supports reset and restarting a terminated session", () => {
    const terminated = apply("idle", "start", "processStarted", "initializeSucceeded", "initialized", "configurationDone", "terminated");
    expect(transitionDapLifecycle(terminated, "start")).toEqual({ state: "starting", accepted: true });
    expect(transitionDapLifecycle(terminated, "reset")).toEqual({ state: "idle", accepted: true });
  });
});
