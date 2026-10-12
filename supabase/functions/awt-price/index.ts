
const COINSNIPER_URL = "https://coinsniper.net/coin/72966";

const AWT_MINT =
  "ETvGFek4eDeHP7iC7yceGpduTRypHpsUT6tybwMXpump";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, max-age=0"
};

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function extractAWTPrice(html: string): number {
  // Verify that this is the exact AWT listing.
  if (!html.includes(AWT_MINT)) {
    throw new Error("AWT mint not found on CoinSniper page");
  }

  // Remove scripts, styles and HTML tags.
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");

  // Read the price displayed under the AWT heading.
  const match = text.match(
    /Artworqq Token Project Price\s*\(USD\)\s*:\s*\$\s*(0\s*\.\s*(?:\(\s*0x\d+\s*\)\s*)?\d+)/i
  );

  if (!match) {
    throw new Error(
      "AWT price not found in CoinSniper page content"
    );
  }

  const rawPrice = match[1].replace(/\s/g, "");

  let price: number;

  // CoinSniper's compact notation:
  // 0.(0x5)5419 means 0.000005419.
  const compact = rawPrice.match(
    /^0\.\(0x(\d+)\)(\d+)$/i
  );

  if (compact) {
    const zeroCount = Number(compact[1]);

    if (zeroCount < 1 || zeroCount > 30) {
      throw new Error("Invalid price notation");
    }

    price = Number(
      "0." + "0".repeat(zeroCount) + compact[2]
    );
  } else {
    price = Number(rawPrice);
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Invalid AWT price returned");
  }

  return price;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  if (
    request.method !== "GET" &&
    request.method !== "POST"
  ) {
    return respond({ error: "Method not allowed" }, 405);
  }

  try {
    // Fetch the listing again for each request.
    const response = await fetch(COINSNIPER_URL, {
      method: "GET",
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 StickerMania/1.0"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(
        "CoinSniper returned HTTP " + response.status
      );
    }

    const html = await response.text();
    const awtUsd = extractAWTPrice(html);

    return respond({
      success: true,
      token: "AWT",
      mint: AWT_MINT,
      priceUsd: awtUsd,
      source: COINSNIPER_URL,
      retrievedAt: new Date().toISOString()
    });
  } catch (error) {
    return respond({
      success: false,
      error: error instanceof Error
        ? error.message
        : String(error)
    }, 502);
  }
});
