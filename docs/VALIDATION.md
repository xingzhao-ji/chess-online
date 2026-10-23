# Recorded validation

Environment: Node.js 24.19.0 on the implementation Linux host, 2026-10-23. These are local results, not a deployment or load claim.

- `npm test`: 19/19 tests pass. Real WebSocket/HTTP transport, isolated SQLite files, protocol invariants, a transaction-write failure injection, actual SIGKILL/process recreation, secure command-ID fallback, lost join-response recovery, pending-claim storage, and outbound queue boundaries are exercised.
- `npm run build`: passes strict TypeScript checks for client/server/tests, Vite client production build, and Node server compilation.
- Browser visual/interaction/accessibility QA: parent integration review confirmed create/invite/join, then found `crypto.randomUUID` unavailable on an HTTP preview origin. The command-ID helper now falls back to `crypto.getRandomValues`, with focused tests; parent browser revalidation remains separate.
- Docker build/run: not performed by this implementer. Dockerfile and Compose configuration are provided.
- 100-room or sustained load tests: not run. No throughput/latency/concurrency benchmark is claimed.

The first test invocation used the tsx CLI, whose temporary Unix socket was unavailable in this environment. The script now uses Node's supported `--import tsx` loader; the passing runs use that command. An initial CSS build failed on an unnecessary data import; it was removed before the passing build. These were tooling failures, not evidence of passing runtime checks.

Independent review found two additional failure boundaries: a committed join with a dropped response stranded Black, and slow socket readers could accumulate unbounded application output. The fixes make claims retryable from a client-persisted capability and route all application frames through a 256 KiB send budget. The join regression uses a real HTTP proxy that consumes the backend's committed response and destroys the client response. Pending-claim reload/storage failures and queued-byte boundaries use focused deterministic helper tests; they are not presented as browser tests or sustained networking benchmarks.
