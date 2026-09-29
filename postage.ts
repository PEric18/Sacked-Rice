// Sacked: "postage" Edge Function
// Works out live Australia Post prices for what's in the cart.
// Australia only for now.
// Paste all of this into Supabase > Edge Functions > (new function called "postage").
//
// It needs two secrets (Edge Functions > Secrets):
//   AUSPOST_API_KEY  your Australia Post PAC API key
//   FROM_POSTCODE    the postcode you'd send parcels from, e.g. 2000

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const PACKAGING_KG = 0.3;   // the box and padding
const MAX_KG = 22;          // Australia Post's limit for one parcel

// Pick a box size (cm) that suits the weight. Rice is heavy but compact.
function boxFor(kg: number) {
  if (kg <= 2.5) return { length: 25, width: 18, height: 10 };
  if (kg <= 5.5) return { length: 30, width: 22, height: 14 };
  if (kg <= 11)  return { length: 36, width: 28, height: 18 };
  return { length: 45, width: 32, height: 22 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // 1. Only signed-in people can get prices
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await db.auth.getUser();
    if (!user) return reply({ error: "Please sign in first." }, 401);

    // 2. Check what the page sent
    const { postcode, items } = await req.json();
    if (!/^\d{4}$/.test(String(postcode ?? ""))) {
      return reply({ error: "Enter a 4-digit Australian postcode." }, 400);
    }
    if (!Array.isArray(items) || items.length === 0) return reply({ error: "Your cart is empty." }, 400);
    for (const i of items) {
      if (!Number.isInteger(i.id) || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 50) {
        return reply({ error: "Something's wrong with the cart. Try removing and re-adding items." }, 400);
      }
    }

    // 3. Work out the weight from the database, not from the page
    const { data: rice, error } = await db.from("rice").select("id, pack_kg").in("id", items.map((i) => i.id));
    if (error) return reply({ error: "Couldn't read the rice list: " + error.message }, 500);
    let kg = PACKAGING_KG;
    for (const i of items) {
      const r = rice.find((x) => x.id === i.id);
      if (!r) return reply({ error: "One of the rices in your cart no longer exists." }, 400);
      kg += Number(r.pack_kg) * i.qty;
    }
    kg = Math.round(kg * 100) / 100;

    if (kg > MAX_KG) {
      return reply({ error: `That parcel would weigh ${kg} kg, and Australia Post's limit is ${MAX_KG} kg. Try a smaller order.` }, 400);
    }

    // 4. Ask Australia Post
    const box = boxFor(kg);
    const q = new URLSearchParams({
      from_postcode: Deno.env.get("FROM_POSTCODE") ?? "",
      to_postcode: String(postcode),
      length: String(box.length), width: String(box.width), height: String(box.height),
      weight: String(kg),
    });
    const url = "https://digitalapi.auspost.com.au/postage/parcel/domestic/service.json?" + q;

    const res = await fetch(url, { headers: { "AUTH-KEY": Deno.env.get("AUSPOST_API_KEY") ?? "" } });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      const why = data?.error?.errorMessage ?? `Australia Post replied with status ${res.status}.`;
      return reply({ error: "Couldn't get postage prices. " + why }, 502);
    }

    // 5. Tidy the answer into a simple list, cheapest first.
    //    Australia Post also lists its own prepaid satchels and boxes
    //    ("Large satchel", "Extra large"). We pack in our own box, so we
    //    only offer the two main services: Parcel Post and Express Post.
    type Service = { code: string; name: string; price: string };
    let list: Service[] = data.services?.service ?? [];
    if (!Array.isArray(list)) list = [list];

    const speed = (code: string) => (code.includes("EXPRESS") ? "Express Post" : "Parcel Post");
    const MAIN = ["AUS_PARCEL_REGULAR", "AUS_PARCEL_EXPRESS"];

    let chosen = list.filter((s) => MAIN.includes(s.code));
    let options = chosen.map((s) => ({ code: s.code, name: speed(s.code), price: Number(s.price) }));

    // Fallback: if the main two aren't there, show everything, clearly labelled
    if (options.length === 0) {
      options = list.map((s) => ({
        code: s.code,
        name: s.name === speed(s.code) ? s.name : `${speed(s.code)} – ${s.name}`,
        price: Number(s.price),
      }));
    }
    options = options.filter((o) => o.price > 0).sort((a, b) => a.price - b.price);

    if (options.length === 0) return reply({ error: "Australia Post had no services for that address and weight." }, 404);
    return reply({ postcode: String(postcode), weight_kg: kg, options });
  } catch (e) {
    return reply({ error: "Something went wrong: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
