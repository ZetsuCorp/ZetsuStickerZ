
import { createClient } from "npm:@supabase/supabase-js@2";
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

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFmyXzM7o4LPN4KC"
]);

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
    signal: AbortSignal.timeout(15000)
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

async function authenticate(request: Request) {
  const header = request.headers.get("Authorization") || "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) throw new Error("Not signed in");

  const { data, error } = await admin.auth.getUser(token);

  if (error || !data.user) {
    throw new Error("Invalid Discord session");
  }

  return data.user;
}

function accountAddress(key: any): string {
  return typeof key === "string"
    ? key
    : String(key.pubkey);
}

function getAllInstructions(transaction: any): any[] {
  const outer = transaction.transaction.message.instructions || [];
  const inner = (transaction.meta.innerInstructions || [])
    .flatMap((group: any) => group.instructions || []);

  return [...outer, ...inner];
}

function verifyTransfer(
  transaction: any,
  purchase: any
): boolean {
  if (!transaction?.meta || transaction.meta.err !== null) {
    return false;
  }

  if (transaction.blockTime === null) {
    return false;
  }

  // The payment must occur after purchase creation.
  const earliest = Math.floor(
    new Date(purchase.created_at).getTime() / 1000
  ) - 120;

  if (transaction.blockTime < earliest) {
    return false;
  }

  const accounts = transaction.transaction.message.accountKeys
    .map(accountAddress);

  if (!accounts.includes(purchase.payment_reference)) {
    return false;
  }

  const pre = transaction.meta.preTokenBalances || [];
  const post = transaction.meta.postTokenBalances || [];

  const instructions = getAllInstructions(transaction);

  const expected = new Decimal(
    String(purchase.awt_amount)
  );

  // Check destination accounts owned by the receiver.
  for (const balance of post) {
    if (
      balance.mint !== MINT ||
      balance.owner !== RECEIVER
    ) {
      continue;
    }

    const destination = accounts[balance.accountIndex];

    if (!destination) continue;

    const before = pre.find(
      (entry: any) =>
        entry.accountIndex === balance.accountIndex &&
        entry.mint === MINT
    );

    const decimals = balance.uiTokenAmount.decimals;

    const expectedRaw = BigInt(
      expected.mul(
        new Decimal(10).pow(decimals)
      ).toFixed(0)
    );

    const afterRaw = BigInt(
      balance.uiTokenAmount.amount
    );

    const beforeRaw = BigInt(
      before?.uiTokenAmount?.amount || "0"
    );

    if (afterRaw - beforeRaw < expectedRaw) {
      continue;
    }

    // Confirm that a SPL-token transfer instruction
    // actually sent tokens into that destination.
    const transferFound = instructions.some((instruction: any) => {
      if (!TOKEN_PROGRAMS.has(
        String(instruction.programId || "")
      )) {
        return false;
      }

      const parsed = instruction.parsed;

      if (!parsed) return false;

      if (
        parsed.type !== "transfer" &&
        parsed.type !== "transferChecked"
      ) {
        return false;
      }

      const info = parsed.info || {};

      if (info.destination !== destination) {
        return false;
      }

      if (info.mint && info.mint !== MINT) {
        return false;
      }

      return true;
    });

    if (transferFound) {
      return true;
    }
  }

  return false;
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

    const purchaseId = body?.purchaseId;

    if (
      typeof purchaseId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(purchaseId)
    ) {
      return output({ error: "Invalid purchase ID" }, 400);
    }

    const { data: purchase, error } = await admin
      .from("capsule_purchases")
      .select("*")
      .eq("id", purchaseId)
      .eq("player_id", user.id)
      .single();

    if (error || !purchase) {
      return output({ error: "Purchase not found" }, 404);
    }

    // Return already recorded rewards.
    if (
      purchase.status === "paid" ||
      purchase.status === "fulfilled"
    ) {
      const { data: capsule } = await admin
        .from("capsules")
        .select("*")
        .eq("id", purchase.capsule_id)
        .single();

      return output({
        status: purchase.status,
        purchaseId,
        capsule
      });
    }

    if (purchase.status !== "pending") {
      return output({
        status: purchase.status,
        purchaseId
      });
    }

    // Find transactions mentioning the unique reference.
    const signatures = await rpc("getSignaturesForAddress", [
      purchase.payment_reference,
      {
        limit: 30,
        commitment: "finalized"
      }
    ]);

    for (const entry of signatures || []) {
      if (entry.err) continue;

      const transaction = await rpc("getParsedTransaction", [
        entry.signature,
        {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0
        }
      ]);

      if (!transaction) continue;

      if (!verifyTransfer(transaction, purchase)) {
        continue;
      }

      // Record payment + select reward atomically in SQL.
      const { data: result, error: completeError } =
        await admin.rpc("complete_capsule_purchase", {
          p_purchase_id: purchaseId,
          p_signature: entry.signature
        });

      if (completeError) {
        throw new Error(completeError.message);
      }

      return output({
        ...result,
        purchaseId,
        paymentSignature: entry.signature
      });
    }

    return output({
      status: "pending",
      purchaseId,
      message: "Waiting for Solana payment confirmation"
    });

  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.error("[VERIFY-CAPSULE]", message);

    return output({
      error: message
    }, 500);
  }
});
