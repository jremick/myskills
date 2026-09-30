/** CLI adapters share the existing transport and credential store. Authorization
 * remains in the API; command routing never upgrades the supplied credential. */
export interface ParityCommandInput {
  command: string;
  args: string[];
  options: Record<string, string | boolean | string[]>;
}

export interface ParityCommandContext {
  request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    auth?: "required" | "optional" | "none",
  ): Promise<Record<string, unknown>>;
  readInput(path: string): Promise<Record<string, unknown>>;
  secret(label: string): Promise<string>;
  output(value: unknown): void;
  writeOutput(path: string, contents: string): Promise<void>;
}
