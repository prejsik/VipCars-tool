const fs = require("node:fs");

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${label}.`);
  return number;
}

function latestChunkArtifacts(artifacts, runNumber, maxAttempt) {
  runNumber = positiveInteger(runNumber, "run number");
  const latest = new Map();
  for (const artifact of artifacts) {
    const match = /^vipcars-results-chunk-(\d+)-(\d+)(?:-attempt-(\d+))?$/.exec(artifact.name || "");
    if (!match || Number(match[2]) !== runNumber) continue;
    const chunk = positiveInteger(match[1], "chunk"), attempt = positiveInteger(match[3] || 1, "attempt");
    if (attempt > maxAttempt) continue;
    const id = positiveInteger(artifact.id, "artifact id");
    const previous = latest.get(chunk);
    if (previous?.attempt === attempt) throw new Error(`Ambiguous duplicate artifact for chunk ${chunk}, attempt ${attempt}.`);
    if (!previous || attempt > previous.attempt) latest.set(chunk, { id, attempt, expired: artifact.expired === true });
  }
  for (const [chunk, artifact] of latest) {
    if (artifact.expired) throw new Error(`Latest artifact for chunk ${chunk} has expired.`);
  }
  return new Map([...latest.entries()].sort(([left], [right]) => left - right));
}

function resumeChunkArtifact(artifacts, chunk, runNumber, runAttempt) {
  chunk = positiveInteger(chunk, "chunk");
  const prior = latestChunkArtifacts(artifacts, runNumber, positiveInteger(runAttempt, "run attempt") - 1);
  const artifact = prior.get(chunk);
  if (!artifact) throw new Error(`Missing checkpoint artifact for chunk ${chunk}; refusing to reset attempts and cooldown.`);
  return String(artifact.id);
}

if (require.main === module) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const artifacts = fs.readFileSync(0, "utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    if (mode === "resume") {
      console.log(resumeChunkArtifact(artifacts, args[0], args[1], args[2]));
    } else if (mode === "ids") {
      const latest = latestChunkArtifacts(artifacts, args[0], positiveInteger(args[1], "run attempt"));
      console.log([...latest.values()].map((artifact) => artifact.id).join(","));
    } else throw new Error("Use resume CHUNK RUN_NUMBER RUN_ATTEMPT or ids RUN_NUMBER RUN_ATTEMPT.");
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { latestChunkArtifacts, resumeChunkArtifact };
