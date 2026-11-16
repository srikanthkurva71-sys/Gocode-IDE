export type DapLifecycleState =
  | "idle"
  | "starting"
  | "initializing"
  | "launching"
  | "configuring"
  | "running"
  | "stopped"
  | "terminating"
  | "terminated"
  | "failed";

export type DapLifecycleEvent =
  | "start"
  | "processStarted"
  | "initializeSucceeded"
  | "initialized"
  | "configurationDone"
  | "stopped"
  | "continued"
  | "stopRequested"
  | "terminated"
  | "processExited"
  | "failure"
  | "reset";

const transitions: Record<
  DapLifecycleState,
  Partial<Record<Exclude<DapLifecycleEvent, "reset">, DapLifecycleState>>
> = {
  idle: { start: "starting" },
  starting: {
    processStarted: "initializing",
    stopRequested: "terminating",
    processExited: "terminated",
    failure: "failed",
  },
  initializing: {
    initializeSucceeded: "launching",
    stopRequested: "terminating",
    processExited: "terminated",
    failure: "failed",
  },
  launching: {
    initialized: "configuring",
    stopRequested: "terminating",
    processExited: "terminated",
    failure: "failed",
  },
  configuring: {
    configurationDone: "running",
    stopped: "stopped",
    stopRequested: "terminating",
    processExited: "terminated",
    failure: "failed",
  },
  running: {
    stopped: "stopped",
    continued: "running",
    stopRequested: "terminating",
    terminated: "terminated",
    processExited: "terminated",
    failure: "failed",
  },
  stopped: {
    stopped: "stopped",
    continued: "running",
    stopRequested: "terminating",
    terminated: "terminated",
    processExited: "terminated",
    failure: "failed",
  },
  terminating: {
    terminated: "terminated",
    processExited: "terminated",
    failure: "failed",
  },
  terminated: { start: "starting" },
  failed: { start: "starting" },
};

export type DapLifecycleTransition = {
  state: DapLifecycleState;
  accepted: boolean;
};

export function transitionDapLifecycle(
  current: DapLifecycleState,
  event: DapLifecycleEvent,
): DapLifecycleTransition {
  if (event === "reset") return { state: "idle", accepted: true };
  const next = transitions[current][event];
  return next
    ? { state: next, accepted: true }
    : { state: current, accepted: false };
}
