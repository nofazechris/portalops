import { randomUUID } from "node:crypto";
import type {
  DeliveryStatus, FinalityStatus, NormalizedEvent, RetryPolicy, WebhookAttempt, WebhookDelivery, WebhookEndpoint,
} from "../shared-types/index.ts";
import type { Row, SqlDriver } from "./driver.ts";
import {
  redact, type ApiKeyRecord, type AuthTokenKind, type AutomationRecord, type ContractRecord, type ProjectRecord, type UserRecord, type ReceiverMode, type ReceiverRecord, type ReceiverRequestRecord,
} from "./records.ts";

const uid = (prefix: string, len: number) => prefix + randomUUID().replaceAll("-", "").slice(0, len);

/**
 * The PortalOps data layer. Every query lives here, written once with `?` placeholders in the SQL subset that SQLite and
 * PostgreSQL share. The engine-specific parts are in the driver; the single dialect difference the store itself handles is
 * "insert unless it already exists" (see `ignore`).
 *
 * All methods are async. Use `tx()` for multi-statement atomicity; the store it hands you is bound to the transaction.
 */
export class SqlStore {
  protected readonly d: SqlDriver;
  private readonly inTx: boolean;

  constructor(driver: SqlDriver, inTx = false) {
    this.d = driver;
    this.inTx = inTx;
  }

  get dialect(): "sqlite" | "postgres" { return this.d.dialect; }

  async close(): Promise<void> { await this.d.close(); }

  /** Runs `fn` atomically. Everything inside must use the store it is given (`s`), not the outer one. */
  async tx<T>(fn: (s: SqlStore) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.d.transaction((txd) => fn(new SqlStore(txd, true)));
  }

  /** Raw access for tests and diagnostics only. Application code must use the typed methods. */
  rawAll(sql: string, params?: unknown[]): Promise<Row[]> { return this.d.all(sql, params); }
  rawRun(sql: string, params?: unknown[]): Promise<{ changes: number }> { return this.d.run(sql, params); }

  // ---------------------------------------------------------------- internals
  private all(sql: string, params?: unknown[]): Promise<Row[]> { return this.d.all(sql, params); }
  private async get(sql: string, params?: unknown[]): Promise<Row | undefined> { return (await this.d.all(sql, params))[0]; }
  private run(sql: string, params?: unknown[]): Promise<{ changes: number }> { return this.d.run(sql, params); }

  /** Adapts `INSERT OR IGNORE INTO …` (SQLite) to `INSERT INTO … ON CONFLICT DO NOTHING` (PostgreSQL). Same semantics: skip on any unique violation. */
  private ignore(sql: string): string {
    if (this.d.dialect !== "postgres") return sql;
    return sql.replace(/^\s*INSERT OR IGNORE INTO/i, "INSERT INTO").trimEnd() + " ON CONFLICT DO NOTHING";
  }

  // ----------------------------------------------------------------- projects
  async ensureProject(id: string, name: string, networkId: string): Promise<void> {
    await this.run(this.ignore("INSERT OR IGNORE INTO projects (id, name, network_id, created_at) VALUES (?, ?, ?, ?)"), [id, name, networkId, new Date().toISOString()]);
  }

  async createProject(p: { ownerId: string | null; name: string; description?: string | null; networkId: string; kind?: "user" | "public_demo" | "playground" }): Promise<ProjectRecord> {
    const id = uid("prj_", 20);
    const createdAt = new Date().toISOString();
    await this.run("INSERT INTO projects (id, name, description, owner_id, kind, network_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, p.name, p.description ?? null, p.ownerId, p.kind ?? "user", p.networkId, createdAt]);
    return { id, name: p.name, description: p.description ?? null, ownerId: p.ownerId, kind: p.kind ?? "user", networkId: p.networkId, createdAt };
  }

  private rowToProject(r: Row): ProjectRecord {
    return { id: r.id as string, name: r.name as string, description: (r.description as string | null) ?? null, ownerId: (r.owner_id as string | null) ?? null, kind: r.kind as ProjectRecord["kind"], networkId: r.network_id as string, createdAt: r.created_at as string };
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    const r = await this.get("SELECT * FROM projects WHERE id = ?", [id]);
    return r ? this.rowToProject(r) : null;
  }

  async listProjectsByOwner(ownerId: string): Promise<ProjectRecord[]> {
    return (await this.all("SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at", [ownerId])).map((r) => this.rowToProject(r));
  }

  async listAllProjects(): Promise<ProjectRecord[]> {
    return (await this.all("SELECT * FROM projects ORDER BY created_at")).map((r) => this.rowToProject(r));
  }

  async getPublicDemoProject(): Promise<ProjectRecord | null> {
    const r = await this.get("SELECT * FROM projects WHERE kind = 'public_demo' LIMIT 1");
    return r ? this.rowToProject(r) : null;
  }

  async getPlaygroundProject(): Promise<ProjectRecord | null> {
    const r = await this.get("SELECT * FROM projects WHERE kind = 'playground' LIMIT 1");
    return r ? this.rowToProject(r) : null;
  }

  async updateProject(id: string, patch: { name?: string; description?: string | null }): Promise<void> {
    if (patch.name !== undefined) await this.run("UPDATE projects SET name = ? WHERE id = ?", [patch.name, id]);
    if (patch.description !== undefined) await this.run("UPDATE projects SET description = ? WHERE id = ?", [patch.description, id]);
  }

  // ------------------------------------------------------------------- cursor
  async getCursor(projectId: string, networkId: string): Promise<{ block: number; hash: string } | null> {
    const r = await this.get("SELECT last_processed_block AS block, last_processed_block_hash AS hash FROM chain_cursors WHERE project_id = ? AND network_id = ?", [projectId, networkId]);
    return r ? { block: Number(r.block), hash: r.hash as string } : null;
  }

  /** When the cursor was last advanced (ISO string), or null. Used to tell a healthy ingester from a stalled one. */
  async getCursorUpdatedAt(projectId: string, networkId: string): Promise<string | null> {
    const r = await this.get("SELECT updated_at FROM chain_cursors WHERE project_id = ? AND network_id = ?", [projectId, networkId]);
    return r ? (r.updated_at as string) : null;
  }

  async setCursor(projectId: string, networkId: string, block: number, hash: string): Promise<void> {
    await this.run(
      `INSERT INTO chain_cursors (project_id, network_id, last_processed_block, last_processed_block_hash, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, network_id) DO UPDATE SET
         last_processed_block = excluded.last_processed_block,
         last_processed_block_hash = excluded.last_processed_block_hash,
         updated_at = excluded.updated_at`,
      [projectId, networkId, block, hash, new Date().toISOString()],
    );
  }

  async deleteCursor(projectId: string, networkId: string): Promise<void> {
    await this.run("DELETE FROM chain_cursors WHERE project_id = ? AND network_id = ?", [projectId, networkId]);
  }

  // ------------------------------------------------------------------- events
  /** Idempotent. Returns true if the event was new, false if it was already stored. */
  async insertEvent(e: NormalizedEvent): Promise<boolean> {
    const r = await this.run(
      this.ignore(`INSERT OR IGNORE INTO events (id, project_id, network_id, source, chain_id, contract_address, event_name, decoded,
           topics, data, payload, transaction_hash, transaction_index, block_number, block_hash, event_index, observed_at, finality_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      [
        e.id, e.projectId, e.network, e.source, e.chainId, e.contractAddress, e.eventName, e.decoded ? 1 : 0,
        JSON.stringify(e.topics), e.data, e.payload ? JSON.stringify(e.payload) : null,
        e.transactionHash, e.transactionIndex, e.blockNumber, e.blockHash, e.eventIndex, e.observedAt, e.finalityStatus,
      ],
    );
    return r.changes === 1;
  }

  private rowToEvent(r: Row): NormalizedEvent {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      network: r.network_id as NormalizedEvent["network"],
      source: r.source as NormalizedEvent["source"],
      chainId: Number(r.chain_id),
      contractAddress: r.contract_address as string,
      eventName: (r.event_name as string | null) ?? null,
      decoded: Number(r.decoded) === 1,
      topics: JSON.parse(r.topics as string),
      data: r.data as string,
      payload: r.payload ? JSON.parse(r.payload as string) : null,
      transactionHash: r.transaction_hash as string,
      transactionIndex: Number(r.transaction_index),
      blockNumber: Number(r.block_number),
      blockHash: r.block_hash as string,
      eventIndex: Number(r.event_index),
      observedAt: r.observed_at as string,
      processingStatus: "persisted",
      finalityStatus: r.finality_status as FinalityStatus,
    };
  }

  async getEvent(id: string): Promise<NormalizedEvent | null> {
    const r = await this.get("SELECT * FROM events WHERE id = ?", [id]);
    return r ? this.rowToEvent(r) : null;
  }

  async listEvents(q: { projectId: string; limit?: number; offset?: number; contractAddress?: string; transactionHash?: string }): Promise<NormalizedEvent[]> {
    const where = ["project_id = ?"];
    const args: (string | number)[] = [q.projectId];
    if (q.contractAddress) { where.push("contract_address = ?"); args.push(q.contractAddress.toLowerCase()); }
    if (q.transactionHash) { where.push("transaction_hash = ?"); args.push(q.transactionHash.toLowerCase()); }
    args.push(Math.min(q.limit ?? 50, 500), q.offset ?? 0);
    const rows = await this.all(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY block_number DESC, event_index DESC LIMIT ? OFFSET ?`, args);
    return rows.map((r) => this.rowToEvent(r));
  }

  async countEvents(projectId: string): Promise<number> {
    return Number((await this.get("SELECT COUNT(*) AS n FROM events WHERE project_id = ?", [projectId]))!.n);
  }

  /** Marks events at or after fromBlock whose block hash is no longer canonical as orphaned. Finalized events are never touched. */
  async markOrphaned(projectId: string, fromBlock: number, canonicalHash: (block: number) => string | null, source?: "evm" | "native"): Promise<number> {
    // `source` keeps one chain's reorganisation from touching the other's events (their block numbers are unrelated).
    const rows = await this.all(`SELECT id, block_number, block_hash FROM events WHERE project_id = ? AND block_number >= ? AND finality_status NOT IN ('orphaned', 'finalized')${source ? " AND source = ?" : ""}`, source ? [projectId, fromBlock, source] : [projectId, fromBlock]);
    const stale = rows.filter((r) => canonicalHash(Number(r.block_number)) !== (r.block_hash as string)).map((r) => r.id as string);
    await this.tx(async (s) => { for (const id of stale) await s.run("UPDATE events SET finality_status = 'orphaned' WHERE id = ?", [id]); });
    return stale.length;
  }

  /** Events at or below `upTo` that are not yet finalized or orphaned, oldest first. */
  async listUnfinalized(projectId: string, upTo: number, limit = 500, source?: "evm" | "native"): Promise<{ id: string; blockNumber: number; blockHash: string; transactionHash: string; eventIndex: number }[]> {
    const rows = await this.all("SELECT id, block_number, block_hash, transaction_hash, event_index FROM events WHERE project_id = ? AND block_number <= ? AND finality_status IN ('included','confirmed')" + (source ? " AND source = '" + (source === "native" ? "native" : "evm") + "'" : "") + " ORDER BY block_number, event_index LIMIT ?", [projectId, upTo, limit]);
    return rows.map((r) => ({ id: r.id as string, blockNumber: Number(r.block_number), blockHash: r.block_hash as string, transactionHash: r.transaction_hash as string, eventIndex: Number(r.event_index) }));
  }

  /** Sets the status of specific events. "finalized" is only applied to events that are not orphaned. */
  async setFinality(ids: string[], status: "finalized" | "orphaned"): Promise<number> {
    if (!ids.length) return 0;
    const sql = `UPDATE events SET finality_status = ? WHERE id = ? AND finality_status IN ('included','confirmed'${status === "orphaned" ? ",'orphaned'" : ""})`;
    return this.tx(async (s) => {
      let n = 0;
      for (const id of ids) n += (await s.run(sql, [status, id])).changes;
      return n;
    });
  }

  /** Promotes included events to confirmed once they are `depth` blocks behind the head. */
  async confirmUpTo(projectId: string, headBlock: number, depth: number, source?: "evm" | "native"): Promise<number> {
    return (await this.run("UPDATE events SET finality_status = 'confirmed' WHERE project_id = ? AND finality_status = 'included' AND block_number <= ?" + (source ? " AND source = '" + (source === "native" ? "native" : "evm") + "'" : ""), [projectId, headBlock - depth])).changes;
  }

  // ---------------------------------------------------------------- endpoints
  async createEndpoint(ep: Omit<WebhookEndpoint, "id" | "createdAt"> & { id?: string }, encryptedSecret: string): Promise<WebhookEndpoint> {
    const id = ep.id ?? uid("ep_", 20);
    const createdAt = new Date().toISOString();
    await this.run(
      `INSERT INTO webhook_endpoints (id, project_id, url, description, encrypted_secret, enabled, event_filter, retry_policy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ep.projectId, ep.url, ep.description, encryptedSecret, ep.enabled ? 1 : 0, JSON.stringify(ep.eventFilter), JSON.stringify(ep.retryPolicy), createdAt],
    );
    return { ...ep, id, createdAt };
  }

  private rowToEndpoint(r: Row): WebhookEndpoint {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      url: r.url as string,
      description: (r.description as string | null) ?? null,
      enabled: Number(r.enabled) === 1,
      eventFilter: JSON.parse(r.event_filter as string),
      retryPolicy: JSON.parse(r.retry_policy as string) as RetryPolicy,
      createdAt: r.created_at as string,
    };
  }

  /** Secret is returned only to the delivery worker; API responses must use listEndpoints/getEndpoint. */
  async getEndpointWithSecret(id: string): Promise<{ endpoint: WebhookEndpoint; encryptedSecret: string } | null> {
    const r = await this.get("SELECT * FROM webhook_endpoints WHERE id = ?", [id]);
    return r ? { endpoint: this.rowToEndpoint(r), encryptedSecret: r.encrypted_secret as string } : null;
  }

  async getEndpoint(id: string): Promise<WebhookEndpoint | null> {
    return (await this.getEndpointWithSecret(id))?.endpoint ?? null;
  }

  async listEndpoints(projectId: string): Promise<WebhookEndpoint[]> {
    return (await this.all("SELECT * FROM webhook_endpoints WHERE project_id = ? ORDER BY created_at", [projectId])).map((r) => this.rowToEndpoint(r));
  }

  async setEndpointEnabled(id: string, enabled: boolean): Promise<void> {
    await this.run("UPDATE webhook_endpoints SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  }

  async updateEndpoint(id: string, patch: { url?: string; description?: string | null; enabled?: boolean; eventFilter?: string[]; retryPolicy?: RetryPolicy; encryptedSecret?: string }): Promise<void> {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (patch.url !== undefined) { sets.push("url = ?"); args.push(patch.url); }
    if (patch.description !== undefined) { sets.push("description = ?"); args.push(patch.description); }
    if (patch.enabled !== undefined) { sets.push("enabled = ?"); args.push(patch.enabled ? 1 : 0); }
    if (patch.eventFilter !== undefined) { sets.push("event_filter = ?"); args.push(JSON.stringify(patch.eventFilter)); }
    if (patch.retryPolicy !== undefined) { sets.push("retry_policy = ?"); args.push(JSON.stringify(patch.retryPolicy)); }
    if (patch.encryptedSecret !== undefined) { sets.push("encrypted_secret = ?"); args.push(patch.encryptedSecret); }
    if (!sets.length) return;
    await this.run(`UPDATE webhook_endpoints SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
  }

  async deleteEndpoint(id: string): Promise<void> {
    await this.tx(async (s) => {
      await s.run("DELETE FROM automation_rules WHERE endpoint_id = ?", [id]);
      await s.run("DELETE FROM webhook_endpoints WHERE id = ?", [id]); // deliveries and attempts cascade
    });
  }

  // --------------------------------------------------------------- deliveries
  private rowToDelivery(r: Row): WebhookDelivery {
    return {
      id: r.id as string,
      eventId: r.event_id as string,
      endpointId: r.endpoint_id as string,
      kind: r.kind as WebhookDelivery["kind"],
      status: r.status as DeliveryStatus,
      attemptCount: Number(r.attempt_count),
      nextAttemptAt: (r.next_attempt_at as string | null) ?? null,
      lastResponseStatus: r.last_response_status === null ? null : Number(r.last_response_status),
      lastError: (r.last_error as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  /** Returns the new delivery id, or null if an initial delivery already exists for this (event, endpoint). */
  async createDelivery(eventId: string, endpointId: string, kind: "initial" | "replay", now = new Date()): Promise<string | null> {
    const id = uid("dlv_", 24);
    const t = now.toISOString();
    const r = await this.run(
      this.ignore(`INSERT OR IGNORE INTO webhook_deliveries (id, event_id, endpoint_id, kind, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`),
      [id, eventId, endpointId, kind, t, t, t],
    );
    return r.changes === 1 ? id : null;
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    const r = await this.get("SELECT * FROM webhook_deliveries WHERE id = ?", [id]);
    return r ? this.rowToDelivery(r) : null;
  }

  async listDeliveries(q: { eventId?: string; endpointId?: string; status?: DeliveryStatus; limit?: number }): Promise<WebhookDelivery[]> {
    const where: string[] = ["1=1"];
    const args: (string | number)[] = [];
    if (q.eventId) { where.push("event_id = ?"); args.push(q.eventId); }
    if (q.endpointId) { where.push("endpoint_id = ?"); args.push(q.endpointId); }
    if (q.status) { where.push("status = ?"); args.push(q.status); }
    args.push(Math.min(q.limit ?? 100, 500));
    return (await this.all(`SELECT * FROM webhook_deliveries WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`, args)).map((r) => this.rowToDelivery(r));
  }

  async dueDeliveries(now: Date, limit = 20): Promise<WebhookDelivery[]> {
    return (await this.all("SELECT * FROM webhook_deliveries WHERE status IN ('pending','retrying') AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?", [now.toISOString(), limit])).map((r) => this.rowToDelivery(r));
  }

  /**
   * Atomically takes a due delivery for one worker by pushing its next_attempt_at forward by `leaseMs`.
   * Returns false if another worker already took it. If the worker dies mid-attempt the lease simply expires and the
   * delivery is retried (at-least-once: consumers de-duplicate on the event id).
   */
  async claimDelivery(id: string, now: Date, leaseMs: number): Promise<boolean> {
    const r = await this.run("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ? AND status IN ('pending','retrying') AND next_attempt_at <= ?", [new Date(now.getTime() + leaseMs).toISOString(), id, now.toISOString()]);
    return r.changes === 1;
  }

  async recordAttempt(a: WebhookAttempt, next: { status: DeliveryStatus; nextAttemptAt: string | null; lastError: string | null }): Promise<void> {
    await this.tx(async (s) => {
      await s.run(
        `INSERT INTO webhook_attempts (id, delivery_id, attempt_number, started_at, finished_at, response_status, response_duration_ms, sanitised_response, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [a.id, a.deliveryId, a.attemptNumber, a.startedAt, a.finishedAt, a.responseStatus, a.responseDurationMs, a.sanitisedResponse, a.errorCode],
      );
      await s.run(
        "UPDATE webhook_deliveries SET status = ?, attempt_count = ?, next_attempt_at = ?, last_response_status = ?, last_error = ?, updated_at = ? WHERE id = ?",
        [next.status, a.attemptNumber, next.nextAttemptAt, a.responseStatus, next.lastError, a.finishedAt, a.deliveryId],
      );
    });
  }

  async listAttempts(deliveryId: string): Promise<WebhookAttempt[]> {
    return (await this.all("SELECT * FROM webhook_attempts WHERE delivery_id = ? ORDER BY attempt_number", [deliveryId])).map((r) => ({
      id: r.id as string,
      deliveryId: r.delivery_id as string,
      attemptNumber: Number(r.attempt_number),
      startedAt: r.started_at as string,
      finishedAt: r.finished_at as string,
      responseStatus: r.response_status === null ? null : Number(r.response_status),
      responseDurationMs: Number(r.response_duration_ms),
      sanitisedResponse: (r.sanitised_response as string | null) ?? null,
      errorCode: (r.error_code as string | null) ?? null,
    }));
  }

  // -------------------------------------------------------------------- users
  async createUser(email: string, passwordHash: string, opts: { verified?: boolean; githubId?: string; githubLogin?: string } = {}): Promise<{ id: string; email: string; createdAt: string } | null> {
    const id = uid("usr_", 20);
    const createdAt = new Date().toISOString();
    const r = await this.run(
      this.ignore("INSERT OR IGNORE INTO users (id, email, password_hash, created_at, email_verified_at, github_id, github_login) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      [id, email.toLowerCase(), passwordHash, createdAt, opts.verified ? createdAt : null, opts.githubId ?? null, opts.githubLogin ?? null],
    );
    return r.changes === 1 ? { id, email: email.toLowerCase(), createdAt } : null;
  }

  private userRow(r: Row): UserRecord {
    return {
      id: r.id as string, email: r.email as string, passwordHash: r.password_hash as string, createdAt: r.created_at as string,
      emailVerifiedAt: (r.email_verified_at as string | null) ?? null, githubId: (r.github_id as string | null) ?? null, githubLogin: (r.github_login as string | null) ?? null,
      totpEnabledAt: (r.totp_enabled_at as string | null) ?? null,
    };
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const r = await this.get("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);
    return r ? this.userRow(r) : null;
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const r = await this.get("SELECT * FROM users WHERE id = ?", [id]);
    return r ? this.userRow(r) : null;
  }

  // ----------------------------------------------------------- two-factor sign-in
  /** Starts (or restarts) setup with a fresh encrypted secret. Refused while two-factor is already on. */
  async setTotpSecret(userId: string, encryptedSecret: string): Promise<boolean> {
    const r = await this.run("UPDATE users SET totp_secret = ?, totp_last_step = NULL, recovery_codes = NULL WHERE id = ? AND totp_enabled_at IS NULL", [encryptedSecret, userId]);
    return r.changes === 1;
  }

  async getTotp(userId: string): Promise<{ secretEnc: string | null; enabledAt: string | null; lastStep: number | null; recoveryLeft: number } | null> {
    const r = await this.get("SELECT totp_secret, totp_enabled_at, totp_last_step, recovery_codes FROM users WHERE id = ?", [userId]);
    if (!r) return null;
    const codes = r.recovery_codes ? (JSON.parse(r.recovery_codes as string) as string[]) : [];
    return { secretEnc: (r.totp_secret as string | null) ?? null, enabledAt: (r.totp_enabled_at as string | null) ?? null, lastStep: r.totp_last_step === null || r.totp_last_step === undefined ? null : Number(r.totp_last_step), recoveryLeft: codes.length };
  }

  /** Turns two-factor on after a first valid code, and stores the hashed recovery codes. */
  async enableTotp(userId: string, now: Date, step: number, recoveryHashes: string[]): Promise<boolean> {
    const r = await this.run("UPDATE users SET totp_enabled_at = ?, totp_last_step = ?, recovery_codes = ? WHERE id = ? AND totp_secret IS NOT NULL AND totp_enabled_at IS NULL", [now.toISOString(), step, JSON.stringify(recoveryHashes), userId]);
    return r.changes === 1;
  }

  /** Replaces the recovery codes (the old ones stop working). */
  async setRecoveryCodes(userId: string, recoveryHashes: string[]): Promise<void> {
    await this.run("UPDATE users SET recovery_codes = ? WHERE id = ? AND totp_enabled_at IS NOT NULL", [JSON.stringify(recoveryHashes), userId]);
  }

  async disableTotp(userId: string): Promise<void> {
    await this.run("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, recovery_codes = NULL WHERE id = ?", [userId]);
  }

  /** Records a used time step. True only for the first caller, so two requests carrying the same code cannot both succeed. */
  async claimTotpStep(userId: string, step: number): Promise<boolean> {
    const r = await this.run("UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)", [step, userId, step]);
    return r.changes === 1;
  }

  /** Uses one recovery code (by hash). True only once per code, even under concurrent attempts. */
  async useRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const r = await this.get("SELECT recovery_codes FROM users WHERE id = ?", [userId]);
    const raw = (r?.recovery_codes as string | null) ?? null;
    if (!raw) return false;
    const codes = JSON.parse(raw) as string[];
    if (!codes.includes(codeHash)) return false;
    const next = JSON.stringify(codes.filter((c) => c !== codeHash));
    return (await this.run("UPDATE users SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?", [next, userId, raw])).changes === 1;
  }

  async getUserByGithubId(githubId: string): Promise<UserRecord | null> {
    const r = await this.get("SELECT * FROM users WHERE github_id = ?", [githubId]);
    return r ? this.userRow(r) : null;
  }

  async markEmailVerified(userId: string, now: Date = new Date()): Promise<void> {
    await this.run("UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL", [now.toISOString(), userId]);
  }

  async linkGithub(userId: string, githubId: string, githubLogin: string): Promise<void> {
    await this.run("UPDATE users SET github_id = ?, github_login = ? WHERE id = ?", [githubId, githubLogin, userId]);
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
  }

  // -------------------------------------------------------------- auth tokens
  /** Issues a token, superseding any earlier unused one of the same kind for this user (only the newest link works). */
  async createAuthToken(userId: string, kind: AuthTokenKind, tokenHash: string, expiresAt: Date, now: Date = new Date()): Promise<void> {
    await this.run("DELETE FROM auth_tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL", [userId, kind]);
    await this.run("INSERT INTO auth_tokens (id, user_id, kind, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [uid("tok_", 20), userId, kind, tokenHash, now.toISOString(), expiresAt.toISOString()]);
  }

  /** Reads a token without using it (a wrong second-factor code must not burn the sign-in challenge). Null for unknown, expired, wrong-kind or used. */
  async peekAuthToken(kind: AuthTokenKind, tokenHash: string, now: Date = new Date()): Promise<string | null> {
    const r = await this.get("SELECT user_id FROM auth_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?", [tokenHash, kind, now.toISOString()]);
    return r ? (r.user_id as string) : null;
  }

  /** Atomically uses a token: returns its user id once, and null for unknown, expired, wrong-kind or already-used tokens. */
  async consumeAuthToken(kind: AuthTokenKind, tokenHash: string, now: Date = new Date()): Promise<string | null> {
    const r = await this.get("SELECT user_id FROM auth_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?", [tokenHash, kind, now.toISOString()]);
    if (!r) return null;
    const won = await this.run("UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", [now.toISOString(), tokenHash]);
    return won.changes === 1 ? (r.user_id as string) : null; // two concurrent uses: exactly one wins
  }

  // ----------------------------------------------------------------- sessions
  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [tokenHash, userId, new Date().toISOString(), expiresAt.toISOString()]);
  }

  /** Returns the user id for a live (unexpired, unrevoked) session. */
  async findSessionUser(tokenHash: string, now: Date = new Date()): Promise<string | null> {
    const r = await this.get("SELECT user_id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?", [tokenHash, now.toISOString()]);
    return r ? (r.user_id as string) : null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.run("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", [new Date().toISOString(), tokenHash]);
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [new Date().toISOString(), userId]);
  }

  /** Deletes sessions that expired or were revoked more than a day ago. */
  async purgeSessions(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - 86_400_000).toISOString();
    await this.run("DELETE FROM auth_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)", [cutoff, cutoff]);
    return (await this.run("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)", [cutoff, cutoff])).changes;
  }

  // ---------------------------------------------------------------- contracts
  async createContract(c: { projectId: string; address: string; name?: string | null; abi?: unknown | null; startBlock?: number | null; deploymentTxHash?: string | null; runtimeType?: "evm" | "ink" }): Promise<ContractRecord | null> {
    const id = uid("ctr_", 20);
    const createdAt = new Date().toISOString();
    const runtimeType = c.runtimeType ?? "evm";
    // EVM addresses are case-insensitive hex and stored lower-case; SS58 addresses are case-sensitive and kept exactly as given.
    const address = runtimeType === "ink" ? c.address : c.address.toLowerCase();
    const r = await this.run(
      this.ignore("INSERT OR IGNORE INTO contracts (id, project_id, address, name, runtime_type, abi, start_block, deployment_tx_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)"),
      [id, c.projectId, address, c.name ?? null, runtimeType, c.abi ? JSON.stringify(c.abi) : null, c.startBlock ?? null, c.deploymentTxHash?.toLowerCase() ?? null, createdAt],
    );
    return r.changes === 1 ? this.getContract(id) : null;
  }

  private rowToContract(r: Row): ContractRecord {
    return { id: r.id as string, projectId: r.project_id as string, address: r.address as string, name: (r.name as string | null) ?? null, runtimeType: r.runtime_type as string, abi: r.abi ? JSON.parse(r.abi as string) : null, startBlock: r.start_block === null ? null : Number(r.start_block), deploymentTxHash: (r.deployment_tx_hash as string | null) ?? null, status: r.status as string, createdAt: r.created_at as string };
  }

  async getContract(id: string): Promise<ContractRecord | null> {
    const r = await this.get("SELECT * FROM contracts WHERE id = ?", [id]);
    return r ? this.rowToContract(r) : null;
  }

  async listContracts(projectId: string): Promise<ContractRecord[]> {
    return (await this.all("SELECT * FROM contracts WHERE project_id = ? ORDER BY created_at, id", [projectId])).map((r) => this.rowToContract(r));
  }

  async contractEventCounts(projectId: string): Promise<Record<string, number>> {
    const rows = await this.all("SELECT contract_address AS a, COUNT(*) AS n FROM events WHERE project_id = ? GROUP BY contract_address", [projectId]);
    return Object.fromEntries(rows.map((r) => [r.a as string, Number(r.n)]));
  }

  // -------------------------------------------------------------- automations
  async createAutomation(a: { projectId: string; name: string; triggerEventName: string | null; triggerContract: string | null; endpointId: string }): Promise<AutomationRecord> {
    const id = uid("aut_", 20);
    const createdAt = new Date().toISOString();
    const contract = a.triggerContract?.toLowerCase() ?? null;
    await this.run("INSERT INTO automation_rules (id, project_id, name, trigger_event_name, trigger_contract, endpoint_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)", [id, a.projectId, a.name, a.triggerEventName, contract, a.endpointId, createdAt]);
    return { id, projectId: a.projectId, name: a.name, triggerEventName: a.triggerEventName, triggerContract: contract, endpointId: a.endpointId, enabled: true, createdAt };
  }

  async listAutomations(projectId: string): Promise<AutomationRecord[]> {
    return (await this.all("SELECT * FROM automation_rules WHERE project_id = ? ORDER BY created_at, id", [projectId])).map((r) => ({
      id: r.id as string, projectId: r.project_id as string, name: r.name as string,
      triggerEventName: (r.trigger_event_name as string | null) ?? null, triggerContract: (r.trigger_contract as string | null) ?? null,
      endpointId: r.endpoint_id as string, enabled: Number(r.enabled) === 1, createdAt: r.created_at as string,
    }));
  }

  async getAutomation(id: string): Promise<AutomationRecord | null> {
    const r = await this.get("SELECT project_id FROM automation_rules WHERE id = ?", [id]);
    return r ? (await this.listAutomations(r.project_id as string)).find((a) => a.id === id) ?? null : null;
  }

  async setAutomationEnabled(id: string, enabled: boolean): Promise<void> {
    await this.run("UPDATE automation_rules SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  }

  async deleteAutomation(id: string): Promise<void> {
    await this.run("DELETE FROM automation_rules WHERE id = ?", [id]);
  }

  // -------------------------------------------------------- queries for the UI
  async searchEvents(q: { projectId: string; search?: string; contractAddress?: string; eventName?: string; finalityStatus?: string; deliveryStatus?: DeliveryStatus; limit?: number; offset?: number }): Promise<{ items: NormalizedEvent[]; total: number }> {
    const where = ["e.project_id = ?"];
    const args: (string | number)[] = [q.projectId];
    if (q.search) {
      const like = "%" + q.search.toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m) + "%";
      where.push("(lower(e.transaction_hash) LIKE ? ESCAPE '\\' OR e.contract_address LIKE ? ESCAPE '\\' OR lower(COALESCE(e.event_name,'')) LIKE ? ESCAPE '\\' OR lower(e.id) LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }
    if (q.contractAddress) { where.push("e.contract_address = ?"); args.push(q.contractAddress.toLowerCase()); }
    if (q.eventName) { where.push("e.event_name = ?"); args.push(q.eventName); }
    if (q.finalityStatus) { where.push("e.finality_status = ?"); args.push(q.finalityStatus); }
    if (q.deliveryStatus) {
      where.push("EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id = e.id AND d.status = ?)");
      args.push(q.deliveryStatus);
    }
    const sql = `FROM events e WHERE ${where.join(" AND ")}`;
    const total = Number((await this.get(`SELECT COUNT(*) AS n ${sql}`, args))!.n);
    const rows = await this.all(`SELECT e.* ${sql} ORDER BY e.block_number DESC, e.event_index DESC LIMIT ? OFFSET ?`, [...args, Math.min(q.limit ?? 50, 200), q.offset ?? 0]);
    return { items: rows.map((r) => this.rowToEvent(r)), total };
  }

  /** Most recent delivery status per event, for list views. */
  async deliveryStatusByEvent(eventIds: string[]): Promise<Record<string, { status: DeliveryStatus; count: number }>> {
    if (!eventIds.length) return {};
    const marks = eventIds.map(() => "?").join(",");
    const rows = await this.all(`SELECT event_id, status FROM webhook_deliveries WHERE event_id IN (${marks}) ORDER BY created_at, id`, eventIds);
    const out: Record<string, { status: DeliveryStatus; count: number }> = {};
    for (const r of rows) {
      const k = r.event_id as string;
      const cur = out[k] ?? { status: r.status as DeliveryStatus, count: 0 };
      cur.status = r.status as DeliveryStatus; // chronological: the last row is the most recent delivery
      cur.count++;
      out[k] = cur;
    }
    return out;
  }

  async projectStats(projectId: string): Promise<{ events: number; delivered: number; failed: number; retrying: number; pending: number; activeEndpoints: number; lastEventObservedAt: string | null }> {
    const n = async (sql: string, ...a: string[]) => Number((await this.get(sql, a))!.n);
    const dc = async (status: DeliveryStatus) =>
      Number((await this.get("SELECT COUNT(*) AS n FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id WHERE w.project_id = ? AND d.status = ?", [projectId, status]))!.n);
    return {
      events: await n("SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND finality_status != 'orphaned'", projectId),
      delivered: await dc("delivered"), failed: await dc("failed"), retrying: await dc("retrying"), pending: await dc("pending"),
      activeEndpoints: await n("SELECT COUNT(*) AS n FROM webhook_endpoints WHERE project_id = ? AND enabled = 1", projectId),
      lastEventObservedAt: ((await this.get("SELECT MAX(observed_at) AS t FROM events WHERE project_id = ?", [projectId]))!.t as string | null) ?? null,
    };
  }

  /** Deliveries for a project joined with their event, most recently updated first. Used by the Replay Centre. */
  async listProjectDeliveries(projectId: string, status?: DeliveryStatus, limit = 100): Promise<{ delivery: WebhookDelivery; event: NormalizedEvent }[]> {
    const rows = await this.all(
      `SELECT d.* FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id WHERE w.project_id = ? ${status ? "AND d.status = ?" : ""} ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`,
      status ? [projectId, status, Math.min(limit, 500)] : [projectId, Math.min(limit, 500)],
    );
    const out: { delivery: WebhookDelivery; event: NormalizedEvent }[] = [];
    for (const r of rows) {
      const delivery = this.rowToDelivery(r);
      const event = await this.getEvent(delivery.eventId);
      if (event) out.push({ delivery, event });
    }
    return out;
  }

  // ---------------------------------------------------------- service status
  async beat(name: string, detail?: unknown, now: Date = new Date()): Promise<void> {
    await this.run(
      "INSERT INTO service_status (name, updated_at, detail) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET updated_at = excluded.updated_at, detail = excluded.detail",
      [name, now.toISOString(), detail === undefined ? null : JSON.stringify(detail)],
    );
  }

  async getServiceStatus(name: string): Promise<{ updatedAt: string; detail: unknown } | null> {
    const r = await this.get("SELECT updated_at, detail FROM service_status WHERE name = ?", [name]);
    return r ? { updatedAt: r.updated_at as string, detail: r.detail ? JSON.parse(r.detail as string) : null } : null;
  }

  // ----------------------------------------------------------------- api keys
  async createApiKey(k: { projectId: string; name: string; scope: "read" | "write"; prefix: string; keyHash: string; createdBy: string | null; expiresAt?: string | null }): Promise<ApiKeyRecord> {
    const id = uid("key_", 20);
    const createdAt = new Date().toISOString();
    const expiresAt = k.expiresAt ?? null;
    await this.run("INSERT INTO api_keys (id, project_id, name, scope, prefix, key_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, k.projectId, k.name, k.scope, k.prefix, k.keyHash, k.createdBy, createdAt, expiresAt]);
    return { id, projectId: k.projectId, name: k.name, scope: k.scope, prefix: k.prefix, createdAt, lastUsedAt: null, revokedAt: null, expiresAt };
  }

  private rowToApiKey(r: Row): ApiKeyRecord {
    return { id: r.id as string, projectId: r.project_id as string, name: r.name as string, scope: r.scope as "read" | "write", prefix: r.prefix as string, createdAt: r.created_at as string, lastUsedAt: (r.last_used_at as string | null) ?? null, revokedAt: (r.revoked_at as string | null) ?? null, expiresAt: (r.expires_at as string | null) ?? null };
  }

  /** Looks a key up by the hash of its plaintext. Returns the owner of the project too, because a key acts on its owner's behalf. */
  async findApiKeyByHash(keyHash: string): Promise<(ApiKeyRecord & { ownerId: string | null }) | null> {
    const r = await this.get("SELECT k.*, p.owner_id AS owner_id FROM api_keys k JOIN projects p ON p.id = k.project_id WHERE k.key_hash = ?", [keyHash]);
    return r ? { ...this.rowToApiKey(r), ownerId: (r.owner_id as string | null) ?? null } : null;
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | null> {
    const r = await this.get("SELECT * FROM api_keys WHERE id = ?", [id]);
    return r ? this.rowToApiKey(r) : null;
  }

  async listApiKeys(projectId: string): Promise<ApiKeyRecord[]> {
    return (await this.all("SELECT * FROM api_keys WHERE project_id = ? ORDER BY created_at DESC, id DESC", [projectId])).map((r) => this.rowToApiKey(r));
  }

  async countActiveApiKeys(projectId: string): Promise<number> {
    return Number((await this.get("SELECT COUNT(*) AS n FROM api_keys WHERE project_id = ? AND revoked_at IS NULL", [projectId]))!.n);
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.run("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [new Date().toISOString(), id]);
  }

  // ------------------------------------------------------------ shared rate limits
  /** Counts one request against a fixed window shared by every API instance. Returns the count in the current window and when it ends. */
  async hitRateLimit(key: string, windowMs: number, nowMs: number): Promise<{ hits: number; windowEnd: number }> {
    const end = nowMs + windowMs;
    const r = await this.get(
      "INSERT INTO rate_limits (key, hits, window_end) VALUES (?, 1, ?) ON CONFLICT (key) DO UPDATE SET " +
        "hits = CASE WHEN rate_limits.window_end <= ? THEN 1 ELSE rate_limits.hits + 1 END, " +
        "window_end = CASE WHEN rate_limits.window_end <= ? THEN ? ELSE rate_limits.window_end END RETURNING hits, window_end",
      [key, end, nowMs, nowMs, end],
    );
    return { hits: Number(r!.hits), windowEnd: Number(r!.window_end) };
  }

  /** Removes counters whose window has ended. */
  async pruneRateLimits(nowMs: number): Promise<void> {
    await this.run("DELETE FROM rate_limits WHERE window_end <= ?", [nowMs]);
  }

  /** Records use at most once a minute per key so a busy integration does not turn every request into a write. */
  async touchApiKey(id: string, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 60_000).toISOString();
    await this.run("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)", [now.toISOString(), id, cutoff]);
  }

  // -------------------------------------------------------------------- audit
  async audit(action: string, actorId: string | null, projectId: string | null, metadata?: unknown): Promise<void> {
    await this.run("INSERT INTO audit_logs (project_id, actor_id, action, metadata, created_at) VALUES (?, ?, ?, ?, ?)", [projectId, actorId, action, metadata === undefined ? null : redact(JSON.stringify(metadata)), new Date().toISOString()]);
  }

  async listAudit(projectId: string, limit = 100): Promise<{ action: string; actorId: string | null; metadata: unknown; createdAt: string }[]> {
    return (await this.all("SELECT * FROM audit_logs WHERE project_id = ? ORDER BY id DESC LIMIT ?", [projectId, limit])).map((r) => ({
      action: r.action as string, actorId: (r.actor_id as string | null) ?? null, metadata: r.metadata ? JSON.parse(r.metadata as string) : null, createdAt: r.created_at as string,
    }));
  }

  // ---------------------------------------------------------- test receivers
  async createReceiver(endpointId: string, tokenHash: string): Promise<string> {
    const id = uid("rcv_", 20);
    await this.run("INSERT INTO test_receivers (id, endpoint_id, token_hash, mode, created_at) VALUES (?, ?, ?, 'ok', ?)", [id, endpointId, tokenHash, new Date().toISOString()]);
    return id;
  }

  private rowToReceiver(r: Row): ReceiverRecord {
    return { id: r.id as string, endpointId: r.endpoint_id as string, mode: r.mode as ReceiverMode, createdAt: r.created_at as string };
  }

  async getReceiverByTokenHash(tokenHash: string): Promise<ReceiverRecord | null> {
    const r = await this.get("SELECT * FROM test_receivers WHERE token_hash = ?", [tokenHash]);
    return r ? this.rowToReceiver(r) : null;
  }

  async getReceiverByEndpoint(endpointId: string): Promise<ReceiverRecord | null> {
    const r = await this.get("SELECT * FROM test_receivers WHERE endpoint_id = ?", [endpointId]);
    return r ? this.rowToReceiver(r) : null;
  }

  async setReceiverMode(id: string, mode: ReceiverMode): Promise<void> {
    await this.run("UPDATE test_receivers SET mode = ? WHERE id = ?", [mode, id]);
  }

  async receiverEventProcessed(receiverId: string, eventId: string): Promise<boolean> {
    return !!(await this.get("SELECT 1 AS x FROM receiver_requests WHERE receiver_id = ? AND event_id = ? AND outcome = 'ok' LIMIT 1", [receiverId, eventId]));
  }

  /** Keeps only the newest 100 rows per receiver so an unauthenticated sink cannot grow the database without bound. */
  async recordReceiverRequest(receiverId: string, r: Omit<ReceiverRequestRecord, "id" | "receivedAt"> & { receivedAt?: string }): Promise<void> {
    await this.tx(async (s) => {
      await s.run(
        "INSERT INTO receiver_requests (receiver_id, received_at, event_id, delivery_id, attempt, signature_ok, signature_reason, outcome, http_status, body_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [receiverId, r.receivedAt ?? new Date().toISOString(), r.eventId, r.deliveryId, r.attempt, r.signatureOk ? 1 : 0, r.signatureReason, r.outcome, r.httpStatus, r.bodyPreview],
      );
      await s.run("DELETE FROM receiver_requests WHERE receiver_id = ? AND id NOT IN (SELECT id FROM receiver_requests WHERE receiver_id = ? ORDER BY id DESC LIMIT 100)", [receiverId, receiverId]);
    });
  }

  async listReceiverRequests(receiverId: string, limit = 50): Promise<ReceiverRequestRecord[]> {
    return (await this.all("SELECT * FROM receiver_requests WHERE receiver_id = ? ORDER BY id DESC LIMIT ?", [receiverId, Math.min(limit, 100)])).map((r) => ({
      id: Number(r.id), receivedAt: r.received_at as string, eventId: (r.event_id as string | null) ?? null, deliveryId: (r.delivery_id as string | null) ?? null,
      attempt: r.attempt === null ? null : Number(r.attempt), signatureOk: Number(r.signature_ok) === 1, signatureReason: (r.signature_reason as string | null) ?? null,
      outcome: r.outcome as string, httpStatus: Number(r.http_status), bodyPreview: (r.body_preview as string | null) ?? null,
    }));
  }

  // --------------------------------------------------------------------- logs
  async log(level: "info" | "warn" | "error", area: string, message: string, meta?: unknown, projectId?: string): Promise<void> {
    await this.run("INSERT INTO logs (project_id, level, area, message, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)", [projectId ?? null, level, area, redact(message), meta === undefined ? null : redact(JSON.stringify(meta)), new Date().toISOString()]);
  }

  async listLogs(projectId: string, limit = 100): Promise<{ level: string; area: string; message: string; meta: unknown; createdAt: string }[]> {
    return (await this.all("SELECT * FROM logs WHERE project_id = ? ORDER BY id DESC LIMIT ?", [projectId, limit])).map((r) => ({
      level: r.level as string,
      area: r.area as string,
      message: r.message as string,
      meta: r.meta ? JSON.parse(r.meta as string) : null,
      createdAt: r.created_at as string,
    }));
  }
}
