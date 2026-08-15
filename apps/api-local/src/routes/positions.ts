import type { FastifyPluginAsync } from "fastify";
import { handleGetPositions } from "@meridian/api-core";

export const positionsRoute: FastifyPluginAsync = async (app) => {
  app.get("/:publicKey", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };

    const result = await handleGetPositions(publicKey);
    if (result.error) {
      app.log.error(result.error, "[positions] read failed");
    }
    reply.code(result.status).send(result.body);
  });
};
