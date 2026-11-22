import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ClientState, TicTacToeRoom } from "../src/room";

type Msg = ClientState | { type: "error"; code: string; message: string };

const ORIGIN = "https://belaschinke.com";
let roomCounter = 0;
const freshRoom = () => `room-${++roomCounter}-${crypto.randomUUID().slice(0, 8)}`;

/** Opens a socket to a room and exposes its messages as an async queue. */
async function connect(room: string, name: string, pid: string = crypto.randomUUID(), extra = "") {
  const res = await SELF.fetch(`https://games.test/tictactoe/${room}?name=${encodeURIComponent(name)}&pid=${pid}${extra}`, {
    headers: { Upgrade: "websocket", Origin: ORIGIN },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const queue: Msg[] = [];
  const waiting: ((m: Msg) => void)[] = [];
  let closeCode: number | null = null;
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string) as Msg;
    const w = waiting.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  ws.addEventListener("close", (e) => {
    closeCode = e.code;
  });
  ws.accept();

  const next = (): Promise<Msg> =>
    queue.length
      ? Promise.resolve(queue.shift()!)
      : new Promise((resolve, reject) => {
          waiting.push(resolve);
          setTimeout(() => reject(new Error(`${name}: no message within 2s`)), 2000);
        });
  const nextState = async (): Promise<ClientState> => {
    const m = await next();
    if (m.type !== "state") throw new Error(`${name}: expected state, got ${JSON.stringify(m)}`);
    return m;
  };
  return {
    ws,
    next,
    nextState,
    send: (data: unknown) => ws.send(typeof data === "string" ? data : JSON.stringify(data)),
    closeCode: () => closeCode,
    pid,
    name,
  };
}
type Client = Awaited<ReturnType<typeof connect>>;

/** Two connected players, returned as [whoever moves first, the other]. */
async function startGame(room = freshRoom()) {
  const a = await connect(room, "Ada");
  await a.nextState(); // waiting
  const b = await connect(room, "Bob");
  const [sa, sb] = [await a.nextState(), await b.nextState()];
  expect(sa.status).toBe("playing");
  return sa.turn === sa.you ? { first: a, second: b, room, state: sa } : { first: b, second: a, room, state: sb };
}

async function move(mover: Client, other: Client, cell: number) {
  mover.send({ type: "move", cell });
  return [await mover.nextState(), await other.nextState()] as const;
}

describe("http routing", () => {
  it("serves a health line on /", async () => {
    const res = await SELF.fetch("https://games.test/");
    expect(res.status).toBe(200);
  });
  it.each([
    ["/nope", 404],
    ["/tictactoe/", 404],
    ["/tictactoe/a/b", 404],
    ["/tictactoe/has%20space", 400],
    ["/tictactoe/" + "x".repeat(33), 400],
  ])("%s -> %i", async (path, status) => {
    const res = await SELF.fetch("https://games.test" + path, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(status);
  });
  it("rejects a plain GET to a room", async () => {
    expect((await SELF.fetch("https://games.test/tictactoe/abc")).status).toBe(426);
  });
  it("rejects foreign origins", async () => {
    const res = await SELF.fetch("https://games.test/tictactoe/abc", {
      headers: { Upgrade: "websocket", Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
  it("treats room names case-insensitively", async () => {
    const room = freshRoom();
    const a = await connect(room.toUpperCase(), "Ada");
    await a.nextState();
    const b = await connect(room, "Bob");
    expect((await b.nextState()).status).toBe("playing");
  });
});

describe("tic-tac-toe room", () => {
  it("first player waits, second starts the game with opposite marks and names", async () => {
    const room = freshRoom();
    const a = await connect(room, "Ada");
    const wait = await a.nextState();
    expect(wait).toMatchObject({ status: "waiting", players: { [wait.you]: { name: "Ada", connected: true } } });

    const b = await connect(room, "Bob");
    const [sa, sb] = [await a.nextState(), await b.nextState()];
    expect(sa.status).toBe("playing");
    expect(sa.you).not.toBe(sb.you);
    expect(sa.players).toEqual({
      [sa.you]: { name: "Ada", connected: true },
      [sb.you]: { name: "Bob", connected: true },
    });
    expect(sa.board).toEqual(Array(9).fill(null));
    expect(sa.turn).toBe(sb.turn);
  });

  it("a third connection is told the room is full and closed", async () => {
    const { room } = await startGame();
    const c = await connect(room, "Cy");
    expect(await c.next()).toMatchObject({ type: "error", code: "room_full" });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.closeCode()).toBe(4001);
  });

  it("can't move before an opponent arrives", async () => {
    const a = await connect(freshRoom(), "Ada");
    await a.nextState();
    a.send({ type: "move", cell: 0 });
    expect(await a.next()).toMatchObject({ type: "error", code: "no_opponent" });
  });

  it("rejects out-of-turn, taken and nonsense moves", async () => {
    const { first, second } = await startGame();
    second.send({ type: "move", cell: 0 });
    expect(await second.next()).toMatchObject({ code: "illegal_move" });

    await move(first, second, 4);
    second.send({ type: "move", cell: 4 });
    expect(await second.next()).toMatchObject({ code: "illegal_move" });
    second.send({ type: "move", cell: 12 });
    expect(await second.next()).toMatchObject({ code: "illegal_move" });
    second.send("not json");
    expect(await second.next()).toMatchObject({ code: "bad_message" });
    second.send({ type: "teleport" });
    expect(await second.next()).toMatchObject({ code: "bad_message" });
    second.send(JSON.stringify({ type: "move", cell: 0, pad: "x".repeat(2000) }));
    expect(await second.next()).toMatchObject({ code: "bad_message" });
  });

  it("plays to a win, then rematches with the other player starting", async () => {
    const { first, second, state } = await startGame();
    const starter = state.turn;
    await move(first, second, 0);
    await move(second, first, 3);
    await move(first, second, 1);
    await move(second, first, 4);
    const [s1, s2] = await move(first, second, 2);
    for (const s of [s1, s2]) {
      expect(s).toMatchObject({ status: "over", winner: starter, line: [0, 1, 2] });
    }

    first.send({ type: "move", cell: 8 });
    expect(await first.next()).toMatchObject({ code: "illegal_move" });

    first.send({ type: "rematch" });
    expect((await first.nextState()).rematch).toEqual([starter]);
    expect((await second.nextState()).status).toBe("over");
    second.send({ type: "rematch" });
    const [r1, r2] = [await second.nextState(), await first.nextState()];
    for (const r of [r1, r2]) {
      expect(r).toMatchObject({ status: "playing", winner: null, rematch: [], board: Array(9).fill(null) });
      expect(r.turn).not.toBe(starter);
    }
  });

  it("can't ask for a rematch mid-game", async () => {
    const { first } = await startGame();
    first.send({ type: "rematch" });
    expect(await first.next()).toMatchObject({ code: "not_over" });
  });

  it("when a player leaves deliberately the other waits, and a newcomer gets a fresh game", async () => {
    const { first, second, room } = await startGame();
    await move(first, second, 4);
    second.ws.close(1000, "bye");
    const left = await first.nextState();
    expect(left.status).toBe("waiting");
    expect(Object.values(left.players)).toHaveLength(1);

    const c = await connect(room, "Cy");
    const [s1, s3] = [await first.nextState(), await c.nextState()];
    expect(s1.status).toBe("playing");
    expect(s1.board).toEqual(Array(9).fill(null));
    expect(s3.you).not.toBe(s1.you);
  });

  it("a game survives the room being evicted from memory mid-match", async () => {
    const { first, second, room } = await startGame();
    await move(first, second, 4);
    await move(second, first, 0);

    const stub = env.TICTACTOE_ROOM.get(env.TICTACTOE_ROOM.idFromName(room));
    await evictDurableObject(stub); // sockets hibernate, memory is dropped

    const [s1, s2] = await move(first, second, 8);
    for (const s of [s1, s2]) {
      expect(s.status).toBe("playing");
      expect(s.board.filter(Boolean)).toHaveLength(3);
      expect(Object.keys(s.players)).toHaveLength(2);
    }
  });

  it("reconnecting with the same pid takes back the seat mid-game", async () => {
    const { first, second, room } = await startGame();
    await move(first, second, 4);
    const before = await (async () => {
      second.send({ type: "move", cell: 0 });
      return [await second.nextState(), await first.nextState()][0];
    })();

    // second's connection "drops" without a clean close; it comes back
    const again = await connect(room, "Bob again", second.pid);
    const [sAgain, sFirst] = [await again.nextState(), await first.nextState()];
    expect(sAgain.you).toBe(before.you);
    expect(sAgain.board).toEqual(before.board);
    expect(sAgain.status).toBe("playing");
    expect(sFirst.players[before.you]?.name).toBe("Bob again");
    await new Promise((r) => setTimeout(r, 50));
    expect(second.closeCode()).toBe(4002);

    // and the game carries on with the new socket
    const [m1] = await move(first, again, 8);
    expect(m1.board.filter(Boolean)).toHaveLength(3);
  });

  it("an invalid pid is replaced, so it can't be used to collide", async () => {
    const room = freshRoom();
    const a = await connect(room, "Ada", "x");
    await a.nextState();
    const b = await connect(room, "Bob", "x");
    const [sa, sb] = [await a.nextState(), await b.nextState()];
    expect(sa.you).not.toBe(sb.you);
  });

  it("a dropped player keeps their seat: room pauses, strangers are kept out, the game resumes", async () => {
    const { first, second, room } = await startGame();
    await move(first, second, 4);
    const [afterSecond] = await move(second, first, 0);
    const mark = afterSecond.you;

    second.ws.close(3000, "network gone"); // not 1000: not a deliberate leave
    const paused = await first.nextState();
    expect(paused.status).toBe("paused");
    expect(paused.players[mark]).toEqual({ name: second.name, connected: false });

    first.send({ type: "move", cell: 8 });
    expect(await first.next()).toMatchObject({ code: "no_opponent" });

    const stranger = await connect(room, "Cy");
    expect(await stranger.next()).toMatchObject({ code: "room_full" });

    const back = await connect(room, "Returning", second.pid);
    const [sBack, sFirst] = [await back.nextState(), await first.nextState()];
    expect(sBack.you).toBe(mark);
    expect(sBack.status).toBe("playing");
    expect(sBack.board.filter(Boolean)).toHaveLength(2);
    expect(sFirst.players[mark]).toEqual({ name: "Returning", connected: true });
  });

  it("after the grace period a newcomer may take the seat, with a fresh game", async () => {
    const { first, second, room } = await startGame();
    await move(first, second, 4);
    second.ws.close(3000, "gone");
    const paused = await first.nextState();
    const away = paused.you === "X" ? "O" : "X";

    // pretend the seat was vacated long ago
    const stub = env.TICTACTOE_ROOM.get(env.TICTACTOE_ROOM.idFromName(room));
    await runInDurableObject(stub, async (_instance: TicTacToeRoom, state) => {
      const stored = (await state.storage.get<any>("state"))!;
      stored.seats[away].leftAt = 0;
      await state.storage.put("state", stored);
    });
    await evictDurableObject(stub); // reload from storage

    const c = await connect(room, "Cy");
    const [sc, s1] = [await c.nextState(), await first.nextState()];
    expect(sc.you).toBe(away);
    expect(s1.status).toBe("playing");
    expect(s1.board).toEqual(Array(9).fill(null));
    expect(s1.players[away]?.name).toBe("Cy");
  });

  it("an empty room is wiped by its alarm", async () => {
    const { first, second, room } = await startGame();
    await move(first, second, 4);
    first.ws.close(3000, "gone");
    await second.nextState();
    second.ws.close(3000, "gone");
    await new Promise((r) => setTimeout(r, 100));

    const stub = env.TICTACTOE_ROOM.get(env.TICTACTOE_ROOM.idFromName(room));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_i: TicTacToeRoom, state) => {
      expect(await state.storage.get("state")).toBeUndefined();
    });

    // the old player id no longer holds anything: a fresh room
    const back = await connect(room, "Ada", first.pid);
    expect((await back.nextState()).status).toBe("waiting");
  });
});

describe("lobby", () => {
  const lobby = async (path = "") => {
    const res = await SELF.fetch(`https://games.test/lobby${path}`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    return res.json() as Promise<any>;
  };

  it("lists a public room while its host waits, and drops it once full", async () => {
    const room = freshRoom();
    const a = await connect(room, "Ada Lobby", undefined, "&public=1");
    await a.nextState();
    let view = await lobby();
    expect(view.open).toContainEqual({ room, host: "Ada Lobby" });
    expect(view.names).toContain("Ada Lobby");
    expect(await lobby(`/rooms/${room}`)).toEqual({ exists: true });

    const b = await connect(room, "Bob Lobby");
    await b.nextState();
    view = await lobby();
    expect(view.open.map((o: any) => o.room)).not.toContain(room);
    expect(view.names).toEqual(expect.arrayContaining(["Ada Lobby", "Bob Lobby"]));
  });

  it("never lists a private room, but still knows it exists", async () => {
    const room = freshRoom();
    const a = await connect(room, "Cy Private");
    await a.nextState();
    expect((await lobby()).open.map((o: any) => o.room)).not.toContain(room);
    expect(await lobby(`/rooms/${room}`)).toEqual({ exists: true });
  });

  it("only the first player decides whether a room is public", async () => {
    const room = freshRoom();
    const a = await connect(room, "Dee");
    await a.nextState();
    a.ws.close(1000);
    await new Promise((r) => setTimeout(r, 100));
    // empty again: the next host decides
    const b = await connect(room, "Eve", undefined, "&public=1");
    await b.nextState();
    expect((await lobby()).open).toContainEqual({ room, host: "Eve" });
  });

  it("forgets a room when its last player leaves", async () => {
    const room = freshRoom();
    const a = await connect(room, "Fay", undefined, "&public=1");
    await a.nextState();
    a.ws.close(1000);
    await new Promise((r) => setTimeout(r, 100));
    expect(await lobby(`/rooms/${room}`)).toEqual({ exists: false });
  });

  it("hands out a free three-digit room", async () => {
    const { room } = await lobby("/free-room");
    expect(room).toMatch(/^[1-9][0-9]{2}$/);
    expect(await lobby(`/rooms/${room}`)).toEqual({ exists: false });
  });

  it("rejects bad room names", async () => {
    const res = await SELF.fetch("https://games.test/lobby/rooms/has%20space", { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(400);
  });
});
