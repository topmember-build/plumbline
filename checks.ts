// Plumbline check engine v1.
// Rules decide the verdict. The AI only explains it.

export type Level = "pass" | "warn" | "fail";
export type Verdict = "ALLOW" | "WARN" | "BLOCK";

export interface CheckResult {
  name: string;
  level: Level;
  detail: string;
}

// Starting thresholds (percent of value lost between amount in and amount out).
// These are guesses to tune against real quotes at realistic trade sizes.
const WARN_LOSS_PCT = 1;
const FAIL_LOSS_PCT = 3;
// Below this size, fixed fees dominate, so a big loss % says little about the token.
const TINY_TRADE_USD = 10;

export function priceDeviation(quote: any): CheckResult {
  const inUsd = Number(quote.amountInUsd);
  const outUsd = Number(quote.amountOutUsd);

  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd) || inUsd <= 0) {
    return {
      name: "price_deviation",
      level: "warn",
      detail: "Quote has no usable USD values, so price deviation could not be checked.",
    };
  }
  if (outUsd <= 0) {
    return {
      name: "price_deviation",
      level: "warn",
      detail: "No market price for the destination asset, so the value you receive can't be verified.",
    };
  }

  const lossPct = ((inUsd - outUsd) / inUsd) * 100;
  const lossText = `${lossPct.toFixed(1)}% of value lost ($${inUsd.toFixed(2)} in, $${outUsd.toFixed(2)} out)`;

  if (lossPct >= FAIL_LOSS_PCT && inUsd < TINY_TRADE_USD) {
    return {
      name: "price_deviation",
      level: "warn",
      detail: `${lossText}. Trade is very small, so fixed fees likely explain most of this. Retry with a realistic size.`,
    };
  }
  if (lossPct >= FAIL_LOSS_PCT) {
    return { name: "price_deviation", level: "fail", detail: lossText };
  }
  if (lossPct >= WARN_LOSS_PCT) {
    return { name: "price_deviation", level: "warn", detail: lossText };
  }
  return { name: "price_deviation", level: "pass", detail: lossText };
}

// Worst result wins.
export function combine(results: CheckResult[]): Verdict {
  if (results.some((r) => r.level === "fail")) return "BLOCK";
  if (results.some((r) => r.level === "warn")) return "WARN";
  return "ALLOW";
}

// Later: assetProvenance(quote), holderConcentration(quote).
export function runAllChecks(quote: any): { verdict: Verdict; results: CheckResult[] } {
  const results = [priceDeviation(quote)];
  return { verdict: combine(results), results };
}
