const schedulers = new WeakMap();

function createResultRequestGate(cooldown, deadlineAt, intervalMs = 3000) {
  if (!schedulers.has(cooldown)) schedulers.set(cooldown, { queue: Promise.resolve(), nextStartAt: 0 });
  const scheduler = schedulers.get(cooldown);
  const checkBudget = () => {
    if (cooldown.until > Date.now()) {
      const error = new Error(`VipCars server cooldown until ${new Date(cooldown.until).toISOString()}.`);
      error.code = "SERVER_COOLDOWN";
      error.retryAt = cooldown.until;
      error.retryable = true;
      throw error;
    }
    if (Date.now() >= deadlineAt) {
      const error = new Error("VipCars request deadline reached before dispatch.");
      error.code = "ATTEMPT_TIMEOUT";
      error.retryable = true;
      throw error;
    }
  };
  return (send) => {
    const dispatched = scheduler.queue.then(async () => {
      checkBudget();
      while (Date.now() < scheduler.nextStartAt) {
        const wait = Math.min(scheduler.nextStartAt - Date.now(), deadlineAt - Date.now());
        await new Promise((resolve) => setTimeout(resolve, wait));
        checkBudget();
      }
      scheduler.nextStartAt = Date.now() + intervalMs;
      // A stalled browser command must not hold the shared dispatch queue.
      return { response: send() };
    });
    scheduler.queue = dispatched.then(() => {}, () => {});
    return dispatched.then(({ response }) => response);
  };
}

module.exports = { createResultRequestGate };
