export function createLimiter(maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Concurrency must be a positive integer.');
  let active = 0;
  const waiting = [];
  return async task => {
    if (active >= maximum) await new Promise(resolve => waiting.push(resolve));
    active++;
    try { return await task(); }
    finally {
      active--;
      waiting.shift()?.();
    }
  };
}
