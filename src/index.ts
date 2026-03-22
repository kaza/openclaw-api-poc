import { loadConfig } from "./config.js";
import { AgentHarness } from "./agent.js";
import { createApp } from "./http/app.js";
import { FastTestHarness } from "./testing/fast-harness.js";

const { config } = await loadConfig();
const harness = process.env.HARNESS_TEST_MODE === "true" ? new FastTestHarness() : new AgentHarness(config);
if (harness instanceof AgentHarness) {
  await harness.init();
}

const app = createApp(config, harness);

const server = app.listen(config.server.port, () => {
  console.log(`Agent harness listening on :${config.server.port}`);
});

async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  if (harness instanceof AgentHarness) {
    await harness.shutdown();
  }
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
