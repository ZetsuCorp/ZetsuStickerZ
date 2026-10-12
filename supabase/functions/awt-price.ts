const AWT_MINT =
  "ETvGFek4eDeHP7iC7yceGpduTRypHpsUT6tybwMXpump";

const COIN_URL =
  "https://coinsniper.net/coin/72966";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods":
    "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function output(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS
  });
}

/* HTML TEXT */

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&dollar;/gi, "$")
    .replace(/&amp;/gi, "&")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const hex = code.toLowerCase().startsWith("x");

      const value = parseInt(
        hex ? code.slice(1) : code,
        hex ? 16 : 10
      );

      return Number.isFinite(value) &&
        value >= 0 &&
        value <= 0x10ffff
        ? String.fromCodePoint(value)
        : "";
    });
}

const SUBSCRIPT_DIGITS: Record<string, string> = {
  "₀": "0",
  "₁": "1",
  "₂": "2",
  "₃": "3",
  "₄": "4",
  "₅": "5",
  "₆": "6",
  "₇": "7",
  "₈": "8",
  "₉": "9"
};

function normalizePriceText(input: string): string {
  return decodeEntities(input)
    .replace(/[₀-₉]+/g, digits => {
      const count = [...digits]
        .map(digit => SUBSCRIPT_DIGITS[digit])
        .join("");

      return `_{${count}}`;
    })
    .normalize("NFKC");
}

/* COINSNIPER PRICE FORMAT */

function parsePublishedPrice(input: string): number | null {
  let value = normalizePriceText(input)
    .replace(/[\s\u200B-\u200D\uFEFF$,]/g, "");

  /*
    CoinSniper compact price examples:

    0.^ {(0x5)}5419
    0.⁽⁰ˣ⁵⁾5419
    0.0_{5}5419

    All represent:

    0.000005419
  */

  const compact =
    value.match(
      /^0\.(?:\^)?\{?\(?0[x×](\d+)\)?\}?(\d+)$/i
    ) ||
    value.match(
      /^0\.0_\{(\d+)\}(\d+)$/
    );

  if (compact) {
    const zeroCount = Number(compact[1]);
    const digits = compact[2];

    if (
      !Number.isInteger(zeroCount) ||
      zeroCount < 0 ||
      zeroCount > 30
    ) {
      return null;
    }

    value =
      "0." +
      "0".repeat(zeroCount) +
      digits;
  }

  if (
    !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
  ) {
    return null;
  }

  const price = Number(value);

  return Number.isFinite(price) && price > 0
    ? price
    : null;
}

/* READ THE PUBLISHED PRICE ON COINSNIPER */

function readPriceFromHTML(html: string): number | null {
  if (!html.includes("Artworqq Token Project")) {
    throw new Error("Incorrect CoinSniper listing");
  }

  /*
    Read the visible page.

    CoinSniper may render the price across
    multiple HTML elements or use Unicode
    superscript characters.
  */

  const text = normalizePriceText(
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
        /<!--[\s\S]*?-->/g,
        " "
      )
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ");

  const PRICE_PATTERN = String.raw`(0\s*\.\s*(?:\^\s*)?\{?\s*\(?\s*0\s*[x×]\s*\d+\s*\)?\s*\}?\s*\d+|0\s*\.\s*0\s*_\s*\{\s*\d+\s*\}\s*\d+|\d+(?:\s*\.\s*\d+)?(?:[eE][+-]?\d+)?)`;

  const labels = [
    String.raw`Artworqq\s+Token\s+Project\s+Price\s*\(USD\)\s*:?\s*`,
    String.raw`Market\s+Data\s+Price\s*:?\s*`,
    String.raw`\bPrice\s*:?\s*`
  ];

  for (const label of labels) {
    const pattern = new RegExp(
      label + String.raw`\$?\s*` + PRICE_PATTERN,
      "i"
    );

    const match = text.match(pattern);

    if (!match) {
      continue;
    }

    const price = parsePublishedPrice(match[1]);

    if (price !== null) {
      return price;
    }
  }

  /*
    Check price data embedded in the same page.
    This is still CoinSniper, not another source.
  */

  const normalizedHTML = normalizePriceText(html);

  const jsonKeys = [
    "priceUsd",
    "price_usd",
    "usdPrice",
    "priceUSD"
  ];

  for (const key of jsonKeys) {
    const
