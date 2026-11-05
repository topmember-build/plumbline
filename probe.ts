// Probes candidate tokens with dry quotes at rising trade sizes and runs the
// Plumbline checks on each result. Dry quotes move no funds.
// Usage: npx tsx probe.ts

import "dotenv/config";
import { runAllChecks } from "./checks.ts";

const ONECLICK = "https://1click.chaindefuser.com";
const ORIGIN = process.env.ORIGIN_ASSET ?? "nep141:wrap.near"; // assumes wNEAR (24 decimals)
const REFUND_TO = process.env.REFUND_TO;
if (!REFUND_TO) throw new Error("Missing REFUND_TO in .env");

// All candidates live on the NEAR chain, so the recipient is a NEAR account.
const CANDIDATES = [
  { symbol: "JAMBO", assetId: "nep141:jambo-1679.meme-cooking.near" },
  { symbol: "NearKat", assetId: "nep141:kat.token0.near" },
  { symbol: "BLACKDRAGON", assetId: "nep141:blackdragon.tkn.near" },
  { symbol: "SHITZU", assetId: "nep141:token.0xshitzu.near" },
  { symbol: "CFI", assetId: "nep141:cfi.consumer-fi.near" },
];
const SIZES_USD = [1000, 5000, 25000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Look up the origin token's price to convert USD sizes into amounts.
const tokRes = await fetch(`${ONECLICK}/v0/tokens`);
const tokens: any[] = await tokRes.json();
const originPrice = Number(tokens.find((t) => t.assetId === ORIGIN)?.price);
if (!Number.isFinite(originPrice) || originPrice <= 0) {
  throw new Error(`No price found for origin asset ${ORIGIN}`);
}

async function quote(destAsset: string, usd: number) {
  // 24 decimals: amount = (usd / price) * 1e24, built from integers to avoid float errors.
  const nearAmount = usd / originPrice;
  const amount = (BigInt(Math.round(nearAmount * 1e6)) * 10n ** 18n).toString();

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
      destinationAsset: destAsset,
      amount,
      recipient: REFUND_TO,
      recipientType: "DESTINATION_CHAIN",
      refundTo: REFUND_TO,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

console.log(`Origin price used: $${originPrice} per ${ORIGIN}\n`);
for (const c of CANDIDATES) {
  for (const usd of SIZES_USD) {
    const r = await quote(c.assetId, usd);
    if (!r.ok) {
      const msg = String(r.json?.message ?? JSON.stringify(r.json)).slice(0, 120);
      console.log(`${c.symbol}\t$${usd}\tERROR ${r.status}: ${msg}`);
    } else {
      const { verdict, results } = runAllChecks(r.json.quote ?? r.json);
      console.log(`${c.symbol}\t$${usd}\t${verdict}\t${results[0].detail}`);
    }
    await sleep(500);
  }
}
