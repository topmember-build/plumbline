// Lists tokens supported by the NEAR Intents 1Click API.
// Usage: npx tsx tokens.ts            (first 60 tokens)
//        npx tsx tokens.ts sol        (filter by symbol or chain name)

const res = await fetch("https://1click.chaindefuser.com/v0/tokens");
if (!res.ok) {
  throw new Error(`Token list failed (${res.status}): ${await res.text()}`);
}

const tokens: any[] = await res.json();
const filter = (process.argv[2] ?? "").toLowerCase();

const rows = tokens.filter(
  (t) =>
    !filter ||
    String(t.symbol).toLowerCase().includes(filter) ||
    String(t.blockchain).toLowerCase().includes(filter),
);

console.log(`${rows.length} of ${tokens.length} tokens match`);
for (const t of rows.slice(0, 60)) {
  console.log(`${t.symbol}\t${t.blockchain}\tprice=${t.price}\t${t.assetId}`);
}
