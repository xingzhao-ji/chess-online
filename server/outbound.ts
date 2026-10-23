export const MAX_OUTBOUND_BYTES = 256 * 1024;
type OutboundSocket = { readyState: number; bufferedAmount: number; send: (data: string) => void; terminate: () => void };

export function canQueueOutbound(socket: Pick<OutboundSocket,'readyState'|'bufferedAmount'|'terminate'>, bytes: number): boolean {
  if (socket.readyState !== 1) return false;
  if (socket.bufferedAmount + bytes > MAX_OUTBOUND_BYTES) {socket.terminate();return false;}
  return true;
}

/** All application frames, including unsolicited state/presence broadcasts, pass through this boundary. */
export function sendBounded(socket: OutboundSocket, value: unknown): boolean {
  if (socket.readyState !== 1) return false;
  const encoded = JSON.stringify(value);
  if (!canQueueOutbound(socket, Buffer.byteLength(encoded, 'utf8'))) return false;
  socket.send(encoded);
  return true;
}
