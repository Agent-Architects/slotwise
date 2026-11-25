import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Db, SqlValue } from "../core/ports.js";

// node:sqlite is loaded through require so bundlers and test runners that do not know the builtin leave it alone.
const require = createRequire(import.meta.url);
type DatabaseSync = import("node:sqlite").DatabaseSync;

/**
 * Node adapter on the built-in node:sqlite (synchronous). Each statement runs to completion before any
 * other request can run, so the single-statement booking insert is atomic here too.
 */
export class SqliteDb implements Db {
  readonly kind = "sqlite";
  readonly raw: DatabaseSync;
  constructor(path: string) {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }
  migrate(dir: string): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set((this.raw.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      this.raw.exec("BEGIN");
      try {
        this.raw.exec(readFileSync(join(dir, f), "utf8"));
        this.raw.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
        this.raw.exec("COMMIT");
      } catch (e) {
        this.raw.exec("ROLLBACK");
        throw e;
      }
    }
  }
  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (this.raw.prepare(sql).get(...params) as T | undefined) ?? null;
  }
  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }
  async batch(stmts: { sql: string; params?: SqlValue[] }[]): Promise<{ changes: number }[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = stmts.map((s) => ({ changes: Number(this.raw.prepare(s.sql).run(...(s.params ?? [])).changes) }));
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  close(): void {
    this.raw.close();
  }
}
