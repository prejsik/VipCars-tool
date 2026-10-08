const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { buildPlan, runDiagnostic } = require("../tools/vipcars-diagnostic");

const start = Date.parse("2026-10-08T19:14:00Z");
const options = { pickupDate: "2026-10-09", notBefore: "2026-10-08T19:14:00Z" };
function clock(initial = start) {
  let time = initial;
  return { now: () => time, sleep: async (ms) => { time += ms; }, advance: (ms) => { time += ms; } };
}

test("each variant uses the same eight explicit searches without changing production defaults", () => {
  const plan = buildPlan(options, start);
  assert.deepEqual(plan.checks.map((check) => [check.location, check.durationDays]), [
    ["Bydgoszcz", 2], ["Warsaw", 2], ["Bydgoszcz", 3], ["Warsaw", 3],
    ["Bydgoszcz", 4], ["Warsaw", 4], ["Bydgoszcz", 5], ["Warsaw", 5]
  ]);
  assert.deepEqual(plan.variants.map((variant) => [variant.id, variant.concurrency, variant.intervalMs, variant.networkResults]), [
    ["serial", 1, 3000, true], ["slow", 1, 8000, true], ["parallel", 2, 3000, true], ["native", 1, 3000, false]
  ]);
  assert.equal(plan.pickupDate, "2026-10-09");
  assert.equal(plan.attemptBudgetMs, 360000);
});

test("invalid dates, unsafe start times and duplicate variants cannot authorize live queries", () => {
  for (const patch of [
    { pickupDate: "2026-02-30" }, { pickupDate: "2026-10-08" },
    { notBefore: "invalid" }, { notBefore: "2026-10-08T19:13:02Z" },
    { order: "serial,serial,parallel,native" }, { order: "serial,slow,parallel,anything" }
  ]) assert.throws(() => buildPlan({ ...options, ...patch }, start), /pickup|notBefore|order/);
});

test("a complete run issues exactly 32 checks, with bounded concurrency and quiet windows", async () => {
  const timer = clock(start - 60000);
  const launched = [];
  let active = 0;
  const peak = {};
  const summary = await runDiagnostic(buildPlan(options, timer.now()), {
    ...timer,
    attempt: async (check, context) => {
      active += 1;
      peak[context.variant.id] = Math.max(peak[context.variant.id] || 0, active);
      launched.push({ id: context.variant.id, location: check.location, duration: check.durationDays, at: timer.now() });
      await Promise.resolve();
      timer.advance(10);
      active -= 1;
      return { ok: true, providerCount: check.location === "Bydgoszcz" ? 0 : 3 };
    }
  });
  assert.equal(launched.length, 32);
  assert.ok(launched[0].at >= start);
  assert.deepEqual(peak, { serial: 1, slow: 1, parallel: 2, native: 1 });
  assert.equal(summary.phases.length, 4);
  for (const phase of summary.phases) {
    assert.equal(phase.checks.length, 8);
    assert.equal(phase.checks.filter((check) => check.ok && check.providerCount > 0).length, 4);
  }
  for (let index = 1; index < summary.phases.length; index += 1) {
    assert.ok(summary.phases[index].startedAtMs - summary.phases[index - 1].finishedAtMs >= 3660000);
  }
});

test("a server cooldown stops queued checks, reaches the sibling and delays the next variant", async () => {
  const timer = clock();
  const plan = buildPlan({ ...options, order: "parallel,serial,slow,native" }, start);
  const calls = [];
  let observedSiblingCooldown = 0;
  const retryAt = start + 2 * 3600000;
  const summary = await runDiagnostic(plan, {
    ...timer,
    attempt: async (check, context) => {
      calls.push({ variant: context.variant.id, at: timer.now() });
      if (context.variant.id === "parallel") {
        if (context.worker === 0) {
          await Promise.resolve();
          context.cooldown.until = retryAt;
          context.onCooldown();
          return { ok: false, errorCode: "SERVER_COOLDOWN", retryAt };
        }
        await Promise.resolve();
        await Promise.resolve();
        observedSiblingCooldown = context.cooldown.until;
        return { ok: false, errorCode: "SERVER_COOLDOWN", retryAt };
      }
      return { ok: true, providerCount: 1 };
    }
  });
  assert.equal(calls.filter((entry) => entry.variant === "parallel").length, 2);
  assert.equal(observedSiblingCooldown, retryAt);
  assert.ok(calls.find((entry) => entry.variant === "serial").at >= retryAt);
  assert.equal(summary.phases[0].checks.length, 2);
  assert.equal(summary.phases[0].status, "incomplete");
});

test("a thrown worker failure stops new work immediately and cannot produce success", async () => {
  const timer = clock();
  let calls = 0;
  const summary = await runDiagnostic(buildPlan({ ...options, order: "parallel,serial,slow,native" }, start), {
    ...timer,
    attempt: async (check, context) => {
      calls += 1;
      if (context.worker === 0) throw new Error("Browser launch failed");
      await Promise.resolve();
      return { ok: true, providerCount: 1 };
    }
  });
  assert.ok(calls <= 2);
  assert.equal(summary.phases.length, 1);
  assert.equal(summary.status, "stopped");
  assert.match(summary.stopReason, /Browser launch failed/);
});

test("a long cooldown ends the experiment without querying past its hard time budget", async () => {
  const timer = clock();
  let calls = 0;
  const summary = await runDiagnostic(buildPlan(options, start), {
    ...timer,
    attempt: async () => {
      calls += 1;
      return { ok: false, errorCode: "SERVER_COOLDOWN", retryAt: start + 24 * 3600000 };
    }
  });
  assert.equal(calls, 1);
  assert.equal(summary.status, "stopped");
  assert.match(summary.stopReason, /budget|cooldown/i);
});

test("a queued run after the pickup time cannot start a search", async () => {
  const timer = clock(Date.parse("2026-10-09T08:00:00Z"));
  let calls = 0;
  const plan = buildPlan(options, start);
  const summary = await runDiagnostic(plan, { ...timer, attempt: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(summary.status, "stopped");
});

test("a stage budget skips cases explicitly instead of shortening their search allowance", async () => {
  const timer = clock();
  const summary = await runDiagnostic(buildPlan(options, start), {
    ...timer,
    attempt: async (check, context) => {
      assert.ok(context.deadlineAt - timer.now() >= 360000);
      timer.advance(360001);
      return { ok: true, providerCount: 1 };
    }
  });
  const first = summary.phases[0];
  assert.equal(first.status, "censored");
  assert.equal(first.checks.length, 4);
  assert.equal(first.unattemptedCount, 4);
  assert.equal(first.failureCount, 0);
  assert.equal(first.completeCount, 4);
  assert.equal(summary.status, "incomplete");
});

test("attempt timeout is censored data, not an identified provider failure", async () => {
  const timer = clock();
  const summary = await runDiagnostic(buildPlan(options, start), {
    ...timer,
    attempt: async () => {
      timer.advance(360000);
      return { ok: false, errorCode: "ATTEMPT_TIMEOUT", providerCount: 0 };
    }
  });
  const first = summary.phases[0];
  assert.equal(first.checks[0].measurementStatus, "censored");
  assert.equal(first.censoredCount, 1);
  assert.equal(first.failureCount, 0);
  assert.equal(first.unattemptedCount, 7);
});

test("a progress-write failure stops both workers and still closes the phase", async () => {
  for (const failAfterAttempt of [false, true]) {
    const timer = clock();
    let calls = 0;
    let cleanups = 0;
    const summary = await runDiagnostic(buildPlan({ ...options, order: "parallel,serial,slow,native" }, start), {
      ...timer,
      attempt: async () => {
        calls += 1;
        await Promise.resolve();
        return { ok: true, providerCount: 1 };
      },
      finishPhase: async () => { cleanups += 1; },
      onProgress: (state) => {
        const check = state.phases[0]?.checks[0];
        if (check && (!failAfterAttempt || check.finishedAtMs)) throw new Error("Diagnostic disk full");
      }
    });
    assert.ok(calls <= (failAfterAttempt ? 2 : 0));
    assert.equal(cleanups, 1);
    assert.equal(summary.phases.length, 1);
    assert.equal(summary.status, "stopped");
    assert.match(summary.stopReason, /Diagnostic disk full/);
    if (!failAfterAttempt) assert.equal(summary.phases[0].unattemptedCount, 8);
  }
});

test("the command defaults to a dry plan and refuses GitHub reruns before live work", () => {
  const script = path.resolve(__dirname, "../tools/vipcars-diagnostic.js");
  const args = [script, "--pickup-date", "2099-10-09", "--not-before", "2099-10-08T19:14:00Z"];
  const dry = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).checks.length, 8);
  const rerun = spawnSync(process.execPath, [...args, "--live"], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, GITHUB_RUN_ATTEMPT: "2" }
  });
  assert.equal(rerun.status, 1);
  assert.match(rerun.stderr, /reruns are disabled/);
});
