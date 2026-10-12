import { createClient } from "npm:@supabase/supabase-js@2";
import Decimal from "npm:decimal.js@10.4.3";
import bs58 from "npm:bs58@6";

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

/* DECODE SPL TOKEN AMOUNT */

function readUint64LE(bytes: Uint8Array): bigint {
  let amount = 0n;

  for (let i = 7; i >= 0; i--) {
    amount =
      (amount << 8n) +
      BigInt(bytes[i]);
  }

  return amount;
}

function decodeTransfer(
  instruction: any,
  accounts: string[]
) {
  const programId =
    accounts[instruction.programIdIndex];

  if (!TOKEN_PROGRAMS.has(programId)) {
    return null;
  }

  if (
    typeof instruction.data !== "string" ||
    !Array.isArray(instruction.accounts)
  ) {
    return null;
  }

  const bytes = bs58.decode(instruction.data);

  if (bytes.length < 9) {
    return null;
  }

  const type = bytes[0];

  /*
    SPL Token instruction 3:
    Transfer

    Accounts:
    0 = Source
    1 = Destination
    2 = Authority
  */

  if (type === 3) {
    if (instruction.accounts.length < 3) {
      return null;
    }

    return {
      destination:
        accounts[instruction.accounts[1]],

      amount: readUint64LE(
        bytes.subarray(1, 9)
      ),

      mint: null,

      accounts: instruction.accounts.map(
        (index: number) => accounts[index]
      )
    };
  }

  /*
    SPL Token instruction 12:
    TransferChecked

    Accounts:
    0 = Source
    1 = Mint
    2 = Destination
    3 = Authority
  */

  if (type === 12) {
    if (
      bytes.length < 10 ||
      instruction.accounts.length < 4
    ) {
      return null;
    }

    return {
      destination:
        accounts[instruction.accounts[2]],

      amount: readUint64LE(
        bytes.subarray(1, 9)
      ),

      mint:
        accounts[instruction.accounts[1]],

      accounts: instruction.accounts.map(
        (index: number) => accounts[index]
      )
    };
  }

  return null;
}

/* VERIFY ACTUAL AWT PAYMENT */

function verifyTransfer(
  transaction: any,
  purchase: any
): boolean {
  if (
    !transaction?.meta ||
    transaction.meta.err !== null
  ) {
    return false;
  }

  if (
    typeof transaction.blockTime !== "number"
  ) {
    return false;
  }

  /*
    Transaction must be associated
    with this purchase's creation time.
  */

  const createdAt =
    new Date(purchase.created_at).getTime();

  if (!Number.isFinite(createdAt)) {
    return false;
  }

  const earliest =
    Math.floor(createdAt / 1000) - 120;

  if (transaction.blockTime < earliest) {
    return false;
  }

  const accounts = getAccounts(transaction);

  const reference =
    purchase.payment_reference;

  if (
    typeof reference !== "string" ||
    !accounts.includes(reference)
  ) {
    return false;
  }

  const preBalances =
    transaction.meta.preTokenBalances || [];

  const postBalances =
    transaction.meta.postTokenBalances || [];

  const instructions =
    getAllInstructions(transaction);

  const expected =
    new Decimal(String(purchase.awt_amount));

  if (
    !expected.isFinite() ||
    expected.lte(0)
  ) {
    return false;
  }

  /*
    Inspect receiving token accounts.

    Require:
    - Correct AWT mint
    - Correct receiver
    - Sufficient balance increase
    - Actual SPL token transfer
    - Correct payment reference
    - Sufficient amount sent
  */

  for (const balance of postBalances) {
    if (
      balance.mint !== MINT ||
      balance.owner !== RECEIVER
    ) {
      continue;
    }

    const destination =
      accounts[balance.accountIndex];

    if (!destination) {
      continue;
    }

    const decimals =
      balance.uiTokenAmount?.decimals;

    if (
      !Number.isInteger(decimals) ||
      decimals < 0
    ) {
      continue;
    }

    const expectedDecimal = expected.mul(
      new Decimal(10).pow(decimals)
    );

    if (
      !expectedDecimal.isFinite() ||
      !expectedDecimal.isInteger()
    ) {
      continue;
    }

    const expectedRaw = BigInt(
      expectedDecimal.toFixed(0)
    );

    if (expectedRaw <= 0n) {
      continue;
    }

    const before = preBalances.find(
      (entry: any) =>
        entry.accountIndex === balance.accountIndex &&
        entry.mint === MINT
    );

    const afterRaw = BigInt(
      balance.uiTokenAmount.amount
    );

    const beforeRaw = BigInt(
      before?.uiTokenAmount?.amount || "0"
    );

    const receivedRaw =
      afterRaw - beforeRaw;

    if (receivedRaw < expectedRaw) {
      continue;
    }

    /*
      Decode the transfer instructions.

      The reference must be attached
      to the actual token transfer.

      Merely appearing somewhere in
      the transaction is insufficient.
    */

    let transferredRaw = 0n;

    for (const instruction of instructions) {
      const transfer = decodeTransfer(
        instruction,
        accounts
      );

      if (!transfer) {
        continue;
      }

      if (
        transfer.destination !== destination
      ) {
        continue;
      }

      if (
        transfer.mint !== null &&
        transfer.mint !== MINT
      ) {
        continue;
      }

      if (
        !transfer.accounts.includes(reference)
      ) {
        continue;
      }

      transferredRaw += transfer.amount;
    }

    if (transferredRaw >= expectedRaw) {
      return true;
    }
  }

  return false;
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
        - SPL token program
        - Destination token account
        - Transfer amount
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
