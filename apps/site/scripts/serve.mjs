import { createServer } from "node:http";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve, sep, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT ?? 4188);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Use a port between 1 and 65535.");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    let path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      response.writeHead(404).end("Not found");
      return;
    }
    // Preview assets must remain inside plain dist directories and below 16 MiB.
    let handle, content;
    try {
      await noSymlinks(path);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let info = await handle.stat();
      if (info.isDirectory()) {
        await handle.close(); handle = undefined;
        path = resolve(path, "index.html");
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        info = await handle.stat();
      }
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Preview asset must be a bounded regular file.");
      await noSymlinks(path);
      const named = await lstat(path);
      if (!named.isFile() || named.dev !== info.dev || named.ino !== info.ino) throw new Error("Preview asset changed while opening.");
      content = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < content.length) {
        const { bytesRead } = await handle.read(content, length, content.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== info.size || (await handle.stat()).size !== info.size) throw new Error("Preview asset size changed while reading.");
      content = content.subarray(0, length);
    } finally { await handle?.close(); }
    response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`MySkills static site preview: http://127.0.0.1:${port}\n`);
});

async function noSymlinks(path) {
  let current = root;
  const info = await lstat(current);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Preview root must be a plain directory.");
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Preview symlinks are not allowed.");
  }
}
