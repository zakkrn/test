import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { M365AttachmentDownloader, type TurnContext } from "@microsoft/agents-hosting";
import type { Attachment } from "@microsoft/agents-activity";
import { convert } from "officeparser";
import { downloadSharePointFile, graphFileAccessEnabled, isSharePointUrl } from "./graph.js";

type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

export interface ProcessedAttachments {
  blocks: ContentBlock[];
  /** Ids of files uploaded to the Anthropic Files API during this turn. */
  fileIds: string[];
  /** Human-readable notes about attachments that could not be used. */
  problems: string[];
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const OFFICE_EXTENSIONS = new Set(["docx", "pptx", "xlsx", "odt", "odp", "ods", "rtf", "epub"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "html", "htm", "log", "ini", "toml",
  "js", "ts", "tsx", "jsx", "py", "java", "cs", "go", "rb", "php", "rs", "c", "cpp", "h", "sql", "sh", "ps1",
]);
const EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
};

/** Largest extracted text (characters) sent inline. Bigger files are rejected, never silently cut. */
const MAX_TEXT_CHARS = 500_000;

const downloader = new M365AttachmentDownloader();

/**
 * Downloads the attachments on the incoming Teams message and turns them into
 * Claude content blocks: images and PDFs go through the Anthropic Files API
 * (so history stores a small file id rather than the bytes), text and Office
 * documents are converted to text.
 */
export async function processAttachments(
  client: Anthropic,
  context: TurnContext,
): Promise<ProcessedAttachments> {
  const result: ProcessedAttachments = { blocks: [], fileIds: [], problems: [] };

  const attachments = (context.activity.attachments ?? []).filter(
    (a) => a.contentType && !a.contentType.startsWith("text/html") && !a.contentType.startsWith("application/vnd.microsoft.card"),
  );
  if (attachments.length === 0) return result;

  // Files shared in group chats and channels are SharePoint/OneDrive links. Those are
  // fetched through Microsoft Graph instead, so the bot's channel token never goes to SharePoint.
  const isShared = (a: Attachment) => a.contentType === "reference" || isSharePointUrl(a.contentUrl);
  const direct = attachments.filter((a) => !isShared(a));
  const files = direct.length > 0 ? await downloader.downloadFiles(withAttachments(context, direct)) : [];

  for (const attachment of attachments) {
    let name = attachment.name || "vedlegg";
    let file: { content: Buffer; contentType: string } | undefined;

    if (isShared(attachment)) {
      if (!graphFileAccessEnabled()) {
        result.problems.push(`«${name}» er delt som en SharePoint-fil, og agenten har ikke tilgang til slike filer (GRAPH_FILE_ACCESS er av).`);
        continue;
      }
      try {
        const downloaded = await downloadSharePointFile(attachment.contentUrl ?? "");
        file = downloaded;
        name = attachment.name || downloaded.name;
      } catch (error) {
        console.error(`Graph download failed for ${name}:`, error);
        result.problems.push(`Klarte ikke å hente «${name}» fra SharePoint.`);
        continue;
      }
    } else {
      file = files.find((f) => f.contentUrl && f.contentUrl === attachment.contentUrl);
    }

    if (!file) {
      result.problems.push(`Klarte ikke å laste ned «${name}».`);
      continue;
    }

    const ext = extensionOf(name, attachment.content);
    const mime = normalizeMime(file.contentType, attachment.contentType, ext);

    try {
      if (IMAGE_TYPES.has(mime)) {
        const id = await upload(client, file.content, name, mime);
        result.fileIds.push(id);
        result.blocks.push({ type: "image", source: { type: "file", file_id: id } });
      } else if (mime === "application/pdf") {
        const id = await upload(client, file.content, name, mime);
        result.fileIds.push(id);
        result.blocks.push({ type: "document", source: { type: "file", file_id: id }, title: name });
      } else if (OFFICE_EXTENSIONS.has(ext)) {
        const { value } = await convert(file.content, "md");
        pushText(result, name, String(value));
      } else if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/")) {
        pushText(result, name, file.content.toString("utf8"));
      } else {
        result.problems.push(`Filtypen til «${name}» støttes ikke.`);
      }
    } catch (error) {
      console.error(`Failed to process attachment ${name}:`, error);
      result.problems.push(`Klarte ikke å lese «${name}».`);
    }
  }

  return result;
}

/** A view of the turn context whose activity carries only the given attachments. */
function withAttachments(context: TurnContext, attachments: Attachment[]): TurnContext {
  const activity = Object.assign(Object.create(Object.getPrototypeOf(context.activity)), context.activity, { attachments });
  return Object.create(context, { activity: { value: activity } });
}

function pushText(result: ProcessedAttachments, name: string, text: string): void {
  if (text.length > MAX_TEXT_CHARS) {
    result.problems.push(`«${name}» er for stor (${text.length.toLocaleString("nb-NO")} tegn, maks ${MAX_TEXT_CHARS.toLocaleString("nb-NO")}).`);
    return;
  }
  result.blocks.push({ type: "text", text: `<fil navn="${name}">\n${text}\n</fil>` });
}

async function upload(client: Anthropic, content: Buffer, name: string, mime: string): Promise<string> {
  const uploaded = await client.files.upload({ file: await toFile(content, name, { type: mime }) });
  return uploaded.id;
}

function extensionOf(name: string, content: unknown): string {
  const fromContent = (content as { fileType?: unknown } | undefined)?.fileType;
  if (typeof fromContent === "string" && fromContent) return fromContent.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function normalizeMime(downloaded: string, declared: string | undefined, ext: string): string {
  for (const candidate of [downloaded, declared]) {
    const mime = candidate?.split(";")[0].trim().toLowerCase();
    if (mime && mime !== "application/octet-stream" && !mime.startsWith("application/vnd.microsoft.teams")) {
      return mime === "image/jpg" ? "image/jpeg" : mime;
    }
  }
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}
