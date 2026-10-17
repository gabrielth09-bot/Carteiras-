// Worker: vigia as carteiras da Polymarket a cada 1 minuto e avisa pelo ntfy.
// Precisa de: KV com binding "CFG", segredo "CHAVE" e Cron "* * * * *".
// Usa a mesma consulta da página (Data API v2 primeiro, v1 como reserva).
const DATA = "https://data-api.polymarket.com";
const ESPORT = /^(lol|cs2?|csgo|dota2?|valorant|val|r6(?:siege)?|codmw|cod|ow|rl|kog|hok|mlbb|sc2|starcraft)(?![a-z])/i;
const JANELA_S = 900; // só os últimos 15 minutos (o plano grátis tem 10 ms de CPU por rodada)
const LIMITE = 200;      // apostas por página
const MAX_PAGINAS = 3;   // carteiras com muitas execuções pequenas podem passar de uma página
const vistosMem = {};    // memória desta instância: reserva caso o KV falhe
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

function cursorDe(body) {
  if (!body || typeof body !== "object") return null;
  const p = body.pagination || body.meta || {};
  return p.next_cursor || p.nextCursor || body.next_cursor || body.nextCursor || null;
}
function soEsports(lista, saida) {
  // só converte o que é e-sports (o resto é descartado sem gastar CPU)
  for (const t of lista) {
    if (t && ESPORT.test(t.eventSlug || t.event_slug || t.slug || "")) saida.push(normalizar(t));
  }
}
async function buscar(w, desde) {
  let ultimo = "";
  // v2 primeiro, seguindo o cursor se houver mais de uma página
  try {
    const esports = []; let total = 0, cursor = null;
    for (let p = 0; p < MAX_PAGINAS; p++) {
      let url = `${DATA}/v2/trades?user=${w}&limit=${LIMITE}&start=${desde}`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const b = await r.json();
      const lista = Array.isArray(b) ? b : (b.data || b.events || []);
      total += lista.length;
      soEsports(lista, esports);
      cursor = cursorDe(b);
      if (!cursor || lista.length === 0) break;
    }
    return { api: "v2", total, esports };
  } catch (e) { ultimo = String(e); }
  // reserva: v1 (uma página)
  try {
    const r = await fetch(`${DATA}/trades?user=${w}&limit=${LIMITE}&start=${desde}`);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const b = await r.json();
    const lista = Array.isArray(b) ? b : (b.data || b.events || []);
    const esports = []; soEsports(lista, esports);
    return { api: "v1", total: lista.length, esports };
  } catch (e) { ultimo += " | v1: " + String(e); }
  console.error("sem resposta para " + w.slice(0, 8) + ": " + ultimo);
  return null;
}

async function avisar(topico, titulo, corpo, tag) {
  try {
    const r = await fetch("https://ntfy.sh/" + encodeURIComponent(topico), {
      method: "POST", headers: { "Title": titulo, "Tags": tag }, body: corpo,
    });
    if (!r.ok) console.error("ntfy respondeu " + r.status + " (topico ..." + topico.slice(-4) + ")");
    return r.ok;
  } catch (e) { console.error("ntfy falhou: " + e); return false; }
}

async function vigiar(env) {
  const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
  if (!cfg || !cfg.topico || !cfg.carteiras || !cfg.carteiras.length) { console.log("rodada: nada para vigiar (0 carteiras ou sem topico)"); return; }
  const estado = JSON.parse((await env.CFG.get(ESTADO)) || "{}");
  const desde = Math.floor(Date.now() / 1000) - JANELA_S;
  const resumo = { carteiras: cfg.carteiras.length, v2: 0, v1: 0, erros: 0, trades: 0, novos: 0, avisosOk: 0, avisosFalha: 0, topico: "..." + cfg.topico.slice(-4) };
  // consulta todas as carteiras ao mesmo tempo (a espera de rede não conta como CPU)
  const respostas = await Promise.all(cfg.carteiras.map(c => buscar(c.w, desde)));
  const novas = [];
  let mudou = false;
  cfg.carteiras.forEach((c, i) => {
    const r = respostas[i];
    if (!r) { resumo.erros++; return; }
    resumo[r.api]++;
    resumo.trades += r.total;
    const esports = r.esports;
    const primeira = !(c.w in estado) && !(c.w in vistosMem); // primeira vez: só marca o que já existe
    const vistos = new Set([...(estado[c.w] || []), ...(vistosMem[c.w] || [])]);
    const novos = esports.filter(t => !vistos.has(chave(t)));
    const chavesAgora = esports.map(chave);
    vistosMem[c.w] = chavesAgora;
    if (primeira || novos.length) {
      estado[c.w] = chavesAgora; // guarda só a janela atual: estado pequeno e rápido
      mudou = true;
    }
    if (!primeira) for (const t of novos) novas.push({ c, t });
  });
  resumo.novos = novas.length;
  let lista = novas;
  if (mudou) {
    try { await env.CFG.put(ESTADO, JSON.stringify(estado)); }
    catch (e) {
      // KV recusou (limite diário, por exemplo): avisa só o que é bem recente, para não repetir aviso a cada minuto
      console.error("KV put falhou: " + e);
      resumo.kvFalhou = true;
      const corte = Date.now() - 75000;
      lista = novas.filter(x => paraMs(x.t.timestamp) >= corte);
    }
  }
  for (const { c, t } of lista.slice(0, 5)) {
    const preco = Number(t.price) || 0;
    const valor = (Number(t.size) || 0) * preco;
    const odd = preco > 0 ? (1 / preco).toFixed(2) : "-";
    const lado = String(t.side || "").toUpperCase() === "SELL" ? "vendeu" : "comprou";
    const nome = c.nome || (c.w.slice(0, 6) + "..." + c.w.slice(-4));
    const corpo = `${nome}: ${lado} ${t.outcome || "?"}\n${t.title || t.slug || ""}\nvalor US$ ${valor.toFixed(2)} · odd ${odd}`;
    const ok = await avisar(cfg.topico, "Nova aposta - carteira monitorada", corpo, "bell");
    if (ok) resumo.avisosOk++; else resumo.avisosFalha++;
  }
  // números importantes primeiro, para aparecerem na lista mesmo com o texto cortado
  console.log(`novos=${resumo.novos} trades=${resumo.trades} erros=${resumo.erros} | rodada ` + JSON.stringify(resumo));
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
    // confirmação de ponta a ponta: este aviso prova que o servidor consegue falar com o ntfy
    if (topico && carteiras.length) await avisar(topico, "Servidor sincronizado", "Vigiando " + carteiras.length + " carteira(s) a cada minuto, mesmo com a página fechada.", "white_check_mark");
    return resp(JSON.stringify({ carteiras: carteiras.length }));
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(vigiar(env).catch(async e => {
      console.error("vigiar falhou: " + e);
      try {
        const min = new Date(ev.scheduledTime).getUTCMinutes();
        const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
        if (cfg && cfg.topico && min % 15 === 0) await avisar(cfg.topico, "Monitor com erro", String(e).slice(0, 200), "warning");
      } catch (e2) { console.error("aviso de erro falhou: " + e2); }
    }));
  },
};
