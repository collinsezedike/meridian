import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env.local first (developer overrides), then fall back to .env
config({ path: resolve(process.cwd(), "../../.env.local") });
config({ path: resolve(process.cwd(), "../../.env") });

import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";
import { vaultsRoute } from "./routes/vaults";
import { positionsRoute } from "./routes/positions";
import { txRoute } from "./routes/tx";

const app = Fastify({ logger: true });

await app.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? DEFAULT_ALLOWED_ORIGIN });
await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

app.register(vaultsRoute, { prefix: "/api/v1/vaults" });
app.register(positionsRoute, { prefix: "/api/v1/positions" });
app.register(txRoute, { prefix: "/api/v1/tx" });

app.get("/health", async () => ({ status: "ok" }));

try {
  await app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
