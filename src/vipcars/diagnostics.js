const { parseResultRequest } = require("./resultTransport");

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function sanitizeMessage(value) {
  return String(value || "")
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi, "$1<redacted>")
    .replace(/(https?:\/\/[^\s"'<>?]+)\?\\?["'][^\r\n]*/g, "$1?<redacted>")
    .replace(/https?:\/\/[^\s"'<>]+/g, safeUrl)
    .replace(/\b(authorization\s*:\s*)(?:bearer\s+)?\S+/gi, "$1<redacted>")
    .replace(/\b(token|api[_-]?key|password|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=<redacted>")
    .slice(0, 1000);
}

function createAttemptDiagnostics(metadata) {
  const started = Date.now();
  const requests = [];
  const errors = [];
  const stages = [];
  const activeStages = new Set();
  let resultState = null;
  const listeners = [];
  const elapsedFor = (names, now) => stages.reduce((total, stage) =>
    total + (names.includes(stage.name) ? stage.elapsed_ms : 0), 0)
    + [...activeStages].reduce((total, stage) =>
      total + (names.includes(stage.name) ? elapsedStage(stage, now) : 0), 0);
  const elapsedStage = (stage, now) => Math.max(0,
    now - stage.start - (elapsedFor(stage.exclude, now) - stage.excluded));
  const recordStage = (records, interval, elapsed_ms, status) => {
    const { name, aggregate } = interval;
    const stage = aggregate && records.find((record) => record.name === name);
    if (stage) {
      stage.elapsed_ms += elapsed_ms;
      stage.count += 1;
      if (status === "failure" || (status === "running" && stage.status !== "failure")) stage.status = status;
    } else records.push({ name, elapsed_ms, status, ...(aggregate ? { count: 1 } : {}) });
  };
  const startStage = (name, { aggregate = false, exclude = [] } = {}) => {
    const start = Date.now();
    const interval = { name, aggregate, exclude, start, excluded: elapsedFor(exclude, start) };
    activeStages.add(interval);
    return (status = "success") => {
      if (!activeStages.has(interval)) return;
      const elapsed_ms = elapsedStage(interval, Date.now());
      activeStages.delete(interval);
      recordStage(stages, interval, elapsed_ms, status);
    };
  };
  const append = (records, record) => {
    if (records.length >= 50) records.shift();
    records.push({ elapsed_ms: Date.now() - started, ...record });
  };
  const requestRecord = (request) => {
    const url = new URL(request.url());
    if (!/(^|\.)(vipcars|supplycars)\.com$/i.test(url.hostname)) return null;
    const type = request.resourceType();
    if (!["document", "script", "xhr", "fetch"].includes(type)) return null;
    const record = { url: safeUrl(url.href), resource_type: type };
    const result = parseResultRequest(url.href, { includeFiltered: true, includeBootstrap: true });
    if (result) {
      record.result_type = result.params.get("load_type");
      for (const key of ["offset", "car_page"]) {
        const value = result.params.get(key);
        if (/^\d+$/.test(value || "")) record[key] = Number(value);
      }
      const timing = request.timing?.();
      if (timing?.requestStart >= 0 && timing.responseStart >= timing.requestStart) {
        record.response_wait_ms = Math.round(timing.responseStart - timing.requestStart);
      }
    }
    return record;
  };
  return {
    recordResultState(state) {
      resultState = Object.fromEntries([
        "cardCount", "pageCount", "automaticCardCount", "totalCount", "counterId",
        "noResults", "hasBusyIndicator", "busy", "filterChecked"
      ].map((key) => [key, state[key]]));
    },
    attach(page) {
      const handlers = {
        response: (response) => {
          const record = requestRecord(response.request());
          if (record) append(requests, { ...record, status: response.status() });
        },
        requestfailed: (request) => {
          const record = requestRecord(request);
          if (record) append(requests, { ...record, error: sanitizeMessage(request.failure()?.errorText) });
        },
        pageerror: (error) => append(errors, { type: "pageerror", message: sanitizeMessage(error.message) }),
        console: (message) => {
          if (message.type() === "error") {
            append(errors, { type: "console", message: sanitizeMessage(message.text()) });
          }
        }
      };
      for (const [event, handler] of Object.entries(handlers)) {
        // Diagnostics must not turn an unusual request URL into a scraper failure.
        const listener = (value) => { try { handler(value); } catch {} };
        page.on(event, listener);
        listeners.push(() => page.removeListener(event, listener));
      }
    },
    detach() { listeners.forEach((remove) => remove()); },
    start: startStage,
    async measure(name, action, options) {
      const finish = startStage(name, options);
      let status = "success";
      try { return await action(); }
      catch (error) { status = "failure"; throw error; }
      finally { finish(status); }
    },
    snapshot(error) {
      const now = Date.now();
      const currentStages = stages.map((stage) => ({ ...stage }));
      for (const interval of activeStages) {
        recordStage(currentStages, interval, elapsedStage(interval, now), error ? "failure" : "running");
      }
      return {
        ...metadata, started_at: new Date(started).toISOString(), elapsed_ms: now - started,
        outcome: error ? "failure" : "success", stages: currentStages, requests, errors, result_state: resultState,
        failure: error ? { code: error.code || error.name, message: sanitizeMessage(error.message) } : null
      };
    }
  };
}

module.exports = { createAttemptDiagnostics, sanitizeMessage };
