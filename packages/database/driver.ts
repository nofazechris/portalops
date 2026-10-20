/**
 * The only thing the store needs from a database. Two implementations exist: SQLite (`sqlite-driver.ts`) and PostgreSQL
 * (`pg-driver.ts`). All SQL in the store is written once, with `?` placeholders, in the common subset of both dialects.
 * The few dialect differences (INSERT OR IGNORE, placeholders, DDL) are handled inside the store/drivers, never by callers.
 */

export type Row = Record<string, unknown>;

export interface SqlDriver {
  readonly dialect: "sqlite" | "postgres";
  /** Runs a query and returns all rows. */
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Runs a statement and returns how many rows it changed. */
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /**
   * Runs `fn` atomically. Everything `fn` does must go through the `tx` driver it is handed (that is the connection that holds the
   * transaction). Commits if `fn` resolves, rolls back if it throws. Nested calls on the `tx` driver reuse the same transaction.
   */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Converts `?` placeholders to PostgreSQL's `$1, $2, …`, ignoring any `?` inside single-quoted string literals. */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      out += c;
      if (inString && sql[i + 1] === "'") { out += "'"; i++; continue; } // escaped quote inside a literal
      inString = !inString;
    } else if (c === "?" && !inString) {
      out += "$" + ++n;
    } else {
      out += c;
    }
  }
  return out;
}
