// One-command check a judge can re-run: sends a test message to the model Plumbline uses
// and verifies the attestation and the response signature.
// Usage: npm run verify

import "dotenv/config";
import { chatAndVerify, verifyModelAttestation } from "./verifier.ts";

const model = process.env.NEAR_AI_MODEL ?? "Qwen/Qwen3.6-35B-A3B-FP8";
const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");

console.log(`Model: ${model}`);
const att = await verifyModelAttestation(model, true);
console.log(`[${mark(att.nonceOk)}] Fresh nonce echoed by gateway and model TEE`);
console.log(`[${mark(att.gpuPassed)}] NVIDIA GPU attestation: ${att.gpuSummary}`);
console.log(`      Model TEE address(es): ${att.modelAddresses.join(", ")}`);

const r = await chatAndVerify([{ role: "user", content: "Respond with only two words" }], model);
const v = r.verification;
console.log(`[${mark(v.signatureVerified)}] Response signature (${v.kind}) recovered to ${v.signer} and matches the attested address`);
console.log(`      Chat id: ${r.chatId}`);
if (v.error) console.log(`      Note: ${v.error}`);
console.log("[NOT DONE] Intel TDX quote (CPU-side proof) is not verified by this script");

console.log(v.verified ? "\nRESULT: verified (see the list above for exactly what that covers)" : "\nRESULT: NOT verified");
process.exit(v.verified ? 0 : 1);
