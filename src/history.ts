import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Storage } from "@microsoft/agents-hosting";

export interface ConversationRecord {
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Files uploaded to the Anthropic Files API that this conversation references. */
  fileIds: string[];
}

/**
 * Persists conversation history and serializes turns per conversation, so two
 * messages arriving at once in the same chat can't overwrite each other's history.
 */
export class ConversationStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly storage: Storage) {}

  /** Runs `fn` with exclusive access to the conversation's record. */
  async withConversation<T>(
    conversationId: string,
    fn: (record: ConversationRecord) => Promise<{ record: ConversationRecord | null; result: T }>,
  ): Promise<T> {
    const key = storageKey(conversationId);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const items = await this.storage.read([key]);
      const stored = items[key] as ConversationRecord | undefined;
      const record: ConversationRecord = {
        messages: stored?.messages ?? [],
        fileIds: stored?.fileIds ?? [],
      };
      const { record: updated, result } = await fn(record);
      if (updated === null) {
        await this.storage.delete([key]);
      } else {
        // eTag "*" = last write wins; the in-process lock already serializes turns.
        await this.storage.write({ [key]: { ...updated, eTag: "*" } });
      }
      return result;
    });
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }
}

/** Teams conversation ids contain characters some backends reject, so hash them. */
function storageKey(conversationId: string): string {
  return `conversation-${createHash("sha256").update(conversationId).digest("hex")}`;
}
