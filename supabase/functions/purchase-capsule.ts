import { createClient } from "npm:@supabase/supabase-js@2";
import { Keypair } from "npm:@solana/web3.js@1.98.4";
import Decimal from "npm:decimal.js@10.4.3";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const RPC_URL =
  Deno.env.get("SOLANA_RPC_URL") ||
  "https://api.mainnet-beta.solana.com";

const MINT =
  "ETvGFek4eDeHP7iC7yceGpduTRypHpsUT6tybwMXpump";

const RECEIVER =
  "CT1fjjJMaNb2jgwH7rnuyiLcASmtmdRzSw7tQv8VXaRK";

const PRICES = {
  common: "0.50",
  rare: "1.00",
  legendary: "3.00"
} as const;

type Tier = keyof typeof PRICES;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const admin = createClient(URL, SERVICE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function output(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS
  });
}

async function authenticate(request: Request) {
  const header = request.headers.get("Authorization") || "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) throw new Error("Sign in with Discord");

  const { data, error } = await admin.auth.getUser(token);

  if (error || !data.user) {
    throw new Error("Invalid Discord session");
  }

  return data.user;
}

async function rpc(method: string, params: unknown[]) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    }),
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Solana RPC HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(JSON.stringify(data.error));
  }

  return data.result;
}

async function getDecimals() {
  const result = await rpc("getTokenSupply", [
    MINT,
    { commitment: "confirmed" }
  ]);

  const decimals = result?.value?.decimals;

  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 9
  ) {
    throw new Error("Could not read AWT decimals");
  }

  return decimals as number;
}

async function getAWTPrice() {
  const response = await fetch(
    `${URL}/functions/v1/awt-price`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
      },
      body: JSON.stringify({ mint: MINT }),
      signal: AbortSignal.timeout(16000)
    }
  );

  const data = await response.json();

  if (!response.ok || data.success !== true) {
    throw new Error(
      "Price lookup: " +
      String(data.error || `HTTP ${response.status}`)
    );
  }

  if (data.mint !== MINT) {
    throw new Error("Incorrect AWT mint");
  }

  const price = new Decimal(String(data.priceUsd));

  if (!price.isFinite() || price.lte(0)) {
    throw new Error("Invalid published AWT price");
  }

  return price;
}

function calculateAmount(
  priceUsd: string,
  awtUsd: Decimal,
  decimals: number
) {
  const factor = new Decimal(10).pow(decimals);

  return new Decimal(priceUsd)
    .div(awtUsd)
    .mul(factor)
    .ceil()
    .div(factor)
    .toFixed(decimals);
}

function solanaPay(
  amount: string,
  reference: string,
  tier: Tier
) {
  const params = new URLSearchParams({
    amount,
    "spl-token": MINT,
    reference,
    label: "Sticker Mania",
    message: `${tier.toUpperCase()} Capsule`
  });

  return `solana:${RECEIVER}?${params.toString()}`;
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS
    });
  }

  if (request.method !== "POST") {
    return output({ error: "POST required" }, 405);
  }

  try {
    const user = await authenticate(request);

    const body = await request.json();
    const tier = body?.tier;

    if (
      typeof tier !== "string" ||
      !Object.prototype.hasOwnProperty.call(PRICES, tier)
    ) {
      return output({ error: "Invalid capsule tier" }, 400);
    }

    const selectedTier = tier as Tier;

    // Make sure rewards exist before taking payment.
    const { data: rewards, error: rewardError } = await admin
      .from("capsules")
      .select("id")
      .eq("tier", selectedTier)
      .eq("active", true)
      .limit(1);

    if (rewardError) throw rewardError;

    if (!rewards?.length) {
      return output({
        error: "No active rewards for this capsule tier"
      }, 409);
    }

    const priceUsd = PRICES[selectedTier];
    const awtUsd = await getAWTPrice();
    const decimals = await getDecimals();

    const awtAmount = calculateAmount(
      priceUsd,
      awtUsd,
      decimals
    );

    const reference =
      Keypair.generate().publicKey.toBase58();

    const expiresAt = new Date(
      Date.now() + 20 * 60 * 1000
    ).toISOString();

    // Store the pending purchase first.
    const { data: purchase, error } = await admin
      .from("capsule_purchases")
      .insert({
        player_id: user.id,
        capsule_id: null,
        tier: selectedTier,
        price_usd: priceUsd,
        awt_amount: awtAmount,
        payment_reference: reference,
        status: "pending",
        expires_at: expiresAt
      })
      .select("id")
      .single();

    if (error || !purchase) {
      throw new Error(
        "Purchase insert failed: " +
        (error?.message || "Unknown database error")
      );
    }

    return output({
      success: true,
      purchaseId: purchase.id,
      tier: selectedTier,
      priceUsd: Number(priceUsd),
      awtUsd: awtUsd.toString(),
      awtAmount,
      mint: MINT,
      receiver: RECEIVER,
      reference,
      paymentUrl: solanaPay(
        awtAmount,
        reference,
        selectedTier
      ),
      expiresAt
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.error("[PURCHASE-CAPSULE]", message);

    return output({
      success: false,
      error: message
    }, 500);
  }
});
