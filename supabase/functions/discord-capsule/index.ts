
import { createClient } from "npm:@supabase/supabase-js@2.58.0";
const APP="1558904698025676851";
const PRICES:Record<string,number>={common:1,rare:3,legendary:5};
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const h={"Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,x-client-info,content-type","Access-Control-Allow-Methods":"POST,OPTIONS"};
const out=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:h});
async function discord(path:string,token:string,method="GET"){
 const r=await fetch("https://discord.com/api/v10"+path,{method,headers:{Authorization:"Bot "+token},signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error("Discord API "+r.status);
 return r.status===204?null:r.json();
}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:h});
 if(req.method!=="POST")return out({error:"POST required"},405);
 try{
  const bot=Deno.env.get("DISCORD_BOT_TOKEN");
  if(!bot)return out({error:"Set DISCORD_BOT_TOKEN in Supabase secrets"},503);
  const jwt=req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if(!jwt)return out({error:"Sign in required"},401);
  const {data:{user},error:authErr}=await admin.auth.getUser(jwt);
  if(authErr||!user)return out({error:"Invalid session"},401);
  const ident=user.identities?.find(i=>i.provider==="discord");
  const discordId=String(ident?.identity_data?.sub||ident?.id||"");
  if(!/^\d{15,25}$/.test(discordId))return out({error:"Discord identity required"},403);
  const {data:account}=await admin.from("sticker_accounts").select("discord_id").eq("id",user.id).maybeSingle();
  if(account?.discord_id!==discordId)return out({error:"Discord account not linked"},403);
  const input=await req.json(),tier=String(input?.tier||""),skuId=String(input?.skuId||"");
  if(!Object.hasOwn(PRICES,tier)||!/^\d{15,25}$/.test(skuId))return out({error:"Invalid tier or SKU"},400);
  const skus=await discord("/applications/"+APP+"/skus",bot);
  const sku=Array.isArray(skus)?skus.find(x=>String(x.id)===skuId):null;
  const name=String(sku?.name||"").trim().toLowerCase();
  if(!sku||Number(sku.type)!==3||!(name.includes("("+tier+")")||name.endsWith(" "+tier)))return out({error:"SKU mismatch"},400);
  const {data:available}=await admin.from("capsules").select("id").eq("tier",tier).eq("active",true).limit(1);
  if(!available?.length)return out({error:"No active sticker for this tier"},409);
  const entitlements=await discord("/applications/"+APP+"/entitlements?user_id="+discordId+"&sku_ids="+skuId+"&limit=100",bot);
  const ent=Array.isArray(entitlements)?entitlements.find(e=>String(e.user_id)===discordId&&String(e.sku_id)===skuId&&!e.deleted&&!e.consumed&&[1,4].includes(Number(e.type))&&(!e.ends_at||Date.parse(e.ends_at)>Date.now())):null;
  if(!ent)return out({status:"pending",error:"Verified purchase not yet available"},202);
  const reference="discord:"+String(ent.id);
  const {data:existing,error:lookupErr}=await admin.from("capsule_purchases").select("id,player_id").eq("payment_reference",reference).maybeSingle();
  if(lookupErr)throw lookupErr;
  if(existing&&existing.player_id!==user.id)return out({error:"Purchase belongs to another account"},403);
  let id=existing?.id;
  if(!id){
   const {data:inserted,error:insertErr}=await admin.from("capsule_purchases").insert({player_id:user.id,capsule_id:null,tier,price_usd:PRICES[tier],payment_reference:reference,status:"pending"}).select("id").single();
   if(insertErr){
    const {data:concurrent}=await admin.from("capsule_purchases").select("id,player_id").eq("payment_reference",reference).maybeSingle();
    if(!concurrent||concurrent.player_id!==user.id)throw insertErr;
    id=concurrent.id;
   }else id=inserted.id;
  }
  const {data:reward,error:completeErr}=await admin.rpc("complete_capsule_purchase",{p_purchase_id:id,p_signature:reference});
  if(completeErr)throw completeErr;
  try{await discord("/applications/"+APP+"/entitlements/"+ent.id+"/consume",bot,"POST")}
  catch(err){console.error("Entitlement consume failed",err);return out({...reward,warning:"Reward saved, entitlement consumption pending"});}
  return out(reward);
 }catch(err){console.error("[DISCORD CAPSULE]",err);return out({error:"Discord verification unavailable"},503);}
});