/**
 * Makes every way a service process can end leave a line in its output, so "it just disappeared" can be told apart from
 * "something external stopped it" and "our code threw".
 *
 *  - uncaughtException / unhandledRejection: logged with stack, exit 1
 *  - SIGINT / SIGTERM / SIGHUP / SIGBREAK:   logged by name, graceful shutdown, exit 0
 *  - exit:                                   final line with the exit code and uptime
 *
 * What it cannot see: a native abort or an external TerminateProcess/taskkill (those give the process no chance to run
 * JavaScript). For those, the absence of any line above is itself the evidence. Run with
 * `node --report-on-fatalerror --report-directory=data/reports` to also capture V8-level fatal errors.
 */
export function installProcessDiagnostics(name: string, shutdown: () => void | Promise<void>): void {
  const started = Date.now();
  const stamp = () => new Date().toISOString();
  let stopping = false;

  process.on("uncaughtException", (e) => { console.error(`${stamp()} [${name}] uncaughtException:`, e instanceof Error ? e.stack : e); process.exit(1); });
  process.on("unhandledRejection", (e) => { console.error(`${stamp()} [${name}] unhandledRejection:`, e instanceof Error ? e.stack : e); process.exit(1); });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(sig, () => {
        if (stopping) return;
        stopping = true;
        console.error(`${stamp()} [${name}] received ${sig}; shutting down`);
        Promise.resolve(shutdown()).catch((e) => console.error(`[${name}] shutdown error:`, e)).finally(() => process.exit(0));
      });
    } catch { /* signal not supported on this platform */ }
  }

  process.on("exit", (code) => console.error(`${stamp()} [${name}] exit code=${code} uptime=${((Date.now() - started) / 1000).toFixed(0)}s`));
}
