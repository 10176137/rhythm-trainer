/** Best-effort evidence sealing. The caller must detach these writers before
 * invoking this function, so reentrant cleanup cannot finalize them twice.
 * Failures are returned individually; one writer must not block the other. */
export function closeTakeEvidence({ journal, trace }, reason, atSessionMs) {
  const errors = [];
  const attempt = (stage, operation) => {
    try {
      const result = operation();
      if (result?.persistenceDegraded) errors.push({ stage, error: new Error(result.persistenceError ?? result.error ?? '证据未完整保存') });
    } catch (error) { errors.push({ stage, error }); }
  };
  if (journal) {
    attempt('journal-append', () => journal.append('take_aborted', { reason, atSessionMs }));
    attempt('journal-finalize', () => journal.finalize({ aborted: true, reason }));
  }
  if (trace) attempt('trace-finalize', () => trace.finalize());
  return errors;
}
