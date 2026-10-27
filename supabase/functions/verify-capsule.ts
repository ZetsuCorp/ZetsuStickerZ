import { createClient } from "npm:@supabase/supabase-js@2";
import Decimal from "npm:decimal.js@10.4.3";
import bs58 from "npm:bs58@6";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const RPC_URL =
  Deno.env.get("SOLANA_RPC_URL") ||
  "https://api.mainnet-beta.solana.com";

const RECEIVER = "CT1fjjJMaNb2jgwH7rnuyiLcASmtmdRzSw7tQv8VXaRK";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
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

/* SOLANA RPC */

async function rpc(method: string, params: unknown[]) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      `Solana RPC HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(
      JSON.stringify(data.error)
    );
  }

  return data.result;
}

/* AUTHENTICATION */

async function authenticate(request: Request) {
  const header =
    request.headers.get("Authorization") || "";

  const token =
    header.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    throw new Error("Not signed in");
  }

  const { data, error } =
    await admin.auth.getUser(token);

  if (error || !data.user) {
    throw new Error("Invalid Discord session");
  }

  return data.user;
}

/* TRANSACTION ACCOUNTS */

function getAccounts(transaction: any): string[] {
  const message =
    transaction?.transaction?.message;

  const staticKeys =
    message?.accountKeys || [];

  const loaded =
    transaction?.meta?.loadedAddresses;

  return [
    ...staticKeys.map((key: any) =>
      typeof key === "string"
        ? key
        : String(key.pubkey)
    ),
    ...(loaded?.writable || []),
    ...(loaded?.readonly || [])
  ];
}

/* TRANSACTION INSTRUCTIONS */

function getAllInstructions(transaction: any): any[] {
  const outer =
    transaction?.transaction?.message
      ?.instructions || [];

  const inner =
    (transaction?.meta?.innerInstructions || [])
      .flatMap(
        (group: any) => group.instructions || []
      );

  return [...outer, ...inner];
}

/* DECODE NATIVE SOL TRANSFER */

function readUint64LE(bytes: Uint8Array): bigint {
  let amount = 0n;
  for (let i = 7; i >= 0; i--) amount = (amount << 8n) + BigInt(bytes[i]);
  return amount;
}

function verifyTransfer(transaction: any, purchase: any): boolean {
  if (!transaction?.meta || transaction.meta.err !== null ||
      typeof transaction.blockTime !== "number") return false;

  const createdAt = Date.parse(purchase.created_at);
  if (!Number.isFinite(createdAt) ||
      transaction.blockTime < Math.floor(createdAt / 1000) - 120) return false;

  const accounts = getAccounts(transaction);
  const reference = purchase.payment_reference;
  const receiverIndex = accounts.indexOf(RECEIVER);
  if (typeof reference !== "string" || !accounts.includes(reference) ||
      receiverIndex < 0) return false;

  const quoted = new Decimal(String(purchase.sol_amount)).mul(1_000_000_000);
  if (!quoted.isFinite() || !quoted.isInteger() || quoted.lte(0)) return false;
  const expected = BigInt(quoted.toFixed(0));

  const before = transaction.meta.preBalances?.[receiverIndex];
  const after = transaction.meta.postBalances?.[receiverIndex];
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) ||
      BigInt(after) - BigInt(before) < expected) return false;

  // Require the read-only Solana Pay reference on the SOL transfer itself.
  let sum = 0n;
  for (const instruction of getAllInstructions(transaction)) {
    if (accounts[instruction.programIdIndex] !== SYSTEM_PROGRAM ||
        typeof instruction.data !== "string" ||
        !Array.isArray(instruction.accounts) ||
        instruction.accounts.length < 2) continue;

    let bytes: Uint8Array;
    try { bytes = bs58.decode(instruction.data); } catch { continue; }
    if (bytes.length !== 12 || bytes[0] !== 2 ||
        bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 0) continue;

    // Solana Pay requires the unique reference on the transfer instruction.
    const keys = instruction.accounts.map((i: number) => accounts[i]);
    if (keys[1] === RECEIVER && keys.includes(reference)) {
      sum += readUint64LE(bytes.subarray(4, 12));
    }
  }
  return sum >= expected;
}

/* RETURN EXISTING REWARD */

async function getRecordedPurchase(
  purchase: any,
  purchaseId: string
) {
  const { data: capsule, error } =
    await admin
      .from("capsules")
      .select("*")
      .eq("id", purchase.capsule_id)
      .single();

  if (error) {
    throw new Error(error.message);
  }

  return {
    status: purchase.status,
    purchaseId,
    capsule
  };
}

/* VERIFY CAPSULE EDGE FUNCTION */

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS
    });
  }

  if (request.method !== "POST") {
    return output({
      error: "POST required"
    }, 405);
  }

  try {
    /* AUTHENTICATE */

    const user =
      await authenticate(request);

    const body =
      await request.json();

    const purchaseId =
      body?.purchaseId;

    if (
      typeof purchaseId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(purchaseId)
    ) {
      return output({
        error: "Invalid purchase ID"
      }, 400);
    }

    /* FIND PURCHASE */

    const { data: purchase, error } =
      await admin
        .from("capsule_purchases")
        .select("*")
        .eq("id", purchaseId)
        .eq("player_id", user.id)
        .single();

    if (error || !purchase) {
      return output({
        error: "Purchase not found"
      }, 404);
    }

    /* ALREADY COMPLETED */

    if (
      purchase.status === "paid" ||
      purchase.status === "fulfilled"
    ) {
      return output(
        await getRecordedPurchase(
          purchase,
          purchaseId
        )
      );
    }

    /* OTHER STATUS */

    if (purchase.status !== "pending") {
      return output({
        status: purchase.status,
        purchaseId
      });
    }

    /* FIND TRANSACTIONS BY REFERENCE */

    const signatures = await rpc(
      "getSignaturesForAddress",
      [
        purchase.payment_reference,
        {
          limit: 100,
          commitment: "finalized"
        }
      ]
    );

    for (const entry of signatures || []) {
      if (
        entry.err ||
        typeof entry.signature !== "string"
      ) {
        continue;
      }

      /*
        Retrieve raw transaction instructions.

        This allows inspection of:
        - Native SOL transfer
        - Receiving wallet
        - Lamports transferred
        - Payment reference
      */

      const transaction = await rpc(
        "getTransaction",
        [
          entry.signature,
          {
            encoding: "json",
            commitment: "finalized",
            maxSupportedTransactionVersion: 0
          }
        ]
      );

      if (!transaction) {
        continue;
      }

      if (
        !verifyTransfer(
          transaction,
          purchase
        )
      ) {
        continue;
      }

      /*
        Payment is verified.

        Record payment and select reward
        using the existing SQL function.
      */

      const {
        data: result,
        error: completeError
      } = await admin.rpc(
        "complete_capsule_purchase",
        {
          p_purchase_id: purchaseId,
          p_signature: entry.signature
        }
      );

      if (completeError) {
        throw new Error(
          completeError.message
        );
      }

      return output({
        ...result,
        purchaseId,
        paymentSignature: entry.signature
      });
    }

    /* STILL PENDING */

    return output({
      status: "pending",
      purchaseId,
      message:
        "Waiting for Solana payment confirmation"
    });

  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "[VERIFY-CAPSULE]",
      message
    );

    return output({
      error: message
    }, 500);
  }
});
