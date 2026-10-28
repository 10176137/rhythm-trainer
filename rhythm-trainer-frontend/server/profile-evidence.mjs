import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Rebuildable cache. Each committed Take carries its own mastery evidence. */
export class ProfileEvidenceCache {
  #model;
  #ids = new Set();
  #dirty = false;
  constructor({ file, createModel, write, logger = console }) {
    this.file = file;
    this.write = write ?? ((record) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(tmp, 'wx');
        try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
      } finally { try { fs.unlinkSync(tmp); } catch { /* rename succeeded */ } }
    });
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.schemaVersion !== 1 || !Array.isArray(record.snapshot)) throw new Error('invalid profile');
      this.#model = createModel(record.snapshot);
      if (Array.isArray(record.appliedTakeIds)) this.#ids = new Set(record.appliedTakeIds.filter((id) => typeof id === 'string'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error?.('[profile] 缓存损坏，保留原文件并重新读取已保存的练习记录:', error.message);
        try { fs.renameSync(file, `${file}.${Date.now()}.corrupt`); } catch { /* preserve in place if move fails */ }
      }
      this.#model = createModel();
    }
  }
  snapshot() { return this.#model.snapshot(); }
  recover(takes) {
    const ordered = [...takes].sort((a, b) => String(a.lifecycle?.finishedAtIso ?? '').localeCompare(String(b.lifecycle?.finishedAtIso ?? '')) || String(a.takeId).localeCompare(String(b.takeId)));
    for (const take of ordered) {
      const evidence = take.engineDiagnostics?.profileEvidence;
      if (!evidence || this.#ids.has(take.takeId)) continue;
      this.#model.observeAttempt(evidence.modeId, evidence.attempt);
      this.#ids.add(take.takeId);
      this.#dirty = true;
    }
    if (this.#dirty) {
      this.write({ schemaVersion: 1, snapshot: this.#model.snapshot(), appliedTakeIds: [...this.#ids] });
      this.#dirty = false;
    }
  }
}
