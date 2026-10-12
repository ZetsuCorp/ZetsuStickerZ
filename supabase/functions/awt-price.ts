
const AWT_MINT =
  "ETvGFek4eDeHP7iC7yceGpduTRypHpsUT6tybwMXpump";

const COIN_URL = "https://coinsniper.net/coin/72966";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function output(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS
  });
}

function parsePublishedPrice(input: string): number | null {
  const value = input
    .replace(/\s+/g, "")
    .replace(/,/g, "")
    .replace(/^\$/, "");

  // CoinSniper compact notation, e.g. 0.^ {(0x5)}5419.
  const compact = value.match(
    /^0\.\^\{?\(?0x(\d+)\)?\}?(\d+)$/i
  );

  if (compact) {
    const zeros = Number(compact[1]);

    if (zeros < 0 || zeros > 30) return null;

    const price = Number(
      "0." + "0".repeat(zeros) + compact[2]
    );

    return Number.isFinite(price) && price > 0
      ? price
      : null;
  }

  // Other CoinSniper compact notation: 0.0_{5}5419.
  const subscript = value.match(
    /^0\.0_\{(\d+)\}(\d+)$/
  );

  if (subscript) {
    const zeros = Number(subscript[1]);

    if (zeros < 0 || zeros > 30) return null;

    const price = Number(
      "0." + "0".repeat(zeros) + subscript[2]
    );

    return Number.isFinite(price) && price > 0
      ? price
      : null;
  }

  // Ordinary decimal price.
  if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    return null;
  }

  const price = Number(value);

  return Number.isFinite(price) && price > 0
    ? price
    : null;
}

function readPriceFromHTML(html: string): number | null {
  if (!html.includes(AWT_MINT)) {
    throw new Error("Incorrect token listing");
  }

  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&dollar;/gi, "$")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  const numberPattern =
    String.raw`(0\s*\.\s*\^\s*\{?\s*\(?\s*0x\d+\s*\)?\s*\}?\s*\d+` +
    String.raw`|0\.0_\{\d+\}\d+` +
    String.raw`|\d+\.\d+(?:[eE][+-]?\d+)?)`;

  const patterns = [
    new RegExp(
      String.raw`Artworqq Token Project Price\s*\(USD\)\s*:\s*\$?\s*` +
      numberPattern,
      "i"
    ),
    new RegExp(
      String.raw`Market Data\s+Price\s*:?\s*\$?\s*` +
      numberPattern,
      "i"
    )
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match) continue;

    const price = parsePublishedPrice(match[1]);

    if (price !== null) return price;
  }

  // Embedded structured price data.
  const jsonPatterns = [
    /"priceUsd"\s*:\s*"?(0\.\d+(?:e[+-]?\d+)?)"?/i,
    /"price_usd"\s*:\s*"?(0\.\d+(?:e[+-]?\d+)?)"?/i,
    /"usdPrice"\s*:\s*"?(0\.\d+(?:e[+-]?\d+)?)"?/i
  ];

  for (const pattern of jsonPatterns) {
    const match = html.match(pattern);

    if (!match) continue;

    const price = parsePublishedPrice(match[1]);

    if (price !== null) return price;
  }

  return null;
}

async function getAWTPrice() {
  let pageError = "";

  try {
    const response = await fetch(COIN_URL, {
      headers: {
        Accept: "text/html"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`CoinSniper HTTP ${response.status}`);
    }

    const html = await response.text();
    const price = readPriceFromHTML(html);

    if (price !== null) {
      return {
        price,
        method: "coinsniper-page"
      };
    }

    pageError = "CoinSniper did not display a numeric price";
  } catch (error) {
    pageError =
      error instanceof Error ? error.message : String(error);
  }

  // Preserve the published rate in Supabase configuration
  // when CoinSniper supplies no number.
  const configured = Deno.env.get("AWT_PUBLISHED_PRICE_USD");

  if (configured) {
    const price = parsePublishedPrice(configured);

    if (price !== null) {
      return {
        price,
        method: "published-price-config"
      };
    }
  }

  throw new Error(
    pageError +
    ". Set AWT_PUBLISHED_PRICE_USD in Supabase."
  );
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS
    });
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return output({ error: "Method not allowed" }, 405);
  }

  try {
    const result = await getAWTPrice();

    return output({
      success: true,
      token: "AWT",
      mint: AWT_MINT,
      priceUsd: result.price,
      source: COIN_URL,
      method: result.method,
      retrievedAt: new Date().toISOString()
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.error("[AWT PRICE]", message);

    return output({
      success: false,
      error: message
    }, 502);
  }
});
