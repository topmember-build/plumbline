// Tests small fee payments: trader pays NEAR, agent receives USDC on the NEAR chain.
// Dry quotes only. Nothing is sent and no funds move.
// Usage: npx tsx fee-quote.ts

import "dotenv/config";

const ONECLICK = "https://1click.chaindefuser.com";
const ORIGIN = "nep141:wrap.near";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ACCOUNT = process.env.REFUND_TO;
if (!ACCOUNT) throw new Error("Missing REFUND_TO in .env");

const toYocto = (near: number) => (BigInt(Math.round(near * 1e6)) * 10n ** 18n).toString();

for (const nearAmount of [0.05, 0.1, 0.25, 0.5, 1]) {
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
      destinationAsset: USDC_NEAR,
      amount: toYocto(nearAmount),
      recipient: ACCOUNT,
      recipientType: "DESTINATION_CHAIN",
      refundTo: ACCOUNT,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
  const json: any = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.log(`${nearAmount} NEAR\tERROR ${res.status}: ${String(json?.message ?? JSON.stringify(json)).slice(0, 140)}`);
  } else {
    const q = json.quote ?? json;
    const inUsd = Number(q.amountInUsd);
    const outUsd = Number(q.amountOutUsd);
    const loss = inUsd > 0 ? (((inUsd - outUsd) / inUsd) * 100).toFixed(1) : "?";
    console.log(`${nearAmount} NEAR\t$${inUsd.toFixed(3)} in -> $${outUsd.toFixed(3)} out\t${loss}% lost`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
