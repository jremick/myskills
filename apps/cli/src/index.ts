#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { runCli, type CliPrompt, type FetchLike } from "./cli.js";
import { createFileTokenStore } from "./token-store.js";

const fetchImpl = (globalThis as unknown as { fetch: FetchLike }).fetch;

class MuteableOutput extends Writable {
  muted = false;

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) {
      process.stdout.write(chunk);
    }
    callback();
  }
}

const exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  fetch: fetchImpl,
  prompt: createTerminalPrompt(),
  tokenStore: createFileTokenStore(process.env),
  io: {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
});

process.exitCode = exitCode;

function createTerminalPrompt(): CliPrompt {
  return {
    async text(label) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(label);
      } finally {
        rl.close();
      }
    },
    async secret(label) {
      const output = new MuteableOutput();
      const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
      try {
        process.stdout.write(label);
        output.muted = true;
        return await rl.question("");
      } finally {
        output.muted = false;
        rl.close();
        process.stdout.write("\n");
      }
    },
  };
}
