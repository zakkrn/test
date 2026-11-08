// Builds appPackage/teams-app.zip with the bot's clientId filled into the manifest.
// Usage: npm run package   (reads clientId from .env or the environment)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "appPackage");
const clientId = process.env.clientId;
if (!clientId || !/^[0-9a-f-]{36}$/i.test(clientId)) {
  console.error("Set clientId (the Azure Bot's Microsoft App ID) in .env or the environment first.");
  process.exit(1);
}

const manifest = fs.readFileSync(path.join(dir, "manifest.json"), "utf8").replaceAll("${{CLIENT_ID}}", clientId);
const zip = new AdmZip();
zip.addFile("manifest.json", Buffer.from(manifest, "utf8"));
zip.addLocalFile(path.join(dir, "color.png"));
zip.addLocalFile(path.join(dir, "outline.png"));
const out = path.join(dir, "teams-app.zip");
zip.writeZip(out);
console.log(`Wrote ${out}`);
