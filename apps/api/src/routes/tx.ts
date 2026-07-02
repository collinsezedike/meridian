import type { FastifyPluginAsync } from "fastify";
import {
  APP_NETWORK,
  buildTxAddresses,
  DepositRequestSchema,
  WithdrawRequestSchema,
  TrustlineRequestSchema,
  SubmitRequestSchema,
  formatZodError,
  sanitizeTxError,
} from "@meridian/shared";
import {
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
} from "@meridian/stellar-sdk-helpers";

export const txRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/deposit",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = DepositRequestSchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: formatZodError(parsed.error) });

      try {
        const { walletAddress, vaultId, amount } = parsed.data;
        const result = await buildDepositTx(
          vaultId,
          walletAddress,
          amount,
          buildTxAddresses(process.env.DEFINDEX_VAULT_ID),
          APP_NETWORK
        );
        reply.send(result);
      } catch (err) {
        app.log.error({ err }, "[tx/deposit] build failed");
        reply.code(500).send({
          error: sanitizeTxError(err, "Failed to build deposit transaction"),
        });
      }
    }
  );

  app.post(
    "/withdraw",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = WithdrawRequestSchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: formatZodError(parsed.error) });

      try {
        const { walletAddress, vaultId, shares } = parsed.data;
        const result = await buildWithdrawTx(
          vaultId,
          walletAddress,
          shares,
          buildTxAddresses(process.env.DEFINDEX_VAULT_ID),
          APP_NETWORK
        );
        reply.send(result);
      } catch (err) {
        app.log.error({ err }, "[tx/withdraw] build failed");
        reply.code(500).send({
          error: sanitizeTxError(err, "Failed to build withdraw transaction"),
        });
      }
    }
  );

  app.post("/add-trustline", async (req, reply) => {
    const parsed = TrustlineRequestSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: formatZodError(parsed.error) });

    try {
      const result = await buildAddTrustlineTx(
        parsed.data.walletAddress,
        APP_NETWORK
      );
      reply.send(result);
    } catch (err) {
      app.log.error({ err }, "[tx/add-trustline] build failed");
      reply.code(500).send({
        error: sanitizeTxError(err, "Failed to build trustline transaction"),
      });
    }
  });

  app.post("/submit", async (req, reply) => {
    const parsed = SubmitRequestSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: formatZodError(parsed.error) });

    try {
      const result = await submitTx(parsed.data.xdr, APP_NETWORK);
      reply.send(result);
    } catch (err) {
      app.log.error({ err }, "[tx/submit] failed");
      reply
        .code(500)
        .send({ error: sanitizeTxError(err, "Failed to submit transaction") });
    }
  });
};
