/** Backend-only refinement of a canonical ScoreDocumentV1. The original XML
 * identity remains unchanged; the refined input still passes Rust's frozen
 * document and plan fingerprint gates. React sends endpoint IDs, never a cropped document. */
function reject(message) { throw Object.assign(new Error(message), { code: 'INVALID_NOTE_RANGE' }); }
function validBeat(beat) {
  if (!beat || !Number.isSafeInteger(beat.numerator) || !Number.isSafeInteger(beat.denominator) || beat.denominator <= 0) reject('选段音符时间非法');
  return beat;
}
function compare(a, b) {
  validBeat(a); validBeat(b);
  const delta = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
function endBeat(event) {
  const a = validBeat(event.onsetBeat); const b = validBeat(event.durationBeat);
  let n = BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator);
  let d = BigInt(a.denominator) * BigInt(b.denominator);
  let x = n < 0n ? -n : n; let y = d;
  while (y) [x, y] = [y, x % y];
  if (x) { n /= x; d /= x; }
  if (!Number.isSafeInteger(Number(n)) || !Number.isSafeInteger(Number(d))) reject('选段时值超出精度范围');
  return { numerator: Number(n), denominator: Number(d) };
}
export function applyPlanNoteRange(document, selection, config) {
  if (selection == null) return document;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || Object.keys(selection).some((key) => !['startEventId', 'endEventId'].includes(key))
    || typeof selection.startEventId !== 'string' || typeof selection.endEventId !== 'string') reject('选段需要两个有效音符 ID');
  const sourcePart = document.parts?.find((part) => part.partId === config?.partId);
  if (!sourcePart) reject('选段声部不存在');
  const events = sourcePart.measures.flatMap((measure) => measure.events);
  const playable = (event) => event?.kind === 'note' && !event.isGrace && !event.isCue;
  let start = events.find((event) => event.eventId === selection.startEventId);
  let end = events.find((event) => event.eventId === selection.endEventId);
  if (!playable(start) || !playable(end)) reject('选段边界不是当前乐谱中的可练习音符');
  if (compare(start.onsetBeat, end.onsetBeat) > 0) [start, end] = [end, start];
  if (config.range?.startMeasureOrdinal !== start.source.measureOrdinal || config.range?.endMeasureOrdinal !== end.source.measureOrdinal) reject('音符边界与练习小节范围不一致');
  const refined = structuredClone(document);
  const part = refined.parts.find((part) => part.partId === config.partId);
  for (const measure of part.measures) {
    measure.events = measure.events.filter((event) => event.kind === 'rest'
      || (compare(event.onsetBeat, start.onsetBeat) >= 0 && compare(event.onsetBeat, end.onsetBeat) <= 0));
  }
  const kept = new Map(refined.parts.flatMap((part) => part.measures.flatMap((measure) => measure.events)).map((event) => [event.eventId, event]));
  refined.tieSpans = refined.tieSpans.flatMap((span) => {
    const members = span.eventIds.map((id) => kept.get(id)).filter(Boolean).sort((a, b) => compare(a.onsetBeat, b.onsetBeat));
    // A tie cut at the start becomes a new attack; a tie cut at the end ends
    // at the last retained note. A lone retained member is an ordinary note.
    members.forEach((event, index) => {
      event.tieStart = event.tiedStart = members.length > 1 && index < members.length - 1;
      event.tieStop = event.tiedStop = index > 0;
      if (members.length < 2) delete event.tieSpanId;
    });
    return members.length < 2 ? [] : [{ ...span, eventIds: members.map((event) => event.eventId), startBeat: members[0].onsetBeat, endBeat: endBeat(members.at(-1)) }];
  });
  return refined;
}
