# Video script: the 67-second film, warmer

The current film (`brand/motion/`) is tight and well paced, but it opens like every product film: "Every block tells a story." This keeps its **timing and pictures**
and changes the **words**: a joke up front, then plain, human sentences. Each line below fits the same slot as the original, so the visuals do not move.

To use it: replace the matching `text` entries in `brand/motion/narration.json` and run the film's render script (see `brand/motion/README.md`).

## Narration, slot by slot

| Time (s) | Now | Replace with | Why |
| --- | --- | --- | --- |
| 3.2 to 10.1 | "Every block tells a story. Contracts emit events, every single block." | "Smart contracts are brilliant at doing things... and terrible at telling anyone." | A joke that is also the problem, in one breath. |
| 10.4 to 11.7 | "But most apps never hear them." | "So most apps miss them." | Shorter, lands as the punchline. |
| 13.7 to 17.1 | "This is PortalOps. The event layer for Portaldot." | "Meet PortalOps. The event layer for Portaldot." | Warmer opening of the answer. |
| 17.4 to 21.1 | "Watch. Decode. Confirm. Deliver. Replay." | "It watches, decodes, confirms, delivers, and replays." | Full sentence; same five beats. |
| 21.9 to 24.5 | "Raw logs become named, typed events." | "Hex goes in. Named events come out." | Concrete picture. |
| 25.6 to 27.2 | "And nothing ever gets a guessed name." | "Never a guessed name." | Fits the slot, same promise. |
| 28.3 to 31.5 | "Know exactly how final every event is." | "And it tells you how final each one is." | Plainer. |
| 31.8 to 34.3 | "Finalized, straight from the chain itself." | "Straight from the node, not from a hunch." | A small smile. |
| 34.6 to 36.0 | "Every webhook is signed." | *(keep)* | Already perfect. |
| 36.3 to 39.0 | "If your server fails, it retries." | "If your server is down, it tries again." | Says what actually happens. |
| 39.6 to 40.1 | "Delivered." | *(keep)* | |
| 40.9 to 44.8 | "Fixed your server? Replay it. The chain is never touched." | "Fixed your server? Replay what you missed. The chain isn't touched." | |
| 45.8 to 48.3 | "Don't trust us. Verify it yourself." | "Don't trust us. Ask the chain." | Names the new button. |
| 49 to 52 | "Every claim, checked against the public testnet." | *(keep)* | |
| 52 to 54 | "Solidity and ink!" | *(keep)* | |
| 54 to 61 | "An SDK, a dashboard, and Claude. One event layer for all of Portaldot." | *(keep)* | |
| 62 to 67 | "PortalOps. Every event, delivered." | *(keep)* | Callback to the opening joke is in the caption below. |

## Two shots worth adding

The film predates two features. If you re-cut the picture, these are the best additions:

- **At 45 to 48 s ("Ask the chain")**: the playground's **Verify against the chain** button turning to "Verified on chain", with the green checklist.
- **At 49 to 52 s**: the `/registry` page, with PortalQuest and PortalPing marked as verified.

## YouTube description (paste)

> Smart contracts are brilliant at doing things, and terrible at telling anyone. PortalOps is the event layer for Portaldot: it watches contracts
> (Solidity and Rust), decodes their events, tells you how final each one is, delivers them to your server as signed, retried, replayable webhooks,
> and lets you verify any event against the chain yourself.
>
> Try it, no signup: https://portalops.onrender.com/playground
> Code and evidence you can re-run: https://github.com/nofazechris/portalops
> Built for the Portaldot Hacker House, track Modular Cloud & Middleware. Testnet only.
