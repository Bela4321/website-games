import { DurableObject } from "cloudflare:workers";
import { applyMove, newGame, other, type Game, type Mark } from "./tictactoe";

/**
 * One Durable Object per tic-tac-toe room. Two players connect over
 * WebSockets; after every change each of them receives the full state.
 *
 * Uses the WebSocket Hibernation API, so an idle room costs nothing: the
 * object may be evicted between messages while sockets stay open. Everything
 * that must survive that lives in storage (game + seats) or in the socket's
 * attachment (which seat it holds).
 *
 * Connect: /tictactoe/<room>?name=<display name>&pid=<random id per browser>
 *
 * Seats: a player who drops or reloads keeps their seat (and the game) for
 * SEAT_GRACE_SECONDS; reconnecting with the same pid resumes. Only a clean
 * close (code 1000, i.e. the client pressed "leave") frees the seat at once.
 * A new pairing always starts a fresh game.
 *
 * The first player in an empty room decides whether it is listed in the
 * lobby (?public=1); the room reports its seats to the lobby after each change.
 *
 * Client -> server:  {type:"move", cell:0..8} | {type:"rematch"} | "ping"
 * Server -> client:  {type:"state", ...} | {type:"error", code, message} | "pong"
 */

interface Seat {
  pid: string;
  name: string;
  leftAt: number | null; // ms timestamp while disconnected
}

/** stored on each socket */
interface Attachment {
  mark: Mark;
  pid: string;
}

interface Stored {
  game: Game;
  rematch: Mark[];
  seats: Partial<Record<Mark, Seat>>;
  /** the room's name, as the lobby knows it */
  room?: string;
  /** listed in the lobby's open rooms while a player waits */
  public?: boolean;
}

export type ClientState = {
  type: "state";
  you: Mark;
  /** waiting: a seat is empty; paused: opponent disconnected, seat held */
  status: "waiting" | "paused" | "playing" | "over";
  players: Partial<Record<Mark, { name: string; connected: boolean }>>;
  board: Game["board"];
  turn: Mark;
  winner: Game["winner"];
  line: number[] | null;
  rematch: Mark[];
};

const MAX_MESSAGE_BYTES = 1024;
export const CLOSE_ROOM_FULL = 4001;
export const CLOSE_REPLACED = 4002;
const PID = /^[A-Za-z0-9_-]{8,64}$/;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const MARKS: Mark[] = ["X", "O"];

const fresh = (): Stored => ({ game: newGame("X"), rematch: [], seats: {} });

export class TicTacToeRoom extends DurableObject<Env> {
  private stored: Stored = fresh();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // keep-alive answered by the runtime without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.stored = (await ctx.storage.get<Stored>("state")) ?? fresh();
    });
  }

  private get graceMs(): number {
    return Number(this.env.SEAT_GRACE_SECONDS) * 1000;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const params = new URL(request.url).searchParams;
    const name = cleanName(params.get("name"));
    const rawPid = params.get("pid") ?? "";
    const pid = PID.test(rawPid) ? rawPid : crypto.randomUUID();
    const room = request.headers.get("X-Room-Name") ?? this.stored.room;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const ok = new Response(null, { status: 101, webSocket: client });

    const seats = { ...this.stored.seats };

    // 1. Returning player: take the seat back, keep the game.
    const own = MARKS.find((m) => seats[m]?.pid === pid);
    if (own) {
      for (const s of this.sockets().filter((s) => s.att.mark === own)) {
        s.ws.serializeAttachment(null);
        tryClose(s.ws, CLOSE_REPLACED, "reconnected elsewhere");
      }
      server.serializeAttachment({ mark: own, pid } satisfies Attachment);
      seats[own] = { pid, name, leftAt: null };
      await this.save({ ...this.stored, seats, room });
      this.broadcast();
      return ok;
    }

    // 2. Newcomer: an empty seat, or one whose holder has been gone too long.
    const now = Date.now();
    const empty = MARKS.filter((m) => !seats[m]);
    const expired = MARKS.filter((m) => {
      const left = seats[m]?.leftAt;
      return left != null && now - left >= this.graceMs;
    });
    const mark = empty.length === 2 ? randomMark() : (empty[0] ?? expired[0]);
    if (!mark) {
      // Browsers can't read an HTTP error on a failed upgrade, so accept,
      // explain, and close with an app-specific code.
      send(server, { type: "error", code: "room_full", message: "This room already has two players." });
      tryClose(server, CLOSE_ROOM_FULL, "room full");
      return ok;
    }

    server.serializeAttachment({ mark, pid } satisfies Attachment);
    // whoever opens an empty room decides whether it is listed
    const isPublic = Object.keys(seats).length === 0 ? params.get("public") === "1" : this.stored.public;
    seats[mark] = { pid, name, leftAt: null };
    const opponent = seats[other(mark)];
    // a new pairing starts a fresh game
    const next = opponent ? { game: newGame(randomMark()), rematch: [] } : this.stored;
    await this.save({ ...next, seats, room, public: isPublic });
    this.broadcast();
    return ok;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return; // a socket we are about to close

    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    if (size > MAX_MESSAGE_BYTES || typeof raw !== "string") {
      return send(ws, { type: "error", code: "bad_message", message: "Message not understood." });
    }
    let msg: { type?: unknown; cell?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: "error", code: "bad_message", message: "Message not understood." });
    }

    if (!this.bothConnected()) {
      return send(ws, { type: "error", code: "no_opponent", message: "Your opponent isn't here right now." });
    }

    if (msg.type === "move") {
      const result = applyMove(this.stored.game, att.mark, msg.cell);
      if (!result.ok) return send(ws, { type: "error", code: "illegal_move", message: result.error });
      await this.save({ ...this.stored, game: result.game, rematch: [] });
    } else if (msg.type === "rematch") {
      if (!this.stored.game.winner) {
        return send(ws, { type: "error", code: "not_over", message: "The game isn't over yet." });
      }
      const rematch = [...new Set([...this.stored.rematch, att.mark])];
      if (rematch.length === 2) {
        await this.save({ ...this.stored, game: newGame(other(this.stored.game.starter)), rematch: [] });
      } else {
        await this.save({ ...this.stored, rematch });
      }
    } else {
      return send(ws, { type: "error", code: "bad_message", message: "Message not understood." });
    }
    this.broadcast();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.leave(ws, code === 1000);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws, false);
  }

  /** Clears a room nobody has been connected to for a while. */
  async alarm(): Promise<void> {
    if (this.sockets().length > 0) return;
    const room = this.stored.room;
    await this.ctx.storage.deleteAll();
    this.stored = fresh();
    if (room) await this.lobby().report(room, { public: false, names: [], open: false });
  }

  // ---------------------------------------------------------------------------

  private async leave(ws: WebSocket, deliberate: boolean): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    ws.serializeAttachment(null);
    tryClose(ws, 1000, "bye");
    if (!att) return; // never seated, or seat already handed to a new socket

    const seats = { ...this.stored.seats };
    const seat = seats[att.mark];
    if (seat?.pid === att.pid) {
      if (deliberate) delete seats[att.mark];
      else seats[att.mark] = { ...seat, leftAt: Date.now() };
      await this.save({ ...this.stored, seats });
    }
    if (this.sockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + Math.max(EMPTY_ROOM_TTL_MS, this.graceMs));
    }
    this.broadcast();
  }

  private sockets(): { ws: WebSocket; att: Attachment }[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as Attachment | null }))
      .filter((s): s is { ws: WebSocket; att: Attachment } => s.att !== null);
  }

  private connectedMarks(): Set<Mark> {
    return new Set(this.sockets().map((s) => s.att.mark));
  }

  private bothConnected(): boolean {
    return this.connectedMarks().size === 2;
  }

  private async save(next: Stored): Promise<void> {
    this.stored = next;
    await this.ctx.storage.put("state", next);
    await this.reportToLobby();
  }

  private lobby() {
    return this.env.LOBBY.get(this.env.LOBBY.idFromName("lobby"));
  }

  /** Tells the lobby who sits here now (players gone past their grace count as gone). */
  private async reportToLobby(): Promise<void> {
    const { room, seats } = this.stored;
    if (!room) return;
    const now = Date.now();
    const present = MARKS.map((m) => seats[m]).filter(
      (s): s is Seat => !!s && (s.leftAt == null || now - s.leftAt < this.graceMs),
    );
    try {
      await this.lobby().report(room, {
        public: !!this.stored.public,
        names: present.map((s) => s.name),
        open: present.length === 1 && present[0].leftAt == null,
      });
    } catch {
      /* the lobby is a convenience: a game never fails because of it */
    }
  }

  private broadcast(): void {
    const { game, rematch, seats } = this.stored;
    const connected = this.connectedMarks();
    const players: ClientState["players"] = {};
    for (const m of MARKS) {
      const seat = seats[m];
      if (seat) players[m] = { name: seat.name, connected: connected.has(m) };
    }
    const status: ClientState["status"] =
      !seats.X || !seats.O ? "waiting" : connected.size < 2 ? "paused" : game.winner ? "over" : "playing";
    for (const { ws, att } of this.sockets()) {
      send(ws, {
        type: "state",
        you: att.mark,
        status,
        players,
        board: game.board,
        turn: game.turn,
        winner: game.winner,
        line: game.line,
        rematch,
      } satisfies ClientState);
    }
  }
}

function send(ws: WebSocket, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    /* socket already gone; close handler cleans up */
  }
}

function tryClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

function cleanName(raw: string | null): string {
  const name = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
  return name || "Anonymous";
}

function randomMark(): Mark {
  return crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? "X" : "O";
}
