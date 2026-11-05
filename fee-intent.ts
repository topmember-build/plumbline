// Creates a REAL (non-dry) Intents quote for Plumbline's fee.
//   Trader pays NEAR  ->  agent receives exactly FEE_USD of USDC on the NEAR chain.
// This script only creates the quote and prints the deposit address. Nothing is
// sent and no funds move until YOU send NEAR to that address from your wallet.
// Usage: npx tsx fee-intent.ts

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

const ONECLICK = "https://1click.chaindefuser.com";
const ORIGIN = "nep141:wrap.near";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key} in .env`);
  return v;
}

const REFUND_TO = need("REFUND_TO");
// The agent's account receives the fee. Falls back to REFUND_TO for a first test.
const RECIPIENT = process.env.AGENT_ACCOUNT || REFUND_TO;
const FEE_USD = Number(process.env.FEE_USD ?? "0.25");
const amountOut = String(Math.round(FEE_USD * 1e6)); // USDC has 6 decimals

// Default is EXACT_OUTPUT (agent receives exactly FEE_USD). If the service cannot fill that
// (for example "Deposit address is not included in quote response"), set
// SWAP_TYPE=EXACT_INPUT and NEAR_AMOUNT=0.1 in .env to fix the NEAR amount instead.
const SWAP_TYPE = process.env.SWAP_TYPE === "EXACT_INPUT" ? "EXACT_INPUT" : "EXACT_OUTPUT";
const NEAR_AMOUNT = Number(process.env.NEAR_AMOUNT ?? "0.1");
const toYocto = (near: number) => (BigInt(Math.round(near * 1e6)) * 10n ** 18n).toString();
const amount = SWAP_TYPE === "EXACT_INPUT" ? toYocto(NEAR_AMOUNT) : amountOut;
console.log(`Requesting ${SWAP_TYPE} quote, amount ${amount}`);

const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.ONECLICK_JWT) headers.Authorization = `Bearer ${process.env.ONECLICK_JWT}`;

const res = await fetch(`${ONECLICK}/v0/quote`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    dry: false,
    swapType: SWAP_TYPE,
    slippageTolerance: 100,
    originAsset: ORIGIN,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC_NEAR,
    amount,
    recipient: RECIPIENT,
    recipientType: "DESTINATION_CHAIN",
    refundTo: REFUND_TO,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }),
});
const json: any = await res.json().catch(() => ({}));
if (!res.ok) throw new Error(`Quote failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);

const q = json.quote ?? json;
mkdirSync("fixtures", { recursive: true });
writeFileSync("fixtures/fee-order.json", JSON.stringify(json, null, 2));

console.log("Fee quote created. Nothing has been sent.\n");
console.log("Recipient (agent) :", RECIPIENT);
console.log("Refund address    :", REFUND_TO);
console.log("Deposit address   :", q.depositAddress);
if (q.depositMemo) console.log("Deposit memo      :", q.depositMemo);
console.log("Send exactly      :", q.amountInFormatted, "NEAR  (raw:", q.amountIn, ")");
console.log("Agent receives    :", q.amountOutFormatted, "USDC  (~$" + q.amountOutUsd + ")");
console.log("Quote deadline    :", q.deadline ?? json.deadline);
console.log("\nFull quote saved to fixtures/fee-order.json");
console.log("Do NOT send funds until you have checked these details with Claude.");
