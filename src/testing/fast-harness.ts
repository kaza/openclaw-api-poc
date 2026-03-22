import type { ChatHarness } from "../http/app.js";

interface FastUserState {
  rememberedSecret?: string;
}

function buildFastReply(state: FastUserState, text: string, audioFilePath?: string): string {
  const trimmed = text.trim();

  const exactTokenMatch = trimmed.match(/^Reply with exactly this token and nothing else:\s*(.+)$/i);
  if (exactTokenMatch) {
    return exactTokenMatch[1].trim();
  }

  const rememberSecretMatch = trimmed.match(/remember this exact secret token:\s*([A-Z0-9_:-]+)/i);
  if (rememberSecretMatch) {
    state.rememberedSecret = rememberSecretMatch[1].trim();
    const replyMatch = trimmed.match(/Reply with:\s*([^.!?\n]+[.!?]?)/i);
    return replyMatch?.[1]?.trim() ?? "stored.";
  }

  if (/What secret token did I ask you to remember earlier/i.test(trimmed)) {
    return state.rememberedSecret ?? "NO_SECRET";
  }

  if (audioFilePath) {
    return "Audio received and processed in fast test mode.";
  }

  if (!trimmed) {
    return "OK";
  }

  return `FAST_TEST_MODE: ${trimmed}`;
}

function emitDeltas(text: string, onDelta: (delta: string) => void): void {
  const words = text.split(/(\s+)/).filter(Boolean);
  if (words.length <= 1) {
    onDelta(text);
    return;
  }

  for (const chunk of words) onDelta(chunk);
}

export class FastTestHarness implements ChatHarness {
  private readonly users = new Map<string, FastUserState>();

  private getState(userId: string): FastUserState {
    let state = this.users.get(userId);
    if (!state) {
      state = {};
      this.users.set(userId, state);
    }
    return state;
  }

  async prompt(userId: string, text: string, audioFilePath?: string): Promise<string> {
    return buildFastReply(this.getState(userId), text, audioFilePath);
  }

  async promptStream(
    userId: string,
    text: string,
    handlers: {
      onDelta: (delta: string) => void;
      onDone: (fullText: string) => void;
    },
    audioFilePath?: string,
  ): Promise<void> {
    const reply = buildFastReply(this.getState(userId), text, audioFilePath);
    emitDeltas(reply, handlers.onDelta);
    handlers.onDone(reply);
  }
}
