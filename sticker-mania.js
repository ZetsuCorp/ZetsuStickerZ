
/* CONFIGURATION */

// Discord Activities route Supabase requests through the registered URL mapping.
const SUPABASE_URL = window.location.hostname.endsWith(".discordsays.com")
  ? window.location.origin + "/discord-supabase"
  : "https://jqvnrdjrkdjgjbmqmbbl.supabase.co";

const SUPABASE_KEY =
  "sb_publishable_jmEahTk4OssD_IrOZq_6iQ_P6QFFJr6";

const RECEIVER =
  "CT1fjjJMaNb2jgwH7rnuyiLcASmtmdRzSw7tQv8VXaRK";

const CAPSULE_PRICES = {
  common: 0.05,
  rare: 1.00,
  legendary: 3.00
};

const ACCOUNT_URL =
  new URL("account.html", window.location.href).href;

const PRICE_REFRESH_MS = 60000;
const PAYMENT_CHECK_MS = 2000;

const client = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

const $ = id => document.getElementById(id);

/* STATE */

let currentUser = null;
let activePurchase = null;

let paymentTimer = null;
let purchasing = false;
let checkingPayment = false;

/* ELEMENTS */

const priceMain = $("sol-price-main");
const pricePurchase = $("sol-price-purchase");

const payButton = $("pay-button");
const signinButton = $("signin-button");

const collectionAvatar = $("collection-avatar");

const purchaseOverlay = $("purchase-overlay");
const purchaseClose = $("purchase-close");
const purchaseStatus = $("purchase-status");

const dispenser = $("dispenser-container");

/* Shared app audio preference; all app sounds can use this setting. */
const volumeToggle = $("app-volume-toggle");
const volumeLevel = $("app-volume-level");
const volumeVideo = $("sticker-video");
const SOUND_PREF = "sticker_mania_volume";

let appVolume = 0.8;
let appMuted = false;
try {
  const saved = JSON.parse(localStorage.getItem(SOUND_PREF) || "null");
  if (saved && Number.isFinite(saved.volume)) {
    appVolume = Math.max(0, Math.min(1, saved.volume));
    appMuted = !!saved.muted;
  }
} catch (error) {
  console.warn("[AUDIO PREFERENCE]", error);
}
function applyAppVolume() {
  volumeVideo.volume = appVolume;
  volumeVideo.muted = appMuted || appVolume === 0;
  volumeLevel.value = String(Math.round(appVolume * 100));
  const muted = volumeVideo.muted;
  volumeToggle.textContent = muted ? "🔇" : "🔊";
  volumeToggle.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
  volumeToggle.title = muted ? "Unmute sound" : "Mute sound";
  volumeToggle.setAttribute("aria-pressed", String(muted));
  try {
    localStorage.setItem(SOUND_PREF, JSON.stringify({
      volume: appVolume, muted: appMuted
    }));
  } catch (error) {
    console.warn("[AUDIO PREFERENCE]", error);
  }
}
volumeToggle.onclick = () => {
  if (appMuted || appVolume === 0) {
    if (appVolume === 0) appVolume = 0.8;
    appMuted = false;
  } else {
    appMuted = true;
  }
  applyAppVolume();
};
volumeLevel.oninput = () => {
  appVolume = Number(volumeLevel.value) / 100;
  appMuted = appVolume === 0;
  applyAppVolume();
};
applyAppVolume();

const authOverlay = $("auth-overlay");
const authButton = $("discord-auth");
const authStatus = $("auth-status");

const tierButtons = [
  ...document.querySelectorAll("[data-tier]")
];

/* FUNCTION ERROR DETAILS */

async function functionError(error) {
  let message = error?.message || "Unknown error";

  if (error?.context instanceof Response) {
    const response = error.context;

    try {
      const text = await response.clone().text();

      try {
        const json = JSON.parse(text);

        message =
          json.error ||
          json.message ||
          JSON.stringify(json);

      } catch {
        message = text || message;
      }

    } catch {}

    return `HTTP ${response.status}: ${message}`;
  }

  return message;
}

/* LIVE SOL/USD PRICE: PUBLIC MARKET DATA, NO SUPABASE FUNCTION */

let lastSOLPrice = null;
let solPriceUpdating = false;

function formatPrice(price) {
  return "$" + Number(price).toFixed(2);
}

async function refreshSOLPrice() {
  // Discord-only diagnosis: show the first failed source in the existing price label.
  const diagnosingDiscord = !!window.StickerDiscord?.isActivity;
  let firstFailure = "";
  const feeds = [
    {
      url: window.StickerDiscord?.isActivity
        ? "/sol-price-feed/v2/prices/SOL-USD/spot"
        : "https://api.coinbase.com/v2/prices/SOL-USD/spot",
      get: json => json?.data?.amount
    },
    {
      url: "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
      get: json => Object.values(json?.result || {})[0]?.c?.[0]
    },
    {
      url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      get: json => json?.solana?.usd
    }
  ];

  for (const feed of feeds) {
    try {
      const response = await fetch(feed.url, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) {
        if (diagnosingDiscord && !firstFailure) firstFailure = "HTTP " + response.status;
        continue;
      }

      const price = Number(feed.get(await response.json()));
      if (!Number.isFinite(price) || price <= 0) {
        if (diagnosingDiscord && !firstFailure) firstFailure = "DATA";
        continue;
      }

      lastSOLPrice = price;
      const label = "SOL " + formatPrice(price);
      priceMain.textContent = label;
      pricePurchase.textContent = label;
      return;
    } catch (error) {
      console.warn("[SOL PRICE] Market feed unavailable:", feed.url, error);
      if (diagnosingDiscord && !firstFailure) {
        firstFailure = error instanceof SyntaxError ? "PARSE" :
          error?.name === "AbortError" || error?.name === "TimeoutError" ? "TIMEOUT" :
          error instanceof TypeError ? "NETWORK" : "REQUEST";
      }
    }
  }

  // Preserve the last valid quote if all price feeds temporarily fail.
  const label = lastSOLPrice === null
    ? (diagnosingDiscord ? "SOL ERR " + (firstFailure || "UNKNOWN") : "SOL PRICE UNAVAILABLE")
    : "SOL " + formatPrice(lastSOLPrice) + " (LAST)";
  priceMain.textContent = label;
  pricePurchase.textContent = label;
}

function updateSOLPrice() {
  if (document.hidden || solPriceUpdating) return;
  solPriceUpdating = true;
  void refreshSOLPrice().finally(() => { solPriceUpdating = false; });
}

/* DISCORD USER INFORMATION */

function discordName(user) {
  return (
    user?.user_metadata?.global_name ||
    user?.user_metadata?.preferred_username ||
    user?.user_metadata?.user_name ||
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    "Discord User"
  );
}

function discordId(user) {
  const identity = user?.identities?.find(
    identity => identity.provider === "discord"
  );

  return (
    identity?.id ||
    identity?.identity_data?.provider_id ||
    user?.user_metadata?.provider_id ||
    null
  );
}

/* LOGIN DISPLAY */

function updateLoginDisplay() {
  const signedIn = !!currentUser;

  signinButton.classList.toggle(
    "signed-in",
    signedIn
  );

  const avatar =
    currentUser?.user_metadata?.avatar_url;

  if (signedIn && avatar) {
    collectionAvatar.src = avatar;
    collectionAvatar.style.display = "block";
  } else {
    collectionAvatar.removeAttribute("src");
    collectionAvatar.style.display = "none";
  }
}

/* ACCOUNT SYNC */

async function syncAccount(user) {
  if (!user) return;

  const { error } = await client
    .from("sticker_accounts")
    .upsert(
      {
        id: user.id,
        discord_id: discordId(user),
        username: discordName(user),
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "id"
      }
    );

  if (error) {
    console.error("[ACCOUNT SYNC]", error.message);
  }
}

/* DISCORD AUTHENTICATION */

function openAuth() {
  authStatus.textContent = "";
  authOverlay.classList.add("open");
}

function closeAuth() {
  authOverlay.classList.remove("open");
}

authButton.onclick = async () => {
  authButton.disabled = true;
  authStatus.textContent = "";

  try {
    const { error } =
      await client.auth.signInWithOAuth({
        provider: "discord",
        options: {
          redirectTo: ACCOUNT_URL,
          scopes: "identify"
        }
      });

    if (error) {
      throw error;
    }
  } catch (error) {
    authStatus.textContent = error.message;
  } finally {
    authButton.disabled = false;
  }
};

signinButton.onclick = () => {
  if (!currentUser) {
    openAuth();
    return;
  }

  window.location.href = ACCOUNT_URL;
};

$("auth-close").onclick = closeAuth;

authOverlay.onclick = event => {
  if (event.target === authOverlay) {
    closeAuth();
  }
};

client.auth.onAuthStateChange(
  (event, session) => {
    currentUser = session?.user || null;

    updateLoginDisplay();

    if (event === "SIGNED_IN" && currentUser) {
      const user = currentUser;

      setTimeout(() => {
        void syncAccount(user);
        resumePendingPayment();
      }, 0);
    }
  }
);

async function restoreUser() {
  const { data, error } =
    await client.auth.getUser();

  if (error) {
    console.error("[SESSION]", error.message);
  }

  currentUser = data?.user || null;

  updateLoginDisplay();
  resumePendingPayment();
}

void restoreUser();

// Discord Activity: sign into the matching existing account at startup.
if (window.StickerDiscord?.isActivity) {
  void window.StickerDiscord.authorizePlayer()
    .then(async ({ player, linked, loginProof }) => {
      if (!linked || !loginProof) {
        authStatus.textContent = "Discord connected. Link your Sticker Mania account to continue.";
        return;
      }
      const { data, error } = await client.auth.verifyOtp({
        token_hash: loginProof,
        type: "magiclink"
      });
      if (error || !data?.user) throw error || new Error("Account session unavailable");
      if (discordId(data.user) !== player.id) {
        await client.auth.signOut();
        throw new Error("Discord account does not match Sticker Mania account");
      }
      currentUser = data.user;
      updateLoginDisplay();
      closeAuth();
    })
    .catch(error => {
      console.warn("[STICKERZ DISCORD AUTH]", error);
      authStatus.textContent = "Discord login failed: " + error.message;
    });
}

/* AUTHENTICATED EDGE FUNCTIONS */

async function invoke(name, body) {
  const {
    data: sessionData,
    error: sessionError
  } = await client.auth.getSession();

  if (sessionError) {
    throw sessionError;
  }

  const token = sessionData.session?.access_token;

  if (!token) {
    throw new Error("Sign in with Discord");
  }

  const { data, error } =
    await client.functions.invoke(
      name,
      {
        method: "POST",
        body,
        headers: {
          Authorization: "Bearer " + token
        }
      }
    );

  if (error) {
    const detail = await functionError(error);
    if (error.name === "FunctionsFetchError" ||
        /Failed to send a request to the Edge Function/i.test(detail)) {
      throw new Error(
        "Payment server unavailable (" + name +
        "). Its Supabase Edge Function must be deployed."
      );
    }
    throw new Error(detail);
  }

  if (!data || data.error) {
    throw new Error(
      data?.error || "Invalid function response"
    );
  }

  return data;
}

/* PENDING TRANSACTION */

function pendingKey() {
  return (
    "sticker_mania_pending_" +
    (currentUser?.id || "anonymous")
  );
}

// Each payment keeps its own reference; previous attempts must never block
// a new purchase or get overwritten before their reward is recovered.
function readPending() {
  try {
    const raw = JSON.parse(localStorage.getItem(pendingKey()) || "[]");
    const list = Array.isArray(raw) ? raw : [raw]; // legacy single-payment record
    return list.filter(p => p && typeof p.purchaseId === "string");
  } catch (error) {
    console.error("[PENDING PURCHASE]", error);
    return [];
  }
}

function savePending(purchase) {
  try {
    const list = readPending().filter(p => p.purchaseId !== purchase.purchaseId);
    list.push(purchase);
    localStorage.setItem(pendingKey(), JSON.stringify(list.slice(-20)));
  } catch (error) {
    console.error("[PENDING PURCHASE]", error);
  }
}

function clearPending(purchaseId) {
  try {
    const list = readPending().filter(p => p.purchaseId !== purchaseId);
    if (list.length) localStorage.setItem(pendingKey(), JSON.stringify(list));
    else localStorage.removeItem(pendingKey());
  } catch (error) {
    console.error("[PENDING PURCHASE]", error);
  }
}

/* PURCHASE VALIDATION */

function validatePurchase(data, tier) {
  if (
    !data ||
    !data.purchaseId ||
    !data.reference ||
    !data.paymentUrl ||
    data.receiver !== RECEIVER
  ) {
    throw new Error("Incomplete purchase response");
  }

  if (
    Number(data.priceUsd) !==
    CAPSULE_PRICES[tier]
  ) {
    throw new Error("Incorrect capsule price");
  }

  const amount = Number(data.solAmount);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error("Invalid SOL payment amount");
  }

  const url = new URL(data.paymentUrl);

  if (
    url.protocol !== "solana:" ||
    url.pathname !== RECEIVER ||
    url.searchParams.has("spl-token") ||
    url.searchParams.get("reference") !== data.reference ||
    Number(url.searchParams.get("amount")) !== amount
  ) {
    throw new Error("Invalid Solana Pay payment request");
  }
}

/* VERIFIED PUBLIC BUY LOG */
let buyLogUpdating = false;
async function refreshBuyLog() {
  if (document.hidden || buyLogUpdating) return;
  buyLogUpdating = true;
  try {
    const { data, error } = await client.rpc("recent_sticker_buys", { max_rows: 15 });
    if (error) throw error;
    const list = $("buy-log-items");
    list.replaceChildren();
    if (!data?.length) { list.textContent = "No purchases yet"; return; }
    for (const buy of data) {
      const item = document.createElement("div");
      item.className = "buy-log-entry";
      item.textContent = (buy.buyer || "User") + " got " +
        (buy.sticker || "Sticker") + " (" + (buy.tier || "common") + ")";
      list.append(item);
    }
  } catch (error) {
    console.error("[BUY LOG]", error);
  } finally {
    buyLogUpdating = false;
  }
}
void refreshBuyLog();
setInterval(refreshBuyLog, 15000);

/* INSTANT CAPSULE CHECKOUT — NO PAYMENT SCREEN */

function purchaseExpired(purchase) {
  return !!purchase?.expiresAt && Date.now() >= Date.parse(purchase.expiresAt);
}

/* Verified purchase: play the machine animation before revealing the sticker.
   Queue clips so simultaneous confirmations never hide each other. */
let stickerRevealQueue = Promise.resolve();

function playStickerOpening() {
  return new Promise(resolve => {
    const overlay = $("sticker-video-overlay");
    const video = $("sticker-video");
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      video.onended = null;
      video.onerror = null;
      video.pause();
      overlay.hidden = true;
      resolve();
    };
    // Never withhold a purchased sticker due to failed or stalled playback.
    const watchdog = setTimeout(finish, 90000);
    video.onended = finish;
    video.onerror = finish;
    overlay.hidden = false;
    try {
      applyAppVolume();
      video.currentTime = 0;
      const playing = video.play();
      if (playing && typeof playing.catch === "function") playing.catch(finish);
    } catch (error) {
      console.error("[STICKER VIDEO]", error);
      finish();
    }
  });
}

function revealPurchasedSticker(capsule) {
  stickerRevealQueue = stickerRevealQueue.catch(console.error).then(async () => {
    await playStickerOpening();
    dispenseReward(capsule);
  });
}

function dispenseReward(capsule) {
  const reward = document.createElement("div");
  reward.textContent = capsule?.reward_name || "CAPSULE DISPENSED";
  reward.style.cssText =
    "position:absolute;left:0;top:-90%;width:100%;min-height:125%;" +
    "display:grid;place-items:center;padding:5px;border:2px solid #64ffcb;" +
    "border-radius:10px;background:#140829;color:#64ffcb;" +
    "font-weight:bold;font-size:clamp(9px,1.5vw,16px);" +
    "text-align:center;overflow-wrap:anywhere;box-shadow:0 0 22px #8c46ff;" +
    "transition:opacity .45s ease";
  dispenser.replaceChildren(reward);
  dispenser.setAttribute("aria-live", "polite");

  setTimeout(() => {
    if (reward.parentNode !== dispenser) return;
    reward.style.opacity = "0";
    setTimeout(() => {
      if (reward.parentNode === dispenser) reward.remove();
    }, 450);
  }, 3500);
}

function stopPolling() {
  if (paymentTimer !== null) clearInterval(paymentTimer);
  paymentTimer = null;
}

async function checkPayment() {
  if (checkingPayment || !currentUser) return;
  checkingPayment = true;
  try {
    for (const purchase of readPending()) {
      try {
        const result = await invoke("verify-capsule", {
          purchaseId: purchase.purchaseId,
          ...(purchase.signature ? { signature: purchase.signature } : {})
        });
        if (result.status === "paid" || result.status === "fulfilled") {
          clearPending(purchase.purchaseId);
          revealPurchasedSticker(result.capsule);
          void refreshBuyLog();
        } else if (result.status === "expired" || result.status === "cancelled") {
          clearPending(purchase.purchaseId);
        }
      } catch (error) {
        console.error("[CAPSULE VERIFICATION]", error);
        // A deleted or inaccessible purchase is not a customer-facing error.
        // Discard only that stale record so other payments can still resolve.
        if (/HTTP 404: Purchase not found/i.test(String(error?.message || error))) {
          clearPending(purchase.purchaseId);
        }
      }
    }
  } finally {
    checkingPayment = false;
  }
}

function startPolling() {
  if (paymentTimer !== null || !readPending().length) return;
  const began = Date.now();
  void checkPayment();
  paymentTimer = setInterval(() => {
    if (!readPending().length || Date.now() - began > 180000) {
      stopPolling();
      return;
    }
    void checkPayment();
  }, PAYMENT_CHECK_MS);
}

function resumePendingPayment() {
  if (currentUser && readPending().length) startPolling();
}

function closePurchase() {
  purchaseOverlay.hidden = true;
  purchaseStatus.textContent = "";
  payButton.focus();
}

function openPurchase() {
  purchaseOverlay.hidden = false;
  purchaseStatus.textContent = "";
  updateSOLPrice();
}

async function buyCapsule(tier) {
  if (purchasing) return;
  if (!Object.prototype.hasOwnProperty.call(CAPSULE_PRICES, tier)) return;

  // Discord Activity only: launch Discord's native SKU checkout.
  // Fulfillment is intentionally separate; a client checkout result is not
  // sufficient proof to release a sticker.
  if (window.StickerDiscord?.isActivity) {
    purchasing = true;
    tierButtons.forEach(button => { button.disabled = true; });
    purchaseStatus.textContent = "OPENING DISCORD CHECKOUT...";
    try {
      const sdk = await window.StickerDiscord.ready;
      const { skus } = await sdk.commands.getSkus();
      const matches = (skus || []).filter(sku => {
        const name = String(sku.name || "").trim().toLowerCase();
        return Number(sku.type) === 3 &&
          (name.includes("(" + tier + ")") || name.endsWith(" " + tier));
      });
      if (matches.length !== 1) {
        throw new Error("Expected one published Discord consumable SKU for " + tier);
      }
      const result = await sdk.commands.startPurchase({ sku_id: matches[0].id });
      purchaseStatus.textContent = Array.isArray(result) && result.length
        ? "DISCORD PURCHASE COMPLETE. STICKER DELIVERY NOT YET CONNECTED."
        : "DISCORD CHECKOUT CLOSED.";
    } catch (error) {
      console.error("[DISCORD CHECKOUT]", error);
      purchaseStatus.textContent = "DISCORD CHECKOUT: " + (error?.message || "UNAVAILABLE");
    } finally {
      purchasing = false;
      tierButtons.forEach(button => { button.disabled = false; });
    }
    return;
  }

  if (!currentUser) { closePurchase(); openAuth(); return; }

  purchasing = true;
  tierButtons.forEach(button => { button.disabled = true; });
  purchaseStatus.textContent = "OPENING PHANTOM...";

  let purchase = null;
  try {
    const phantom = window.phantom?.solana ||
      (window.solana?.isPhantom ? window.solana : null);

    // Connect immediately from the capsule click to preserve wallet activation.
    const wallet = phantom ? await phantom.connect() : null;

    const result = await invoke("purchase-capsule", { tier });
    validatePurchase(result, tier);
    purchase = {
      purchaseId: result.purchaseId,
      tier,
      priceUsd: result.priceUsd,
      solAmount: result.solAmount,
      reference: result.reference,
      paymentUrl: result.paymentUrl,
      expiresAt: result.expiresAt
    };
    savePending(purchase);

    if (!phantom) {
      // Solana Pay link is the mobile wallet fallback; no QR or second button.
      closePurchase();
      startPolling();
      window.location.href = purchase.paymentUrl;
      return;
    }

    const web3 = window.solanaWeb3;
    if (!web3) throw new Error("Solana web3.js was not loaded");
    if (purchaseExpired(purchase)) throw new Error("Payment window expired");

    const lamports = Math.round(Number(purchase.solAmount) * 1_000_000_000);
    if (!Number.isSafeInteger(lamports) || lamports <= 0) {
      throw new Error("Invalid SOL amount");
    }

    const transfer = web3.SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new web3.PublicKey(RECEIVER),
      lamports
    });
    // Solana Pay's read-only, non-signer reference on the transfer.
    transfer.keys.push({
      pubkey: new web3.PublicKey(purchase.reference),
      isSigner: false,
      isWritable: false
    });
    const tx = new web3.Transaction().add(transfer);
    tx.feePayer = wallet.publicKey;

    const { data: block, error: blockError } = await client.functions.invoke(
      "solana-blockhash", { method: "POST", body: {} }
    );
    if (blockError || !block?.blockhash) {
      throw new Error(blockError ? await functionError(blockError) : "SOL RPC unavailable");
    }
    if (purchaseExpired(purchase)) throw new Error("Payment window expired");
    tx.recentBlockhash = block.blockhash;

    // Phantom handles authorization, signing and broadcasting.
    const sent = await phantom.signAndSendTransaction(tx);
    if (!sent?.signature) throw new Error("Phantom did not return a transaction");
    purchase.signature = sent.signature;
    savePending(purchase);
    closePurchase();

    // Verify against the merchant wallet without displaying another screen.
    startPolling();
  } catch (error) {
    console.error("[CAPSULE PAYMENT]", error);
    purchaseStatus.textContent = "Payment could not start. Try again.";
    // If submission was interrupted, still check the reference for a late transfer.
    if (purchase && !purchase.signature) startPolling();
  } finally {
    purchasing = false;
    tierButtons.forEach(button => { button.disabled = false; });
  }
}

payButton.onclick = openPurchase;
purchaseClose.onclick = closePurchase;
purchaseOverlay.onclick = event => {
  if (event.target === purchaseOverlay) closePurchase();
};
tierButtons.forEach(button => {
  button.onclick = () => { void buyCapsule(button.dataset.tier); };
});

// A checkout opened from Discord selects the tier on the normal website.
// The user must tap the tier again: wallet approval must be a real user action.
if (!window.StickerDiscord?.isActivity) {
  const tier = new URLSearchParams(window.location.search).get("checkout");
  if (Object.prototype.hasOwnProperty.call(CAPSULE_PRICES, tier)) {
    openPurchase();
    purchaseStatus.textContent = "SELECT " + tier.toUpperCase() + " TO PAY.";
  }
}

/* ESCAPE KEY */

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") {
    return;
  }

  if (!purchaseOverlay.hidden) {
    closePurchase();
  } else {
    closeAuth();
  }
});

/* START */

updateSOLPrice();

setInterval(
  updateSOLPrice,
  PRICE_REFRESH_MS
);

document.addEventListener(
  "visibilitychange",
  () => {
    if (!document.hidden) {
      updateSOLPrice();
      void refreshBuyLog();
    }
  }
);

