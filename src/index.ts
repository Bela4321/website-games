export { TicTacToeRoom } from "./room";

const ROOM_ID = /^[a-z0-9-]{1,32}$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("games.belaschinke.com: game servers for belaschinke.com\n");
    }

    const match = url.pathname.match(/^\/tictactoe\/([^/]+)$/);
    if (!match) return new Response("Not found", { status: 404 });

    // Only pages on the site may open games from a browser. (Non-browser
    // clients can fake Origin, so this just stops other sites embedding it.)
    const origin = request.headers.get("Origin");
    if (origin && !isAllowedOrigin(origin, env)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    const room = decodeURIComponent(match[1]).toLowerCase();
    if (!ROOM_ID.test(room)) {
      return new Response("Room names use a-z, 0-9 and '-', up to 32 characters", { status: 400 });
    }
    const stub = env.TICTACTOE_ROOM.get(env.TICTACTOE_ROOM.idFromName(room));
    return stub.fetch(request);
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
