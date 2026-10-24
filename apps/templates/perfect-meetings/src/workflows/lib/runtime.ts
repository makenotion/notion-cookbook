/**
 * The workflow runtime unwinds the handler with thrown values to suspend a
 * wait (`WorkflowWaitInterrupt`) or defer a step retry (a non-Error value).
 * Code that catches errors must rethrow these untouched.
 */
export function isRuntimeSignal(error: unknown): boolean {
  return !(error instanceof Error) || error.name === "WorkflowWaitInterrupt"
}
