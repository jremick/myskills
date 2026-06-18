#!/usr/bin/env node
import { runCli, type FetchLike } from "./cli.js";
import { createFileConfigStore } from "./config-store.js";
import { createTokenStore } from "./token-store.js";
import { createTerminalPrompt } from "./terminal-prompt.js";

const fetchImpl = (globalThis as unknown as { fetch: FetchLike }).fetch;
const prompt = createTerminalPrompt();

try {
  const exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    fetch: fetchImpl,
    configStore: createFileConfigStore(process.env),
    prompt,
    tokenStore: createTokenStore(process.env),
    io: {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    },
  });

  process.exitCode = exitCode;
} finally {
  prompt.close();
}
