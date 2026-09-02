import type { FastifyPluginAsync } from "fastify";
import { handleGetKeeperHealth } from "@meridian/api-core";

// Only the read-only health check is mirrored here for local dev — unlike
// /api/v1/vaults, accrue/rebalance are cron-invoked Vercel functions that
// sign real transactions off a funded keeper account and are deliberately
// not wired into the local Fastify server.
export const keepersRoute: FastifyPluginAsync = async (app) => {
  app.get("/health", async (_req, reply) => {
    const result = await handleGetKeeperHealth();
    if (result.error) {
      app.log.error(result.error, "[keepers] failed to read keeper health");
    }
    return reply.code(result.status).send(result.body);
  });
};
