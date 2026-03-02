import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { globSync } from "glob";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { createWhitelistedBashOperations } from "../security/bash-policy.js";
import { DEFAULT_ALLOWED_BASH_COMMANDS } from "../security/defaults.js";
import { validatePath } from "../security/path-validation.js";

export interface SandboxedToolsOptions {
  userDir: string;
  allowedCommands?: string[];
}

export function createSandboxedTools(options: SandboxedToolsOptions): AgentTool<any>[] {
  const userDir = path.resolve(options.userDir);
  const allowedCommands = options.allowedCommands?.length
    ? options.allowedCommands
    : [...DEFAULT_ALLOWED_BASH_COMMANDS];

  const readOnlyPath = (requestedPath: string): string => validatePath(requestedPath, userDir, false);
  const writablePath = (requestedPath: string): string => validatePath(requestedPath, userDir, true);

  const readTool = createReadTool(userDir, {
    operations: {
      access: async (requestedPath) => {
        const safePath = readOnlyPath(requestedPath);
        await access(safePath, constants.R_OK);
      },
      readFile: async (requestedPath) => {
        const safePath = readOnlyPath(requestedPath);
        return readFile(safePath);
      },
    },
  });

  const writeTool = createWriteTool(userDir, {
    operations: {
      mkdir: async (requestedDir) => {
        const safeDir = writablePath(requestedDir);
        await mkdir(safeDir, { recursive: true });
      },
      writeFile: async (requestedPath, content) => {
        const safePath = writablePath(requestedPath);
        await writeFile(safePath, content, "utf8");
      },
    },
  });

  const editTool = createEditTool(userDir, {
    operations: {
      access: async (requestedPath) => {
        const safePath = writablePath(requestedPath);
        await access(safePath, constants.R_OK | constants.W_OK);
      },
      readFile: async (requestedPath) => {
        const safePath = writablePath(requestedPath);
        return readFile(safePath);
      },
      writeFile: async (requestedPath, content) => {
        const safePath = writablePath(requestedPath);
        await writeFile(safePath, content, "utf8");
      },
    },
  });

  const lsTool = createLsTool(userDir, {
    operations: {
      exists: async (requestedPath) => {
        try {
          const safePath = readOnlyPath(requestedPath);
          await access(safePath, constants.F_OK);
          return true;
        } catch {
          return false;
        }
      },
      stat: async (requestedPath) => {
        const safePath = readOnlyPath(requestedPath);
        return stat(safePath);
      },
      readdir: async (requestedPath) => {
        const safePath = readOnlyPath(requestedPath);
        return readdir(safePath);
      },
    },
  });

  const findTool = createFindTool(userDir, {
    operations: {
      exists: async (requestedPath) => {
        try {
          const safePath = readOnlyPath(requestedPath);
          await access(safePath, constants.F_OK);
          return true;
        } catch {
          return false;
        }
      },
      glob: (pattern, cwd, findOptions) => {
        if (pattern.split(/[\\/]+/).includes("..")) {
          throw new Error(`Blocked path traversal in glob pattern: ${pattern}`);
        }

        const safeCwd = readOnlyPath(cwd);
        const results = globSync(pattern, {
          cwd: safeCwd,
          dot: true,
          absolute: true,
          nodir: false,
          ignore: findOptions.ignore,
        }).slice(0, findOptions.limit);

        return results.map((match) => readOnlyPath(match));
      },
    },
  });

  const grepTool = createGrepTool(userDir, {
    operations: {
      isDirectory: async (requestedPath) => {
        const safePath = readOnlyPath(requestedPath);
        return (await stat(safePath)).isDirectory();
      },
      readFile: async (requestedPath) => {
        const safePath = readOnlyPath(requestedPath);
        return readFile(safePath, "utf8");
      },
    },
  });

  const bashTool = createBashTool(userDir, {
    operations: createWhitelistedBashOperations({
      allowedCommands,
      userDir,
      binDir: path.join(userDir, "bin"),
    }),
  });

  return [readTool, bashTool, editTool, writeTool, grepTool, findTool, lsTool];
}
