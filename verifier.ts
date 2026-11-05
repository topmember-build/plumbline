// Plumbline verifier: calls NEAR AI Cloud and checks what came back.
// Ported from NEAR's official example (near-examples/nearai-cloud-verification-example).
//
// What a PASS means here:
//   1. Fresh nonce echoed by the gateway and the model TEE (no replayed report).
//   2. NVIDIA's attestation service accepted the model host's GPU evidence
//      (overall result, nonce, secure boot on, debug off on every GPU).
//   3. The request and response hashes in NEAR's signature match the exact bytes we sent and got.
//   4. The signature recovers to a signing address listed in the attestation report.
//
// What it does NOT check (so do not claim it):
//   - The Intel TDX quote (the CPU-side proof) is NOT verified. NEAR's docs list that as a
//     separate step using dcap-qvl, so the link from the signing address to the hardware
//     is only as strong as the attestation report itself.
//   - NVIDIA's result tokens are decoded, not signature-checked against NVIDIA's keys
//     (the official example does the same). We rely on the TLS connection to NVIDIA.

import { createHash, randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { decodeJwt } from "jose";

const NEAR_AI = process.env.NEARAI_CLOUD_BASE_URL || "https://cloud-api.near.ai";
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const ATTESTATION_TTL_MS = 10 * 60 * 1000;

const apiKey = () => {
  const k = process.env.NEAR_AI_API_KEY;
  if (!k) throw new Error("Missing NEAR_AI_API_KEY in .env");
  return k;
};
const authHeaders = () => ({ Authorization: `Bearer ${apiKey()}` });
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface ModelAttestation {
  model: string;
  checkedAt: number;
  nonce: string;
  gatewayAddresses: string[];
  modelAddresses: string[];
  nonceOk: boolean; // gateway and model TEEs both echoed our nonce
  gpuPassed: boolean;
  gpuSummary: string;
  tdxQuoteVerified: false; // not implemented, see header
}

export interface Verification {
  verified: boolean; // signature + hashes + attested address + GPU + nonce all passed
  signatureVerified: boolean;
  gpuPassed: boolean;
  nonceOk: boolean;
  kind: string;
  signer: string | null;
  tdxQuoteVerified: false;
  error: string | null;
}

// ---------- NVIDIA result decoding (from the official example) ----------
function decodeNvidia(resp: any): Record<string, any> {
  if (!Array.isArray(resp)) throw new Error("Expected array response from NVIDIA attestation service");
  const out: Record<string, any> = {};
  const dec = (key: string, token: unknown) => {
    if (typeof token === "string" && token.includes(".")) {
      try {
        out[key] = decodeJwt(token);
      } catch (e) {
        out[key] = { error: (e as Error).message };
      }
    }
  };
  for (const item of resp) {
    if (Array.isArray(item)) {
      if (item.length === 2) dec(item[0], item[1]);
    } else if (item && typeof item === "object") {
      for (const [k, t] of Object.entries(item)) dec(k, t);
    }
  }
  return out;
}

async function checkGpu(payload: unknown, nonce: string): Promise<{ passed: boolean; summary: string }> {
  let payloadNonceOk = false;
  try {
    const parsed: any = typeof payload === "string" ? JSON.parse(payload) : payload;
    payloadNonceOk = String(parsed?.nonce ?? "").toLowerCase() === nonce;
  } catch {
    payloadNonceOk = false;
  }

  const res = await fetch(NRAS, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`NVIDIA attestation service answered ${res.status}`);

  const decoded = decodeNvidia(await res.json());
  const overall = decoded.JWT ?? {};
  const overallOk = overall["x-nvidia-overall-att-result"] === true;
  const eatNonceOk = typeof overall.eat_nonce === "string" && same(overall.eat_nonce, nonce);
  const gpus = Object.entries(decoded).filter(([k]) => k.startsWith("GPU-"));
  const gpusOk =
    gpus.length > 0 &&
    gpus.every(([, c]: [string, any]) => (c.secboot === true || c.secboot === "true") && c.dbgstat === "disabled");

  const passed = overallOk && eatNonceOk && payloadNonceOk && gpusOk;
  const model = gpus[0] ? (gpus[0][1] as any).hwmodel : "unknown";
  const summary =
    `${gpus.length} GPU(s) ${model}; overall=${overallOk}, nonce=${eatNonceOk && payloadNonceOk}, ` +
    `secure boot and debug-off=${gpusOk}`;
  return { passed, summary };
}

// ---------- Model attestation (cached, because the NVIDIA call is slow) ----------
const cache = new Map<string, ModelAttestation>();

export async function verifyModelAttestation(model: string, force = false): Promise<ModelAttestation> {
  const hit = cache.get(model);
  if (!force && hit && Date.now() - hit.checkedAt < ATTESTATION_TTL_MS) return hit;

  const nonce = randomBytes(32).toString("hex");
  const params = new URLSearchParams({ signing_algo: "ecdsa", model, nonce });
  const res = await fetch(`${NEAR_AI}/v1/attestation/report?${params}`, {
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (!res.ok) throw new Error(`Attestation request failed: ${res.status}`);
  const report: any = await res.json();

  const modelAtts: any[] = report.model_attestations ?? [];
  const modelAddresses = [...new Set(modelAtts.map((a) => a.signing_address).filter(Boolean))] as string[];
  const gwAddr = report.gateway_attestation?.signing_address;
  const gatewayAddresses = gwAddr ? [gwAddr as string] : [];

  const gatewayNonceOk = report.gateway_attestation?.request_nonce === nonce;
  const modelNoncesOk = modelAtts.length > 0 && modelAtts.every((a) => a.request_nonce === nonce);

  // GPU evidence: every model TEE node must pass, and there must be at least one.
  const payloads = modelAtts.filter((a) => a.nvidia_payload);
  let gpuPassed = payloads.length > 0;
  const notes: string[] = [];
  if (payloads.length === 0) notes.push("no NVIDIA payload in the report (is this a TEE-hosted model?)");
  for (const a of payloads) {
    const r = await checkGpu(a.nvidia_payload, nonce);
    gpuPassed &&= r.passed;
    notes.push(r.summary);
  }

  const att: ModelAttestation = {
    model,
    checkedAt: Date.now(),
    nonce,
    gatewayAddresses,
    modelAddresses,
    nonceOk: gatewayNonceOk && modelNoncesOk && modelAddresses.length > 0,
    gpuPassed,
    gpuSummary: notes.join(" | "),
    tdxQuoteVerified: false,
  };
  cache.set(model, att);
  return att;
}

// ---------- Chat + signature check ----------
async function getSignature(chatId: string, model: string): Promise<any> {
  const url =
    `${NEAR_AI}/v1/signature/${encodeURIComponent(chatId)}` +
    `?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  let last = "unknown error";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json", ...authHeaders() } });
    if (res.ok) return res.json();
    last = `Signature request failed: ${res.status}`;
    if (res.status !== 404) break; // 404 can happen briefly when another node served the chat
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(last);
}

export async function chatAndVerify(
  messages: { role: string; content: string }[],
  model: string,
): Promise<{
  content: string;
  chatId: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  verification: Verification;
}> {
  const att = await verifyModelAttestation(model);

  // The exact string we send is what NEAR hashes and signs, so we build it ourselves.
  const requestBody = JSON.stringify({ messages, stream: false, model });
  const res = await fetch(`${NEAR_AI}/v1/chat/completions`, {
    method: "POST",
    headers: { accept: "application/json", "Content-Type": "application/json", ...authHeaders() },
    body: requestBody,
  });
  const responseText = await res.text();
  if (!res.ok) throw new Error(`Chat completion failed: ${res.status} ${responseText.slice(0, 200)}`);

  const parsed: any = JSON.parse(responseText);
  const chatId: string = parsed.id;
  if (!chatId) throw new Error("Chat response had no id");
  const content: string = parsed.choices?.[0]?.message?.content ?? "";
  const usage = {
    prompt_tokens: parsed.usage?.prompt_tokens ?? 0,
    completion_tokens: parsed.usage?.completion_tokens ?? 0,
  };

  const base = { kind: "unknown", signer: null as string | null, tdxQuoteVerified: false as const };
  let v: Verification;
  try {
    const sig = await getSignature(chatId, model);
    const parts = String(sig.text).split(":");
    const kind: string =
      sig.signature_kind === "provider_tee" || sig.signature_kind === "gateway"
        ? sig.signature_kind
        : parts.length === 3
          ? "provider_tee"
          : "gateway";
    const kindMatches = parts.length === (kind === "provider_tee" ? 3 : 2);

    const hasModel = parts.length === 3;
    const signedReq = parts[hasModel ? 1 : 0];
    const signedRes = parts[hasModel ? 2 : 1];
    const hashesMatch = signedReq === sha256(requestBody) && signedRes === sha256(responseText);
    const modelOk = kind === "provider_tee" ? hasModel && parts[0] === model : true;

    const recovered = ethers.verifyMessage(sig.text, sig.signature);
    const expected = kind === "gateway" ? att.gatewayAddresses : att.modelAddresses;
    const attested = expected.some((a) => same(a, recovered));

    const signatureVerified = kindMatches && hashesMatch && modelOk && attested;
    let error: string | null = null;
    if (!signatureVerified) {
      error = !kindMatches
        ? "signature kind does not match the signed text"
        : !hashesMatch
          ? "signed hashes do not match what was sent and received"
          : !modelOk
            ? "signed model id does not match the model requested"
            : "signer is not an address listed in the attestation report";
    }
    v = {
      ...base,
      kind,
      signer: recovered,
      signatureVerified,
      gpuPassed: att.gpuPassed,
      nonceOk: att.nonceOk,
      verified: signatureVerified && att.gpuPassed && att.nonceOk,
      error: error ?? (!att.gpuPassed ? "GPU attestation did not pass" : !att.nonceOk ? "attestation nonce not echoed" : null),
    };
  } catch (e) {
    v = {
      ...base,
      signatureVerified: false,
      gpuPassed: att.gpuPassed,
      nonceOk: att.nonceOk,
      verified: false,
      error: (e as Error).message,
    };
  }
  return { content, chatId, usage, verification: v };
}
