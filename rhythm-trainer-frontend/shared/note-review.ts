export interface NoteReviewItem {
  id: string;
  eventId: string | null;
  measure: number | null;
  pitch: number | null;
  actualPitch: number | null;
  pitchLabel: string;
  state: 'good' | 'attention' | 'error' | 'unknown';
  result: string;
  messages: string[];
  onsetErrorMs: number | null;
  intervalErrorMs: number | null;
  expectedDurationMs: number | null;
  actualDurationMs: number | null;
  durationResult: string;
}
export interface NoteReview {
  takeId: string;
  kind: 'timeline' | 'follow' | 'unavailable';
  trustworthy: boolean;
  scoreFingerprint: string | null;
  xml: string | null;
  notice: string;
  items: NoteReviewItem[];
}
