
import { getSolPriceUsd } from "./_shared/sol-price.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(JSON.stringify({ error: "GET or POST required" }),
      { status: 405, headers: CORS });
  }
  try {
    const solUsd = await getSolPriceUsd();
    return new Response(JSON.stringify({
      success: true,
      symbol: "SOL",
      priceUsd: solUsd.toString(),
      fetchedAt: new Date().toISOString()
    }), { headers: CORS });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }), { status: 503, headers: CORS });
  }
});
