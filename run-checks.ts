// Runs the checks against a saved quote.
// Usage: npm run checks            (uses fixtures/quote.json)
//        npm run checks -- path.json

import { readFileSync } from "node:fs";
import { runAllChecks } from "./checks.ts";

const file = process.argv[2] ?? "fixtures/quote.json";
const raw = JSON.parse(readFileSync(file, "utf8"));
const quote = raw.quote ?? raw;

const { verdict, results } = runAllChecks(quote);

console.log(`File: ${file}`);
for (const r of results) {
  console.log(`  [${r.level.toUpperCase()}] ${r.name}: ${r.detail}`);
}
console.log(`VERDICT: ${verdict}`);
