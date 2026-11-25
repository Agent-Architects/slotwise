import type { Db, SqlValue } from "../core/ports.js";

/** Cloudflare D1 adapter. A single statement and a batch are each atomic in D1. */
export class D1Db implements Db {
  readonly kind = "d1";
  constructor(private d1: D1Database) {}
  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const r = await this.d1.prepare(sql).bind(...params).all<T>();
    return r.results ?? [];
  }
  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.d1.prepare(sql).bind(...params).first<T>()) ?? null;
  }
  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const r = await this.d1.prepare(sql).bind(...params).run();
    return { changes: r.meta.changes ?? 0 };
  }
  async batch(stmts: { sql: string; params?: SqlValue[] }[]): Promise<{ changes: number }[]> {
    const rs = await this.d1.batch(stmts.map((s) => this.d1.prepare(s.sql).bind(...(s.params ?? []))));
    return rs.map((r) => ({ changes: r.meta.changes ?? 0 }));
  }
}
