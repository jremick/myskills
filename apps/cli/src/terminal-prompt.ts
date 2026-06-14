import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { CliPrompt } from "./cli.js";

export interface TerminalPrompt extends CliPrompt {
  close: () => void;
}

export function createTerminalPrompt(options: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  terminal?: boolean;
} = {}): TerminalPrompt {
  const input = options.input ?? stdin;
  const output = new MuteableOutput(options.output ?? stdout);
  const terminal = options.terminal ?? Boolean((input as NodeJS.ReadStream).isTTY);
  if (!terminal) {
    return createPipedPrompt(input, output);
  }

  const rl = createInterface({ input, output, terminal });
  let closed = false;

  return {
    async text(label) {
      assertOpen(closed);
      output.muted = false;
      return await rl.question(label);
    },
    async secret(label) {
      assertOpen(closed);
      output.writeVisible(label);
      output.muted = true;
      try {
        return await rl.question("");
      } finally {
        output.muted = false;
        output.writeVisible("\n");
      }
    },
    close() {
      if (!closed) {
        closed = true;
        rl.close();
      }
    },
  };
}

function createPipedPrompt(input: NodeJS.ReadableStream, output: MuteableOutput): TerminalPrompt {
  let closed = false;
  let linesPromise: Promise<string[]> | null = null;
  let lines: string[] = [];

  return {
    async text(label) {
      assertOpen(closed);
      output.writeVisible(label);
      return await nextPipedLine();
    },
    async secret(label) {
      assertOpen(closed);
      output.writeVisible(label);
      try {
        return await nextPipedLine();
      } finally {
        output.writeVisible("\n");
      }
    },
    close() {
      closed = true;
    },
  };

  async function nextPipedLine(): Promise<string> {
    if (!linesPromise) {
      linesPromise = readPipedLines(input);
    }
    if (lines.length === 0) {
      lines = await linesPromise;
    }
    const next = lines.shift();
    if (next === undefined) {
      throw new Error("Prompt input ended before an answer was provided.");
    }
    return next;
  }
}

async function readPipedLines(input: NodeJS.ReadableStream): Promise<string[]> {
  let data = "";
  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  const lines = data.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

class MuteableOutput extends Writable {
  muted = false;

  constructor(private readonly visibleOutput: NodeJS.WritableStream) {
    super();
  }

  writeVisible(chunk: string): void {
    this.visibleOutput.write(chunk);
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) {
      this.visibleOutput.write(chunk);
    }
    callback();
  }
}

function assertOpen(closed: boolean): void {
  if (closed) {
    throw new Error("Prompt is closed.");
  }
}
