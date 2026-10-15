// Worker: vigia as carteiras da Polymarket a cada 1 minuto e avisa pelo ntfy.
// Precisa de: KV com binding "CFG", segredo "CHAVE" e Cron "* * * * *".
const DATA = "https://data-api.polymarket.com";
const ESPORT = /^(lol|cs2?|csgo|dota2?|valorant|val|r6(?:siege)?|codmw|cod|ow|rl|kog|hok|mlbb|sc2|starcraft)(?![a-z])/i;
const JANELA_S = 2 * 3600;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const resp = (t, s = 200) => new Response(t, { status: s, headers: CORS });

function ms(ts) { const n = Number(ts) || 0; return n > 1e12 ? n : n * 1000; }
function chave(t) {
  return [t.transactionHash || "", t.conditionId || "", Math.floor(ms(t.timestamp) / 1000),
    Number(t.size).toFixed(4), Number(t.price).toFixed(4), t.outcome || ""].join("|");
}

async function vigiar(env) {
  const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
  if (!cfg || !cfg.topico || !cfg.carteiras || !cfg.carteiras.length) return;
  const estado = JSON.parse((await env.CFG.get("estado")) || "{}");
  const desde = Math.floor(Date.now() / 1000) - JANELA_S;
  const novas = [];
  let mudou = false;
  for (const c of cfg.carteiras) {
    let trades;
    try {
      const r = await fetch(`${DATA}/trades?user=${c.w}&limit=500&start=${desde}`);
      if (!r.ok) continue;
      const b = await r.json();
      trades = Array.isArray(b) ? b : (b.data || []);
    } catch (e) { continue; }
    const vistos = new Set(estado[c.w] || []);
    const primeira = !(c.w in estado); // primeira vez: só marca o que já existe
    const novos = trades.filter(t => ESPORT.test(t.eventSlug || t.slug || "") && !vistos.has(chave(t)));
    for (const t of trades) vistos.add(chave(t));
    if (primeira || novos.length) { estado[c.w] = [...vistos].slice(-600); mudou = true; }
    if (!primeira) for (const t of novos) novas.push({ c, t });
  }
  if (mudou) await env.CFG.put("estado", JSON.stringify(estado));
  for (const { c, t } of novas.slice(0, 5)) {
    const preco = Number(t.price) || 0;
    const valor = (Number(t.size) || 0) * preco;
    const odd = preco > 0 ? (1 / preco).toFixed(2) : "-";
    const lado = String(t.side || "").toUpperCase() === "SELL" ? "vendeu" : "comprou";
    const nome = c.nome || (c.w.slice(0, 6) + "..." + c.w.slice(-4));
    const corpo = `${nome}: ${lado} ${t.outcome || "?"}\n${t.title || t.slug || ""}\nvalor US$ ${valor.toFixed(2)} · odd ${odd}`;
    await fetch("https://ntfy.sh/" + encodeURIComponent(cfg.topico), {
      method: "POST", headers: { "Title": "Nova aposta - carteira monitorada", "Tags": "bell" }, body: corpo,
    }).catch(() => {});
  }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.headers.get("Authorization") !== "Bearer " + env.CHAVE) return resp("nao autorizado", 401);
    if (new URL(req.url).pathname !== "/config" || req.method !== "POST") return resp("ok");
    let b;
    try { b = await req.json(); } catch (e) { return resp("json invalido", 400); }
    const carteiras = (Array.isArray(b.carteiras) ? b.carteiras : [])
      .filter(c => c && /^0x[0-9a-fA-F]{40}$/.test(c.w || ""))
      .slice(0, 20)
      .map(c => ({ w: c.w.toLowerCase(), nome: String(c.nome || "").slice(0, 40) }));
    const topico = String(b.topico || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    await env.CFG.put("cfg", JSON.stringify({ carteiras, topico }));
    // esquece o estado de carteiras que saíram da lista
    const estado = JSON.parse((await env.CFG.get("estado")) || "{}");
    const manter = new Set(carteiras.map(c => c.w));
    let limpou = false;
    for (const w of Object.keys(estado)) if (!manter.has(w)) { delete estado[w]; limpou = true; }
    if (limpou) await env.CFG.put("estado", JSON.stringify(estado));
    return resp(JSON.stringify({ carteiras: carteiras.length }));
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(vigiar(env)); },
};
