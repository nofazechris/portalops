/**
 * Outgoing email for account flows (verify your address, reset your password).
 *
 * One tiny interface, three implementations:
 *   ResendSender   sends through the Resend HTTP API (https://resend.com)
 *   ConsoleSender  development/fallback: prints to the server log. In production it never prints the message body, because the
 *                  body contains a working sign-in link and logs are not a safe place for those
 *   MemorySender   tests: keeps what would have been sent
 *
 * Sending is always best-effort from the caller's point of view: a failed email must never make sign-up or "forgot password"
 * return an error that reveals anything (or block the user from using the app).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  ok: boolean;
  /** Provider message id when sent. */
  id?: string;
  /** A short reason when not sent. Never contains the API key. */
  error?: string;
}

export interface EmailSender {
  readonly kind: "resend" | "console" | "memory";
  send(message: EmailMessage): Promise<SendResult>;
}

export interface ResendOptions {
  apiKey: string;
  /** "Name <address@verified-domain>" or a bare address. */
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Sender used while no domain is verified. Resend only delivers it to the account owner's own address. */
export const RESEND_TEST_SENDER = "PortalOps <onboarding@resend.dev>";

export class ResendSender implements EmailSender {
  readonly kind = "resend" as const;
  private readonly o: ResendOptions;
  constructor(o: ResendOptions) {
    if (!/^re_[A-Za-z0-9_-]{10,}$/.test(o.apiKey)) throw new Error("RESEND_API_KEY does not look like a Resend key (it should start with re_).");
    this.o = o;
  }

  async send(m: EmailMessage): Promise<SendResult> {
    const f = this.o.fetch ?? fetch;
    try {
      const res = await f("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: this.o.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
        redirect: "error",
      });
      const body = (await res.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
      if (res.ok && body?.id) return { ok: true, id: body.id };
      // Resend's messages are safe to surface (for example "You can only send testing emails to your own email address").
      return { ok: false, error: `Resend ${res.status}${body?.message ? ": " + String(body.message).slice(0, 200) : ""}` };
    } catch (e) {
      const name = (e as { name?: string }).name;
      return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "Resend timed out" : "Resend could not be reached" };
    }
  }
}

export class ConsoleSender implements EmailSender {
  readonly kind = "console" as const;
  private readonly showBody: boolean;
  private readonly log: (line: string) => void;
  /** `showBody` only in development: the message contains a live link. */
  constructor(opts: { showBody: boolean; log?: (line: string) => void }) {
    this.showBody = opts.showBody;
    this.log = opts.log ?? ((l) => console.log(l));
  }
  async send(m: EmailMessage): Promise<SendResult> {
    if (this.showBody) this.log(`[email · not sent: no provider configured] to=${m.to} subject="${m.subject}"\n${m.text}`);
    else this.log(`[email] not sent (no provider configured): "${m.subject}"`);
    return { ok: false, error: "no email provider configured" };
  }
}

export class MemorySender implements EmailSender {
  readonly kind = "memory" as const;
  readonly sent: EmailMessage[] = [];
  /** Set to make the next sends fail, to test that callers cope. */
  failWith: string | null = null;
  async send(m: EmailMessage): Promise<SendResult> {
    if (this.failWith) return { ok: false, error: this.failWith };
    this.sent.push(m);
    return { ok: true, id: "mem_" + this.sent.length };
  }
  /** The most recent link in a message to `to` (handy in tests). */
  lastLink(to: string): string | null {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    return m ? (/https?:\/\/\S+/.exec(m.text)?.[0] ?? null) : null;
  }
}

/** Chooses the sender from the environment. */
export function createEmailSender(env: { RESEND_API_KEY?: string; EMAIL_FROM?: string }, opts: { production: boolean; fetch?: typeof fetch }): EmailSender {
  const key = (env.RESEND_API_KEY ?? "").trim();
  if (key) {
    try {
      return new ResendSender({ apiKey: key, from: (env.EMAIL_FROM ?? "").trim() || RESEND_TEST_SENDER, fetch: opts.fetch });
    } catch (e) {
      console.error(`email: ${e instanceof Error ? e.message : "invalid email settings"} Falling back to console output.`);
    }
  }
  return new ConsoleSender({ showBody: !opts.production });
}
