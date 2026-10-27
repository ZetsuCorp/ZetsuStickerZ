// Fresh mainnet blockhash for Phantom transaction signing.
// No wallet keys or user funds are handled by this endpoint.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

const RPC_URLS = [
  Deno.env.get("SOLANA_RPC_URL"),
  "https://solana-rpc.publicnode.com",
  "https://rpc.solanatracker.io/public",
  "https://api.mainnet.solana.com"
].filter((url): url is string => !!url);

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST required" }), {
      status: 405, headers: CORS
    });
  }
  let lastError = "No available RPC";
  for (const endpoint of RPC_URLS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getLatestBlockhash",
          params: [{ commitment: "confirmed" }]
        }),
        signal: AbortSignal.timeout(7000)
      });
      if (!response.ok) {
        lastError = "RPC HTTP " + response.status;
        continue;
      }
      const json = await response.json();
      const blockhash = json?.result?.value?.blockhash;
      const lastValidBlockHeight = json?.result?.value?.lastValidBlockHeight;
      if (typeof blockhash === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(blockhash) &&
          Number.isInteger(lastValidBlockHeight)) {
        return new Response(JSON.stringify({ blockhash, lastValidBlockHeight }), {
          status: 200, headers: CORS
        });
      }
      lastError = JSON.stringify(json?.error || "Missing latest blockhash");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  console.error("[SOLANA-BLOCKHASH] All RPC providers unavailable:", lastError);
  return new Response(JSON.stringify({ error: "SOL mainnet RPC unavailable: " + lastError }), {
    status: 503, headers: CORS
  });
});
