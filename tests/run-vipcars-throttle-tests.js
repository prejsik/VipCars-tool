const assert = require("node:assert/strict");
const { createResultRequestGate } = require("../src/vipcars/requestThrottle");

async function main() {
  const starts = [];
  const gate = createResultRequestGate({ until: 0 }, Date.now() + 2000, 30);
  await Promise.all([1, 2, 3].map(() => gate(() => starts.push(Date.now()))));
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 29);
  assert.ok(starts[2] - starts[1] >= 29);

  const shared = { until: 0 };
  const acrossScenarios = [];
  const firstGate = createResultRequestGate(shared, Date.now() + 2000, 30);
  const secondGate = createResultRequestGate(shared, Date.now() + 2000, 30);
  await firstGate(() => acrossScenarios.push(Date.now()));
  await Promise.all([firstGate, secondGate].map((run) => run(() => acrossScenarios.push(Date.now()))));
  assert.ok(acrossScenarios[1] - acrossScenarios[0] >= 29, "pacing must survive a new attempt/scenario");
  assert.ok(acrossScenarios[2] - acrossScenarios[1] >= 29, "shared gates must not dispatch concurrently");

  let sent = 0;
  const blocked = createResultRequestGate({ until: Date.now() + 3600000 }, Date.now() + 1000, 10);
  await assert.rejects(blocked(() => sent++), { code: "SERVER_COOLDOWN" });
  assert.equal(sent, 0);

  const cooldown = { until: 0 };
  const interrupted = createResultRequestGate(cooldown, Date.now() + 1000, 50);
  await interrupted(() => sent++);
  const queued = interrupted(() => sent++);
  cooldown.until = Date.now() + 3600000;
  await assert.rejects(queued, { code: "SERVER_COOLDOWN" });
  assert.equal(sent, 1);

  const expired = createResultRequestGate({ until: 0 }, Date.now() + 20, 100);
  await expired(() => sent++);
  await assert.rejects(expired(() => sent++), { code: "ATTEMPT_TIMEOUT" });
  assert.equal(sent, 2);

  const stalledState = { until: 0 };
  const stalledGate = createResultRequestGate(stalledState, Date.now() + 2000, 50);
  void stalledGate(() => new Promise(() => {}));
  const afterStall = createResultRequestGate(stalledState, Date.now() + 20, 50);
  let guard;
  try {
    await Promise.race([
      assert.rejects(afterStall(() => { throw new Error("expired request was sent"); }), { code: "ATTEMPT_TIMEOUT" }),
      new Promise((resolve, reject) => { guard = setTimeout(() => reject(new Error("stalled dispatch poisoned the shared queue")), 150); })
    ]);
    const recovered = createResultRequestGate(stalledState, Date.now() + 1000, 50);
    assert.equal(await recovered(() => "dispatched"), "dispatched");
  } finally { clearTimeout(guard); }
  console.log("PASS result request pacing, concurrent queue, cooldown and deadline");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
