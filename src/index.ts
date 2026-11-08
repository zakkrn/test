import Anthropic from "@anthropic-ai/sdk";
import { AgentApplication, MemoryStorage, TurnContext, TurnState } from "@microsoft/agents-hosting";
import { startServer } from "@microsoft/agents-hosting-express";
import { askClaude, resetConversation } from "./claude.js";

const agent = new AgentApplication<TurnState>({
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
        "Hei! Jeg er en AI-assistent drevet av Claude. Spør meg om hva som helst. Skriv `/reset` for å starte en ny samtale.",
      );
    }
  }
});

agent.onMessage(/^\s*\/(reset|ny|new)\s*$/i, async (context: TurnContext) => {
  resetConversation(conversationKey(context));
  await context.sendActivity("Samtalen er nullstilt. 🧹");
});

agent.onMessage(/^\s*\/(help|hjelp)\s*$/i, async (context: TurnContext) => {
  await context.sendActivity(
    "**Kommandoer**\n- `/reset` – start en ny samtale\n- `/hjelp` – vis denne hjelpen\n\nEllers sender du bare en melding, så svarer jeg.",
  );
});

agent.onActivity("message", async (context: TurnContext) => {
  const text = context.activity.text?.trim();
  if (!text) {
    await context.sendActivity("Jeg kan foreløpig bare lese tekstmeldinger.");
    return;
  }

  // In group chats and channels, tell Claude who is speaking.
  const isGroup = context.activity.conversation?.conversationType !== "personal";
  const sender = context.activity.from?.name ?? "Ukjent";
  const prompt = isGroup ? `[${sender}]: ${text}` : text;

  try {
    const reply = await askClaude(conversationKey(context), prompt);
    await context.sendActivity(reply);
  } catch (error) {
    console.error("Claude request failed:", error);
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
