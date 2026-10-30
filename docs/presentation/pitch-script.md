# Pitch script: PortalOps in three minutes

For whoever is on stage. It is written to be **said out loud**, not read: short sentences, one idea each. Change any word to sound like you.
The only rule is that every claim stays true, because the judges will check (and the README tells them exactly how).

## Before you go on (5 minutes)

- Open https://portalops.onrender.com/playground **now**. The free hosting sleeps when idle, and the first load can take up to a minute.
- Click **Send a free ping** once as a rehearsal, so the demo wallet and the page are warm. (It allows one per visitor every five minutes, so wait before the live one.)
- Open `/registry` in a second tab. Have the README story open in a third.
- Know your fallback (below). A demo that fails gracefully still looks good.

## The three-minute version

**0:00 — The joke (10 s).** Pick one, and smile before you say it.

- "Smart contracts are brilliant at doing things, and terrible at telling anyone about it."
- "A contract just paid a reward on chain. Your server found out the way you find out about a party: three days later, from someone else, and slightly wrong."
- "Blockchain events are a group chat in hexadecimal. Everything is happening. Nobody can read it."

**0:10 — The problem (40 s).** *Slow down here. This is the part they should feel.*

"Imagine a game on Portaldot. A player finishes a quest. The contract pays the reward, and it shouts: *that happened.* That shout is called an event.
Your server needs to hear it, and react. Send the email. Unlock the next level.

"But look at what the chain gives you. Hex. We went through the testnet's public events: thirty-two contracts, two hundred and twenty-five events. Not one
was readable without the contract's ABI.

"And that's the easy part. The chain can change its mind about what happened. Your server goes down at three in the morning and misses it. The webhook
fails and nobody retries. Every team ends up building this same plumbing. Slowly. Differently. With different bugs."

**0:50 — The solution (35 s).**

"So we built the plumbing once, for Portaldot. It's called PortalOps, and it does five things. *Watch* your contracts, Solidity and Rust. *Decode* the
hex into names a person can read. *Confirm* how final each event is, from the node itself, never guessed. *Deliver* it to your server as a signed webhook,
and retry when you're down. And *replay* anything you missed, without touching the chain again."

**1:25 — The demo (60 s).** *This is the moment. Do it live; see the run-of-show below.*

"Let me show you. This is a real transaction on the Portaldot testnet. I click *Send a free ping*." *(click)* "It's on the chain. PortalOps has caught it.
Decoded: the contract, the sender, the note. Finalized by the network. And delivered to a webhook, signature verified."

*(click Verify against the chain)* "Now, you shouldn't have to trust me. This button runs in *your* browser. It asks the public Portaldot node for this
transaction and checks every field against what we stored. Green means the chain agrees with us. If we'd changed one byte, it would be red."

**2:25 — Why Portaldot, and why it matters (25 s).**

"Portaldot runs two contract engines on one chain. Solidity and Rust report their events in different places, and there are quirks that cost a new team
a week. We wrote them down, we built around them, and we put a registry of verified contracts in public, so source code is proven to be what runs at an
address. People are coming to Portaldot to build real-world assets, games, payments and agents. All of them live on one question: *what just happened?* We'd like every one of them to
get the answer in minutes."

**2:50 — The honest close (10 s).**

"It's testnet software, on free hosting, with no outside users yet. We'd rather tell you that than have you find it. Everything else, you can check with
one command. We're PortalOps. Thank you."

*(Optional callback if you opened with the joke: "…and now your server hears about the party on time.")*

## Live-demo run-of-show (60 seconds)

1. Playground page, scrolled to **Make an event happen**.
2. Click **Send a free ping**. Say what is happening while the five steps tick: sent, captured, decoded, finalized, delivered.
3. When all five are green, click **Verify against the chain**. Read the verdict aloud: "Verified on chain."
4. Optional: click **Copy a command to check it yourself**, and say "that's a plain curl against the public node, no PortalOps involved".

**If the network is slow** (the testnet sometimes is): say so calmly, then open the earlier proof instead: the playground's **Live events** list shows
real recent pings; click any event in the explorer (`/app`) and **Verify against the chain** works on it immediately. Or open `/registry` and show
PortalQuest and PortalPing as verified contracts. A judge sees the same idea either way.

**If the free pings are used up** (30 a day, one per visitor every five minutes): the page says so and offers "Send from my wallet". Use an existing
event instead.

## Shorter and longer

- **Ninety seconds:** joke, problem in two sentences, the five verbs in one breath, the demo (cut the registry line), the honest close.
- **Five minutes:** add the registry (open `/registry`, click PortalQuest, show source and ABI), then the Arena Lab (`/arena`), then the Claude tools
  ("an assistant can set a whole project up from one sentence").

## When they ask

Full answers are in [For the Portaldot ecosystem](../guides/ecosystem.md). The short versions:

- **"Couldn't anyone build this?"** "Anyone could, and every team would, each hitting the same quirks one at a time. We built it once and wrote the quirks down."
- **"How do I know your data is real?"** "You don't have to take our word. Verify against the chain checks each event against the public node, in your browser."
- **"What about tools that anchor records on chain?"** "Anchoring shows an indexer didn't change history. Checking against the chain shows the record is true. They answer different questions, and a project could use both."
- **"Does it work with Rust?"** "Yes: the reader is verified against real testnet events and real ink! 5 metadata. We haven't deployed our own Rust contract live, because it needs about 420 tPOT locked."
- **"What's next?"** "Security alerts, agent triggers and an audit trail, one-step deploy and watch."
- **"Who is it for?"** "Game and agent teams first. They live on events."
