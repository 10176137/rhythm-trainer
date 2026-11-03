export interface PerformanceReplay {
  version: 1; takeId: string; durationMs: number; warnings: string[];
  notes: Array<{ id: string; pitch: number; velocity: number; atMs: number; durationMs: number; keyDurationMs: number | null }>;
}
