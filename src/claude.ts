import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.CLAUDE_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  [
    "Du er en hjelpsom assistent som svarer brukere i Microsoft Teams.",
    "Svar på samme språk som brukeren skriver på.",
    "Hold svarene konsise og lette å lese i en chat. Teams viser Markdown, så bruk gjerne lister og kodeblokker der det hjelper.",
    "I gruppesamtaler er hver melding merket med navnet på avsenderen i hakeparenteser.",
  ].join("\n");

/**
 * Conversation history per Teams conversation, kept in memory.
 * History is append-only (the full assistant content, including thinking
 * blocks, is stored as-is); server-side compaction keeps it within the
 * context window. Restarting the process clears all history.
 */
const conversations = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

export function resetConversation(conversationId: string): void {
  conversations.delete(conversationId);
}

export async function askClaude(conversationId: string, userText: string): Promise<string> {
  const history = conversations.get(conversationId) ?? [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: "user", content: userText }];

  const response = await client.beta.messages
    .stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ["compact-2026-01-12", "server-side-fallback-2026-07-01"],
      // On a safety-classifier decline, the API re-runs the request on a fallback model.
      fallbacks: "default",
      output_config: { effort: EFFORT },
      context_management: { edits: [{ type: "compact_20260112" }] },
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      messages,
    })
    .finalMessage();

  if (response.stop_reason === "refusal") {
    // Don't store a refused turn; the user can rephrase and try again.
    console.warn(`Refusal in ${conversationId}:`, response.stop_details?.category ?? "unknown");
    return "Beklager, jeg kan ikke hjelpe med akkurat det.";
  }

  // Store the full content (thinking, compaction and fallback blocks included).
  messages.push({ role: "assistant", content: response.content });
  conversations.set(conversationId, messages);

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (response.stop_reason === "max_tokens") {
    return `${text}\n\n_(Svaret ble avkortet.)_`;
  }
  return text || "_(Tomt svar.)_";
}
