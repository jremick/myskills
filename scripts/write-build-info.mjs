import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Release automation supplies the exact source revision. Local builds explicitly
// report unknown rather than accidentally identifying dirty source as a commit.
const revision = process.env.MYSKILLS_BUILD_REVISION?.trim() || null;
if (revision !== null && !/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error("MYSKILLS_BUILD_REVISION must be a full lowercase Git commit SHA.");
}
const metadata = JSON.parse(await readFile("package.json", "utf8"));
const destination = resolve(process.argv[2] ?? "build-info.json");
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify({ version: metadata.version, revision })}\n`);
