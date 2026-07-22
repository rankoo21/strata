// Deploy StrataContract to a GenLayer network.
//
// Reads the deploy key from .env.deploy (gitignored). Never commit that file.
//
//   node scripts/deploy.mjs
//
// Env (.env.deploy):
//   GENLAYER_PRIVATE_KEY   required, hex, 0x optional
//   GENLAYER_NETWORK       studionet | bradbury (default) | localnet
//   GENLAYER_RPC_URL       optional override (custom networks only)
//
// On success it prints the deployed address and writes it back into
// .env.deploy as STRATA_CONTRACT_ADDRESS, and prints the frontend env lines.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createClient, createAccount } from "genlayer-js";
import { studionet, testnetBradbury, localnet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const envPath = join(root, ".env.deploy");
const contractPath = join(root, "contracts", "SpecMatchContract.py");

function parseEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function pickChain(name) {
  switch ((name ?? "bradbury").toLowerCase()) {
    case "bradbury":
    case "testnet-bradbury":
    case "testnetbradbury":
      return testnetBradbury;
    case "localnet":
      return localnet;
    case "studionet":
      return studionet;
    default:
      return testnetBradbury;
  }
}

function writeBackAddress(path, address) {
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/^SPECMATCH_CONTRACT_ADDRESS=.*$/m.test(text)) {
    text = text.replace(/^SPECMATCH_CONTRACT_ADDRESS=.*$/m, `SPECMATCH_CONTRACT_ADDRESS=${address}`);
  } else {
    text += (text.endsWith("\n") || text === "" ? "" : "\n") + `SPECMATCH_CONTRACT_ADDRESS=${address}\n`;
  }
  writeFileSync(path, text);
}

async function main() {
  const env = parseEnv(envPath);
  const pk = env.GENLAYER_PRIVATE_KEY;
  if (!pk) {
    console.error("Missing GENLAYER_PRIVATE_KEY in .env.deploy. Paste your funded account key there.");
    process.exit(1);
  }
  const networkName = env.GENLAYER_NETWORK || "bradbury";
  const chain = pickChain(networkName);
  const account = createAccount(pk.startsWith("0x") ? pk : `0x${pk}`);

  console.log(`Network:  ${networkName}`);
  console.log(`Deployer: ${account.address}`);

  const clientOpts = { chain, account };
  if (env.GENLAYER_RPC_URL) {
    clientOpts.endpoint = env.GENLAYER_RPC_URL;
  }
  const client = createClient(clientOpts);

  const code = readFileSync(contractPath);
  console.log("Deploying SpecMatchContract...");

  const txHash = await client.deployContract({ code, args: [] });
  console.log(`Deploy tx: ${txHash}`);
  console.log("Waiting for receipt (Bradbury can take a few minutes)...");

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
    interval: 6000,
    retries: 150,
  });

  // Bradbury receipts use camelCase and `recipient` holds the deployed address.
  const address =
    receipt?.data?.contract_address ??
    receipt?.contract_address ??
    receipt?.data?.contractAddress ??
    receipt?.contractAddress ??
    receipt?.recipient ??
    receipt?.to_address;

  if (!address) {
    console.error("Deploy accepted but no contract address was found in the receipt.");
    console.error("Inspect with: genlayer receipt " + txHash + " --stdout --stderr");
    process.exit(2);
  }

  console.log("");
  console.log("Deployed SpecMatchContract at:");
  console.log("  " + address);
  writeBackAddress(envPath, address);

  console.log("");
  console.log("Add these to your frontend env (.env.local) to read live:");
  console.log(`  NEXT_PUBLIC_SPECMATCH_MODE=contract`);
  console.log(`  NEXT_PUBLIC_SPECMATCH_CONTRACT=${address}`);
  console.log(`  NEXT_PUBLIC_SPECMATCH_NETWORK=${networkName}`);
}

main().catch((err) => {
  console.error("Deploy failed:", err?.message ?? err);
  process.exit(1);
});
