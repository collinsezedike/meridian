import type { FastifyPluginAsync } from "fastify";
import { handleGetVaults, handleGetVaultById } from "@meridian/api-core";

export const vaultsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    const result = await handleGetVaults();
    if (result.error) {
      app.log.error(result.error, "[vaults] failed to fetch vaults");
    }
    return reply.code(result.status).send(result.body);
  });

  app.get("/:vaultId", async (req, reply) => {
    const { vaultId } = req.params as { vaultId: string };
    const result = await handleGetVaultById(vaultId);
    if (result.error) {
      app.log.error(result.error, "[vaults] failed to fetch vault by id");
    }
    return reply.code(result.status).send(result.body);
  });
};
