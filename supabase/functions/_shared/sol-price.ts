
import Decimal from "npm:decimal.js@10.4.3";

// Two no-key spot-price sources. Each request obtains a fresh SOL/USD quote.
export async function getSolPriceUsd(): Promise<Decimal> {
  const sources = [
    {
      url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
      parse: (data: any) => data?.data?.amount
    },
    {
      url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      parse: (data: any) => data?.solana?.usd
    }
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source.url, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) continue;
      const price = new Decimal(String(source.parse(await response.json())));
      if (price.isFinite() && price.gt(0)) return price;
    } catch (error) {
      console.warn("[SOL-PRICE] source unavailable:", String(error));
    }
  }

  throw new Error("Live SOL/USD price is unavailable. Try again shortly.");
}
