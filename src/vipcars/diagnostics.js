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
  let resultState = null;
  const listeners = [];
  const append = (records, record) => {
    if (records.length >= 50) records.shift();
    records.push({ elapsed_ms: Date.now() - started, ...record });
  };
  const requestRecord = (request) => {
    const url = new URL(request.url());
    if (!/(^|\.)(vipcars|supplycars)\.com$/i.test(url.hostname)) return null;
    const type = request.resourceType();
    if (!["document", "script", "xhr", "fetch"].includes(type)) return null;
    return { url: safeUrl(url.href), resource_type: type };
  };
  return {
    recordResultState(state) {
      resultState = Object.fromEntries([
        "cardCount", "automaticCardCount", "totalCount", "counterId",
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
    async measure(name, action) {
      const start = Date.now();
      let status = "success";
      try { return await action(); }
      catch (error) { status = "failure"; throw error; }
      finally { stages.push({ name, elapsed_ms: Date.now() - start, status }); }
    },
    snapshot(error) {
      return {
        ...metadata, started_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started,
        outcome: error ? "failure" : "success", stages, requests, errors, result_state: resultState,
        failure: error ? { code: error.code || error.name, message: sanitizeMessage(error.message) } : null
      };
    }
  };
}

module.exports = { createAttemptDiagnostics, sanitizeMessage };
