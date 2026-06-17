#!/usr/bin/env node
import { runCli, type FetchLike } from "./cli.js";
import { createFileTokenStore } from "./token-store.js";
import { createTerminalPrompt } from "./terminal-prompt.js";

const fetchImpl = (globalThis as unknown as { fetch: FetchLike }).fetch;
const prompt = createTerminalPrompt();

try {
  const exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    fetch: fetchImpl,
    prompt,
    tokenStore: createFileTokenStore(process.env),
    io: {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    },
  });

  process.exitCode = exitCode;
} finally {
  prompt.close();
}
