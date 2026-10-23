# Protocol and persistence

## HTTP

`POST /api/rooms` accepts JSON `{ "seconds": 600, "increment": 5 }`. Integer ranges are 1–3600 and 0–30. A 201 response contains `{ roomId, token, invite }`; `token` controls White. These are capabilities: do not put responses into logs.

`POST /api/rooms/:id/join` accepts `{ "invite": "...", "claimToken": "..." }`. Before sending, the client generates a cryptographically random 32-byte capability, encodes it as canonical unpadded base64url (43 characters), and persists it in this tab's session storage. The server atomically binds its hash to Black and returns `{ roomId, token }`, where `token` is exactly the caller's `claimToken`. Retrying with the same valid invite and capability is safe, including after a lost response or server restart. A different capability returns HTTP 409 and never reveals the original token. Noncanonical capabilities or aliases to White's capability/the invitation are rejected. Both authenticated seats can use multiple connections; their commands still serialize against one game version.

`GET /api/health` returns `{ "ok": true }`. Errors return `{ code, message }`. Browser requests must have same-host Origin or the configured exact `WEB_ORIGIN`. There is no CORS allow-all header.

## WebSocket

Connect to `/socket` with no capability in the URL. Within five seconds send:

```json
{ "type": "hello", "roomId": "<room-id>", "token": "<private-seat-capability>" }
```

The server authenticates once per connection. A `state` message includes `roomId`, `seat`, `version`, `fen`, `moves`, `whiteMs`, `blackMs`, `running`, `turn`, `outcome`, `check`, `blackJoined`, `serverNow`, `legalMoves` and `online`. Clocks are evaluated at `serverNow`. The browser measures local elapsed time since receiving the snapshot for a display estimate. No client-supplied time is trusted. `legalMoves` is populated only for the current authenticated player. Send `{ "type": "sync" }` for another state snapshot; the shipped client does this every five seconds.

All application writes—including replies and unsolicited position/presence broadcasts—use the same bounded-send helper. It checks `bufferedAmount + UTF-8 bytes of next message` before sending and terminates the connection if the result would exceed 256 KiB. Ping and pong control frames use the same budget check; automatic pong is disabled in favor of this bounded handler. The bound concerns the application/WebSocket queue; operating-system TCP buffers are separate. A client that stops reading cannot keep growing the application queue merely by sending pong frames.

```json
{
  "type": "move",
  "commandId": "<new-UUID>",
  "expectedVersion": 0,
  "from": "e2",
  "to": "e4"
}
```

Promotion requires `"promotion": "q"`, `"r"`, `"b"` or `"n"`. A resignation uses `{ "type": "resign", "commandId": "...", "expectedVersion": 4 }`.

An `ack` has `commandId`, `ok`, `version` and, on rejection, `code`/`message`. Every well-formed new command records a receipt inside the state transaction, including rejected commands. Malformed envelopes are `error` messages and receive no receipt. Retry an uncertain command with **exactly** the same ID and fields. A receipt does not imply the current state is at its historical version; always consume the following authoritative state. A stale-version rejection requires a new action/new ID against the latest snapshot.

IDs are unique within a room. Their canonical payload contains all semantic fields; extra unsupported JSON keys are ignored and never gain authority. Reusing an ID with another seat or different canonical fields returns `command_conflict`. Clock expiry is checked before command receipt replay, so retrying a historical command cannot pause time or undo an outcome.

## SQLite transaction

`rooms` stores hashed seat/invite capabilities, serialized game state and an indexed deadline. `moves` stores accepted SAN, resulting FEN, ply and command identity. `commands` stores authenticated seat, canonical payload, receipt and timestamp. There are no raw capabilities in these tables.

Each command runs in `BEGIN IMMEDIATE` → check deadline → read/check receipt → check version and rules → update state → insert accepted move (if any) → insert receipt → `COMMIT`. Any write failure rolls back the whole operation. Deadline adjudication is also a transaction and increments version once. No network reply is emitted before commit. A 200 ms timer checks only indexed due deadlines, and authenticated state reads also check expiry. Reload rebuilds chess.js from persisted SAN moves so repetition history remains available.

The current deployment model is a single Node process. Do not run multiple server processes on the same file: SQLite will serialize writes, but cross-process WebSocket broadcasts and presence are not implemented. Persistent volumes must be local filesystem volumes with proper SQLite locking semantics.

## Client reconnection

Connections retry with bounded backoff up to five seconds. After authenticating and receiving a state, the client resends its in-memory unacknowledged command once on that connection. This is safe through command receipts. The pending move queue is not written to browser storage; a full page reload obtains current state instead. Private seat links in the URL fragment survive reload. A fragment is not sent in normal HTTP requests or Referer headers, but remains readable by browser extensions, local history and anyone shown the URL.

Pending **seat claims** have a different lifecycle: the capability is written and read back from session storage before the HTTP request. Failed requests retain it. Reloading the same tab reads the saved capability and offers a retry. Only after the returned private seat URL is installed does the client remove the pending claim. If storage cannot be accessed or retain the value, the UI shows an error and sends no claim request. Tab closure/storage clearing can lose this recovery identity; this is not account-based recovery.
