// Worker: vigia as carteiras da Polymarket a cada 1 minuto e avisa pelo ntfy.
// Precisa de: KV com binding "CFG", segredo "CHAVE" e Cron "* * * * *".
// Usa a mesma consulta da página (Data API v2 primeiro, v1 como reserva).
const DATA = "https://data-api.polymarket.com";
const ESPORT = /^(lol|cs2?|csgo|dota2?|valorant|val|r6(?:siege)?|codmw|cod|ow|rl|kog|hok|mlbb|sc2|starcraft)(?![a-z])/i;
const JANELA_S = 600; // só os últimos 10 minutos (o plano grátis tem 10 ms de CPU por rodada)
const LIMITE = 100;
const ESTADO = "estado2"; // nome novo: na primeira rodada as carteiras só são marcadas, sem aviso
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const resp = (t, s = 200) => new Response(t, { status: s, headers: CORS });

function paraMs(ts) {
  if (ts === null || ts === undefined || ts === "") return 0;
  const n = Number(ts);
  if (n) return n > 1e12 ? n : n * 1000;
  const d = Date.parse(String(ts).trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return isNaN(d) ? 0 : d;
}
function normalizar(t) {
  if (!t || typeof t !== "object") return null;
  return {
    conditionId: t.conditionId || t.condition_id || "",
    eventSlug: t.eventSlug || t.event_slug || "",
    slug: t.slug || "",
    title: t.title || "",
    outcome: t.outcome || t.outcome_name || "?",
    side: t.side || "",
    size: t.size,
    price: t.price,
    timestamp: t.timestamp || t.block_timestamp || t.match_time || t.created_at || 0,
    transactionHash: t.transactionHash || t.transaction_hash || t.txHash || t.tx_hash || "",
  };
}
function chave(t) {
  return [t.transactionHash || "", t.conditionId, Math.floor(paraMs(t.timestamp) / 1000),
    Number(t.size).toFixed(4), Number(t.price).toFixed(4), t.outcome].join("|");
}

async function buscar(w, desde) {
  const urls = [
    `${DATA}/v2/trades?user=${w}&limit=${LIMITE}&start=${desde}`,
    `${DATA}/trades?user=${w}&limit=${LIMITE}&start=${desde}`,
  ];
  let ultimo = "";
  for (let i = 0; i < urls.length; i++) {
    try {
      const r = await fetch(urls[i]);
      if (!r.ok) { ultimo = "HTTP " + r.status; continue; }
      const b = await r.json();
      const lista = Array.isArray(b) ? b : (b.data || b.events || []);
      return { api: i === 0 ? "v2" : "v1", trades: lista.map(normalizar).filter(Boolean) };
    } catch (e) { ultimo = String(e); }
  }
  console.error("sem resposta para " + w.slice(0, 8) + ": " + ultimo);
  return null;
}

async function vigiar(env) {
  const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
  if (!cfg || !cfg.topico || !cfg.carteiras || !cfg.carteiras.length) { console.log("rodada: nada para vigiar (0 carteiras ou sem topico)"); return; }
  const estado = JSON.parse((await env.CFG.get(ESTADO)) || "{}");
  const desde = Math.floor(Date.now() / 1000) - JANELA_S;
  const resumo = { carteiras: cfg.carteiras.length, v2: 0, v1: 0, erros: 0, trades: 0, novos: 0 };
  // consulta todas as carteiras ao mesmo tempo (a espera de rede não conta como CPU)
  const respostas = await Promise.all(cfg.carteiras.map(c => buscar(c.w, desde)));
  const novas = [];
  let mudou = false;
  cfg.carteiras.forEach((c, i) => {
    const r = respostas[i];
    if (!r) { resumo.erros++; return; }
    resumo[r.api]++;
    resumo.trades += r.trades.length;
    const esports = r.trades.filter(t => ESPORT.test(t.eventSlug || t.slug || ""));
    const primeira = !(c.w in estado); // primeira vez: só marca o que já existe
    const vistos = new Set(estado[c.w] || []);
    const novos = esports.filter(t => !vistos.has(chave(t)));
    if (primeira || novos.length) {
      estado[c.w] = esports.map(chave); // guarda só a janela atual: estado pequeno e rápido
      mudou = true;
    }
    if (!primeira) for (const t of novos) novas.push({ c, t });
  });
  resumo.novos = novas.length;
  console.log("rodada: " + JSON.stringify(resumo));
  if (mudou) await env.CFG.put(ESTADO, JSON.stringify(estado));
  for (const { c, t } of novas.slice(0, 5)) {
    const preco = Number(t.price) || 0;
    const valor = (Number(t.size) || 0) * preco;
    const odd = preco > 0 ? (1 / preco).toFixed(2) : "-";
    const lado = String(t.side || "").toUpperCase() === "SELL" ? "vendeu" : "comprou";
    const nome = c.nome || (c.w.slice(0, 6) + "..." + c.w.slice(-4));
    const corpo = `${nome}: ${lado} ${t.outcome || "?"}\n${t.title || t.slug || ""}\nvalor US$ ${valor.toFixed(2)} · odd ${odd}`;
    await fetch("https://ntfy.sh/" + encodeURIComponent(cfg.topico), {
      method: "POST", headers: { "Title": "Nova aposta - carteira monitorada", "Tags": "bell" }, body: corpo,
    }).catch(e => console.error("ntfy falhou: " + e));
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
    const estado = JSON.parse((await env.CFG.get(ESTADO)) || "{}");
    const manter = new Set(carteiras.map(c => c.w));
    let limpou = false;
    for (const w of Object.keys(estado)) if (!manter.has(w)) { delete estado[w]; limpou = true; }
    if (limpou) await env.CFG.put(ESTADO, JSON.stringify(estado));
    return resp(JSON.stringify({ carteiras: carteiras.length }));
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(vigiar(env)); },
};
