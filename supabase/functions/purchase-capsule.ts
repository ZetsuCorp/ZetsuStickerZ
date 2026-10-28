import { createClient } from "npm:@supabase/supabase-js@2";
import { Keypair } from "npm:@solana/web3.js@1.98.4";
import Decimal from "npm:decimal.js@10.4.3";
import { getSolPriceUsd } from "./_shared/sol-price.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const RECEIVER =
  "CT1fjjJMaNb2jgwH7rnuyiLcASmtmdRzSw7tQv8VXaRK";

const PRICES = {
  common: "0.05",
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

function calculateAmount(priceUsd: string, solUsd: Decimal) {
  const lamports = new Decimal(priceUsd).div(solUsd).mul(1_000_000_000).ceil();
  if (!lamports.isFinite() || lamports.lte(0)) throw new Error("Invalid SOL amount");
  return lamports.div(1_000_000_000).toFixed(9);
}

function solanaPay(
  amount: string,
  reference: string,
  tier: Tier
) {
  const params = new URLSearchParams({
    amount,
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
    const solUsd = await getSolPriceUsd();
    const solAmount = calculateAmount(priceUsd, solUsd);

    const reference =
      Keypair.generate().publicKey.toBase58();

    const expiresAt = new Date(
      Date.now() + 60 * 1000
    ).toISOString();

    // Store the pending purchase first.
    const { data: purchase, error } = await admin
      .from("capsule_purchases")
      .insert({
        player_id: user.id,
        capsule_id: null,
        tier: selectedTier,
        price_usd: priceUsd,
        sol_amount: solAmount,
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
      solUsd: solUsd.toString(),
      solAmount,
      receiver: RECEIVER,
      reference,
      paymentUrl: solanaPay(
        solAmount,
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
