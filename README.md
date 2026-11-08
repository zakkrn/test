# Claude-agent for Microsoft Teams

En AI-agent som kobler seg til Microsoft Teams og svarer på meldinger ved hjelp av Claude (Anthropic).
Den er bygget med [Microsoft 365 Agents SDK](https://learn.microsoft.com/microsoft-365/agents-sdk/) og
[Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript).

## Funksjoner

- Fungerer i personlig chat, gruppechat og kanaler (i kanaler og grupper svarer den når den blir @nevnt)
- Husker samtalen per Teams-samtale, og komprimerer automatisk lange samtaler
- Viser «skriver …» mens Claude jobber, og håndterer lange svar uten tidsavbrudd
- Kommandoer: `/reset` (ny samtale) og `/hjelp`
- Svarer på samme språk som brukeren

## Struktur

```
src/index.ts         Teams-agenten (meldingshåndtering, kommandoer, server på /api/messages)
src/claude.ts        Kall til Claude API og samtalehistorikk
appPackage/          Teams-app-manifest og ikoner
.env.example         Mal for miljøvariabler
```

## Forutsetninger

- Node.js 22 eller nyere
- En Claude API-nøkkel fra [platform.claude.com](https://platform.claude.com)
- Tilgang til en Azure-konto og en Microsoft 365-tenant der du kan laste opp egne Teams-apper

## Oppsett

### 1. Installer og bygg

```bash
npm install
npm run build
cp .env.example .env
```

### 2. Opprett en Azure Bot

1. Gå til [Azure-portalen](https://portal.azure.com) → **Create a resource** → **Azure Bot**.
2. Velg **Single Tenant** som type og la Azure opprette en ny app-registrering.
3. Når boten er opprettet: gå til **Configuration** og noter **Microsoft App ID** og **App Tenant ID**.
4. Klikk **Manage Password** → **New client secret**, og kopier verdien.
5. Under **Channels**, legg til **Microsoft Teams**.

Fyll inn i `.env`:

```env
clientId=<Microsoft App ID>
clientSecret=<client secret>
tenantId=<App Tenant ID>
ANTHROPIC_API_KEY=<din Claude API-nøkkel>
```

### 3. Kjør agenten og eksponer den

```bash
npm start
```

Agenten lytter på `http://localhost:3978/api/messages`. Teams må nå den over HTTPS, så under
utvikling kan du bruke en tunnel, for eksempel [Dev Tunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/):

```bash
devtunnel host -p 3978 --allow-anonymous
```

Sett **Messaging endpoint** i Azure Bot → Configuration til `https://<tunnel-url>/api/messages`.

### 4. Installer appen i Teams

1. Erstatt `${{CLIENT_ID}}` i `appPackage/manifest.json` (to steder) med din Microsoft App ID,
   og oppdater gjerne `developer`-feltene.
2. Lag app-pakken: `npm run package` (lager `appPackage/teams-app.zip`).
3. I Teams: **Apps** → **Manage your apps** → **Upload an app** → **Upload a custom app**, og velg zip-filen.
4. Åpne en chat med agenten og si hei!

## Konfigurasjon

| Variabel | Standard | Beskrivelse |
|---|---|---|
| `clientId` / `clientSecret` / `tenantId` | – | Fra Azure Bot-registreringen |
| `ANTHROPIC_API_KEY` | – | Claude API-nøkkel |
| `PORT` | `3978` | Port serveren lytter på |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude-modell |
| `CLAUDE_EFFORT` | `medium` | Hvor grundig Claude tenker: `low`, `medium`, `high`, `xhigh`, `max` |
| `SYSTEM_PROMPT` | (innebygd) | Egen systemprompt som erstatter standarden |

Hvis Claudes sikkerhetsfilter avviser en forespørsel, prøver API-et automatisk på nytt med en
annen modell (server-side fallback).

## Begrensninger og videre arbeid

- Samtalehistorikken ligger i minnet og forsvinner ved omstart. For produksjon bør den lagres i
  f.eks. Azure Blob Storage eller Cosmos DB.
- Agenten leser bare tekst, ikke vedlegg eller bilder.
- For produksjon: kjør på f.eks. Azure App Service eller Azure Container Apps i stedet for en tunnel.
