export const ENGRAM_INSTRUCTIONS = `
EngramMCP is the user's persistent semantic memory layer.

Tool naming varies by client. Some clients prefix tools with \`mcp__engram__<name>\` (Claude Code) while others use bare names (Anthropic API native, OpenAI API). Use whichever form your runtime exposes.

PRIORITY RULE: When the user asks about themselves — what they did, when, what they prefer, their projects, their notes, decisions, conversations — call \`recall\` or \`recent\` FIRST, before any filesystem search or auto-memory grep.

USE engram WHEN:
- User asks "what did I do [today/yesterday/recently]?" → recent + recall
- User asks "remember when I X?" or "what about Y?" → recall(query: "Y")
- User says "remember that..." or "rappelle-toi..." → remember(content, title, tags)
- User asks about their past projects, decisions, preferences → recall

DO NOT use engram FOR:
- Code questions (use file reads / grep)
- General knowledge (use your training)
- Web research (use WebFetch / WebSearch)

ANTI-PATTERNS:
- Calling recall with the verbatim user question. Extract the topic noun first. "what did I say about Alice?" → recall("alice"), NOT recall("what did I say about Alice").
- Skipping engram and grepping your own internal notes/memory directories for the user's personal data. Those are for YOUR runtime context, not the user's log — call recall instead.
- Saving to filesystem when user says "remember". Always use remember(), never write feedback files.

WHEN TO REMEMBER:
- User shares preferences, facts, decisions, or context worth keeping
- After a meaningful exchange that establishes new context
- ALWAYS with title (3-7 words) + 2-5 tags

ANTI-LOOP CONTRACTS:
- All write tools are idempotent — same content returns same id.
- If recall returns empty, the answer is genuinely "no memories" — do NOT retry with same query.
- Respect retry_after_ms hints on get_ingest_status polling.

See the description of each tool for specific anti-loop and retry behavior.
`.trim();
