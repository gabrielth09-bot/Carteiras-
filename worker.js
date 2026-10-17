// Worker: vigia as carteiras da Polymarket a cada 1 minuto e avisa pelo ntfy.
// Precisa de: KV com binding "CFG", segredo "CHAVE" e Cron "* * * * *".
// Pensado para o plano grátis do Cloudflare (10 ms de CPU e 50 chamadas externas por rodada).

const DATA = "https://data-api.polymarket.com";
const ESPORT = /^(lol|cs2?|csgo|dota2?|valorant|val|r6(?:siege)?|codmw|cod|ow|rl|kog|hok|mlbb|sc2|starcraft)(?![a-z])/i;

const JANELA_S = 900;          // olha só os últimos 15 min (se uma rodada falhar, a seguinte ainda pega o que perdeu)
const LIMITE = 200;            // apostas por página
const MAX_PAGINAS = 3;         // carteiras com muitas execuções pequenas podem passar de uma página
const CARTEIRAS_POR_LOTE = 4;  // consultas em paralelo; os lotes andam um após o outro
const PAUSA_MS = 300;          // pausa entre um lote e o seguinte
const TENTATIVAS = 2;          // tentativas por pedido quando a API falha de forma temporária
const TIMEOUT_MS = 10000;      // espera máxima por resposta
const MAX_LEITURAS = 34;       // chamadas à Polymarket por rodada (tentativas incluídas)
const MAX_CHAMADAS = 46;       // chamadas externas por rodada (leituras + avisos); o plano grátis permite 50
const MAX_AVISOS = 8;          // avisos por rodada; o que passar disso vira um aviso-resumo
const ESTADO = "estado2";      // mesmo nome da versão anterior: aproveita o histórico já salvo
const vistosMem = {};          // memória desta instância: reserva caso o KV falhe
let travaMs = 0;               // impede duas rodadas ao mesmo tempo nesta instância

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const resp = (t, s = 200) => new Response(t, { status: s, headers: CORS });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cortar = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const moeda = v => "US$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });

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

// guarda só o necessário: chaves de até 2 horas atrás, no máximo 200 por carteira
function enxugar(lista) {
  const corte = Math.floor(Date.now() / 1000) - 7200;
  return lista
    .filter(k => { const ts = Number(String(k).split("|")[2]) || 0; return ts === 0 || ts >= corte; })
    .slice(-200);
}

const listaDe = b => (Array.isArray(b) ? b : ((b && (b.data || b.events)) || []));

function cursorDe(body) {
  if (!body || typeof body !== "object") return null;
  const p = body.pagination || body.meta || {};
  return p.next_cursor || p.nextCursor || body.next_cursor || body.nextCursor || null;
}

function soEsports(lista, saida) {
  for (const t of lista) {
    if (t && ESPORT.test(t.eventSlug || t.event_slug || t.slug || "")) saida.push(normalizar(t));
  }
}

// pedido à Polymarket com tempo limite e uma nova tentativa em caso de erro temporário
async function pedir(run, url) {
  let motivo = "";
  for (let t = 1; t <= TENTATIVAS; t++) {
    if (run.chamadas >= MAX_LEITURAS) throw new Error("limite de chamadas desta rodada");
    run.chamadas++;
    const ctrl = new AbortController();
    const relogio = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (r.ok) return await r.json();
      motivo = "HTTP " + r.status;
      if ([400, 401, 404].includes(r.status)) break; // erro definitivo: repetir não adianta
    } catch (e) {
      motivo = e && e.name === "AbortError" ? "tempo esgotado" : String(e);
    } finally {
      clearTimeout(relogio);
    }
    if (t < TENTATIVAS) await sleep(1000 * t);
  }
  throw new Error(motivo);
}

// v2 primeiro (seguindo o cursor); se falhar logo na primeira página, usa v1 como reserva
async function buscar(run, w, desde) {
  try {
    const esports = []; let total = 0, cursor = null, parcial = false;
    for (let p = 0; p < MAX_PAGINAS; p++) {
      let url = `${DATA}/v2/trades?user=${w}&limit=${LIMITE}&start=${desde}`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      let b;
      try { b = await pedir(run, url); }
      catch (e) { if (p === 0) throw e; parcial = true; break; } // página seguinte falhou: usa o que já veio
      const lista = listaDe(b);
      total += lista.length;
      soEsports(lista, esports);
      cursor = cursorDe(b);
      if (!cursor || cursor === "LTE=" || lista.length === 0) break;
    }
    return { api: "v2", total, esports, parcial };
  } catch (e) {
    let motivo = "v2: " + e.message;
    try {
      const b = await pedir(run, `${DATA}/trades?user=${w}&limit=${LIMITE}&start=${desde}`);
      const lista = listaDe(b);
      const esports = []; soEsports(lista, esports);
      return { api: "v1", total: lista.length, esports, parcial: false };
    } catch (e2) { motivo += " | v1: " + e2.message; }
    console.error(`sem resposta para ${w.slice(0, 8)}: ${motivo}`);
    return null;
  }
}

// consulta as carteiras em lotes, sem disparar tudo de uma vez
async function lerCarteiras(run, carteiras, desde) {
  const saida = [];
  for (let i = 0; i < carteiras.length; i += CARTEIRAS_POR_LOTE) {
    const lote = carteiras.slice(i, i + CARTEIRAS_POR_LOTE);
    saida.push(...(await Promise.all(lote.map(c => buscar(run, c.w, desde)))));
    if (i + CARTEIRAS_POR_LOTE < carteiras.length) await sleep(PAUSA_MS);
  }
  return saida;
}

// envia um aviso ao ntfy: formato JSON; se falhar, tenta o formato simples
async function avisar(run, topico, titulo, corpo, tag, click) {
  if (run.chamadas < MAX_CHAMADAS) {
    run.chamadas++;
    try {
      const r = await fetch("https://ntfy.sh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topico, title: titulo, message: corpo, tags: [tag], ...(click ? { click } : {}) }),
      });
      if (r.ok) return true;
      console.error("ntfy (json) respondeu " + r.status + " (topico ..." + topico.slice(-4) + ")");
    } catch (e) { console.error("ntfy (json) falhou: " + e); }
  }
  if (run.chamadas >= MAX_CHAMADAS) { console.error("sem chamadas livres para avisar: " + titulo); return false; }
  run.chamadas++;
  try {
    // reserva: título só com caracteres básicos
    const t = titulo.normalize("NFD").replace(/[^\x20-\x7E]/g, "").trim() || "Aviso";
    const r = await fetch("https://ntfy.sh/" + encodeURIComponent(topico), {
      method: "POST", headers: { "Title": t, "Tags": tag }, body: corpo,
    });
    if (!r.ok) console.error("ntfy respondeu " + r.status + " (topico ..." + topico.slice(-4) + ")");
    return r.ok;
  } catch (e) { console.error("ntfy falhou: " + e); return false; }
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

async function vigiar(env, minuto) {
  const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
  if (!cfg || !cfg.topico || !cfg.carteiras || !cfg.carteiras.length) { console.log("rodada: nada para vigiar (0 carteiras ou sem topico)"); return; }
  const run = { chamadas: 0 };
  const estado = JSON.parse((await env.CFG.get(ESTADO)) || "{}");
  const desde = Math.floor(Date.now() / 1000) - JANELA_S;
  const resumo = { carteiras: cfg.carteiras.length, v2: 0, v1: 0, parciais: 0, erros: 0, trades: 0, novos: 0, avisosOk: 0, avisosFalha: 0, topico: "..." + cfg.topico.slice(-4) };

  const respostas = await lerCarteiras(run, cfg.carteiras, desde);
  const novas = [];
  let mudou = false;
  cfg.carteiras.forEach((c, i) => {
    const r = respostas[i];
    if (!r) { resumo.erros++; return; }
    resumo[r.api]++;
    if (r.parcial) resumo.parciais++;
    resumo.trades += r.total;
    const primeira = !(c.w in estado) && !(c.w in vistosMem); // primeira vez: só marca o que já existe
    const antigas = estado[c.w] || [];
    const vistos = new Set([...antigas, ...(vistosMem[c.w] || [])]);
    const novos = r.esports.filter(t => !vistos.has(chave(t)));
    const chavesAgora = r.esports.map(chave);
    vistosMem[c.w] = enxugar([...new Set([...(vistosMem[c.w] || []), ...chavesAgora])]);
    if (primeira || novos.length) {
      estado[c.w] = enxugar([...new Set([...antigas, ...chavesAgora])]);
      mudou = true;
    }
    if (!primeira) for (const t of novos) novas.push({ c, t });
  });
  resumo.novos = novas.length;

  let lista = novas;
  if (mudou) {
    try { await env.CFG.put(ESTADO, JSON.stringify(estado)); }
    catch (e) {
      // KV recusou (cota diária do plano grátis, por exemplo): avisa só o que é bem recente
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
    // título curto (cabe na tela de bloqueio); o resto vai no corpo
    const titulo = cortar(`${nome}: ${venda ? "vendeu" : "comprou"} ${t.outcome || "?"}`, 60);
    const corpo = `valor ${moeda(g.custo)}${g.n > 1 ? ` em ${g.n} execuções` : ""} · odd ${odd}\n${cortar(t.title || t.slug || "", 80)}`;
    const click = t.eventSlug ? "https://polymarket.com/event/" + t.eventSlug : "";
    const ok = await avisar(run, cfg.topico, titulo, corpo, venda ? "red_circle" : "green_circle", click);
    if (ok) resumo.avisosOk++; else resumo.avisosFalha++;
  }
  if (grupos.length > MAX_AVISOS) {
    await avisar(run, cfg.topico, `+${grupos.length - MAX_AVISOS} outras apostas`, "Muitas apostas de uma vez. Abra a página para ver todas.", "bell");
  }
  if (resumo.erros === cfg.carteiras.length && minuto % 30 === 0) {
    await avisar(run, cfg.topico, "Sem resposta da Polymarket", "Nenhuma carteira respondeu nesta rodada. O monitor continua tentando a cada minuto.", "warning");
  }
  console.log(`novos=${resumo.novos} trades=${resumo.trades} erros=${resumo.erros} | rodada ` + JSON.stringify({ ...resumo, chamadas: run.chamadas }));
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.headers.get("Authorization") !== "Bearer " + env.CHAVE) return resp("nao autorizado", 401);
    if (new URL(req.url).pathname !== "/config" || req.method !== "POST") return resp("ok");
    let b;
    try { b = (await req.json()) || {}; } catch (e) { return resp("json invalido", 400); }
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
    if (topico && carteiras.length) await avisar({ chamadas: 0 }, topico, "Servidor sincronizado", "Vigiando " + carteiras.length + " carteira(s) a cada minuto, mesmo com a página fechada.", "white_check_mark");
    return resp(JSON.stringify({ carteiras: carteiras.length }));
  },

  async scheduled(ev, env, ctx) {
    // se a rodada anterior ainda estiver rodando nesta instância, esta é pulada (evita aviso duplicado)
    if (Date.now() - travaMs < 120000) { console.log("rodada anterior ainda em andamento: esta foi pulada"); return; }
    const meu = (travaMs = Date.now());
    const minuto = new Date(ev.scheduledTime).getUTCMinutes();
    ctx.waitUntil(vigiar(env, minuto)
      .catch(async e => {
        console.error("vigiar falhou: " + e);
        try {
          const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
          if (cfg && cfg.topico && minuto % 15 === 0) await avisar({ chamadas: 0 }, cfg.topico, "Monitor com erro", String(e).slice(0, 200), "warning");
        } catch (e2) { console.error("aviso de erro falhou: " + e2); }
      })
      .finally(() => { if (travaMs === meu) travaMs = 0; }));
  },
};
