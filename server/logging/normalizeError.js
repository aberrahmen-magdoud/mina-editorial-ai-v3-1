export function normalizeError(err) {
  if (!err) {
    return { name: "Error", message: "Unknown error", stack: undefined };
  }

  if (typeof err === "string") {
    return { name: "Error", message: err, stack: undefined };
  }

  const name = typeof err.name === "string" && err.name.trim() ? err.name : "Error";
  const message = typeof err.message === "string" && err.message.trim()
    ? err.message
    : String(err);
  const stack = typeof err.stack === "string" && err.stack.trim() ? err.stack : undefined;

  return { name, message, stack };
}
