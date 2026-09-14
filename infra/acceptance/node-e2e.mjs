await import("./node-runtime-e2e.mjs");

const { runCanonicalAutodeployAcceptance } = await import("./canonical-autodeploy-e2e.mjs");
const canonicalAutodeploy = await runCanonicalAutodeployAcceptance();
console.log(JSON.stringify({ canonicalAutodeploy }, null, 2));
