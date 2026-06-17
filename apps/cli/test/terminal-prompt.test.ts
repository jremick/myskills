import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { createTerminalPrompt } from "../src/terminal-prompt.js";

test("terminal prompt consumes consecutive piped secret answers without echoing them", async () => {
  const input = Readable.from(["correct horse battery staple\n123456\n"]);
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const prompt = createTerminalPrompt({ input, output, terminal: false });

  try {
    assert.equal(await prompt.secret("Password: "), "correct horse battery staple");
    assert.equal(await prompt.secret("MFA code or recovery code: "), "123456");
  } finally {
    prompt.close();
  }

  const visibleOutput = chunks.join("");
  assert.match(visibleOutput, /Password:/);
  assert.match(visibleOutput, /MFA code or recovery code:/);
  assert.equal(visibleOutput.includes("correct horse"), false);
  assert.equal(visibleOutput.includes("123456"), false);
});
