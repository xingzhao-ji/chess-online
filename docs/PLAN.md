# Open Table implementation plan

Build one friendly private-room chess experience. Server owns chess legality, move order, clocks and outcomes. SQLite stores game state, accepted moves and command receipts in one transaction. Authentication uses random capabilities delivered in URL fragments and authenticated WebSocket messages, never query parameters.

Implement and test the domain/store first, then HTTP/WebSocket transport, then a responsive keyboard-accessible React board. Tests use real sockets and isolated on-disk databases, including a server restart. Ship one Node process serving its compiled frontend, with Docker and CI. No matchmaking, accounts, payments, chat or rating system.

Clock policy: first accepted move starts the clocks; wall time continues during network outages and server downtime. Restore adjudicates an elapsed clock before accepting the next command. The user can resume the same room from a private seat link. The invite is single-use and claims Black. A command ID is bound to its authenticated seat and full canonical payload.
