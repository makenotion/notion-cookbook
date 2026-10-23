export type ActionResult =
  | { status: "success" }
  | { status: "error"; error: { message: string } }

export async function performAction(
  action: () => Promise<ActionResult>
): Promise<string | undefined> {
  try {
    const result = await action()
    return result.status === "error" ? result.error.message : undefined
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "The request failed. Please try again."
  }
}
