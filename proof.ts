// Plumbline hour-one runtime proof.
// Step 1: dry NEAR Intents quote (no deposit address, no funds move)
// Step 2: NEAR AI Cloud inference + fetch attestation and chat signature
// Step 4: append one record to ledger.jsonl
// Step 3 (fee settlement) is manual: see the note at the bottom.
//
// Run: npm run proof      (all steps)
//      npm run quote      (step 1 only)

import "dotenv/config";
import OpenAI from "openai";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const ONECLICK = "https://1click.chaindefuser.com";
const NEAR_AI = "https://cloud-api.near.ai";

function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key} in .env`);
  return v;
}

function save(name: string, data: unknown) {
  mkdirSync("fixtures", { recursive: true });
  writeFileSync(`fixtures/${name}.json`, JSON.stringify(data, null, 2));
}

// ---------- Step 1: dry quote ----------
async function step1(): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // JWT is optional; without it an extra fee applies on real swaps (irrelevant for dry quotes).
  if (process.env.ONECLICK_JWT) headers.Authorization = `Bearer ${process.env.ONECLICK_JWT}`;

  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100, // basis points
    originAsset: process.env.ORIGIN_ASSET ?? "nep141:wrap.near",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: process.env.DEST_ASSET ?? "nep141:eth.omft.near",
    amount: process.env.AMOUNT ?? "100000000000000000000000", // 0.1 NEAR in yoctoNEAR
    recipient: need("RECIPIENT"),
    recipientType: "DESTINATION_CHAIN",
    refundTo: need("REFUND_TO"),
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };

  const res = await fetch(`${ONECLICK}/v0/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Quote failed (${res.status}): ${JSON.stringify(json)}`);

  save("quote", json);
  console.log("STEP 1 OK. Quote saved to fixtures/quote.json");
  console.log(JSON.stringify(json.quote ?? json, null, 2));
  return json;
}

// ---------- Step 2: inference + attestation fetch ----------
async function step2(quote: unknown) {
  const apiKey = need("NEAR_AI_API_KEY");
  const model = process.env.NEAR_AI_MODEL ?? "Qwen/Qwen3.5-122B-A10B";

  const client = new OpenAI({ baseURL: `${NEAR_AI}/v1`, apiKey });
  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          'You are a swap risk analyst. Reply with JSON only: {"verdict":"ALLOW|WARN|BLOCK","reasons":["..."]}',
      },
      { role: "user", content: JSON.stringify({ quote }) },
    ],
  });
  const verdict = completion.choices[0]?.message?.content ?? "";
  console.log("STEP 2a OK. Verdict:", verdict);

  // Fetch attestation report and chat signature.
  // NOTE: this FETCHES the proof. It does not cryptographically verify it.
  // Confirm exact query params in docs.near.ai/cloud/verification, then verify with
  // the official example: github.com/near-examples/nearai-cloud-verification-example
  const nonce = randomBytes(32).toString("hex");
  const auth = { Authorization: `Bearer ${apiKey}` };

  const attRes = await fetch(
    `${NEAR_AI}/v1/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ecdsa`,
    { headers: auth },
  );
  const attestation: any = await attRes.json().catch(() => ({}));
  save("attestation", { status: attRes.status, nonce, attestation });

  const sigRes = await fetch(
    `${NEAR_AI}/v1/signature/${completion.id}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`,
    { headers: auth },
  );
  const signature: any = await sigRes.json().catch(() => ({}));
  save("signature", { status: sigRes.status, chatId: completion.id, signature });

  console.log(
    `STEP 2b: attestation HTTP ${attRes.status}, signature HTTP ${sigRes.status}. Saved to fixtures/.`,
  );
  return { verdict, usage: completion.usage, chatId: completion.id, model };
}

// ---------- Step 4: ledger ----------
function ledger(entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync("ledger.jsonl", line + "\n");
  console.log("STEP 4 OK. Ledger line appended to ledger.jsonl");
}

// ---------- Main ----------
const mode = process.argv[2] ?? "all";
const quote = await step1();
if (mode !== "quote") {
  const r = await step2(quote.quote ?? quote);
  ledger({
    event: "proof-run",
    model: r.model,
    chatId: r.chatId,
    verdict: r.verdict,
    inferenceUsage: r.usage, // tokens; convert to cost using the model's listed price
    feeTxHash: process.env.FEE_TX_HASH ?? null, // paste after Step 3
  });
}

// ---------- Step 3 (manual): fee settlement ----------
// 1. Decide the path: OutLayer wallet or scoped function-call key, per their docs.
// 2. If neither can receive the fee, use a plain NEAR transfer from your small
//    dev account to the agent account.
// 3. Send ONE tiny transfer yourself, confirm it in an explorer, then put the
//    hash in .env as FEE_TX_HASH and re-run `npm run proof`.
// Do not let any script or coding agent send mainnet transactions without your
// explicit confirmation.
