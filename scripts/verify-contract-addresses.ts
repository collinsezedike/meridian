#!/usr/bin/env tsx
/**
 * Verifies that every vault contract address recorded in this repo actually
 * has on-chain bytecode matching the vault contract built from this repo's
 * own source, and that CONTRACT_ADDRESSES and KNOWN_POOLS agree with each
 * other on the vault address.
 *
 * This exists to catch a specific supply-chain risk: a PR can submit clean,
 * reviewable source while pointing a contract address at different,
 * unreviewed bytecode the contributor deployed themselves. Reviewing the
 * source diff alone cannot catch that; this script rebuilds the source and
 * compares its hash against what is actually live on-chain.
 *
 * Only the vault contract is checked, since it's the only contract whose
 * address is currently tracked in these two files and whose source lives in
 * this repo. Third-party contracts (Blend's pool, DeFindex's factory/vault,
 * the USDC/EURC issuers) can't be verified this way, since nobody here
 * controls their source.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_ADDRESSES } from "../packages/shared/src/constants";
import { KNOWN_POOLS } from "../packages/stellar-sdk-helpers/src/known-pools";

const CONTRACTS_DIR = join(__dirname, "..", "packages", "contracts");
const BUILT_WASM_PATH = join(
  CONTRACTS_DIR,
  "target",
  "wasm32v1-none",
  "release",
  "meridian_vault.wasm"
);

interface VerifyTarget {
  label: string;
  network: "testnet" | "mainnet";
  address: string;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry<T>(
  fn: () => T,
  { attempts = 3, delayMs = 3000 } = {}
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.warn(
          `  attempt ${i + 1}/${attempts} failed, retrying in ${delayMs}ms...`
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

async function fetchOnChainHash(
  address: string,
  network: string
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "meridian-verify-"));
  const outFile = join(dir, `${address}.wasm`);
  await retry(() => {
    execFileSync(
      "stellar",
      [
        "contract",
        "fetch",
        "--id",
        address,
        "--network",
        network,
        "-o",
        outFile,
      ],
      { stdio: "inherit" }
    );
  });
  return sha256(outFile);
}

function collectTargets(): VerifyTarget[] {
  const targets: VerifyTarget[] = [];
  for (const network of ["testnet", "mainnet"] as const) {
    const address = CONTRACT_ADDRESSES[network].vault;
    if (address) {
      targets.push({
        label: `CONTRACT_ADDRESSES.${network}.vault`,
        network,
        address,
      });
    }
  }

  const knownPoolAddress = KNOWN_POOLS.testnet["meridian-usdc"]?.contractId;
  if (knownPoolAddress) {
    targets.push({
      label: 'KNOWN_POOLS.testnet["meridian-usdc"].contractId',
      network: "testnet",
      address: knownPoolAddress,
    });
  }

  return targets;
}

function checkInternalConsistency(targets: VerifyTarget[]): boolean {
  const testnetAddresses = new Set(
    targets.filter((t) => t.network === "testnet").map((t) => t.address)
  );
  if (testnetAddresses.size > 1) {
    console.error(
      "MISMATCH: CONTRACT_ADDRESSES.testnet.vault and " +
        'KNOWN_POOLS.testnet["meridian-usdc"].contractId disagree on the ' +
        `vault address: ${[...testnetAddresses].join(", ")}`
    );
    return false;
  }
  return true;
}

async function main() {
  const targets = collectTargets();

  if (targets.length === 0) {
    console.log("No vault addresses configured, nothing to verify.");
    return;
  }

  if (!checkInternalConsistency(targets)) {
    process.exit(1);
  }

  console.log("Building vault contract from source...");
  execFileSync("stellar", ["contract", "build"], {
    cwd: CONTRACTS_DIR,
    stdio: "inherit",
  });

  if (!existsSync(BUILT_WASM_PATH)) {
    console.error(`Expected built WASM not found at ${BUILT_WASM_PATH}`);
    process.exit(1);
  }
  const builtHash = sha256(BUILT_WASM_PATH);
  console.log(`Locally built vault WASM hash: ${builtHash}`);

  let failed = false;
  const seenAddresses = new Set<string>();
  for (const target of targets) {
    const dedupeKey = `${target.network}:${target.address}`;
    if (seenAddresses.has(dedupeKey)) continue;
    seenAddresses.add(dedupeKey);

    console.log(
      `Verifying ${target.label} (${target.address}) on ${target.network}...`
    );
    const onChainHash = await fetchOnChainHash(target.address, target.network);
    console.log(`  on-chain hash: ${onChainHash}`);

    if (onChainHash !== builtHash) {
      console.error(
        `MISMATCH: ${target.label} (${target.address}) on-chain bytecode ` +
          "does not match the vault contract built from this repo's source."
      );
      failed = true;
    } else {
      console.log("  OK: matches locally built source.");
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log("All contract addresses verified against on-chain bytecode.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
