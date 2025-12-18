const FRONTEND_ACTION_PREFIX = "frontend.";

export function emojiForContext({ status, action, sourceSystem } = {}) {
  if (typeof action === "string" && action.startsWith(FRONTEND_ACTION_PREFIX)) return "🖥️";
  if (sourceSystem === "mina-frontend") return "🖥️";
  if (typeof action === "string" && action.startsWith("process.unhandledRejection")) return "🧵";
  if (typeof action === "string" && action.startsWith("process.uncaughtException")) return "💥";
  if (status === 401 || status === 403) return "🚫";
  if (typeof status === "number" && status >= 500) return "🔥";
  if (status === 408 || status === 504) return "⏱️";
  return "⚠️";
}

export function formatErrorCode(emoji, code = "ERROR") {
  const resolvedEmoji = emoji || "⚠️";
  const resolvedCode = typeof code === "string" && code.trim() ? code.trim() : "ERROR";
  return `${resolvedEmoji} ${resolvedCode}`;
}
