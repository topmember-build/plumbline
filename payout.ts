// Plumbline payout: moves the operator's share of verified fees (USDC) from the agent account
// to config.json "payoutAccount", and records the result in ledger.jsonl.
//
//   npm run payout                                  dry run: prints the plan, sends nothing
//   npm run payout -- --register                    register the receiver for USDC (one-time storage deposit, paid in NEAR by the agent)
//   npm run payout -- --send                        send the USDC
//   npm run payout -- --resolve sent <hash> <usdc>  record a transfer that went through but was not logged
//   npm run payout -- --resolve not-sent            record that an attempt did not go through, so sending is allowed again
//
// Needs in .env:  AGENT_ACCOUNT=topmember.near   AGENT_PRIVATE_KEY=ed25519:...   (never share or commit this key)
// Optional:       NEAR_RPC (default https://rpc.mainnet.near.org)
//
// Owed = verified fees - real inference cost - float (floatPct of fees) - payouts already made.
//
// Safety rules (added after a network error hid a transfer that had already gone through):
//   - Before sending, an intent line is written. If the attempt ends in an error, the script checks the
//     agent's balance. It records a payout only when the balance fell by exactly the amount sent.
//   - If the outcome is not certain, sending stays blocked until you run --resolve.
//   - It refuses to send when the balance is lower than what is owed, because that usually means an
//     earlier transfer was not recorded. Use --allow-partial only if you have checked on nearblocks.io.

import "dotenv/config";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Account, JsonRpcProvider, teraToGas } from "near-api-js";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const DECIMALS = 6;
const args = process.argv.slice(2);
const send = args.includes("--send");
const register = args.includes("--register");
const allowPartial = args.includes("--allow-partial");
const resolveAt = args.indexOf("--resolve");

const cfg = { floatPct: 20, payoutAccount: "topmemberbuild.near", ...JSON.parse(readFileSync("config.json", "utf8")) };
const agent = process.env.AGENT_ACCOUNT;
const key = process.env.AGENT_PRIVATE_KEY;
if (!agent) throw new Error("Set AGENT_ACCOUNT in .env");
if ((send || register) && !key) throw new Error("Set AGENT_PRIVATE_KEY in .env to send (never paste it in chat)");
if (cfg.payoutAccount === agent) throw new Error("payoutAccount is the same as the agent account");

const writeLedger = (entry: Record<string, unknown>) =>
  appendFileSync("ledger.jsonl", JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

// ---- --resolve: no network needed ----
if (resolveAt >= 0) {
  const what = args[resolveAt + 1];
  if (what === "sent") {
    const hash = args[resolveAt + 2];
    const usdc = Number(args[resolveAt + 3]);
    if (!hash || !Number.isFinite(usdc) || usdc <= 0) {
      throw new Error("Usage: npm run payout -- --resolve sent <transaction hash> <amount in USDC>");
    }
    writeLedger({ event: "payout", to: cfg.payoutAccount, amountUsdc: usdc, txHash: hash, note: "recorded by hand with --resolve" });
    console.log(`Recorded a payout of ${usdc} USDC with transaction ${hash}.`);
  } else if (what === "not-sent") {
    writeLedger({ event: "payout-failed", note: "confirmed by hand with --resolve not-sent" });
    console.log("Recorded that the last attempt did not go through. Sending is allowed again.");
  } else {
    throw new Error("Use: --resolve sent <hash> <usdc>   or   --resolve not-sent");
  }
  process.exit(0);
}

const ledger: any[] = existsSync("ledger.jsonl")
  ? readFileSync("ledger.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const verified = ledger.filter((e) => e.event === "verdict" && e.feeVerified);
const revenue = verified.reduce((s, e) => s + (e.feeUsd ?? 0), 0);
const cost = verified.reduce((s, e) => s + (e.costUsd ?? 0), 0);
const floatUsd = (revenue * cfg.floatPct) / 100;
const paid = ledger.filter((e) => e.event === "payout").reduce((s, e) => s + (e.amountUsdc ?? 0), 0);
const owed = Math.max(0, revenue - cost - floatUsd - paid);

// An attempt that never reached a final record blocks sending.
const lastPayoutEvent = [...ledger].reverse().find((e) => ["payout-intent", "payout", "payout-failed", "payout-unconfirmed"].includes(e.event));
const pending = lastPayoutEvent && ["payout-intent", "payout-unconfirmed"].includes(lastPayoutEvent.event);

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC || "https://rpc.mainnet.near.org" });
const toMicro = (usd: number) => BigInt(Math.floor(usd * 10 ** DECIMALS));
const fmt = (micro: bigint) => (Number(micro) / 10 ** DECIMALS).toFixed(DECIMALS);
const readBalance = async () =>
  BigInt(await retry<string>(() => provider.callFunction({ contractId: USDC, method: "ft_balance_of", args: { account_id: agent } }) as Promise<string>));

const balance = await readBalance();
const registered: unknown = await retry(() =>
  provider.callFunction({ contractId: USDC, method: "storage_balance_of", args: { account_id: cfg.payoutAccount } }),
);

const owedMicro = toMicro(owed);
const amount = owedMicro < balance ? owedMicro : balance;

console.log(`Verified fees:        $${revenue.toFixed(6)}`);
console.log(`Inference cost:       $${cost.toFixed(6)}`);
console.log(`Float kept (${cfg.floatPct}%):   $${floatUsd.toFixed(6)}`);
console.log(`Already paid out:     $${paid.toFixed(6)}`);
console.log(`Owed to operator:     $${owed.toFixed(6)}`);
console.log(`Agent USDC balance:   ${fmt(balance)} (${agent})`);
console.log(`Receiver registered:  ${registered ? "yes" : "NO"} (${cfg.payoutAccount})`);
console.log(`Would send:           ${fmt(amount)} USDC  ${agent} -> ${cfg.payoutAccount}`);
if (pending) {
  console.log(
    "\nWARNING: an earlier payout attempt has no final result in the ledger. It may have gone through.\n" +
      "Check the agent's transfers on nearblocks.io, then record the result:\n" +
      "  npm run payout -- --resolve sent <transaction hash> <amount in USDC>\n" +
      "  npm run payout -- --resolve not-sent",
  );
}
if (owedMicro > balance) {
  console.log(
    "\nWARNING: the balance is lower than what is owed. That usually means a transfer went through but was not recorded.",
  );
}

if (register) {
  if (registered) {
    console.log("\nReceiver is already registered. Nothing to do.");
  } else {
    const account = new Account(agent, provider, key as any);
    // 0.00125 NEAR is the usual USDC storage deposit; the contract refunds any excess
    const res = await account.callFunction({
      contractId: USDC,
      methodName: "storage_deposit",
      args: { account_id: cfg.payoutAccount, registration_only: true },
      gas: teraToGas("30"),
      deposit: 1_250_000_000_000_000_000_000n,
    });
    console.log("\nRegistered receiver:", JSON.stringify(res).slice(0, 200));
  }
  process.exit(0);
}

if (!send) {
  console.log("\nDry run only. Nothing was sent. Add --send to send.");
  process.exit(0);
}
if (pending) throw new Error("Sending is blocked until the earlier attempt is resolved (see the warning above).");
if (owedMicro > balance && !allowPartial) {
  throw new Error("Refusing to send: the balance is lower than what is owed. Check nearblocks.io first. (--allow-partial overrides.)");
}
if (!registered) throw new Error(`${cfg.payoutAccount} is not registered for USDC. Run: npm run payout -- --register`);
if (amount < 10_000n) throw new Error("Amount is under $0.01. Wait for more sales.");

const account = new Account(agent, provider, key as any);
writeLedger({ event: "payout-intent", to: cfg.payoutAccount, amountUsdc: Number(fmt(amount)), balanceBefore: balance.toString() });

let txHash: string | null = null;
let sendError: unknown = null;
try {
  // callFunctionRaw returns the full transaction outcome (callFunction only returns the contract's return value)
  const result: any = await account.callFunctionRaw({
    contractId: USDC,
    methodName: "ft_transfer",
    args: { receiver_id: cfg.payoutAccount, amount: amount.toString(), memo: "Plumbline operator payout" },
    gas: teraToGas("30"),
    deposit: 1n, // ft_transfer requires exactly 1 yoctoNEAR
  });
  txHash = result?.transaction?.hash ?? result?.transaction_outcome?.id ?? null;
} catch (e) {
  sendError = e;
}

if (!sendError) {
  writeLedger({ event: "payout", to: cfg.payoutAccount, amountUsdc: Number(fmt(amount)), txHash });
  if (!txHash) console.log("Warning: sent, but no transaction hash was returned. Find it on nearblocks.io.");
  console.log(`\nSent ${fmt(amount)} USDC. Transaction: ${txHash}`);
  process.exit(0);
}

// The call ended in an error. The transfer may still have gone through, so check the balance before anything else.
console.log(`\nThe send ended with an error: ${(sendError as Error).message}`);
console.log("Checking the agent's balance to see whether the transfer happened. This takes about 10 seconds.");
await sleep(Number(process.env.PAYOUT_CONFIRM_WAIT_MS ?? 10_000));
try {
  const after = await readBalance();
  if (balance - after === amount) {
    writeLedger({
      event: "payout",
      to: cfg.payoutAccount,
      amountUsdc: Number(fmt(amount)),
      txHash: null,
      note: "confirmed by the balance falling by exactly this amount after a network error; hash not returned",
    });
    console.log(`\nThe transfer DID go through (balance ${fmt(balance)} -> ${fmt(after)}). It is recorded in the ledger.`);
    console.log("Its transaction hash was not returned. Find it on nearblocks.io (search the agent account).");
    console.log("Do not run --resolve sent for this one: the payout is already counted in the ledger.");
    process.exit(0);
  }
  writeLedger({ event: "payout-unconfirmed", amountUsdc: Number(fmt(amount)), balanceBefore: balance.toString(), balanceAfter: after.toString() });
  console.log(
    after === balance
      ? "\nThe balance has not changed, so it looks like nothing was sent. The transaction could still be in flight."
      : "\nThe balance changed by a different amount than expected.",
  );
} catch {
  writeLedger({ event: "payout-unconfirmed", amountUsdc: Number(fmt(amount)), balanceBefore: balance.toString() });
  console.log("\nCould not read the balance to confirm.");
}
console.log(
  "Do NOT run --send again yet. Look at the agent's transfers on nearblocks.io, then run one of:\n" +
    "  npm run payout -- --resolve sent <transaction hash> <amount in USDC>\n" +
    "  npm run payout -- --resolve not-sent",
);
process.exit(1);
