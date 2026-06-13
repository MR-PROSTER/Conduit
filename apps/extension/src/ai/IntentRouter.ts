/**
 * Zero-latency intent classifier — no LLM call.
 * Determines if the user's message should use Ask (read-only) or Agent (edit) mode.
 *
 * Key design decisions:
 * - ASK patterns are checked first and always win over AGENT patterns.
 *   "how do I add a button?" is a question, not an edit request.
 * - Require minimum length before triggering agent — short messages are almost always questions.
 * - Negative-match phrases prevent false positives ("add more detail", "explain how to update").
 */
export type Intent = 'ask' | 'agent';

/**
 * These phrases look like questions BUT the action verb after them is a clear
 * edit command — route to agent. e.g. "can you divide app.py", "can you refactor this"
 */
const AGENT_REQUESTS: readonly RegExp[] = [
  /\bcan you (divide|split|refactor|restructure|reorganize|rewrite|implement|create|delete|rename|move|extract|replace|generate|build|convert|migrate|fix|add|remove|make|edit|update|change)\b/i,
  /\bplease (divide|split|refactor|restructure|reorganize|rewrite|implement|create|delete|rename|move|extract|replace|generate|build|convert|migrate|fix|add|remove|make|edit|update|change)\b/i,
  /\bcould you (divide|split|refactor|restructure|reorganize|rewrite|implement|create|delete|rename|move|extract|generate|build|convert|migrate|fix|make|edit)\b/i,
];

/** These phrases look like actions but are actually questions — keep as Ask mode. */
const QUESTION_PHRASES: readonly RegExp[] = [
  /^(how|what|why|when|where|is|are|could|should|would|does|do)\b/i,
  /^can (i|we|this|it|the|a)\b/i,   // "can I add" or "can this work" = question, not command
  /\bhow (do|does|can|should|would|to)\b/i,
  /\bwhat (is|are|does|do|should|would)\b/i,
  /\bwhy (is|are|does|do)\b/i,
  /\bcan you (explain|show|tell|describe|help|understand|clarify|summarize|list|find|check|look|see|show)\b/i,
  /\bexplain\b/i,
  /\bdescribe\b/i,
  /\btell me\b/i,
  /\bshow me\b/i,
  /\bwhere (is|are|does)\b/i,
  /\bis there\b/i,
  /\bunderstand\b/i,
  /\bwhat'?s\b/i,
  /\?\s*$/,          // ends with a question mark
];

/**
 * These phrases contain action verbs but in a context that means "give me more info",
 * not "edit my files". They prevent false-positive agent triggers.
 */
const QUESTION_OVERRIDES: readonly RegExp[] = [
  /\badd (more|some|a|an) (detail|context|info|information|example|explanation)\b/i,
  /\badd .{0,30} (to (this|your|the) (explanation|answer|description|example))\b/i,
  /\b(can you|please) (add|include|write|show)\b/i,
  /\bhow (to|do (i|you|we)) (add|create|update|fix|change|build|use|implement)\b/i,
  /\bwhat (should|would|do) (i|we|you) (add|create|update|fix|change|implement)\b/i,
];

/** These patterns strongly indicate the user wants the agent to actually edit files. */
const AGENT_PATTERNS: readonly RegExp[] = [
  /\brefactor\b/i,
  /\bimplement\b/i,
  /\brewrite\b/i,
  /\bextract\b/i,
  /\bmigrate\b/i,
  /\bconvert\b/i,
];

/**
 * These action verbs at the very start of the message strongly signal agent intent,
 * but only if the message is long enough (>= 6 words) to be a real command.
 */
const IMPERATIVE_VERBS = new Set([
  'fix', 'refactor', 'add', 'implement', 'create', 'delete',
  'rename', 'update', 'change', 'rewrite', 'move', 'extract',
  'replace', 'write', 'generate', 'build', 'convert', 'migrate',
  'remove', 'make', 'edit',
]);

export class IntentRouter {
  /**
   * Classify the user's input as 'ask' or 'agent'.
   * Runs synchronously with no network calls.
   */
  public static classify(input: string): Intent {
    const trimmed = input.trim();
    if (!trimmed) return 'ask';

    const words = trimmed.split(/\s+/);

    // Very short messages (1-3 words) are almost always questions or greetings
    if (words.length <= 3) return 'ask';

    // Question mark at end → always ask
    if (/\?\s*$/.test(trimmed)) return 'ask';

    // "can you divide / please refactor" — agent requests disguised as polite asks
    // Check these BEFORE question phrases so they aren't swallowed by "can you"
    if (AGENT_REQUESTS.some((p) => p.test(trimmed))) return 'agent';

    // Check question phrases — these win over simple action keywords
    if (QUESTION_PHRASES.some((p) => p.test(trimmed))) return 'ask';

    // Check question-override phrases (e.g. "how to add", "can you create")
    if (QUESTION_OVERRIDES.some((p) => p.test(trimmed))) return 'ask';

    // Strong agent patterns (refactor, rewrite, migrate, etc.)
    if (AGENT_PATTERNS.some((p) => p.test(trimmed))) return 'agent';

    // Imperative verb at the start of a long-enough message → agent
    const firstWord = words[0]?.toLowerCase() ?? '';
    if (words.length >= 4 && IMPERATIVE_VERBS.has(firstWord)) return 'agent';

    // Default to ask — safe, non-destructive
    return 'ask';
  }
}
