import { describe, expect, it } from 'vitest';
import { SessionOwnership, SessionBusyError } from './session-ownership.mjs';

const openSocket = () => ({ readyState: 1 });
const closedSocket = () => ({ readyState: 3 });

describe('explicit Take takeover', () => {
  it('scopes takeover to an opaque generation and never interrupts a newer Take', () => {
    const ownership = new SessionOwnership(); const owner = openSocket(); const next = openSocket();
    let interrupted = 0;
    const interrupt = () => { interrupted++; ownership.releaseTimeline(owner); };
    ownership.claimTimeline({ socket: owner, takeId: 1, interrupt });
    const old = ownership.conflictFor(next);
    expect(old).toMatchObject({ kind: 'timeline', self: false });
    ownership.releaseTimeline(owner);
    ownership.claimTimeline({ socket: owner, takeId: 1, interrupt });
    expect(() => ownership.takeOver(next, old?.leaseId)).toThrow(SessionBusyError);
    expect(interrupted).toBe(0);
    ownership.takeOver(next, ownership.conflictFor(next)?.leaseId);
    expect(interrupted).toBe(1); expect(ownership.conflictFor(next)).toBeNull();
  });
  it('can recover its own orphaned runtime and reports finalization failure', () => {
    const ownership = new SessionOwnership(); const owner = openSocket();
    ownership.claimFollow({ socket: owner, takeId: 'follow', interrupt: same => {
      expect(same).toBe(true); ownership.releaseFollow(owner); throw new Error('disk failure');
    } });
    expect(() => ownership.takeOver(owner, ownership.conflictFor(owner)?.leaseId)).toThrow('disk failure');
    expect(ownership.conflictFor(owner)).toBeNull();
    expect(() => ownership.takeOver(owner, null)).not.toThrow();
  });
});

describe('SessionOwnership start checks', () => {
  it('rejects a second connection while another one owns the timeline take', () => {
    const ownership = new SessionOwnership();
    const first = openSocket();
    const second = openSocket();
    ownership.claimTimeline({ socket: first, takeId: 'take-1' });
    expect(() => ownership.assertTimelineStartAllowed({ socket: second, hasNative: false, hasFollowRuntime: false }))
      .toThrow('另一个设备有进行中的练习');
    expect(ownership.isTimelineHeldBy(first)).toBe(true);
  });

  it('takes over a lease from a closed socket instead of blocking the next practice', () => {
    const ownership = new SessionOwnership();
    const dead = closedSocket();
    const next = openSocket();
    ownership.claimTimeline({ socket: dead, takeId: 'take-dead' });
    expect(() => ownership.assertTimelineStartAllowed({ socket: next, hasNative: false, hasFollowRuntime: false }))
      .not.toThrow();
    expect(ownership.timelineLease).toBeNull();
  });

  it('rejects a timeline start while another connection is practicing Follow', () => {
    const ownership = new SessionOwnership();
    const followOwner = openSocket();
    const timelineOwner = openSocket();
    ownership.claimFollow({ socket: followOwner, takeId: 'follow-1' });
    expect(() => ownership.assertTimelineStartAllowed({ socket: timelineOwner, hasNative: false, hasFollowRuntime: false }))
      .toThrow('另一个设备有进行中的跟手练习');
  });

  it('rejects a timeline start when this connection has a live Follow runtime', () => {
    const ownership = new SessionOwnership();
    const socket = openSocket();
    expect(() => ownership.assertTimelineStartAllowed({ socket, hasNative: false, hasFollowRuntime: true }))
      .toThrow('已有进行中的跟手练习，请先结束当前轮次');
  });

  it('rejects a timeline start when a native take is still active', () => {
    const ownership = new SessionOwnership();
    expect(() => ownership.assertTimelineStartAllowed({ socket: openSocket(), hasNative: true, hasFollowRuntime: false }))
      .toThrow('已有进行中的练习轮次');
  });

  it('rejects a Follow start while any timeline take is held', () => {
    const ownership = new SessionOwnership();
    ownership.claimTimeline({ socket: openSocket(), takeId: 'take-1' });
    expect(() => ownership.assertFollowStartAllowed({
      socket: openSocket(), hasNative: false, hasActiveTake: false, hasFollowRuntime: false,
    })).toThrow('已有进行中的练习轮次');
  });

  it('rejects a Follow start while its own connection has a live runtime', () => {
    const ownership = new SessionOwnership();
    const socket = openSocket();
    expect(() => ownership.assertFollowStartAllowed({
      socket, hasNative: false, hasActiveTake: false, hasFollowRuntime: true,
    })).toThrow('已有进行中的跟手练习');
  });

  it('does not let claim silently replace another connection lease', () => {
    const ownership = new SessionOwnership();
    ownership.claimTimeline({ socket: openSocket(), takeId: 'take-1' });
    expect(() => ownership.claimTimeline({ socket: openSocket(), takeId: 'take-2' })).toThrow('练习租约已被其他连接占用');
  });
});

describe('SessionOwnership release and sink', () => {
  it('releases only the owner lease', () => {
    const ownership = new SessionOwnership();
    const owner = openSocket();
    const other = openSocket();
    ownership.claimTimeline({ socket: owner, takeId: 'take-1' });
    ownership.releaseTimeline(other);
    expect(ownership.isTimelineHeldBy(owner)).toBe(true);
    ownership.releaseTimeline(owner);
    expect(ownership.timelineLease).toBeNull();
    ownership.releaseTimeline(owner);
    expect(ownership.timelineLease).toBeNull();
  });

  it('detaches a sink by identity so an old connection cannot unhook the new one', () => {
    const ownership = new SessionOwnership();
    const oldSink = () => {};
    const newSink = () => {};
    ownership.attachSink(oldSink);
    ownership.attachSink(newSink);
    ownership.detachSink(oldSink);
    expect(ownership.nodeSink).toBe(newSink);
    ownership.detachSink(newSink);
    expect(ownership.nodeSink).toBeNull();
  });

  it('forwards adapter events only while a sink is attached', () => {
    const ownership = new SessionOwnership();
    /** @type {unknown[]} */
    const seen = [];
    ownership.dispatch({ type: 'note-on' });
    ownership.attachSink((event) => seen.push(event));
    ownership.dispatch({ type: 'note-on' });
    expect(seen).toEqual([{ type: 'note-on' }]);
  });
});
