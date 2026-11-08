import { ConfidentialClientApplication } from "@azure/msal-node";

/** Files bigger than this are not downloaded from SharePoint/OneDrive. */
const MAX_BYTES = 50 * 1024 * 1024;

let msal: ConfidentialClientApplication | undefined;

/** True when the agent may read files shared in group chats and channels through Microsoft Graph. */
export function graphFileAccessEnabled(): boolean {
  return process.env.GRAPH_FILE_ACCESS === "true";
}

/** Whether `url` points at SharePoint or OneDrive for Business, where Teams stores shared files. */
export function isSharePointUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname.endsWith(".sharepoint.com") || hostname.endsWith(".sharepoint.us"));
  } catch {
    return false;
  }
}

export class GraphFileError extends Error {}

/**
 * Downloads a file Teams shared as a SharePoint/OneDrive link, using the bot's own
 * app registration (client credentials) and the Graph "shares" endpoint.
 * Needs the Graph application permission Files.Read.All or Sites.Read.All (or
 * Sites.Selected for specific sites), with admin consent.
 */
export async function downloadSharePointFile(url: string): Promise<{ content: Buffer; name: string; contentType: string }> {
  if (!isSharePointUrl(url)) throw new GraphFileError("Not a SharePoint URL");

  const token = await graphToken();
  const shareId = "u!" + Buffer.from(url, "utf8").toString("base64url");
  const base = `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem`;
  const headers = { Authorization: `Bearer ${token}` };

  const metaResponse = await fetch(`${base}?$select=name,size,file`, { headers });
  if (!metaResponse.ok) {
    throw new GraphFileError(`Graph returned ${metaResponse.status} for the file metadata`);
  }
  const meta = (await metaResponse.json()) as { name?: string; size?: number; file?: { mimeType?: string } };
  if ((meta.size ?? 0) > MAX_BYTES) {
    throw new GraphFileError(`File is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  }

  // Graph answers with a redirect to a short-lived, pre-authenticated download URL.
  const contentResponse = await fetch(`${base}/content`, { headers });
  if (!contentResponse.ok) {
    throw new GraphFileError(`Graph returned ${contentResponse.status} for the file content`);
  }
  const content = Buffer.from(await contentResponse.arrayBuffer());
  if (content.length > MAX_BYTES) throw new GraphFileError("File too large");

  return {
    content,
    name: meta.name ?? "vedlegg",
    contentType: meta.file?.mimeType ?? contentResponse.headers.get("content-type") ?? "application/octet-stream",
  };
}

async function graphToken(): Promise<string> {
  const clientId = process.env.clientId;
  const clientSecret = process.env.clientSecret;
  const tenantId = process.env.tenantId;
  if (!clientId || !clientSecret || !tenantId) {
    throw new GraphFileError("clientId, clientSecret and tenantId are required for Graph file access");
  }
  msal ??= new ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority: `https://login.microsoftonline.com/${tenantId}` },
  });
  const result = await msal.acquireTokenByClientCredential({ scopes: ["https://graph.microsoft.com/.default"] });
  if (!result?.accessToken) throw new GraphFileError("Could not get a Microsoft Graph token");
  return result.accessToken;
}
