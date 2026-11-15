export type DapCancelRequest = {
  seq: number;
  type: "request";
  command: "cancel";
  arguments: { requestId: number };
};

/**
 * Build a DAP cancel request for an outstanding adapter request.
 * Returns null for invalid or reused sequence identifiers.
 */
export function createDapCancelRequest(sequence: number, requestId: number): DapCancelRequest | null {
  if (
    !Number.isSafeInteger(sequence) || sequence < 1 ||
    !Number.isSafeInteger(requestId) || requestId < 1 ||
    sequence === requestId
  ) return null;

  return {
    seq: sequence,
    type: "request",
    command: "cancel",
    arguments: { requestId },
  };
}
