/* StickerZ script loader: normal website and Discord Activity use the same game. */
(() => {
  const isDiscordActivity = location.hostname.endsWith(".discordsays.com");
  const base = new URL(".", document.currentScript.src);
  // Discord proxies Activities under <application-id>.discordsays.com.
  // Confirm that Discord's SDK is connected before opening an outside link.
  const activity = {
    isActivity: isDiscordActivity,
    ready: Promise.resolve(null),
    async openExternalLink(url) {
      if (!this.isActivity) throw new Error("Not running in Discord");
      const sdk = await this.ready;
      const result = await sdk.commands.openExternalLink({ url });
      if (result.opened === false) throw new Error("Checkout link was not opened");
      return result;
    }
  };
  window.StickerDiscord = activity;
  if (isDiscordActivity) {
    activity.ready = import("/discord-jsdelivr/npm/@discord/embedded-app-sdk@2.5.0/+esm")
      .then(({ DiscordSDK }) => {
        const sdk = new DiscordSDK("1558904698025676851");
        return sdk.ready().then(() => sdk);
      });
    // The checkout click awaits this; startup can continue without a wallet.
    activity.ready.catch(error => console.error("[DISCORD SDK]", error));
  }

  function load(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Unable to load " + src));
      document.head.appendChild(script);
    });
  }

  const supabaseScript = isDiscordActivity
    ? "/discord-jsdelivr/npm/@supabase/supabase-js@2"
    : "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
  const solanaScript = isDiscordActivity
    ? "/discord-unpkg/@solana/web3.js@1.98.4/lib/index.iife.min.js"
    : "https://unpkg.com/@solana/web3.js@1.98.4/lib/index.iife.min.js";

  Promise.all([
    load(supabaseScript),
    isDiscordActivity ? Promise.resolve() : load(solanaScript).catch(error => {
      // The machine still needs to load if a wallet library is unavailable.
      console.error("[SOLANA LIBRARY]", error);
    })
  ])
    .then(() => {
      if (!window.supabase?.createClient) {
        throw new Error("Supabase library was not initialized");
      }
      return load(new URL("sticker-mania.js", base).href);
    })
    .catch(error => {
      console.error("[STICKER MANIA STARTUP]", error);
      const price = document.getElementById("sol-price-main");
      if (price) price.textContent = "GAME STARTUP ERROR";
    });
})();
