/* StickerZ script loader: normal website and Discord Activity use the same game. */
(() => {
  const isDiscordActivity = location.hostname.endsWith(".discordsays.com");
  const base = new URL(".", document.currentScript.src);

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
    load(solanaScript).catch(error => {
      // A missing wallet library must not disable the vending-machine buttons.
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
