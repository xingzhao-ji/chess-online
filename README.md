# Open Table

Private online chess for two people. Create a table, send the single-use invitation, and play in two browsers. A Node.js server owns the position, turn, clocks and outcome. The React client renders that state and never submits a trusted clock or board position.

This is a runnable portfolio MVP, not a hosted production service. It uses fresh interface code and system-font chess glyphs; no assets or code were copied from the existing Chess_LLM or private game repositories.

## Run

Requires **Node.js 24** and npm. SQLite is provided by `node:sqlite`; there is no separate database service.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3002**. Create a table and copy its invitation into a second browser or private window. The invitation claims Black once. Before joining, the client securely generates and saves its pending seat capability in this tab's session storage. If the response is lost, retry in the same tab—even after reload—to recover the same seat. A different claimant remains denied. Keep each browser's **private seat link** to resume after a reload or reconnect. Anyone with that link can control that seat, so share only the invitation with your opponent.

The database defaults to `data/chess.sqlite`. Restarting with the same file preserves games and command receipts. To expose a local server to your LAN, set `HOST=0.0.0.0` and share its reachable address. Put public deployments behind HTTPS; do not send capability links across untrusted plain HTTP.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP and WebSocket port |
| `HOST` | `127.0.0.1` | Bind address; Docker sets `0.0.0.0` |
| `DB_PATH` | `data/chess.sqlite` | Writable SQLite file on persistent local storage |
| `WEB_ORIGIN` | unset | One extra exact permitted browser origin, if needed |

For development, run `npm run dev:server` in one terminal and `npm run dev` in another. Open http://localhost:5173; Vite proxies `/api` and `/socket` to the backend. The production process serves both the compiled client and backend on port 3002.

## What is implemented

- One-use room invitations and independent random 256-bit seat capabilities. Black's pending capability is saved before claim submission and repeated claims from that same capability safely recover after lost responses. Only hashes are stored in SQLite. URL fragments keep capabilities out of HTTP request paths; sockets authenticate with a message, not a URL query.
- Server-side chess.js move validation, selected promotion/underpromotion, castling, en passant, checkmate and automatic draw adjudication. No optimistic moves change the displayed board before acknowledgment.
- Monotonic game version and idempotent command IDs bound to authenticated seat **and canonical payload**, including the expected version. Replays return the original receipt; changed-payload or cross-seat reuse is refused.
- A single SQLite transaction publishes state, accepted move and command receipt. WAL with `synchronous=FULL` is enabled. Failed receipts are also persisted; retrying the same rejected action preserves that result.
- Live WebSocket updates, presence, automatic reconnect, pending-command retry on reconnect, private seat links, authoritative timeout and persistence across server restarts.
- Responsive board with White/Black orientation, board flipping, legal-move markers, move history, promotion dialog, resignation confirmation and keyboard navigation.

Use **Tab** to enter the board, **arrow keys** to navigate, **Enter/Space** to select a piece or destination, and **Escape** to clear the selection. The promotion and confirmation dialogs are native modal dialogs.

## Clock and rules contract

White's first accepted move starts the clocks. No clock runs while waiting for the opponent or before that first move. An increment is added after every accepted move, including the first. Once started, elapsed wall time counts during disconnections **and server downtime**. On restart/next read, an expired clock is adjudicated before another move can be accepted. The browser display is an estimate corrected by server snapshots; the server alone decides the outcome.

This is casual chess: threefold repetition and the fifty-move rule draw automatically, without a claim. At timeout, the result is a draw if the opponent has only a king or chess.js reports insufficient material; otherwise the opponent wins. This intentionally does not implement every FIDE possible-mating-sequence edge case. A 2,048-ply room limit is also a draw. There are no takebacks, pauses or draw-offer negotiations. Restart semantics depend on a reasonably synchronized system wall clock; backward clock adjustments are clamped per calculation, not corrected by an external trusted time service.

## Verify

```sh
npm test
npm run build
```

The integration suite starts real HTTP/WebSocket servers on ephemeral loopback ports with isolated on-disk SQLite databases. It covers two-player agreement, illegal/out-of-turn/stale actions, duplicate ID payload and actor conflicts, concurrent connections to one seat, invalid capabilities, single-use invites, reconnect/retry, promotion, mate, resignation, threefold repetition and timeout. A real HTTP proxy consumes a committed join response and then drops it to verify safe claim recovery. A database trigger injects failure between state publication and move insertion to prove transaction rollback. A separate Node process is killed with **SIGKILL**, then recreated against the same SQLite file to verify committed moves/receipts and downtime timeout semantics. Focused helper tests verify session-storage failure handling and the outbound WebSocket byte budget.

See [recorded validation](docs/VALIDATION.md). These tests are not browser, accessibility, throughput or production availability certification. No 100-room stress result is claimed.

## Docker

```sh
docker compose up --build
```

Open http://localhost:3002. The named `chess-data` volume retains SQLite files across container recreation. `docker compose down` preserves that volume; `docker compose down -v` removes it. The image runs as the unprivileged Node user. Docker packaging is provided; execution in Docker is not part of the recorded local validation unless explicitly recorded there.

## Design and limits

[Protocol](docs/PROTOCOL.md) describes wire messages and recovery. [Plan](docs/PLAN.md) records the bounded scope.

One Node process owns one SQLite database. This is not a horizontally scaled architecture. Native clients may omit Origin but still require capabilities; browser Origin is checked. Limits include 4 KiB HTTP JSON bodies, 8 KiB incoming WebSocket frames, a 256 KiB application outbound queue/frame budget per socket, 500 simultaneous sockets, in-memory per-address API limits and per-connection command limits. A socket is terminated before the next message would exceed its outbound budget, including unsolicited broadcasts. These are basic resource controls, not comprehensive public-service abuse protection. No accounts, ratings, matchmaking, chat, anti-cheat, admin console, automatic retention or capability rotation/recovery is implemented. Lost seat links cannot be recovered after a successful claim; pending join recovery requires the original tab's session storage. Closing that tab or clearing its storage can lose a pending seat. If session storage is unavailable, joining is refused before a claim request is sent. Room and receipt records accumulate until the operator archives/removes the database. Use trusted local storage and backups; no physical power-loss guarantee is claimed.

Games are private capabilities, not end-to-end encrypted content. The server and database operator can read move histories. This app does not log HTTP requests, authentication payloads, room links or tokens; the CLI prints only its listening port. HTTPS termination and operational logs are the deployer's responsibility.

## Provenance

[chess.js](https://github.com/jhlywa/chess.js) supplies the chess rules engine under BSD-2-Clause. The project does **not** claim to have authored that engine. React/React DOM and ws are MIT-licensed dependencies. Exact versions are in `package-lock.json`; upstream notices are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the distributed notices file. Interface code, server protocol, persistence, tests and styling were created for this project. No externally hosted images or fonts are required.
