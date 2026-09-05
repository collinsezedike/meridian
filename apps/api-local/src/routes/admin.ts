import type { FastifyPluginAsync } from "fastify";
import { handleGetVaultState } from "@meridian/api-core";

export const adminRoute: FastifyPluginAsync = async (app) => {
  app.get("/vault-state", async (_req, reply) => {
    const result = await handleGetVaultState();
    if (result.error) {
      app.log.error(result.error, "[admin] failed to read vault state");
    }
    return reply.code(result.status).send(result.body);
  });
};
