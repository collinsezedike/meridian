import type { FastifyPluginAsync } from "fastify";
import {
  APP_NETWORK,
  buildTxAddresses,
  isValidStellarAddress,
} from "@meridian/shared";
import { resolvePositions } from "@meridian/stellar-sdk-helpers";

export const positionsRoute: FastifyPluginAsync = async (app) => {
  app.get("/:publicKey", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };

    if (!publicKey || !isValidStellarAddress(publicKey)) {
      return reply.code(400).send({ error: "Invalid public key" });
    }

    try {
      const positions = await resolvePositions(
        publicKey,
        APP_NETWORK,
        buildTxAddresses(process.env.DEFINDEX_VAULT_ID)
      );
      reply.send({ positions });
    } catch (err) {
      app.log.error(err, "[positions] read failed");
      reply.code(503).send({ error: "Failed to read positions" });
    }
  });
};
