/** The WebSocket connection owns this health subscription, including idle
 * periods between takes. Closing it must release the captured session state. */
export function observeConnectionStatus(adapter, socket, handler) {
  const unsubscribe = adapter.onStatus(handler);
  socket.once('close', unsubscribe);
}
