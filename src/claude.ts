import Anthropic from "@anthropic-ai/sdk";
import type { ConversationRecord, ConversationStore } from "./history.js";

export const client = new Anthropic();

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.CLAUDE_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  [
    "Du er en hjelpsom assistent som svarer brukere i Microsoft Teams.",
    "Svar på samme språk som brukeren skriver på.",
    "Hold svarene konsise og lette å lese i en chat. Teams viser Markdown, så bruk gjerne lister og kodeblokker der det hjelper.",
    "I gruppesamtaler er hver melding merket med navnet på avsenderen i hakeparenteser.",
    "Filer brukeren legger ved kommer som bilder, PDF-dokumenter eller tekst i <fil>-tagger.",
  ].join("\n");

export interface UserTurn {
  content: Anthropic.Beta.BetaContentBlockParam[];
  /** Files uploaded for this turn; owned by the conversation once the turn is stored. */
  fileIds: string[];
}

export class ClaudeAgent {
  constructor(private readonly store: ConversationStore) {}

  async ask(conversationId: string, turn: UserTurn): Promise<string> {
    return this.store.withConversation(conversationId, async (record) => {
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        ...record.messages,
        { role: "user", content: turn.content },
      ];

      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages
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
      } catch (error) {
        await deleteFiles(turn.fileIds);
        throw error;
      }

      if (response.stop_reason === "refusal") {
        // Don't store a refused turn; the user can rephrase and try again.
        console.warn(`Refusal in conversation:`, response.stop_details?.category ?? "unknown");
        await deleteFiles(turn.fileIds);
        return { record, result: "Beklager, jeg kan ikke hjelpe med akkurat det." };
      }

      // Append the full content (thinking, compaction and fallback blocks included).
      messages.push({ role: "assistant", content: response.content });
      const updated = await trimCompacted({ messages, fileIds: [...record.fileIds, ...turn.fileIds] });

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const reply =
        response.stop_reason === "max_tokens" ? `${text}\n\n_(Svaret ble avkortet.)_` : text || "_(Tomt svar.)_";

      return { record: updated, result: reply };
    });
  }

  async reset(conversationId: string): Promise<void> {
    await this.store.withConversation(conversationId, async (record) => {
      await deleteFiles(record.fileIds);
      return { record: null, result: undefined };
    });
  }
}

/**
 * After server-side compaction the API ignores everything before the latest
 * compaction block, so drop those turns from storage (keeping the user turn
 * that produced it, so history still starts with a user message) and delete
 * uploaded files that nothing references any more.
 */
async function trimCompacted(record: ConversationRecord): Promise<ConversationRecord> {
  const { messages } = record;
  let compactionAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (messages[i].role === "assistant" && Array.isArray(content) && content.some((b) => b.type === "compaction")) {
      compactionAt = i;
      break;
    }
  }
  if (compactionAt < 1) return record;

  const kept = messages.slice(compactionAt - 1);
  const serialized = JSON.stringify(kept);
  const stillUsed = record.fileIds.filter((id) => serialized.includes(id));
  await deleteFiles(record.fileIds.filter((id) => !stillUsed.includes(id)));
  return { messages: kept, fileIds: stillUsed };
}

async function deleteFiles(ids: string[]): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      client.files.delete(id).catch((error) => console.warn(`Could not delete file ${id}:`, error)),
    ),
  );
}
