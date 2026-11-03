/** The WebSocket connection owns this health subscription, including idle
 * periods between takes. Closing it must release the captured session state. */
/**
 * @param {{ onStatus: (handler: any) => () => void }} adapter
 * @param {{ once: (event: string, handler: () => void) => void }} socket
 * @param {any} handler
 */
export function observeConnectionStatus(adapter, socket, handler) {
  const unsubscribe = adapter.onStatus(handler);
  socket.once('close', unsubscribe);
}
