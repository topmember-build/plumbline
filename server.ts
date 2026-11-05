// Plumbline server v0.2 (local).
//   POST /api/order         {"scenario":"allow"|"warn"|"block"}  -> creates an Intents payment order
//   GET  /api/order-status?id=<orderId>                          -> Intents status for that order
//   POST /api/verdict       {"scenario":..., "orderId":...}      -> verdict (needs a SUCCESS payment when requireFee is true)
//   GET  /api/ledger, GET /api/config
//   POST /api/kill          {"on":true|false}
// Rules decide the verdict; the AI only explains it.
// When config.json has "requireFee": true, a verdict is released only after NEAR Intents
// reports the fee order as SUCCESS. When false (demo mode) fees are recorded as unverified.
// Each explanation's NEAR AI signature and GPU attestation are checked (see verifier.ts). The Intel CPU quote is not.
//   GET  /api/tokens        tokens for the live swap builder
// Verdicts run on three frozen demo quotes (scenario allow/warn/block) or on a live dry quote
// from NEAR Intents for any pair the builder offers (scenario custom).
// Usage: npx tsx server.ts

import "dotenv/config";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runAllChecks } from "./checks.ts";
import { chatAndVerify, verifyModelAttestation } from "./verifier.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const NEAR_AI = "https://cloud-api.near.ai";
const ONECLICK = process.env.ONECLICK_URL || "https://1click.chaindefuser.com";
const ORIGIN = "nep141:wrap.near";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const CONFIG_PATH = "config.json";
const LEDGER_PATH = "ledger.jsonl";

const DEFAULTS = {
  killSwitch: false,
  feeUsd: 0.25, // demo-mode fee only; in paid mode the real USDC received is recorded
  feeNear: 0.1, // NEAR the trader sends per verdict in paid mode
  requireFee: false,
  // Qwen3.6-35B-A3B-FP8 on NEAR AI Cloud, per 1M tokens. Source: a third-party price page
  // (typingmind.com), not cloud.near.ai itself. Confirm at cloud.near.ai and edit config.json if it differs.
  inputUsdPerM: 0.17,
  outputUsdPerM: 1.1,
  dailyInferenceBudgetUsd: 1.0,
  // Revenue split of each verified fee: real inference cost first, then a float that stays
  // in the agent account, the rest is paid out to payoutAccount by payout.ts.
  floatPct: 20,
  payoutAccount: "topmemberbuild.near",
};
type Config = typeof DEFAULTS;

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
  return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
}

function writeLedger(entry: Record<string, unknown>) {
  appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

function readLedger(): any[] {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function spentTodayUsd(): number {
  const today = new Date().toISOString().slice(0, 10);
  return readLedger()
    .filter((e) => String(e.ts).startsWith(today) && typeof e.costUsd === "number")
    .reduce((sum, e) => sum + e.costUsd, 0);
}

// Split of verified revenue: inference cost, float kept by the agent, payout owed to the operator.
function splitTotals(all: any[]) {
  const cfg = loadConfig();
  const verified = all.filter((e) => e.event === "verdict" && e.feeVerified);
  const revenue = verified.reduce((s, e) => s + (e.feeUsd ?? 0), 0);
  const cost = verified.reduce((s, e) => s + (e.costUsd ?? 0), 0);
  const floatUsd = (revenue * cfg.floatPct) / 100;
  const paidOutUsd = all.filter((e) => e.event === "payout").reduce((s, e) => s + (e.amountUsdc ?? 0), 0);
  const payoutOwedUsd = Math.max(0, revenue - cost - floatUsd - paidOutUsd);
  return { floatUsd, paidOutUsd, payoutOwedUsd };
}

function totals() {
  const all = readLedger();
  const rows = all.filter((e) => e.event === "verdict");
  const sum = (f: (e: any) => number) => rows.reduce((s, e) => s + f(e), 0);
  return {
    sales: rows.length,
    revenueVerifiedUsd: sum((e) => (e.feeVerified ? e.feeUsd : 0)),
    revenueUnverifiedUsd: sum((e) => (e.feeVerified ? 0 : e.feeUsd)),
    inferenceCostUsd: sum((e) => e.costUsd ?? 0),
    refundedOrders: all.filter((e) => e.event === "fee-refunded").length,
    ...splitTotals(all),
  };
}

// ---------- Live swap builder ----------
type Tok = { assetId: string; symbol: string; blockchain: string; decimals: number; price: number };
const EVM_CHAINS = new Set(["eth", "base", "arb", "op", "bsc", "pol", "avax", "gnosis", "bera"]);
const FROZEN_LABELS: Record<string, string> = {
  allow: "1,000 NEAR into ETH",
  warn: "0.1 NEAR into ETH",
  block: "$5,000 of NEAR into JAMBO",
};
let tokenCache: { at: number; list: Tok[] } | null = null;

async function getTokens(): Promise<Tok[]> {
  if (tokenCache && Date.now() - tokenCache.at < 10 * 60 * 1000) return tokenCache.list;
  try {
    const res = await fetch(`${ONECLICK}/v0/tokens`, { headers: oneClickHeaders() });
    if (!res.ok) throw new Error(`Token list failed (${res.status})`);
    const raw: any[] = await res.json();
    const list = raw
      .map((t) => ({
        assetId: String(t.assetId),
        symbol: String(t.symbol),
        blockchain: String(t.blockchain),
        decimals: Number(t.decimals),
        price: Number(t.price),
      }))
      .filter((t) => t.assetId && t.symbol && Number.isFinite(t.decimals) && Number.isFinite(t.price) && t.price > 0);
    tokenCache = { at: Date.now(), list };
    return list;
  } catch (e) {
    if (tokenCache) return tokenCache.list; // keep serving the last good list
    throw e;
  }
}

// A dry quote needs a destination address that is valid for the chain. It is never used to send funds.
function recipientFor(chain: string): string | null {
  if (chain === "near") return process.env.REFUND_TO ?? null;
  if (EVM_CHAINS.has(chain)) return process.env.RECIPIENT ?? null;
  return null;
}

function toUnits(usd: number, tok: Tok): string {
  const keep = Math.min(tok.decimals, 8);
  const scaled = BigInt(Math.floor((usd / tok.price) * 10 ** keep));
  if (scaled <= 0n) throw new Error("amount is too small");
  return (scaled * 10n ** BigInt(tok.decimals - keep)).toString();
}

async function fetchDryQuote(from: Tok, to: Tok, usd: number): Promise<any> {
  const recipient = recipientFor(to.blockchain);
  const refundTo = process.env.REFUND_TO;
  if (!recipient || !refundTo) throw new Error("the server is missing REFUND_TO or RECIPIENT in .env");
  const res = await fetch(`${ONECLICK}/v0/quote`, {
    method: "POST",
    headers: oneClickHeaders(),
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: from.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: to.assetId,
      amount: toUnits(usd, from),
      recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json?.message ?? `quote failed (${res.status})`));
  return json.quote ?? json;
}

async function resolveCustom(p: any): Promise<{ from: Tok; to: Tok; usd: number } | string> {
  const usd = Number(p?.usd);
  if (!Number.isFinite(usd) || usd < 1 || usd > 250000) return "Amount must be between $1 and $250,000.";
  const list = await getTokens();
  const from = list.find((t) => t.assetId === p?.from && t.blockchain === "near");
  const to = list.find((t) => t.assetId === p?.to && recipientFor(t.blockchain));
  if (!from || !to) return "Pick both tokens from the lists.";
  if (from.assetId === to.assetId) return "Pick two different tokens.";
  return { from, to, usd };
}

const customLabel = (usd: number, from: Tok, to: Tok) =>
  `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })} of ${from.symbol} into ${to.symbol}`;

// Keeps live quote requests to the Intents API reasonable.
const quoteTimes: number[] = [];
function quoteRateOk(): boolean {
  const now = Date.now();
  while (quoteTimes.length && now - quoteTimes[0] > 60_000) quoteTimes.shift();
  if (quoteTimes.length >= 30) return false;
  quoteTimes.push(now);
  return true;
}

async function tokenLists(): Promise<[number, unknown]> {
  try {
    const list = await getTokens();
    const slim = (t: Tok) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain });
    const by = (a: Tok, b: Tok) => a.symbol.localeCompare(b.symbol);
    return [
      200,
      {
        from: list.filter((t) => t.blockchain === "near").sort(by).map(slim),
        to: list.filter((t) => recipientFor(t.blockchain)).sort(by).map(slim),
      },
    ];
  } catch (e) {
    return [502, { error: `Could not load tokens: ${(e as Error).message}` }];
  }
}

// ---------- Intents payments ----------
function oneClickHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.ONECLICK_JWT) h.Authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  return h;
}

const toYocto = (near: number) => (BigInt(Math.round(near * 1e6)) * 10n ** 18n).toString();

function refusalIfNotSelling(cfg: Config): [number, unknown] | null {
  if (cfg.killSwitch) {
    writeLedger({ event: "refused", reason: "kill-switch" });
    return [503, { error: "Plumbline is switched off by its operator (kill switch)." }];
  }
  if (spentTodayUsd() >= cfg.dailyInferenceBudgetUsd) {
    writeLedger({ event: "refused", reason: "daily-budget" });
    return [429, { error: "Daily inference budget reached. Try again tomorrow." }];
  }
  return null;
}

async function createOrder(body: any): Promise<[number, unknown]> {
  const cfg = loadConfig();
  const refusal = refusalIfNotSelling(cfg);
  if (refusal) return refusal; // nobody is asked to pay while the shop is closed

  const scenario = String(body?.scenario ?? "");
  if (!["allow", "warn", "block", "custom"].includes(scenario)) {
    return [400, { error: "scenario must be allow, warn, block or custom" }];
  }
  const refundTo = process.env.REFUND_TO;
  const agent = process.env.AGENT_ACCOUNT;
  if (!refundTo || !agent) return [500, { error: "Set REFUND_TO and AGENT_ACCOUNT in .env" }];

  // For a live swap, make sure a quote exists BEFORE anyone is asked to pay.
  let custom: any = null;
  let snapshot: any = null;
  let swapLabel = FROZEN_LABELS[scenario] ?? scenario;
  if (scenario === "custom") {
    const r = await resolveCustom(body);
    if (typeof r === "string") return [400, { error: r }];
    if (!quoteRateOk()) return [429, { error: "Too many live checks right now. Try again in a minute." }];
    try {
      const q = await fetchDryQuote(r.from, r.to, r.usd);
      snapshot = { amountInUsd: q.amountInUsd, amountOutUsd: q.amountOutUsd, at: new Date().toISOString() };
    } catch (e) {
      return [422, { error: `No quote is available for that swap right now: ${(e as Error).message}` }];
    }
    custom = { from: r.from.assetId, to: r.to.assetId, usd: r.usd };
    swapLabel = customLabel(r.usd, r.from, r.to);
  }

  const res = await fetch(`${ONECLICK}/v0/quote`, {
    method: "POST",
    headers: oneClickHeaders(),
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ORIGIN,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_NEAR,
      amount: toYocto(cfg.feeNear),
      recipient: agent,
      recipientType: "DESTINATION_CHAIN",
      refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  const q = json.quote ?? json;
  if (!res.ok || !q.depositAddress) {
    return [502, { error: `Could not create a payment order: ${String(json?.message ?? res.status)}` }];
  }

  writeLedger({
    event: "order",
    orderId: q.depositAddress,
    scenario,
    swapLabel,
    custom,
    snapshot,
    sendNear: q.amountInFormatted,
    expectedUsdc: q.amountOutFormatted,
  });
  return [
    200,
    {
      orderId: q.depositAddress,
      depositAddress: q.depositAddress,
      depositMemo: q.depositMemo ?? null,
      sendNear: q.amountInFormatted,
      receiveUsdc: q.amountOutFormatted,
      deadline: q.deadline,
    },
  ];
}

function knownOrder(orderId: string): boolean {
  return readLedger().some((e) => e.event === "order" && e.orderId === orderId);
}

async function fetchOrderStatus(orderId: string): Promise<any> {
  const res = await fetch(`${ONECLICK}/v0/status?depositAddress=${encodeURIComponent(orderId)}`, {
    headers: oneClickHeaders(),
  });
  const json: any = await res.json().catch(() => ({}));
  // Log a failed or refunded order once, so the ledger shows it honestly.
  if (["REFUNDED", "FAILED"].includes(json.status)) {
    const already = readLedger().some((e) => e.event === "fee-refunded" && e.orderId === orderId);
    if (!already) {
      writeLedger({
        event: "fee-refunded",
        orderId,
        status: json.status,
        reason: json.swapDetails?.refundReason ?? null,
      });
    }
  }
  return json;
}

async function orderStatus(orderId: string): Promise<[number, unknown]> {
  if (!orderId || !knownOrder(orderId)) return [404, { error: "Unknown order." }];
  const json = await fetchOrderStatus(orderId);
  return [
    200,
    {
      status: json.status ?? null,
      refundReason: json.swapDetails?.refundReason ?? null,
      receivedUsdc: json.swapDetails?.amountOutFormatted ?? null,
    },
  ];
}

// ---------- AI explanation + attestation check ----------
type AttestationInfo = {
  fetched: boolean;
  verified: boolean;
  signatureVerified: boolean;
  gpuPassed: boolean;
  signer: string | null;
  tdxQuoteVerified: false;
  error: string | null;
};
const noAttestation: AttestationInfo = {
  fetched: false,
  verified: false,
  signatureVerified: false,
  gpuPassed: false,
  signer: null,
  tdxQuoteVerified: false,
  error: null,
};

async function explainAndAttest(verdict: string, results: unknown[], cfg: Config, swapLabel: string) {
  const apiKey = process.env.NEAR_AI_API_KEY;
  const model = process.env.NEAR_AI_MODEL ?? "Qwen/Qwen3.6-35B-A3B-FP8";
  const fallback = {
    text: `Verdict ${verdict}. ` + (results as any[]).map((r) => r.detail).join(" "),
    source: "rules" as const,
    model,
    chatId: null as string | null,
    costUsd: 0,
    attestation: noAttestation,
  };
  if (!apiKey) return fallback;

  try {
    const messages = [
        {
          role: "system",
          content:
            "You write the explanation for a swap-risk verdict that has ALREADY been decided. Never change the verdict. " +
            "Use only the facts given and invent nothing. Write exactly 2 short sentences for a trader. " +
            "Sentence 1: what the quote implies, in plain words with the numbers. " +
            "Sentence 2: one practical suggestion (for WARN or BLOCK, try a smaller amount or a more liquid pair; " +
            "for ALLOW, say this check found nothing unusual). " +
            "Say 'the quote implies', never 'you will lose'. Do not mention rules, protocols or restrictions.",
        },
        { role: "user", content: JSON.stringify({ verdict, swap: swapLabel, checks: results }) },
    ];
    // One retry: a customer who already paid should not lose the AI explanation to a network blip.
    let r;
    try {
      r = await chatAndVerify(messages, model);
    } catch (first) {
      console.log("AI call failed, retrying once:", (first as Error).message, (first as any).cause ?? "");
      await new Promise((res) => setTimeout(res, 1500));
      r = await chatAndVerify(messages, model);
    }
    const text = r.content.trim() || fallback.text;
    const costUsd = (r.usage.prompt_tokens * cfg.inputUsdPerM + r.usage.completion_tokens * cfg.outputUsdPerM) / 1e6;
    const v = r.verification;
    const attestation: AttestationInfo = {
      fetched: true,
      verified: v.verified,
      signatureVerified: v.signatureVerified,
      gpuPassed: v.gpuPassed,
      signer: v.signer,
      tdxQuoteVerified: false,
      error: v.error,
    };
    return { text, source: "ai" as const, model, chatId: r.chatId, costUsd, attestation };
  } catch (e) {
    console.log("AI explanation failed, using rules text:", (e as Error).message, (e as any).cause ?? "");
    return fallback;
  }
}

// ---------- Verdict ----------
async function handleVerdict(body: any): Promise<[number, unknown]> {
  const cfg = loadConfig();

  const refusal = refusalIfNotSelling(cfg);
  if (refusal) return refusal;

  const scenario = String(body?.scenario ?? "");
  if (!["allow", "warn", "block", "custom"].includes(scenario)) {
    return [400, { error: "scenario must be allow, warn, block or custom" }];
  }

  // Fee handling
  let feeUsd = cfg.feeUsd;
  let feeVerified = false;
  let feeTx: string | null = null;
  let orderId: string | null = null;
  let orderEvent: any = null;

  if (cfg.requireFee) {
    orderId = String(body?.orderId ?? "");
    if (!orderId) return [402, { error: "Payment required. Create an order first." }];
    const ledger = readLedger();
    orderEvent = ledger.find((e) => e.event === "order" && e.orderId === orderId) ?? null;
    if (!orderEvent) return [402, { error: "Unknown order." }];
    if (orderEvent.scenario !== scenario) return [402, { error: "This payment was for a different swap." }];
    if (ledger.some((e) => e.event === "verdict" && e.orderId === orderId)) {
      return [402, { error: "This payment was already used for a verdict." }];
    }
    const st = await fetchOrderStatus(orderId);
    if (st.status !== "SUCCESS") {
      return [402, { error: `Payment not complete (status: ${st.status ?? "unknown"}).` }];
    }
    const recipient = st.quoteResponse?.quoteRequest?.recipient;
    if (process.env.AGENT_ACCOUNT && recipient !== process.env.AGENT_ACCOUNT) {
      return [402, { error: "Payment went to a different account than the agent." }];
    }
    feeUsd = Number(st.swapDetails?.amountOutUsd) || 0;
    feeVerified = true;
    feeTx = st.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? null;
  }

  let quote: any;
  let swapLabel = FROZEN_LABELS[scenario] ?? scenario;
  let live = false;
  let quoteAt: string | null = null;

  if (scenario === "custom") {
    // Paid mode: the swap was fixed when the order was made. Demo mode: it comes from the request.
    const params = cfg.requireFee ? orderEvent?.custom : body;
    const r = await resolveCustom(params);
    if (typeof r === "string") return [400, { error: r }];
    swapLabel = customLabel(r.usd, r.from, r.to);
    try {
      if (!cfg.requireFee && !quoteRateOk()) {
        return [429, { error: "Too many live checks right now. Try again in a minute." }];
      }
      quote = await fetchDryQuote(r.from, r.to, r.usd);
      quoteAt = new Date().toISOString();
      live = true;
    } catch (e) {
      if (cfg.requireFee && orderEvent?.snapshot) {
        // The customer already paid, so fall back to the quote taken when they ordered.
        quote = orderEvent.snapshot;
        quoteAt = orderEvent.snapshot.at ?? null;
        live = true;
      } else {
        return [502, { error: `No quote is available for that swap right now: ${(e as Error).message}` }];
      }
    }
  } else {
    const file = `fixtures/demo-${scenario}.json`;
    if (!existsSync(file)) return [500, { error: `Missing ${file}. Run: npx tsx demo-fixtures.ts` }];
    const raw = JSON.parse(readFileSync(file, "utf8"));
    quote = raw.quote ?? raw;
  }

  const { verdict, results } = runAllChecks(quote);
  const inUsd = Number(quote.amountInUsd);
  const outUsd = Number(quote.amountOutUsd);
  const lossPct = Number.isFinite(inUsd) && Number.isFinite(outUsd) && inUsd > 0 ? ((inUsd - outUsd) / inUsd) * 100 : null;
  const ex = await explainAndAttest(verdict, results, cfg, swapLabel);

  writeLedger({
    event: "verdict",
    scenario,
    swapLabel,
    live,
    lossPct,
    verdict,
    orderId,
    feeUsd,
    feeVerified,
    feeTx,
    costUsd: ex.costUsd,
    model: ex.model,
    chatId: ex.chatId,
    explanationSource: ex.source,
    signatureVerified: ex.attestation.signatureVerified,
    gpuVerified: ex.attestation.gpuPassed,
    attestationVerified: ex.attestation.verified,
    signer: ex.attestation.signer,
    attestationError: ex.attestation.error,
  });

  return [
    200,
    {
      verdict,
      swap: {
        label: swapLabel,
        amountInUsd: Number.isFinite(inUsd) ? inUsd : null,
        amountOutUsd: Number.isFinite(outUsd) ? outUsd : null,
        lossPct,
        live,
        quoteAt,
      },
      checks: results,
      explanation: ex.text,
      explanationSource: ex.source,
      attestation: ex.attestation,
    },
  ];
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const url = u.pathname;
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      if (!existsSync("public/index.html")) return send(res, 404, { error: "Missing public/index.html" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readFileSync("public/index.html"));
    }
    if (req.method === "GET" && url === "/api/config") return send(res, 200, loadConfig());
    if (req.method === "GET" && url === "/api/tokens") {
      const [status, payload] = await tokenLists();
      return send(res, status, payload);
    }
    if (req.method === "GET" && url === "/api/ledger") {
      return send(res, 200, { totals: totals(), recent: readLedger().slice(-50) });
    }
    if (req.method === "GET" && url === "/api/order-status") {
      const [status, payload] = await orderStatus(String(u.searchParams.get("id") ?? ""));
      return send(res, status, payload);
    }
    if (req.method === "POST" && url === "/api/kill") {
      // Public hosting: the switch only works with the operator token. Without a token set, it only works locally.
      const token = process.env.OPERATOR_TOKEN;
      if (token) {
        const given = Buffer.from(String(req.headers["x-operator-token"] ?? ""));
        const want = Buffer.from(token);
        if (given.length !== want.length || !timingSafeEqual(given, want)) {
          return send(res, 401, { error: "Operator token required" });
        }
      } else if (HOST !== "127.0.0.1") {
        return send(res, 403, { error: "Set OPERATOR_TOKEN to use the kill switch on a public server" });
      }
      const body = await readBody(req);
      const cfg = loadConfig();
      cfg.killSwitch = Boolean(body?.on);
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      writeLedger({ event: "kill-switch", on: cfg.killSwitch });
      return send(res, 200, { killSwitch: cfg.killSwitch });
    }
    if (req.method === "POST" && url === "/api/order") {
      const [status, payload] = await createOrder(await readBody(req));
      return send(res, status, payload);
    }
    if (req.method === "POST" && url === "/api/verdict") {
      const [status, payload] = await handleVerdict(await readBody(req));
      return send(res, status, payload);
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
});

// Local by default. For public hosting set HOST=0.0.0.0 and OPERATOR_TOKEN (the kill switch needs it).
server.listen(PORT, HOST, () => {
  console.log(`Plumbline server on http://${HOST}:${PORT}`);
  if (HOST !== "127.0.0.1" && !process.env.OPERATOR_TOKEN) console.log("Note: OPERATOR_TOKEN is not set, so the kill switch is disabled on this public server.");
  // Warm the attestation cache so the first paid verdict is not slow.
  if (process.env.NEAR_AI_API_KEY) {
    verifyModelAttestation(process.env.NEAR_AI_MODEL ?? "Qwen/Qwen3.6-35B-A3B-FP8")
      .then((a) => console.log(`Attestation warm-up: nonce ${a.nonceOk ? "ok" : "FAIL"}, GPU ${a.gpuPassed ? "ok" : "FAIL"}`))
      .catch((e) => console.log("Attestation warm-up failed:", e.message));
  }
});
