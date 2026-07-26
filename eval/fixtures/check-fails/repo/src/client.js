'use strict';

function backoffDelays(attempts, base = 50) {
  return Array.from({ length: attempts }, (_, i) => base * 2 ** i);
}

async function request(send, { attempts = 4, base = 50, sleep } = {}) {
  const delays = backoffDelays(attempts, base);
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await send();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await (sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(delays[i]);
    }
  }
  throw lastError;
}

module.exports = { backoffDelays, request, retryLegacy: null };
