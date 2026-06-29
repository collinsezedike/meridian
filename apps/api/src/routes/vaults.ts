import type { FastifyPluginAsync } from "fastify";
import { selectBestVault, isVaultCacheWarm } from "@meridian/stellar-sdk-helpers";
import { isDefindexConfigured } from "@meridian/shared";
import { fetchAllVaults } from "../services/vaults.js";

export const vaultsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    try {
      const cached = isVaultCacheWarm();
      const vaults = await fetchAllVaults();
      const best = selectBestVault(vaults, { defindexConfigured: isDefindexConfigured() });
      return reply.send({
        vaults,
        recommendedVaultId: best?.id ?? null,
        updatedAt: new Date().toISOString(),
        cached,
      });
    } catch (err) {
      app.log.error(err, "[vaults] failed to fetch vaults");
      return reply.code(500).send({ error: "Failed to fetch vaults" });
    }
  });

  app.get("/:vaultId", async (req, reply) => {
    try {
      const { vaultId } = req.params as { vaultId: string };
      const vaults = await fetchAllVaults();
      const vault = vaults.find((v) => v.id === vaultId);
      if (!vault) return reply.code(404).send({ error: "vault not found", vaultId });
      return reply.send(vault);
    } catch (err) {
      app.log.error(err, "[vaults] failed to fetch vault by id");
      return reply.code(500).send({ error: "Failed to fetch vault" });
    }
  });
};
