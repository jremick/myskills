#!/usr/bin/env node
import { runCli, type FetchLike } from "./cli.js";

const fetchImpl = (globalThis as unknown as { fetch: FetchLike }).fetch;

const exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  fetch: fetchImpl,
  io: {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
});

process.exitCode = exitCode;
