import { DurableObject } from "cloudflare:workers";

/**
 * One lobby for all tic-tac-toe rooms (a single Durable Object, "lobby").
 *
 * Every room reports who is sitting in it after each seat change; the lobby
 * keeps one row per occupied room. From that it answers:
 *   - which public rooms have one player waiting (the "open rooms" row)
 *   - which names are in use (so the page can suggest a free nickname)
 *   - whether a room exists (so the page can say "Join" or "Create")
 *   - a free three-digit room number for a new room
 *
 * Rows of rooms that stopped reporting (a crashed or evicted room) expire
 * after STALE_MS.
 */

export interface RoomReport {
  public: boolean;
  /** names of the players seated now; empty means the room is gone */
  names: string[];
  /** a player is seated and waiting for a second one */
  open: boolean;
}

export interface LobbyView {
  open: { room: string; host: string }[];
  names: string[];
}

const STALE_MS = 60 * 60 * 1000;
const MAX_OPEN = 24;

export class Lobby extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS rooms (
         id TEXT PRIMARY KEY,
         public INTEGER NOT NULL,
         open INTEGER NOT NULL,
         names TEXT NOT NULL,
         updated INTEGER NOT NULL
       )`,
    );
  }

  report(room: string, r: RoomReport): void {
    if (r.names.length === 0) {
      this.ctx.storage.sql.exec("DELETE FROM rooms WHERE id = ?", room);
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (id, public, open, names, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public = excluded.public, open = excluded.open,
         names = excluded.names, updated = excluded.updated`,
      room,
      r.public ? 1 : 0,
      r.open ? 1 : 0,
      JSON.stringify(r.names),
      Date.now(),
    );
  }

  view(): LobbyView {
    this.prune();
    const rows = this.ctx.storage.sql
      .exec<{ id: string; public: number; open: number; names: string }>("SELECT id, public, open, names FROM rooms ORDER BY updated DESC")
      .toArray();
    const names = rows.flatMap((r) => JSON.parse(r.names) as string[]);
    const open = rows
      .filter((r) => r.public && r.open)
      .slice(0, MAX_OPEN)
      .map((r) => ({ room: r.id, host: (JSON.parse(r.names) as string[])[0] ?? "" }));
    return { open, names };
  }

  exists(room: string): boolean {
    this.prune();
    return this.ctx.storage.sql.exec("SELECT 1 FROM rooms WHERE id = ?", room).toArray().length > 0;
  }

  /** A random three-digit room nobody is in; a longer number if all are taken. */
  freeRoom(): string {
    this.prune();
    const taken = new Set(this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM rooms").toArray().map((r) => r.id));
    const free: string[] = [];
    for (let n = 100; n <= 999; n++) if (!taken.has(String(n))) free.push(String(n));
    if (free.length) return free[randomInt(free.length)];
    let id: string;
    do id = String(1000 + randomInt(9_000_000));
    while (taken.has(id));
    return id;
  }

  private prune(): void {
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE updated < ?", Date.now() - STALE_MS);
  }
}

function randomInt(max: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % max;
}
