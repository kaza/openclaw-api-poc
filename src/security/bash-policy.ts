import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import { validatePathInUserDir } from "./path-validation.js";

const COMMAND_SEPARATORS = new Set(["|", "&&", "||", ";"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

export interface BashValidationOptions {
  allowedCommands: readonly string[];
  userDir: string;
  binDir: string;
}

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;

  const pushCurrent = () => {
    if (!current) return;
    tokens.push(current);
    current = "";
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (quote === "single") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        escaped = true;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "'") {
      quote = "single";
      continue;
    }

    if (char === '"') {
      quote = "double";
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "|" && next === "|") {
      pushCurrent();
      tokens.push("||");
      i += 1;
      continue;
    }

    if (char === "&" && next === "&") {
      pushCurrent();
      tokens.push("&&");
      i += 1;
      continue;
    }

    if (char === "|" || char === ";") {
      pushCurrent();
      tokens.push(char);
      continue;
    }

    current += char;
  }

  if (quote !== null) {
    throw new Error("Blocked bash command: unterminated quoted string");
  }

  pushCurrent();
  return tokens;
}

function shouldValidatePathArg(arg: string, userDir: string): boolean {
  if (!arg || arg.startsWith("-")) return false;

  if (
    arg === "." ||
    arg === ".." ||
    arg.startsWith("/") ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.includes("/") ||
    arg.includes("\\")
  ) {
    return true;
  }

  return existsSync(path.resolve(userDir, arg));
}

interface ParsedCommand {
  binary: string;
  args: string[];
}

function parseCommands(tokens: string[]): ParsedCommand[] {
  const chunks: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (COMMAND_SEPARATORS.has(token)) {
      if (!current.length) {
        throw new Error("Blocked bash command: invalid command chain");
      }
      chunks.push(current);
      current = [];
      continue;
    }

    current.push(token);
  }

  if (!current.length) {
    throw new Error("Blocked bash command: invalid command chain");
  }
  chunks.push(current);

  return chunks.map((chunk) => {
    let index = 0;
    while (index < chunk.length && ENV_ASSIGNMENT.test(chunk[index])) index += 1;

    const binary = chunk[index];
    if (!binary) throw new Error("Blocked bash command: missing executable name");

    return {
      binary,
      args: chunk.slice(index + 1),
    };
  });
}

export function validateBashCommand(command: string, options: BashValidationOptions): void {
  if (!command.trim()) {
    throw new Error("Blocked bash command: empty command");
  }

  if (command.includes("`") || command.includes("$(") || command.includes("<(") || command.includes(">(")) {
    throw new Error("Blocked bash command: backticks, subshells, and process substitution are not allowed");
  }

  const tokens = tokenizeCommand(command);
  const commands = parseCommands(tokens);
  const allowed = new Set(options.allowedCommands);

  for (const parsed of commands) {
    if (!allowed.has(parsed.binary)) {
      throw new Error(`Blocked bash command: '${parsed.binary}' is not in the allowed command whitelist`);
    }

    for (const arg of parsed.args) {
      if (!shouldValidatePathArg(arg, options.userDir)) continue;
      validatePathInUserDir(arg, options.userDir);
    }
  }
}

export function createWhitelistedBashOperations(options: BashValidationOptions): BashOperations {
  const userDir = path.resolve(options.userDir);
  const binDir = path.resolve(options.binDir);

  return {
    exec: async (command, _cwd, execOptions) => {
      validateBashCommand(command, options);

      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        const env = {
          ...process.env,
          ...execOptions.env,
          PATH: binDir,
          HOME: userDir,
        };

        const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
          cwd: userDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (execOptions.timeout && execOptions.timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, execOptions.timeout * 1000);
        }

        const onAbort = () => child.kill("SIGKILL");
        if (execOptions.signal) {
          if (execOptions.signal.aborted) {
            onAbort();
          } else {
            execOptions.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        child.stdout?.on("data", execOptions.onData);
        child.stderr?.on("data", execOptions.onData);

        child.on("error", (error) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          execOptions.signal?.removeEventListener("abort", onAbort);
          reject(error);
        });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          execOptions.signal?.removeEventListener("abort", onAbort);

          if (execOptions.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          if (timedOut) {
            reject(new Error(`timeout:${execOptions.timeout}`));
            return;
          }

          resolve({ exitCode: code });
        });
      });
    },
  };
}
