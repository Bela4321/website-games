# website-games

Game servers for [belaschinke.com](https://belaschinke.com), running as a Cloudflare Worker.
Each tic-tac-toe room is a Durable Object; players connect over WebSockets.

- Live: `wss://games.belaschinke.workers.dev/tictactoe/<room>?name=<name>&pid=<player id>`
  (moves to `games.belaschinke.com` once the domain is on Cloudflare)
- Protocol and seat rules: see the comment at the top of `src/room.ts`

```sh
npm install
npm test          # runs inside the Workers runtime (Miniflare)
npm run dev       # local server on http://localhost:8787
npm run deploy    # manual deploy; pushes to main deploy automatically (Workers Builds)
```

Free plan, no servers, no database: an idle room hibernates, an empty room
deletes its own storage after 10 minutes.
