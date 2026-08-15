import type { FastifyPluginAsync } from "fastify";
import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleAddTrustlineRequest,
  handleSubmitRequest,
} from "@meridian/api-core";

export const txRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/deposit",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const result = await handleDepositRequest(req.body);
      if (result.error) {
        app.log.error({ err: result.error }, "[tx/deposit] build failed");
      }
      reply.code(result.status).send(result.body);
    }
  );

  app.post(
    "/withdraw",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const result = await handleWithdrawRequest(req.body);
      if (result.error) {
        app.log.error({ err: result.error }, "[tx/withdraw] build failed");
      }
      reply.code(result.status).send(result.body);
    }
  );

  app.post("/add-trustline", async (req, reply) => {
    const result = await handleAddTrustlineRequest(req.body);
    if (result.error) {
      app.log.error({ err: result.error }, "[tx/add-trustline] build failed");
    }
    reply.code(result.status).send(result.body);
  });

  app.post("/submit", async (req, reply) => {
    const result = await handleSubmitRequest(req.body);
    if (result.error) {
      app.log.error({ err: result.error }, "[tx/submit] failed");
    }
    reply.code(result.status).send(result.body);
  });
};
