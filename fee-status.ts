// Polls Intents for the status of the fee order created by fee-intent.ts.
// Stops at SUCCESS, REFUNDED or FAILED (or after about 10 minutes).
// Usage: npx tsx fee-status.ts
//        npx tsx fee-status.ts <depositAddress>

import { existsSync, readFileSync } from "node:fs";

const ONECLICK = "https://1click.chaindefuser.com";

let depositAddress = process.argv[2];
let depositMemo: string | undefined;

if (!depositAddress) {
  if (!existsSync("fixtures/fee-order.json")) {
    throw new Error("No fixtures/fee-order.json. Run: npx tsx fee-intent.ts");
  }
  const saved = JSON.parse(readFileSync("fixtures/fee-order.json", "utf8"));
  const q = saved.quote ?? saved;
  depositAddress = q.depositAddress;
  depositMemo = q.depositMemo;
}

const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

for (let i = 0; i < 120; i++) {
  const url =
    `${ONECLICK}/v0/status?depositAddress=${encodeURIComponent(depositAddress!)}` +
    (depositMemo ? `&depositMemo=${encodeURIComponent(depositMemo)}` : "");
  const res = await fetch(url);
  const json: any = await res.json().catch(() => ({}));
  const status = json.status ?? `HTTP ${res.status}`;
  console.log(new Date().toLocaleTimeString(), status);

  if (TERMINAL.has(json.status)) {
    console.log(JSON.stringify(json, null, 2));
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}
