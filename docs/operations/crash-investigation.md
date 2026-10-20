# Investigation: unexplained API exit (code 0xC0000409)

**Status: not reproduced; cause undetermined. Instrumentation added so a recurrence identifies itself.**

## What happened

During development the API process, hosted by the Claude desktop preview harness (`npm run api`), disappeared about 53 s
after it started. The harness reported exit code `3221226505` (= `0xC0000409`, `STATUS_STACK_BUFFER_OVERRUN`, which is what
Windows reports for a process-level `abort()`/fast-fail). No stack trace or message was printed. The worker and Vite server
started at the same time were unaffected.

## What was tried (all against the same code that crashed)

| Experiment | Result |
|---|---|
| API + worker as child processes on a fresh DB, dashboard-style polling + replays + failure injection + logins (scrypt), 4 min, 2,672 requests, V8 fatal-error reports enabled | No exit, no report |
| Same, on a **copy of the real dev database** (including a day of chain catch-up in the worker), 5 min, 3,392 requests | No exit, no report |
| API hosted by the same preview harness, loaded for 6 min from a script **plus** the dashboard open in the browser pane, worker running | No exit |
| Replayed the crash-time start-up sequence (restart dev-server preview, start worker, resize browser to mobile, navigate), watched 2 min | No exit |
| **Memory**: sampled the API process before/after ~1,900 burst requests including rate-limited ones | 74 → 79 MB, flat; no leak |
| **Dirty WAL**: 8 cycles of start → load → `SIGKILL` both processes mid-write → restart on the same SQLite file | Every restart recovered; 0 unexpected exits; 0 bad requests |
| `PRAGMA integrity_check` / `foreign_key_check` on the dev DB after many forced kills | `ok` / 0 rows |
| Showing and hiding the Browser pane while the API ran under the harness | API unaffected |

## What this suggests (not proven)

- Nothing in our code reliably reaches that state, and none of the stressors (load, memory, concurrency with the worker,
  crash-recovery of the database, UI activity) produced it.
- Every harness-hosted process (API, worker, dev server) was killed when the desktop session restarted, so the harness does
  terminate its children. A `TerminateProcess` with an arbitrary status, or a fast-fail raised by the host, is consistent with an
  exit code carrying no JavaScript-level trace. V8-level fatal errors (heap OOM etc.) would have written a report when the
  flags were on; the original process did not have them, so that single case is the one thing the experiments cannot rule out.

## Instrumentation now in place (`packages/config/diagnostics.ts`)

Both services log, to stderr, every way they can end:

- `uncaughtException` / `unhandledRejection` with the stack, exit 1
- `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGBREAK` by name, followed by a graceful shutdown (the worker finishes its pass and closes the DB)
- a final `exit code=… uptime=…s` line

**How to read a future disappearance:**
- exit line with a signal name → something external asked it to stop (harness, user, OS);
- `uncaughtException` line → our bug, with a stack;
- **no line at all** → the process was killed without a chance to run JS (hard kill or native abort).

For native/V8 aborts also run with `node --report-on-fatalerror --report-uncaught-exception --report-directory=data/reports`;
`.claude/launch.json` has a `portalops-api-debug` config that does this.

## Side findings from the same session

1. **The testnet reorganises its latest block(s) routinely.** Polling `eth_getBlockByNumber` for `head-1` showed the hash change
   within a minute. The worker's reorg handling therefore fires often and was logging each one as a warning. It now logs at
   `info` unless events were actually orphaned.
2. **The node supports the `finalized` and `safe` block tags** (finalized ran ~2 blocks behind latest). PortalOps currently reports
   "confirmed" as a 12-block depth heuristic. Using the `finalized` tag would give true protocol finality; this has since
   been implemented: `finalized` status, promotion after hash verification, tests in `apps/worker/ingest.test.ts`.
