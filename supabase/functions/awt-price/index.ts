
const COIN_URL = "https://coinsniper.net/coin/72966";

const AWT_MINT =
  "ETvGFek4eDeHP7iC7yceGpduTRypHpsUT6tybwMXpump";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate"
};

function jsonResponse(
  data: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&dollar;/gi, "$")
    .replace(/&colon;/gi, ":")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, number) => {
      const code = Number(number);
      return code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/gi,
        " "
      )
      .replace(
        /<style\b[^>]*>[\s\S]*?<\/style>/gi,
        " "
      )
      .replace(
        /<\/(?:div|p|section|h[1-6]|li|tr)>/gi,
        " "
      )
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(rawInput: string): number {
  const raw = rawInput
    .replace(/\s/g, "")
    .replace(/,/g, "")
    .replace(/^\$/, "");

  let price: number;

  // CoinSniper older notation:
  // 0.(0x5)5419 = 0.000005419

  let match = raw.match(
    /^0\.\(0x(\d+)\)(\d+)$/i
  );

  if (match) {
    const zeros = Number(match[1]);

    if (zeros > 30) {
      throw new Error("Invalid compact price");
    }

    price = Number(
      "0." + "0".repeat(zeros) + match[2]
    );

  } else {
    // Alternative formatted notation:
    // 0.^ {(0x5)}5419

    match = raw.match(
      /^0\.\^\{\(0x(\d+)\)\}(\d+)$/i
    );

    if (match) {
      const zeros = Number(match[1]);

      if (zeros > 30) {
        throw new Error("Invalid compact price");
      }

      price = Number(
        "0." + "0".repeat(zeros) + match[2]
      );

    } else {
      // Newer compact notation:
      // 0.0_{5}5419

      match = raw.match(
        /^0\.0_\{(\d+)\}(\d+)$/
      );

      if (match) {
        const zeros = Number(match[1]);

        if (zeros > 30) {
          throw new Error("Invalid compact price");
        }

        price = Number(
          "0." + "0".repeat(zeros) + match[2]
        );

      } else {
        // Ordinary dollar notation:
        // 0.000005419

        price = Number(raw);
      }
    }
  }

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      "CoinSniper returned an invalid price"
    );
  }

  return price;
}

function extractAWTPrice(html: string): number {
  // Check the actual token address in the page
  // before accepting any market data.

  if (!html.includes(AWT_MINT)) {
    throw new Error(
      "CoinSniper response does not contain the AWT mint"
    );
  }

  const text = htmlToText(html);

  const valuePattern =
    String.raw`(?:0\.\s*\(\s*0x\d+\s*\)\s*\d+` +
    String.raw`|0\.\s*\^\{\s*\(\s*0x\d+\s*\)\s*\}\s*\d+` +
    String.raw`|0\.0_\{\d+\}\d+` +
    String.raw`|(?:0|[1-9]\d*)\.\d+(?:[eE][-+]?\d+)?` +
    String.raw`|[1-9]\d*(?:[eE][-+]?\d+)?)`;

  const patterns = [
    // Older CoinSniper page
    new RegExp(
      String.raw`Artworqq Token Project Price\s*\(USD\)\s*:\s*\$?\s*(` +
      valuePattern +
      ")",
      "i"
    ),

    // Market data section
    new RegExp(
      String.raw`Market Data\s+Price\s*:?\s*\$?\s*(` +
      valuePattern +
      ")",
      "i"
    ),

    // Newer price display
    new RegExp(
      String.raw`\bPrice\s*:?\s*\$\s*(` +
      valuePattern +
      ")",
      "i"
    )
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match) continue;

    const price = parsePrice(match[1]);

    if (price > 0) {
      return price;
    }
  }

  // Check JSON data embedded in the same page.
  // This allows the function to work when the
  // site provides price data in its HTML state.

  const jsonPricePatterns = [
    /"priceUsd"\s*:\s*"?(0\.\d+(?:[eE]-?\d+)?)"?/i,
    /"price_usd"\s*:\s*"?(0\.\d+(?:[eE]-?\d+)?)"?/i,
    /"usdPrice"\s*:\s*"?(0\.\d+(?:[eE]-?\d+)?)"?/i,
    /\\"priceUsd\\"\s*:\s*\\"?(0\.\d+(?:[eE]-?\d+)?)/i,
    /\\"price_usd\\"\s*:\s*\\"?(0\.\d+(?:[eE]-?\d+)?)/i
  ];

  for (const pattern of jsonPricePatterns) {
    const match = html.match(pattern);

    if (!match) continue;

    return parsePrice(match[1]);
  }

  throw new Error(
    "CoinSniper did not provide a numeric AWT price"
  );
}

async function fetchAWTPrice(): Promise<number> {
  const response = await fetch(COIN_URL, {
    method: "GET",
    headers: {
      "Accept": "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (compatible; StickerMania/1.0)"
    },
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(
      `CoinSniper HTTP ${response.status}`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    throw new Error(
      "CoinSniper did not return an HTML page"
    );
  }

  const html = await response.text();

  if (!html || html.length < 100) {
    throw new Error(
      "CoinSniper returned an empty page"
    );
  }

  return extractAWTPrice(html);
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  if (
    request.method !== "GET" &&
    request.method !== "POST"
  ) {
    return jsonResponse({
      success: false,
      error: "Method not allowed"
    }, 405);
  }

  try {
    const price = await fetchAWTPrice();

    return jsonResponse({
      success: true,
      token: "AWT",
      mint: AWT_MINT,
      priceUsd: price,
      source: COIN_URL,
      retrievedAt: new Date().toISOString()
    });

  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "[AWT PRICE LOOKUP FAILED]",
      message
    );

    return jsonResponse({
      success: false,
      token: "AWT",
      mint: AWT_MINT,
      source: COIN_URL,
      error: message
    }, 502);
  }
});
