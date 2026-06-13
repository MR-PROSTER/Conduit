const AGENT_KEYWORDS = [
  "edit",
  "create file",
  "refactor",
  "implement",
  "fix",
  "rewrite",
  "change",
  "update",
  "delete",
  "remove",
  "move",
  "rename",
  "extract",
  "split",
];

const FILE_PATH_RE =
  /(?:`[^`]+`|['"][^'"]+['"]|(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|cs|cpp|c|h|html|css|scss|yml|yaml|txt))/i;

export type Intent = "chat" | "agent";

export class IntentRouter {
  static classifyIntent(message: string): Intent {
    const trimmed = message.trim();
    if (!trimmed) {
      return "chat";
    }

    const lower = trimmed.toLowerCase();
    const hasFilePath = FILE_PATH_RE.test(trimmed);
    const hasAgentVerb = AGENT_KEYWORDS.some((keyword) => lower.includes(keyword));

    if (hasFilePath && hasAgentVerb) {
      return "agent";
    }

    if (hasFilePath && /\b(file|folder|directory|module|component|class|function)\b/i.test(trimmed)) {
      return "agent";
    }

    if (hasAgentVerb && /\bplease\b|\bcould you\b|\bcan you\b|\bneed to\b/i.test(trimmed)) {
      return "agent";
    }

    return "chat";
  }
}
