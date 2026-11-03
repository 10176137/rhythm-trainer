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
import { randomUUID } from 'node:crypto';
/** @typedef {{ socket: LeaseSocket, takeId: unknown, practiceSessionId?: unknown, leaseId?: string, interrupt?: (sameConnection: boolean) => void }} TimelineLease */
/** @typedef {{ socket: LeaseSocket, takeId: unknown, leaseId?: string, interrupt?: (sameConnection: boolean) => void }} FollowLease */

const SOCKET_OPEN = 1;

/** @param {LeaseSocket | null | undefined} socket */
function isOpen(socket) {
  return socket?.readyState === SOCKET_OPEN;
}

export class SessionBusyError extends Error {
  /** @param {string} message @param {ReturnType<SessionOwnership['conflictFor']>} conflict */
  constructor(message, conflict) { super(message); this.code = 'SESSION_BUSY'; this.conflict = conflict; }
}

export class SessionOwnership {
  /** @type {TimelineLease | null} */
  timelineLease = null;
  /** @type {FollowLease | null} */
  followLease = null;
  /** @type {((event: unknown) => void) | null} */
  nodeSink = null;

  /** Opaque generation identifies one Take, never an engine-local counter.
   * @param {LeaseSocket} socket */
  conflictFor(socket) {
    const lease = this.timelineLease ?? this.followLease;
    return lease ? { leaseId: lease.leaseId, kind: this.timelineLease ? 'timeline' : 'follow', self: lease.socket === socket } : null;
  }

  /** Explicit compare-and-takeover. A stale tap cannot interrupt a newer Take.
   * @param {LeaseSocket} socket @param {unknown} expectedLeaseId */
  takeOver(socket, expectedLeaseId) {
    const conflict = this.conflictFor(socket);
    if ((conflict?.leaseId ?? null) !== expectedLeaseId) {
      throw new SessionBusyError('练习占用状态已变化，请确认后重新接管', conflict);
    }
    const lease = this.timelineLease ?? this.followLease;
    if (lease) {
      if (!lease.interrupt) throw new Error('当前练习无法接管，请先在原设备结束');
      lease.interrupt(lease.socket === socket);
    }
    if (this.timelineLease || this.followLease) throw new Error('原练习未释放，暂时无法接管');
  }

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
        throw new SessionBusyError('另一个设备有进行中的练习，请先结束那一轮或接管练习', this.conflictFor(socket));
      }
      this.timelineLease = null;
    }
    if (hasFollowRuntime || (this.followLease && this.followLease.socket === socket)) {
      throw new SessionBusyError('已有进行中的跟手练习，请先结束当前轮次', this.conflictFor(socket));
    }
    if (this.followLease && this.followLease.socket !== socket) {
      throw new SessionBusyError('另一个设备有进行中的跟手练习，请先结束那一轮或接管练习', this.conflictFor(socket));
    }
    if (hasNative) throw new SessionBusyError('已有进行中的练习轮次，请先结束当前轮次', this.conflictFor(socket));
  }

  /**
   * @param {{ socket: LeaseSocket, hasNative: boolean, hasActiveTake: boolean, hasFollowRuntime: boolean }} options
   */
  assertFollowStartAllowed({ socket, hasNative, hasActiveTake, hasFollowRuntime }) {
    if (this.followLease && this.followLease.socket !== socket) {
      throw new SessionBusyError('另一个设备有进行中的跟手练习，请先结束那一轮或接管练习', this.conflictFor(socket));
    }
    if (this.timelineLease || hasNative || hasActiveTake) {
      throw new SessionBusyError('已有进行中的练习轮次，请先结束当前轮次', this.conflictFor(socket));
    }
    if (hasFollowRuntime) throw new SessionBusyError('已有进行中的跟手练习', this.conflictFor(socket));
  }

  /** @param {TimelineLease} lease */
  claimTimeline(lease) {
    if (this.timelineLease && this.timelineLease.socket !== lease.socket) {
      throw new Error('练习租约已被其他连接占用，请重新确认当前轮次');
    }
    this.timelineLease = { ...lease, leaseId: randomUUID() };
  }

  /** @param {FollowLease} lease */
  claimFollow(lease) {
    if (this.followLease && this.followLease.socket !== lease.socket) {
      throw new Error('跟手练习租约已被其他连接占用，请重新确认当前轮次');
    }
    this.followLease = { ...lease, leaseId: randomUUID() };
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
