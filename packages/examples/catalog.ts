import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ready-made example contracts for the setup wizard and the docs. Each one comes with its source, ABI, deploy command,
 * a description of every event and a copy-paste webhook handler. The compiled output lives in generated.json
 * (rebuild with `npm run examples:build`); servers never need the Solidity compiler.
 */

export interface ExampleEvent {
  name: string;
  /** What it means, in plain language. */
  meaning: string;
  /** What a webhook for this event carries in `data.payload`. Illustrative values. */
  samplePayload: Record<string, string>;
  /** What an app would typically do when it receives this. */
  idea: string;
}

export interface ExampleSummary {
  id: string;
  title: string;
  tagline: string;
  category: string;
  contractName: string;
  events: { name: string; meaning: string }[];
}

export interface ExampleDetail extends ExampleSummary {
  description: string;
  eventDetails: ExampleEvent[];
  source: string;
  abi: unknown[];
  bytecode: string;
  /** Deploy it yourself with the repo script (needs a funded testnet key in .env; dry run by default). */
  deployCommand: string;
  /** Node.js receiver you can paste into your backend. */
  handler: string;
  compiler: { name: string; version: string; evmVersion: string; optimizerRuns: number };
}

interface Generated {
  compiler: ExampleDetail["compiler"];
  contracts: Record<string, { name: string; source: string; abi: unknown[]; bytecode: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
let generated: Generated | null = null;
const load = (): Generated => (generated ??= JSON.parse(readFileSync(resolve(here, "generated.json"), "utf8")) as Generated);

interface Meta {
  title: string;
  tagline: string;
  category: string;
  description: string;
  events: ExampleEvent[];
}

const META: Record<string, Meta> = {
  quest: {
    title: "Quest board",
    tagline: "Create quests, complete them, issue rewards.",
    category: "Gaming & engagement",
    description:
      "A tiny on-chain quest system. Creators publish quests, participants complete them, and creators record rewards. " +
      "Every step emits an event, which makes it the quickest way to see PortalOps capture, decode and deliver real activity.",
    events: [
      { name: "QuestCreated", meaning: "A creator published a new quest.", samplePayload: { questId: "1", creator: "0xCreator…", title: "Bridge your first token" }, idea: "Announce the quest in Discord or your app feed." },
      { name: "QuestCompleted", meaning: "A participant completed a quest.", samplePayload: { questId: "1", participant: "0xPlayer…" }, idea: "Unlock a badge or update a leaderboard." },
      { name: "RewardIssued", meaning: "A creator recorded a reward for a participant.", samplePayload: { questId: "1", recipient: "0xPlayer…", amount: "250" }, idea: "Email a receipt or credit points in your database." },
    ],
  },
  token: {
    title: "Token",
    tagline: "A minimal ERC-20 shaped token: transfers and approvals.",
    category: "DeFi",
    description:
      "A standard-shaped fungible token. Transfers and approvals are the events nearly every DeFi, wallet and analytics product cares about, " +
      "so it shows filtering by event, high-volume ingestion and finality (a transfer is only safe to credit once it is finalized).",
    events: [
      { name: "Transfer", meaning: "Tokens moved between accounts. A mint has from = the zero address.", samplePayload: { from: "0xSender…", to: "0xReceiver…", value: "1000000000000000000" }, idea: "Credit a balance once the event is finalized; alert on large transfers." },
      { name: "Approval", meaning: "An owner allowed a spender to move tokens.", samplePayload: { owner: "0xOwner…", spender: "0xSpender…", value: "5000000000000000000" }, idea: "Warn users about unlimited approvals." },
    ],
  },
  bounty: {
    title: "Bounty board",
    tagline: "Post a task, submit work, approve it.",
    category: "Marketplace / RWA workflow",
    description:
      "A four-state workflow (posted, submitted, approved or cancelled). It is the clearest demo of a business process driven by events: " +
      "each state change notifies a different person, which is exactly what webhooks are for.",
    events: [
      { name: "BountyPosted", meaning: "Someone posted a task with a reward.", samplePayload: { bountyId: "1", poster: "0xPoster…", title: "Translate the docs", reward: "500" }, idea: "Notify matching workers." },
      { name: "WorkSubmitted", meaning: "A hunter submitted proof of work.", samplePayload: { bountyId: "1", hunter: "0xHunter…", proof: "https://example.com/pr/42" }, idea: "Ping the poster to review." },
      { name: "BountyApproved", meaning: "The poster approved the work.", samplePayload: { bountyId: "1", hunter: "0xHunter…", reward: "500" }, idea: "Trigger payment in your own system." },
      { name: "BountyCancelled", meaning: "The poster cancelled an open bounty.", samplePayload: { bountyId: "1", poster: "0xPoster…" }, idea: "Close the listing." },
    ],
  },
};

/** A Node.js (Express) receiver for the example: verifies the signature, ignores duplicates, and branches on the event name. */
function handlerFor(id: string, events: ExampleEvent[]): string {
  const cases = events.map((e) => `      case "${e.name}":\n        // ${e.idea}\n        console.log("${e.name}", p);\n        break;`).join("\n");
  return `// npm i express @portalops/sdk   (SDK: build it from the PortalOps repo with \`npm run sdk:build\`)
import express from "express";
import { constructEvent } from "@portalops/sdk";

const app = express();
const seen = new Set<string>(); // use a database table in production: retries and replays resend the same event id

// IMPORTANT: verify the signature over the RAW body, so do not use express.json() on this route.
app.post("/portal-events", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = constructEvent(process.env.PORTALOPS_WEBHOOK_SECRET!, req.body, req.header("portalops-signature"));
  } catch {
    return res.sendStatus(400); // bad or stale signature: PortalOps will not retry a 4xx
  }

  if (seen.has(event.id)) return res.sendStatus(200); // already handled: acknowledge so it is not retried
  seen.add(event.id);

  // Only act on money-like events once they are final. "finalized" means the node has finalized the block.
  if (event.data.finalityStatus === "orphaned") return res.sendStatus(200);

  const p = event.data.payload ?? {};
  switch (event.data.eventName) {
${cases}
      default:
        break; // undecoded or unrelated event
  }
  res.sendStatus(200); // any 2xx means delivered; a 5xx is retried with backoff
});

app.listen(3000, () => console.log("listening on :3000 (${id} example)"));
`;
}

export function listExamples(): ExampleSummary[] {
  const g = load();
  return Object.entries(META).map(([id, m]) => ({
    id,
    title: m.title,
    tagline: m.tagline,
    category: m.category,
    contractName: g.contracts[id].name,
    events: m.events.map((e) => ({ name: e.name, meaning: e.meaning })),
  }));
}

export function getExample(id: string): ExampleDetail | null {
  // own keys only: "__proto__" / "constructor" must not resolve to Object.prototype members
  if (!Object.hasOwn(META, id)) return null;
  const m = META[id];
  const g = load();
  if (!Object.hasOwn(g.contracts, id)) return null;
  const c = g.contracts[id];
  return {
    id,
    title: m.title,
    tagline: m.tagline,
    category: m.category,
    description: m.description,
    contractName: c.name,
    events: m.events.map((e) => ({ name: e.name, meaning: e.meaning })),
    eventDetails: m.events,
    source: c.source,
    abi: c.abi,
    bytecode: c.bytecode,
    deployCommand: `npm run contract:deploy -- --example ${id} --send`,
    handler: handlerFor(id, m.events),
    compiler: g.compiler,
  };
}
