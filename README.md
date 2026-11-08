# Claude-agent for Microsoft Teams

En AI-agent som kobler seg til Microsoft Teams og svarer på meldinger ved hjelp av Claude (Anthropic).
Den er bygget med [Microsoft 365 Agents SDK](https://learn.microsoft.com/microsoft-365/agents-sdk/) og
[Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript).

## Funksjoner

- Fungerer i personlig chat, gruppechat og kanaler (i kanaler og grupper svarer den når den blir @nevnt)
- **Husker samtalen permanent**: historikken lagres på disk, i Azure Blob Storage eller i Azure Cosmos DB
  og overlever omstart. Lange samtaler komprimeres automatisk.
- **Leser vedlegg**: bilder (PNG, JPEG, GIF, WebP), PDF, Word, Excel, PowerPoint (og OpenDocument/RTF),
  CSV og tekst- og kodefiler
- **Leser filer i gruppechat og kanaler** via Microsoft Graph (valgfritt, se under)
- **Kan kjøre flere instanser** med delt lås i Redis
- Viser «skriver …» mens Claude jobber, og håndterer lange svar uten tidsavbrudd
- Kommandoer: `/reset` (ny samtale, sletter også opplastede filer) og `/hjelp`
- Svarer på samme språk som brukeren
- Ferdig Dockerfile og deploy-skript for Azure Container Apps

## Struktur

```
src/index.ts                 Teams-agenten (meldinger, kommandoer, server på /api/messages)
src/claude.ts                Kall til Claude API, historikk og opprydding av filer
src/attachments.ts           Nedlasting og konvertering av vedlegg
src/history.ts               Lagring av samtaler, med lås per samtale
src/lock.ts                  Låser: i prosessen, eller delt i Redis
src/graph.ts                 Nedlasting av SharePoint/OneDrive-filer via Microsoft Graph
src/storage.ts               Valg av lagring (fil, Blob, Cosmos DB, minne)
appPackage/                  Teams-app-manifest og ikoner
scripts/package.mjs          Lager Teams-app-pakken (zip)
deploy/azure-container-apps.sh  Deploy til Azure
Dockerfile                   Container-image
```

## Forutsetninger

- Node.js 22 eller nyere
- En Claude API-nøkkel fra [platform.claude.com](https://platform.claude.com)
- Tilgang til en Azure-konto og en Microsoft 365-tenant der du kan laste opp egne Teams-apper

## Kom i gang lokalt

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

Agenten lytter på `http://localhost:3978/api/messages` og lagrer historikk i `./data`. Teams må nå den over HTTPS,
så under utvikling kan du bruke en tunnel, for eksempel [Dev Tunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/):

```bash
devtunnel host -p 3978 --allow-anonymous
```

Sett **Messaging endpoint** i Azure Bot → Configuration til `https://<tunnel-url>/api/messages`.

### 4. Installer appen i Teams

1. Kjør `npm run package`. Skriptet fyller inn `clientId` fra `.env` i manifestet og lager `appPackage/teams-app.zip`.
   Oppdater gjerne `developer`-feltene i `appPackage/manifest.json` først.
2. I Teams: **Apps** → **Manage your apps** → **Upload an app** → **Upload a custom app**, og velg zip-filen.
3. Åpne en chat med agenten og si hei!

## Produksjon: Azure Container Apps

`deploy/azure-container-apps.sh` setter opp alt i Azure og kobler boten til:

- en lagringskonto med Blob-container for samtalehistorikken
- et container-register, der imaget bygges i Azure (ingen lokal Docker nødvendig)
- en Container App med HTTPS, der hemmeligheter lagres som Container Apps-secrets
- oppdaterer Azure Botens messaging endpoint til appens adresse

```bash
az login
# Legg BOT_NAME og BOT_RESOURCE_GROUP i .env i tillegg til nøklene over
./deploy/azure-container-apps.sh
```

Skriptet krever Azure CLI 2.70 eller nyere og Node.js, og kan kjøres på nytt for å rulle ut en ny versjon.
Region er `norwayeast` som standard (endre med `LOCATION`). Valg:

- `REPLICAS=3` kjører tre instanser og oppretter en Azure Cache for Redis til låsen (tar 15–20 minutter første gang).
  Har du allerede en Redis, sett `REDIS_URL` i stedet.
- `GRAPH_FILE_ACCESS=true` gir appen Graph-tillatelsen `Files.Read.All` og godkjenner den for organisasjonen.
  Det krever at du er logget inn som Global Administrator eller Privileged Role Administrator. Les sikkerhetsavsnittet under først.

Vil du kjøre containeren et annet sted:

```bash
docker build -t teams-claude-agent .
docker run -p 3978:3978 --env-file .env -e STORAGE_TYPE=blob -e BLOB_CONNECTION_STRING=... teams-claude-agent
```

## Konfigurasjon

| Variabel | Standard | Beskrivelse |
|---|---|---|
| `clientId` / `clientSecret` / `tenantId` | – | Fra Azure Bot-registreringen |
| `ANTHROPIC_API_KEY` | – | Claude API-nøkkel |
| `STORAGE_TYPE` | `file` | `file`, `blob`, `cosmos` eller `memory` |
| `STORAGE_FOLDER` | `./data` | Mappe for `file`-lagring |
| `BLOB_CONNECTION_STRING` / `BLOB_CONTAINER` | – / `teams-agent-state` | For `blob`-lagring |
| `COSMOS_ENDPOINT` / `COSMOS_KEY` / `COSMOS_DATABASE` / `COSMOS_CONTAINER` | – / – / `teams-agent` / `state` | For `cosmos`-lagring |
| `REDIS_URL` | – | Redis for delt lås når flere instanser kjører, f.eks. `rediss://:<nøkkel>@<vert>:6380` |
| `GRAPH_FILE_ACCESS` | `false` | `true` lar agenten hente filer som deles i gruppechat og kanaler |
| `PORT` | `3978` | Port serveren lytter på |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude-modell |
| `CLAUDE_EFFORT` | `medium` | Hvor grundig Claude tenker: `low`, `medium`, `high`, `xhigh`, `max` |
| `SYSTEM_PROMPT` | (innebygd) | Egen systemprompt som erstatter standarden |

## Slik fungerer vedlegg

- **Bilder og PDF** lastes opp til Anthropic Files API. Samtalehistorikken lagrer bare fil-ID-en, ikke selve filen,
  så lagringen holder seg liten. Filene slettes ved `/reset` og når de ikke lenger er med i den komprimerte historikken.
- **Office-dokumenter** gjøres om til Markdown (tabeller beholdes), og **tekstfiler** sendes som tekst.
  Filer over 500 000 tegn avvises med en beskjed, så de blir aldri kuttet uten at du får vite det.
- I **personlig chat** lastes filer ned direkte fra Teams.
- I **gruppechat og kanaler** deler Teams filer som SharePoint/OneDrive-lenker. Med `GRAPH_FILE_ACCESS=true` henter
  agenten dem via Microsoft Graph med sin egen app-identitet (maks 50 MB). Uten det sier agenten fra om hvilke
  vedlegg den ikke fikk lest. Bare lenker til `*.sharepoint.com` hentes.

### Sikkerhet ved Graph-tilgang

`Files.Read.All` som applikasjonstillatelse lar agenten lese **alle** filer i organisasjonens SharePoint og OneDrive,
uavhengig av hvem som spør. En bruker som får lagt ved en lenke til en fil vedkommende selv ikke har tilgang til,
kan dermed få agenten til å lese og oppsummere den. Vurder derfor:

- å bruke `Sites.Selected` i stedet, og gi appen tilgang bare til de SharePoint-områdene den trenger
  (da må tillatelsen settes opp manuelt, ikke med deploy-skriptet)
- å la funksjonen være av hvis agenten brukes i kanaler med mange deltakere eller gjester

## Ting å vite

- Meldinger i samme samtale behandles én om gangen. Uten `REDIS_URL` gjelder det bare innenfor én prosess,
  så kjør da bare én instans. Med Redis kan du kjøre så mange instanser du vil. Låsen fornyes mens Claude svarer,
  og frigjøres av seg selv etter ett minutt hvis en instans krasjer.
- `file`-lagring passer på én maskin. I containere forsvinner disken ved ny utrulling, så bruk `blob` eller `cosmos` der.
- Hvis Claudes sikkerhetsfilter avviser en forespørsel, prøver API-et automatisk på nytt med en annen modell
  (server-side fallback).
