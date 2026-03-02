import { readFile } from "node:fs/promises";
import path from "node:path";

async function maybeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function buildSystemPrompt(workspaceDir: string): Promise<string> {
  const files = [
    { name: "AGENTS.md", path: path.join(workspaceDir, "AGENTS.md") },
    { name: "TOOLS.md", path: path.join(workspaceDir, "TOOLS.md") },
    { name: "MEMORY.md", path: path.join(workspaceDir, "MEMORY.md") },
  ];

  const sections: string[] = [
    "You are running inside a lightweight enterprise agent harness.",
    "Use tools when they materially improve output quality.",
    "When citing retrieved memory, include source attribution.",
  ];

  for (const file of files) {
    const content = await maybeRead(file.path);
    if (!content) continue;
    sections.push(`\n## ${file.name}\n${content.trim()}\n`);
  }

  return sections.join("\n").trim();
}
