// Worker: vigia as carteiras da Polymarket a cada 1 minuto e avisa pelo Telegram.
// Precisa de: KV com binding "CFG", segredo "CHAVE", segredo "TELEGRAM_BOT_TOKEN",
// variável "TELEGRAM_CHAT_ID" e Cron "* * * * *".
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

const EMOJI = { red_circle: "🔴", green_circle: "🟢", white_check_mark: "✅", warning: "⚠️", bell: "🔔" };
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pausa = ms => new Promise(r => setTimeout(r, ms));

// uma chamada à API do Telegram (sendMessage). O token vai na URL, por isso a URL nunca é gravada nos registros.
async function enviarTelegram(env, texto, html) {
  const corpo = { chat_id: env.TELEGRAM_CHAT_ID, text: texto, link_preview_options: { is_disabled: true } };
  if (html) corpo.parse_mode = "HTML";
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
  });
  let d = null;
  try { d = await r.json(); } catch (e) { /* resposta sem JSON */ }
  return {
    ok: r.ok && !!d && d.ok === true,
    status: r.status,
    desc: d && d.description ? String(d.description).slice(0, 120) : "",
    espera: d && d.parameters && d.parameters.retry_after ? Number(d.parameters.retry_after) : 0,
  };
}

async function avisar(env, titulo, corpo, tag, click) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("telegram: faltam TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID");
    return false;
  }
  const emoji = EMOJI[tag] || EMOJI.bell;
  const link = click ? "\n" + click : "";
  const textoHtml = `${emoji} <b>${esc(titulo)}</b>\n${esc(corpo)}${esc(link)}`;
  const textoPlano = `${emoji} ${titulo}\n${corpo}${link}`;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      let r = await enviarTelegram(env, textoHtml, true);
      // 400 = o Telegram não aceitou o formato: tenta de novo em texto simples
      if (!r.ok && r.status === 400) r = await enviarTelegram(env, textoPlano, false);
      if (r.ok) return true;
      console.error("telegram respondeu " + r.status + (r.desc ? ": " + r.desc : ""));
      // 429 (muitas mensagens) e 5xx (falha do Telegram): uma segunda tentativa; outros erros não adiantam repetir
      if (tentativa === 0 && (r.status === 429 || r.status >= 500)) {
        await pausa(Math.min(Math.max(r.espera, 1), 5) * 1000);
        continue;
      }
      return false;
    } catch (e) {
      // o texto do erro pode, em tese, trazer a URL: o token é removido antes de gravar
      console.error("telegram falhou: " + String(e).split(env.TELEGRAM_BOT_TOKEN).join("***"));
      if (tentativa === 0) { await pausa(1000); continue; }
      return false;
    }
  }
  return false;
}

// junta as execuções fracionadas: uma aposta (carteira + mercado + lado) vira UM aviso com o total
function agrupar(novas) {
  const grupos = new Map();
  for (const { c, t } of novas) {
    const k = [c.w, t.conditionId, t.outcome, String(t.side || "").toUpperCase()].join("|");
    let g = grupos.get(k);
    if (!g) { g = { c, t, n: 0, cotas: 0, custo: 0 }; grupos.set(k, g); }
    const size = Number(t.size) || 0, preco = Number(t.price) || 0;
    g.n++; g.cotas += size; g.custo += size * preco;
  }
  return [...grupos.values()].sort((x, y) => y.custo - x.custo);
}
const moeda = v => "US$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const MAX_AVISOS = 8; // por rodada; o que passar disso vira um aviso-resumo

async function vigiar(env) {
  const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
  if (!cfg || !cfg.carteiras || !cfg.carteiras.length) { console.log("rodada: nada para vigiar (0 carteiras)"); return; }
  const estado = JSON.parse((await env.CFG.get(ESTADO)) || "{}");
  const desde = Math.floor(Date.now() / 1000) - JANELA_S;
  const resumo = { carteiras: cfg.carteiras.length, v2: 0, v1: 0, erros: 0, trades: 0, novos: 0, avisosOk: 0, avisosFalha: 0 };
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
  const grupos = agrupar(lista);
  resumo.grupos = grupos.length;
  for (const g of grupos.slice(0, MAX_AVISOS)) {
    const t = g.t;
    const pm = g.cotas > 0 ? g.custo / g.cotas : 0; // preço médio ponderado pelo tamanho
    const odd = pm > 0 ? (1 / pm).toFixed(2).replace(".", ",") : "-";
    const venda = String(t.side || "").toUpperCase() === "SELL";
    const nome = g.c.nome || (g.c.w.slice(0, 6) + "..." + g.c.w.slice(-4));
    const titulo = `${nome}: ${venda ? "vendeu" : "comprou"} ${t.outcome || "?"}`;
    const corpo = `${t.title || t.slug || ""}\n${moeda(g.custo)}${g.n > 1 ? ` em ${g.n} execuções` : ""} · odd ${odd}`;
    const click = t.eventSlug ? "https://polymarket.com/event/" + t.eventSlug : "";
    const ok = await avisar(env, titulo, corpo, venda ? "red_circle" : "green_circle", click);
    if (ok) resumo.avisosOk++; else resumo.avisosFalha++;
  }
  if (grupos.length > MAX_AVISOS) {
    await avisar(env, `+${grupos.length - MAX_AVISOS} outras apostas`, "Muitas apostas de uma vez. Abra a página para ver todas.", "bell");
  }
  // números importantes primeiro, para aparecerem na lista mesmo com o texto cortado
  console.log(`novos=${resumo.novos} trades=${resumo.trades} erros=${resumo.erros} | rodada ` + JSON.stringify(resumo));
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!env.CHAVE || req.headers.get("Authorization") !== "Bearer " + env.CHAVE) return resp("nao autorizado", 401);
    const caminho = new URL(req.url).pathname;
    if (req.method !== "POST" || (caminho !== "/config" && caminho !== "/notify")) return resp("ok");
    let b;
    try { b = await req.json(); } catch (e) { return resp("json invalido", 400); }
    if (!b || typeof b !== "object") return resp("json invalido", 400);

    if (caminho === "/notify") {
      // aviso avulso (botão de teste da página): título, texto, ícone e link opcionais, tudo validado
      const titulo = String(b.titulo || "Aviso de teste").slice(0, 100);
      const corpo = String(b.corpo || "Teste do servidor: se você recebeu esta mensagem, o Telegram está funcionando.").slice(0, 500);
      const tag = Object.keys(EMOJI).includes(b.tag) ? b.tag : "bell";
      const click = typeof b.click === "string" && /^https:\/\/[^\s]{1,280}$/.test(b.click) ? b.click : "";
      const ok = await avisar(env, titulo, corpo, tag, click);
      return resp(JSON.stringify({ ok }), ok ? 200 : 502);
    }

    const carteiras = (Array.isArray(b.carteiras) ? b.carteiras : [])
      .filter(c => c && /^0x[0-9a-fA-F]{40}$/.test(c.w || ""))
      .slice(0, 20)
      .map(c => ({ w: c.w.toLowerCase(), nome: String(c.nome || "").slice(0, 40) }));
    // "topico" (ntfy) não é mais usado; continua guardado só para o Worker antigo poder voltar, se for preciso
    const antigo = JSON.parse((await env.CFG.get("cfg")) || "null") || {};
    const topico = String(b.topico || antigo.topico || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    await env.CFG.put("cfg", JSON.stringify({ carteiras, topico }));
    // esquece o estado de carteiras que saíram da lista
    const estado = JSON.parse((await env.CFG.get(ESTADO)) || "{}");
    const manter = new Set(carteiras.map(c => c.w));
    let limpou = false;
    for (const w of Object.keys(estado)) if (!manter.has(w)) { delete estado[w]; limpou = true; }
    if (limpou) await env.CFG.put(ESTADO, JSON.stringify(estado));
    // confirmação de ponta a ponta: este aviso prova que o servidor consegue falar com o Telegram
    let aviso = null;
    if (carteiras.length) aviso = await avisar(env, "Servidor sincronizado", "Vigiando " + carteiras.length + " carteira(s) a cada minuto, mesmo com a página fechada.", "white_check_mark");
    return resp(JSON.stringify({ carteiras: carteiras.length, aviso }));
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(vigiar(env).catch(async e => {
      console.error("vigiar falhou: " + e);
      try {
        const min = new Date(ev.scheduledTime).getUTCMinutes();
        if (min % 15 === 0) await avisar(env, "Monitor com erro", String(e).slice(0, 200), "warning");
      } catch (e2) { console.error("aviso de erro falhou: " + e2); }
    }));
  },
};
