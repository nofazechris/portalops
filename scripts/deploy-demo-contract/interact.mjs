#!/usr/bin/env node
// Invokes PortalQuest on the public testnet and proves each emitted event is retrievable
// the same way the PortalOps ingestion worker will read it (eth_getLogs by address + block range).
//
//   npm run contract:interact            dry run: shows the plan and gas estimates, sends nothing
//   npm run contract:interact -- --send  creates a quest, completes it, issues a test reward
//
// Uses PORTALDOT_DEPLOYER_PRIVATE_KEY as quest creator. If PORTALDOT_PARTICIPANT_PRIVATE_KEY is set it
// completes the quest; otherwise the deployer does. Keys are never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEventLogs } from "viem";
import { accountFromEnv, assertChain, config, EVIDENCE_PATH, fail, fmt, hasFlag, loadArtifact, loadDeployment, publicClient, walletFor } from "./common.mjs";

const send = hasFlag("--send");
const { abi } = loadArtifact();
const { contractAddress } = loadDeployment();
const creator = accountFromEnv("PORTALDOT_DEPLOYER_PRIVATE_KEY");
const participant = accountFromEnv("PORTALDOT_PARTICIPANT_PRIVATE_KEY", { required: false }) || creator;

console.log(`chain id ${await assertChain()} (verified) · contract ${contractAddress}`);
const code = await publicClient.getCode({ address: contractAddress });
if (!code || code === "0x") fail("No contract code at that address on this network.");
console.log(`creator     ${creator.address}`);
console.log(`participant ${participant.address}${participant === creator ? " (same account)" : ""}`);

const gasPrice = await publicClient.getGasPrice();
const balance = await publicClient.getBalance({ address: creator.address });
console.log(`balance     ${fmt(balance)} · gas price ${gasPrice} wei`);

const evidence = existsSync(EVIDENCE_PATH) ? JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) : { transactions: [] };

async function step(label, account, functionName, args) {
  const base = { address: contractAddress, abi, functionName, args, account };
  let gas = config.gasLimit;
  if (!gas) {
    try {
      gas = await publicClient.estimateContractGas(base);
    } catch (e) {
      fail(`${label}: gas estimation failed (the call would likely revert): ${e.shortMessage || e.message}`);
    }
  }
  console.log(`\n${label}\n  gas estimate ${gas} · max cost ${fmt(gas * gasPrice)}`);
  if (!send) return null;

  const wallet = walletFor(account);
  const hash = await wallet.writeContract({ ...base, gas, gasPrice, type: "legacy" });
  console.log(`  submitted  ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 });
  console.log(`  included   block #${receipt.blockNumber} · status ${receipt.status} · gasUsed ${receipt.gasUsed}`);
  if (receipt.status !== "success") fail(`${label}: transaction reverted.`);

  // 1) events decoded from the receipt
  const fromReceipt = parseEventLogs({ abi, logs: receipt.logs });
  // 2) the same events as the ingestion worker would see them: eth_getLogs for this contract and block
  const fromGetLogs = await publicClient.getLogs({ address: contractAddress, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
  const visible = fromGetLogs.filter((l) => l.transactionHash === hash);
  const decoded = parseEventLogs({ abi, logs: visible });
  console.log(`  receipt logs ${fromReceipt.length} · visible via eth_getLogs ${visible.length}`);
  for (const ev of decoded) console.log(`  event      ${ev.eventName} ${JSON.stringify(ev.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))} (logIndex ${ev.logIndex})`);
  if (visible.length !== fromReceipt.length || visible.length === 0) {
    console.warn("  WARNING: receipt logs and eth_getLogs disagree — investigate before trusting ingestion.");
  }

  evidence.transactions.push({
    label,
    from: account.address,
    function: functionName,
    transactionHash: hash,
    blockNumber: Number(receipt.blockNumber),
    blockHash: receipt.blockHash,
    status: receipt.status,
    gasUsed: String(receipt.gasUsed),
    eventsInReceipt: fromReceipt.length,
    eventsViaGetLogs: visible.length,
    events: decoded.map((e) => ({ name: e.eventName, logIndex: e.logIndex, args: JSON.parse(JSON.stringify(e.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))) })),
    observedAt: new Date().toISOString(),
  });
  return { receipt, decoded };
}

const created = await step("1. createQuest", creator, "createQuest", ["PortalOps demo quest"]);
let questId = created?.decoded.find((e) => e.eventName === "QuestCreated")?.args.questId;
if (send && questId === undefined) fail("QuestCreated was not found in the logs; cannot continue.");
if (!send) questId = 1n; // only used to estimate the later steps in a dry run
if (!send) console.log("\nNote: dry-run estimates for steps 2-3 assume the quest exists and may fail until step 1 is sent.");

await step("2. completeQuest", participant, "completeQuest", [questId]);
await step("3. issueReward", creator, "issueReward", [questId, participant.address, 50n]);

if (!send) {
  console.log("\nDry run only. Nothing was sent. Re-run with --send to execute.");
  process.exit(0);
}
evidence.network = "Portaldot V3.0 Testnet";
evidence.chainId = config.chainId;
evidence.contractAddress = contractAddress;
mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
console.log(`\nDone. Evidence appended to ${EVIDENCE_PATH}`);
