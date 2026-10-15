// Keep CLI execution budget and supervising watchdog coherent.
export function dispatchBudget(settings = {}) {
  const seconds = settings.workerTurnTimeoutSeconds ?? 900;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600) throw new RangeError('workerTurnTimeoutSeconds must be an integer from 60 through 3600');
  return Object.freeze({agentTimeoutSeconds: seconds, watchdogMs: (seconds + 60) * 1000, maxOutputBytes: 4 * 1024 * 1024});
}
