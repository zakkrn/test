import Anthropic from "@anthropic-ai/sdk";
import { AgentApplication, MemoryStorage, TurnContext, TurnState } from "@microsoft/agents-hosting";
import { startServer } from "@microsoft/agents-hosting-express";
import { processAttachments } from "./attachments.js";
import { ClaudeAgent, client } from "./claude.js";
import { ConversationStore } from "./history.js";
import { createStorage } from "./storage.js";

const claude = new ClaudeAgent(new ConversationStore(createStorage()));

const agent = new AgentApplication<TurnState>({
  // Framework turn state is unused (history lives in ConversationStore), so memory is enough here.
  storage: new MemoryStorage(),
  // Shows "typing..." in Teams while Claude works.
  startTypingTimer: true,
  // Acknowledges the HTTP request right away and replies proactively, so
  // long Claude answers don't hit the Teams/Bot Service request timeout.
  longRunningMessages: true,
  // Strips "@Botname" from messages in channels and group chats.
  removeRecipientMention: true,
});

agent.onConversationUpdate("membersAdded", async (context: TurnContext) => {
  for (const member of context.activity.membersAdded ?? []) {
    if (member.id !== context.activity.recipient?.id) {
      await context.sendActivity(
        "Hei! Jeg er en AI-assistent drevet av Claude. Spør meg om hva som helst, eller send meg bilder og filer. Skriv `/reset` for å starte en ny samtale.",
      );
    }
  }
});

agent.onMessage(/^\s*\/(reset|ny|new)\s*$/i, async (context: TurnContext) => {
  await claude.reset(conversationKey(context));
  await context.sendActivity("Samtalen er nullstilt. 🧹");
});

agent.onMessage(/^\s*\/(help|hjelp)\s*$/i, async (context: TurnContext) => {
  await context.sendActivity(
    [
      "**Kommandoer**",
      "- `/reset` – start en ny samtale",
      "- `/hjelp` – vis denne hjelpen",
      "",
      "Ellers sender du bare en melding, så svarer jeg. Jeg kan lese bilder, PDF, Word, Excel, PowerPoint og tekstfiler.",
    ].join("\n"),
  );
});

agent.onActivity("message", async (context: TurnContext) => {
  const text = context.activity.text?.trim() ?? "";

  try {
    const attachments = await processAttachments(client, context);

    if (!text && attachments.blocks.length === 0) {
      await context.sendActivity(
        attachments.problems.length > 0 ? attachments.problems.join("\n") : "Send meg en melding eller en fil.",
      );
      return;
    }

    // In group chats and channels, tell Claude who is speaking.
    const isGroup = context.activity.conversation?.conversationType !== "personal";
    const sender = context.activity.from?.name ?? "Ukjent";
    const message = text || "(Ingen melding, bare vedlegg.)";
    const notes = attachments.problems.length > 0 ? `\n\n[Vedlegg som ikke kunne leses: ${attachments.problems.join(" ")}]` : "";

    const reply = await claude.ask(conversationKey(context), {
      content: [...attachments.blocks, { type: "text", text: `${isGroup ? `[${sender}]: ` : ""}${message}${notes}` }],
      fileIds: attachments.fileIds,
    });

    const warning = attachments.problems.length > 0 ? `\n\n_${attachments.problems.join(" ")}_` : "";
    await context.sendActivity(reply + warning);
  } catch (error) {
    console.error("Failed to handle message:", error);
    await context.sendActivity(friendlyError(error));
  }
});

function conversationKey(context: TurnContext): string {
  return context.activity.conversation?.id ?? "unknown";
}

function friendlyError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) {
    return "Det er mye trafikk akkurat nå. Prøv igjen om litt.";
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "Agenten er feilkonfigurert (ugyldig Claude API-nøkkel). Kontakt administrator.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Fikk ikke kontakt med Claude. Prøv igjen om litt.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Noe gikk galt hos Claude (feil ${error.status ?? "ukjent"}). Prøv igjen.`;
  }
  return "Noe gikk galt. Prøv igjen.";
}

startServer(agent);
