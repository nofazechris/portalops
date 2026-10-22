// The scripted "Claude sets up PortalOps" replay on the landing page. Pure data and pure functions (no React, no timers), so the timeline is
// unit-tested (landingAi.test.js) and the component only has to ask "what should be on screen at time t?".
//
// It replays the REAL sequence of tool calls (these are the actual tool names of the PortalOps MCP server) against the Quest board we
// deployed on the Portaldot testnet. It is labelled as a replay on the page: nothing here talks to a server.

export const AI_PROMPT = "Watch my Quest contract 0x274F8AbeCAa7FE3772A2cB92F67F2ed4A64bc649 and send its events to the test receiver.";

/** What the orb is doing during each phase. The states are the library's: see src/orb.jsx for what each means in PortalOps. */
export const AI_SCRIPT = [
  { id: "prompt", at: 0, kind: "prompt", orb: "listening", duration: 2600 },
  { id: "think1", at: 2800, kind: "thought", orb: "searching", text: "Let me check where this project is.", duration: 900 },
  { id: "status", at: 3700, kind: "tool", orb: "searching", tool: "portalops_setup_status", args: "", result: "1 of 5 done · next: register a contract", duration: 1300 },
  { id: "register", at: 5200, kind: "tool", orb: "connecting", tool: "portalops_register_contract", args: 'address: "0x274F…c649", example: "quest"', result: "Watching PortalQuest · 3 event types · code found on chain ✓", duration: 1700 },
  { id: "webhook", at: 7100, kind: "tool", orb: "working", tool: "portalops_create_webhook", args: "builtinReceiver: true", result: "Webhook ready · signing secret saved to .env.portalops", note: "Claude never saw the secret", duration: 1500 },
  { id: "test", at: 8800, kind: "tool", orb: "weaving", tool: "portalops_send_test_delivery", args: "", result: "200 OK in 21ms · signature verified ✓", duration: 1300 },
  { id: "events", at: 10300, kind: "tool", orb: "composing", tool: "portalops_list_events", args: "limit: 3", result: "QuestCreated · QuestCompleted · RewardIssued", duration: 1500 },
  { id: "final", at: 12000, kind: "final", orb: "breathing", text: "All set. PortalOps is watching your contract and delivering its events. 3 real events from the testnet are already captured, decoded and delivered. Your signing secret is in .env.portalops; I never saw it.", duration: 2200 },
];

export const AI_TOTAL_MS = 14400;

/**
 * Everything visible at time `t` (milliseconds since Run was pressed).
 * @returns {{ promptChars:number, steps:{id:string,kind:string,status:"running"|"done",tool?:string,args?:string,result?:string,note?:string,text?:string}[], orb:string, finished:boolean, progress:number }}
 */
export function snapshotAt(t, script = AI_SCRIPT) {
  const steps = [];
  let orb = "breathing";
  for (const s of script) {
    if (s.kind === "prompt") continue;
    if (t < s.at) break;
    const done = t >= s.at + s.duration;
    steps.push({ id: s.id, kind: s.kind, status: done || s.kind === "final" ? "done" : "running", tool: s.tool, args: s.args, result: done || s.kind !== "tool" ? s.result : undefined, note: done ? s.note : undefined, text: s.text });
  }
  const prompt = script.find((s) => s.kind === "prompt");
  const current = [...script].reverse().find((s) => t >= s.at);
  if (current) orb = t >= current.at + current.duration && current.kind !== "final" ? nextOrb(script, current) : current.orb;
  const typing = Math.max(0, Math.min(1, t / (prompt.duration - 400)));
  const finished = t >= AI_TOTAL_MS - 600;
  if (finished) orb = "breathing";
  return { promptChars: Math.round(typing * AI_PROMPT.length), steps, orb, finished, progress: Math.min(1, t / AI_TOTAL_MS) };
}

function nextOrb(script, current) {
  const i = script.indexOf(current);
  return script[i + 1]?.orb ?? current.orb;
}

/** The finished state, for visitors who prefer reduced motion and for the first paint. */
export const AI_FINAL = snapshotAt(AI_TOTAL_MS);
