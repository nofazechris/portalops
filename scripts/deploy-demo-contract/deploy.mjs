#!/usr/bin/env node
// Deploys PortalQuest (or --example token|bounty|arena) to the Portaldot V3.0 testnet.
//
//   npm run contract:deploy            dry run: checks chain, balance, gas; sends nothing
//   npm run contract:deploy -- --send  broadcasts the deployment transaction
//
// Reads PORTALDOT_DEPLOYER_PRIVATE_KEY from .env (git-ignored). The key is never printed or written anywhere.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress } from "viem";
import { accountFromEnv, assertChain, config, deploymentPathFor, fail, fmt, hasFlag, loadArtifact, publicClient, walletFor } from "./common.mjs";

const send = hasFlag("--send");
const artifact = loadArtifact();
const account = accountFromEnv("PORTALDOT_DEPLOYER_PRIVATE_KEY");

console.log(`Portaldot V3.0 testnet · ${config.rpcUrl}`);
console.log(`chain id  ${await assertChain()} (verified)`);
console.log(`deployer  ${account.address}`);

const [balance, nonce, gasPrice, head] = await Promise.all([
  publicClient.getBalance({ address: account.address }),
  publicClient.getTransactionCount({ address: account.address }),
  publicClient.getGasPrice(),
  publicClient.getBlockNumber(),
]);
console.log(`balance   ${fmt(balance)}`);
console.log(`nonce     ${nonce}`);
console.log(`gas price ${gasPrice} wei · head #${head}`);

if (balance === 0n) {
  fail("This account has zero balance on the EVM side. Fund the NATIVE 5… address that owns this 0x account: its 32-byte id is the 20-byte 0x address followed by twelve 0xEE bytes (see docs/architecture/network-compatibility.md, open question 2).");
}

let gas = config.gasLimit;
if (gas) {
  console.log(`gas limit ${gas} (from PORTALDOT_GAS_LIMIT)`);
} else {
  try {
    gas = await publicClient.estimateGas({ account, data: artifact.bytecode });
  } catch (e) {
    fail(`Gas estimation failed: ${e.shortMessage || e.message}\n  Set PORTALDOT_GAS_LIMIT in .env to override.`);
  }
  console.log(`gas est.  ${gas}`);
}

const maxCost = gas * gasPrice;
console.log(`max cost  ${fmt(maxCost)}`);
if (balance < maxCost) fail("Balance is lower than the maximum deployment cost. Fund the account or lower PORTALDOT_GAS_LIMIT.");

if (!send) {
  console.log("\nDry run only. Nothing was sent. Re-run with --send to deploy.");
  process.exit(0);
}

const wallet = walletFor(account);
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, gas, gasPrice, type: "legacy" });
console.log(`\ndeploy tx submitted: ${hash}`);
console.log("waiting for inclusion…");

const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 });
console.log(`included in block #${receipt.blockNumber} (${receipt.blockHash})`);
if (receipt.status !== "success") fail(`Deployment transaction was included but reverted (status ${receipt.status}).`);
if (!receipt.contractAddress) fail("Receipt has no contractAddress.");

const code = await publicClient.getCode({ address: receipt.contractAddress });
if (!code || code === "0x") fail("Transaction succeeded but no code is present at the contract address.");

const deployment = {
  network: "Portaldot V3.0 Testnet",
  chainId: config.chainId,
  rpcUrl: config.rpcUrl,
  contractName: artifact.contractName,
  contractAddress: getAddress(receipt.contractAddress),
  deployTransactionHash: hash,
  blockNumber: Number(receipt.blockNumber),
  blockHash: receipt.blockHash,
  gasUsed: String(receipt.gasUsed),
  deployer: account.address,
  deployedAt: new Date().toISOString(),
  compiler: artifact.compiler,
  runtimeCodeBytes: (code.length - 2) / 2,
  verification: "receipt status success; eth_getCode returned non-empty runtime bytecode",
};
const DEPLOYMENT_PATH = deploymentPathFor();
mkdirSync(dirname(DEPLOYMENT_PATH), { recursive: true });
writeFileSync(DEPLOYMENT_PATH, JSON.stringify(deployment, null, 2));

console.log(`\nDeployed ${artifact.contractName} at ${deployment.contractAddress}`);
console.log(`Evidence saved to ${DEPLOYMENT_PATH}`);
console.log("Add DEMO_CONTRACT_ADDRESS to .env, then run: npm run contract:interact -- --send");
