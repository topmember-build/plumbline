// Saves three frozen demo quotes and prints the Plumbline verdict for each.
//   demo-allow: 1,000 NEAR -> ETH            (liquid pair, small loss)
//   demo-warn : 0.1 NEAR   -> ETH            (tiny trade, fixed fees dominate)
//   demo-block: ~$5,000 of NEAR -> JAMBO     (thin token, big price impact)
// Dry quotes move no funds. Liquidity changes over time, so re-run this and
// check the verdicts again shortly before recording the demo.
// Usage: npx tsx demo-fixtures.ts

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { runAllChecks } from "./checks.ts";

const ONECLICK = "https://1click.chaindefuser.com";
const ORIGIN = "nep141:wrap.near"; // wNEAR, 24 decimals
const ETH = "nep141:eth.omft.near";
const JAMBO = "nep141:jambo-1679.meme-cooking.near";

function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key} in .env`);
  return v;
}
const REFUND_TO = need("REFUND_TO");
const RECIPIENT_0X = need("RECIPIENT");

// NEAR amount (as a number) -> yoctoNEAR string, built from integers.
const toYocto = (near: number) => (BigInt(Math.round(near * 1e6)) * 10n ** 18n).toString();

const tokRes = await fetch(`${ONECLICK}/v0/tokens`);
const tokens: any[] = await tokRes.json();
const nearPrice = Number(tokens.find((t) => t.assetId === ORIGIN)?.price);
if (!Number.isFinite(nearPrice) || nearPrice <= 0) throw new Error("No NEAR price found");

async function quote(dest: string, amount: string, recipient: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.ONECLICK_JWT) headers.Authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  const res = await fetch(`${ONECLICK}/v0/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ORIGIN,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: dest,
      amount,
      recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: REFUND_TO,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Quote failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const scenarios = [
  { name: "demo-allow", dest: ETH, amount: toYocto(1000), recipient: RECIPIENT_0X },
  { name: "demo-warn", dest: ETH, amount: toYocto(0.1), recipient: RECIPIENT_0X },
  { name: "demo-block", dest: JAMBO, amount: toYocto(5000 / nearPrice), recipient: REFUND_TO },
];

mkdirSync("fixtures", { recursive: true });
for (const s of scenarios) {
  try {
    const json = await quote(s.dest, s.amount, s.recipient);
    writeFileSync(`fixtures/${s.name}.json`, JSON.stringify(json, null, 2));
    const { verdict, results } = runAllChecks(json.quote ?? json);
    console.log(`${s.name}\t${verdict}\t${results[0].detail}`);
  } catch (e) {
    console.log(`${s.name}\tERROR\t${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
