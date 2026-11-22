export { TicTacToeRoom } from "./room";
export { Lobby } from "./lobby";

const ROOM_ID = /^[a-z0-9-]{1,32}$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("games.belaschinke.com: game servers for belaschinke.com\n");
    }

    // Only pages on the site may open games from a browser. (Non-browser
    // clients can fake Origin, so this just stops other sites embedding it.)
    const origin = request.headers.get("Origin");
    if (origin && !isAllowedOrigin(origin, env)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    if (url.pathname.startsWith("/lobby")) return lobbyRoute(url, request, env, origin);

    const match = url.pathname.match(/^\/tictactoe\/([^/]+)$/);
    if (!match) return new Response("Not found", { status: 404 });

    const room = decodeURIComponent(match[1]).toLowerCase();
    if (!ROOM_ID.test(room)) {
      return new Response("Room names use a-z, 0-9 and '-', up to 32 characters", { status: 400 });
    }
    const stub = env.TICTACTOE_ROOM.get(env.TICTACTOE_ROOM.idFromName(room));
    const forwarded = new Request(request);
    forwarded.headers.set("X-Room-Name", room);
    return stub.fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;

export function isAllowedOrigin(origin: string, env: { ALLOWED_ORIGINS: string }): boolean {
  return env.ALLOWED_ORIGINS.split(",").some((pattern) => {
    pattern = pattern.trim();
    if (!pattern.includes("*")) return origin === pattern;
    // "*" matches one run of host characters, e.g. https://*--belaschinke.netlify.app
    const re = new RegExp(
      "^" + pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]+") + "$",
    );
    return re.test(origin);
  });
}

/**
 * GET /lobby                 open public rooms and the names in use
 * GET /lobby/rooms/<room>    {exists}: whether anyone is in that room
 * GET /lobby/free-room       {room}: a free three-digit room number
 */
async function lobbyRoute(url: URL, request: Request, env: Env, origin: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET" } });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });

  const lobby = env.LOBBY.get(env.LOBBY.idFromName("lobby"));
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers });

  if (url.pathname === "/lobby") return json(await lobby.view());
  if (url.pathname === "/lobby/free-room") return json({ room: await lobby.freeRoom() });
  const m = url.pathname.match(/^\/lobby\/rooms\/([^/]+)$/);
  if (m) {
    const room = decodeURIComponent(m[1]).toLowerCase();
    if (!ROOM_ID.test(room)) return new Response(JSON.stringify({ error: "bad room name" }), { status: 400, headers });
    return json({ exists: await lobby.exists(room) });
  }
  return new Response("Not found", { status: 404, headers });
}
