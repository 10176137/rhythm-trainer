/**
 * Process-wide ownership of the single live practice slot.
 *
 * The WebSocket handler is per connection, but MIDI input and the Take lease
 * are global: only one connection may own a timeline or Follow take at a time.
 * Keeping the three fields here makes the start checks and every release path
 * read the same state, instead of each connection closure re-deriving it.
 *
 * This module owns leases and the Node MIDI sink only. Connection-local runtime
 * (`native`, `activeTake`, `followRuntime`) stays with the connection.
 */

/** @typedef {{ readyState?: number }} LeaseSocket */
/** @typedef {{ socket: LeaseSocket, takeId: unknown, practiceSessionId?: unknown }} TimelineLease */
/** @typedef {{ socket: LeaseSocket, takeId: unknown }} FollowLease */

const SOCKET_OPEN = 1;

/** @param {LeaseSocket | null | undefined} socket */
function isOpen(socket) {
  return socket?.readyState === SOCKET_OPEN;
}

export class SessionOwnership {
  /** @type {TimelineLease | null} */
  timelineLease = null;
  /** @type {FollowLease | null} */
  followLease = null;
  /** @type {((event: unknown) => void) | null} */
  nodeSink = null;

  /**
   * Throws the user-facing conflict instead of silently replacing a live Take.
   * @param {{ socket: LeaseSocket, hasNative: boolean, hasFollowRuntime: boolean }} options
   */
  assertTimelineStartAllowed({ socket, hasNative, hasFollowRuntime }) {
    const lease = this.timelineLease;
    if (lease && lease.socket !== socket) {
      // A lease held by a closed socket must not block the next practice; the
      // close handler normally releases it, this is the last-resort takeover.
      if (isOpen(lease.socket)) {
        throw new Error('另一个设备有进行中的练习，请先结束那一轮或等待其断连保存');
      }
      this.timelineLease = null;
    }
    if (hasFollowRuntime || (this.followLease && this.followLease.socket === socket)) {
      throw new Error('已有进行中的跟手练习，请先结束当前轮次');
    }
    if (this.followLease && this.followLease.socket !== socket) {
      throw new Error('另一个设备有进行中的跟手练习，请先结束那一轮或等待其断连保存');
    }
    if (hasNative) throw new Error('已有进行中的练习轮次，请先结束当前轮次');
  }

  /**
   * @param {{ socket: LeaseSocket, hasNative: boolean, hasActiveTake: boolean, hasFollowRuntime: boolean }} options
   */
  assertFollowStartAllowed({ socket, hasNative, hasActiveTake, hasFollowRuntime }) {
    if (this.followLease && this.followLease.socket !== socket) {
      throw new Error('另一个设备有进行中的跟手练习，请先结束那一轮或等待其断连保存');
    }
    if (this.timelineLease || hasNative || hasActiveTake) {
      throw new Error('已有进行中的练习轮次，请先结束当前轮次');
    }
    if (hasFollowRuntime) throw new Error('已有进行中的跟手练习');
  }

  /** @param {{ socket: LeaseSocket, takeId: unknown, practiceSessionId?: unknown }} lease */
  claimTimeline(lease) {
    if (this.timelineLease && this.timelineLease.socket !== lease.socket) {
      throw new Error('练习租约已被其他连接占用，请重新确认当前轮次');
    }
    this.timelineLease = lease;
  }

  /** @param {{ socket: LeaseSocket, takeId: unknown }} lease */
  claimFollow(lease) {
    if (this.followLease && this.followLease.socket !== lease.socket) {
      throw new Error('跟手练习租约已被其他连接占用，请重新确认当前轮次');
    }
    this.followLease = lease;
  }

  /** Release is scoped to the owner; another connection cannot free it. */
  /** @param {LeaseSocket} socket */
  releaseTimeline(socket) {
    if (this.timelineLease?.socket === socket) this.timelineLease = null;
  }

  /** @param {LeaseSocket} socket */
  releaseFollow(socket) {
    if (this.followLease?.socket === socket) this.followLease = null;
  }

  /** @param {LeaseSocket} socket */
  isTimelineHeldBy(socket) {
    return this.timelineLease?.socket === socket;
  }

  /** @param {LeaseSocket} socket */
  isFollowHeldBy(socket) {
    return this.followLease?.socket === socket;
  }

  /** @param {(event: unknown) => void} sink */
  attachSink(sink) {
    this.nodeSink = sink;
  }

  /** Identity-based detach: an old connection must not unhook the new sink. */
  /** @param {(event: unknown) => void} sink */
  detachSink(sink) {
    if (this.nodeSink === sink) this.nodeSink = null;
  }

  /** @param {unknown} event */
  dispatch(event) {
    if (this.nodeSink) this.nodeSink(event);
  }
}
