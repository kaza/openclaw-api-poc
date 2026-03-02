import { loadConfig } from "./config.js";
import { AgentHarness } from "./agent.js";
import { createApp } from "./http/app.js";

const { config } = await loadConfig();
const harness = new AgentHarness(config);
await harness.init();

const app = createApp(config, harness);

const server = app.listen(config.server.port, () => {
  console.log(`Agent harness listening on :${config.server.port}`);
});

async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  await harness.shutdown();
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
