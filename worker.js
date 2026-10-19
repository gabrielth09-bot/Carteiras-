// Worker: vigia as carteiras da Polymarket a cada 1 minuto e avisa pelo Telegram.
// Cada partida ganha um tópico no grupo, e os avisos dela vão para esse tópico.
// Precisa de: KV com binding "CFG", segredo "CHAVE", segredo "TELEGRAM_BOT_TOKEN",
// variável "TELEGRAM_CHAT_ID" (ID do grupo, começa com -100) e Cron "* * * * *".
// Usa a mesma consulta da página (Data API v2 primeiro, v1 como reserva).
const DATA = "https://data-api.polymarket.com";
const ESPORT = /^(lol|cs2?|csgo|dota2?|valorant|val|r6(?:siege)?|codmw|cod|ow|rl|kog|hok|mlbb|sc2|starcraft)(?![a-z])/i;
const JANELA_S = 900;    // só os últimos 15 minutos (o plano grátis tem 10 ms de CPU por rodada)
const LIMITE = 200;      // apostas por página
const MAX_PAGINAS = 3;   // carteiras com muitas execuções pequenas podem passar de uma página
const MAX_AVISOS = 8;    // apostas avisadas por rodada; o que passar disso vira um aviso-resumo
const vistosMem = {};    // memória desta instância: reserva caso o KV falhe
const ESTADO = "estado2"; // nome novo: na primeira rodada as carteiras só são marcadas, sem aviso
const TOPICOS = "topicos"; // partida -> tópico no grupo (guardado no KV)
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

const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pausa = ms => new Promise(r => setTimeout(r, ms));
const moeda = v => "US$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// tira o token de qualquer texto de erro antes de gravar no registro
const limpar = (env, e) => { const tok = env.TELEGRAM_BOT_TOKEN; return tok ? String(e).split(tok).join("***") : String(e); };
// hora de Brasília (UTC-3; o Brasil não usa horário de verão desde 2019), com segundos
function horaBrasilia(ms) {
  if (!ms) return "-";
  const d = new Date(ms - 3 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
// O título vem como "Partida - Mercado", "Partida - Mercado - Campeonato" ou "Partida - Campeonato"
// (quando o mercado é só quem vence a partida, não há trecho de mercado). Só vira mercado o trecho que parece mercado.
const PARECE_MERCADO = /\b(winner|moneyline|handicap|spread|total|kills?|first blood|over|under)\b|\b(map|mapa|game|jogo|round|set)\s*\d+\b/i;
// alguns mercados trazem o nome do mercado no começo do título: "Map Handicap: BCA (-1.5) vs Spirit Academy (BO3)"
const ROTULO_MERCADO = /^(map handicap|handicap|map \d+ handicap|total maps|total kills|map \d+ winner|first blood)\s*:/i;
function separarTitulo(titulo) {
  const partes = String(titulo).split(" - ").map(p => p.trim());
  let partida = partes[0];
  let mercado = null;
  const rotulo = partida.match(/^([^:]+):\s*(.+)$/);
  if (rotulo && ROTULO_MERCADO.test(partida)) {
    // mercado: "Map Handicap: BCA (-1.5)"; partida: "BCA vs Spirit Academy (BO3)" (sem a linha do handicap)
    const corpo = rotulo[2];
    const i = corpo.search(/\s+vs\s+/i);
    const lado = i >= 0 ? corpo.slice(0, i) : corpo;
    mercado = `${rotulo[1]}: ${lado}`;
    partida = i >= 0 ? lado.replace(/\s*\([+-]\d+(\.\d+)?\)/, "") + corpo.slice(i) : corpo;
  }
  const resto = [];
  for (const p of partes.slice(1)) {
    if (mercado === null && PARECE_MERCADO.test(p)) mercado = p;
    else resto.push(p);
  }
  return { partida, mercado, campeonato: resto.length ? resto.join(" - ") : null };
}

// uma chamada à API do Telegram (sendMessage). O token vai na URL, por isso a URL nunca é gravada nos registros.
// Com topico, a mensagem vai para dentro dele; sem topico, vai para a conversa geral do grupo.
async function enviarTelegram(env, texto, html, topico) {
  const corpo = { chat_id: env.TELEGRAM_CHAT_ID, text: texto, link_preview_options: { is_disabled: true } };
  if (html) corpo.parse_mode = "HTML";
  if (topico) corpo.message_thread_id = topico;
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

// título em negrito e detalhes numa citação (barra lateral); sem emoji e sem link de prévia.
// Devolve { ok, desc }: desc traz o motivo quando o Telegram recusa.
async function avisar(env, titulo, corpo, click, topico) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("telegram: faltam TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID");
    return { ok: false, desc: "faltam o token ou o chat" };
  }
  const link = click ? "\n" + click : "";
  const textoHtml = `<b>${esc(titulo)}</b>\n<blockquote>${esc(corpo)}</blockquote>${esc(link)}`;
  const textoPlano = `${titulo}\n${corpo}${link}`;
  let desc = "";
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      let r = await enviarTelegram(env, textoHtml, true, topico);
      // 400 = o Telegram não aceitou o formato: tenta de novo em texto simples (erro de tópico não depende do formato)
      if (!r.ok && r.status === 400 && !/thread/i.test(r.desc)) r = await enviarTelegram(env, textoPlano, false, topico);
      if (r.ok) return { ok: true, desc: "" };
      desc = r.desc;
      console.error("telegram respondeu " + r.status + (r.desc ? ": " + r.desc : ""));
      // 429 (muitas mensagens) e 5xx (falha do Telegram): uma segunda tentativa; outros erros não adiantam repetir
      if (tentativa === 0 && (r.status === 429 || r.status >= 500)) {
        await pausa(Math.min(Math.max(r.espera, 1), 5) * 1000);
        continue;
      }
      return { ok: false, desc };
    } catch (e) {
      console.error("telegram falhou: " + limpar(env, e));
      if (tentativa === 0) { await pausa(1000); continue; }
      return { ok: false, desc: "" };
    }
  }
  return { ok: false, desc };
}

// cria um tópico no grupo com o nome da partida e devolve o id dele
async function criarTopico(env, nome) {
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/createForumTopic", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, name: String(nome).slice(0, 100) }),
  });
  let d = null;
  try { d = await r.json(); } catch (e) { /* resposta sem JSON */ }
  if (!d || d.ok !== true || !d.result) {
    throw new Error(d && d.description ? String(d.description).slice(0, 120) : "HTTP " + r.status);
  }
  return d.result.message_thread_id;
}

// mapa partida -> tópico, guardado no KV. Se o KV não responder, devolve null e os avisos vão para a conversa geral.
async function lerTopicos(env) {
  try { return JSON.parse((await env.CFG.get(TOPICOS)) || "{}") || {}; }
  catch (e) { console.error("KV topicos: leitura falhou: " + limpar(env, e)); return null; }
}

// junta as execuções fracionadas: uma aposta (carteira + mercado + lado) vira UM aviso com o total
// e guarda a hora da primeira execução
function agrupar(novas) {
  const grupos = new Map();
  for (const { c, t } of novas) {
    const k = [c.w, t.conditionId, t.outcome, String(t.side || "").toUpperCase()].join("|");
    let g = grupos.get(k);
    if (!g) { g = { c, t, cotas: 0, custo: 0, ms: 0 }; grupos.set(k, g); }
    const size = Number(t.size) || 0, preco = Number(t.price) || 0;
    const ms = paraMs(t.timestamp);
    g.cotas += size; g.custo += size * preco;
    if (ms && (!g.ms || ms < g.ms)) g.ms = ms;
  }
  return [...grupos.values()].sort((x, y) => y.custo - x.custo);
}

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
  // cada partida tem o seu tópico: o mapa só é lido se houver aviso para mandar
  const topicos = grupos.length ? await lerTopicos(env) : null;
  let topicosMudou = false;
  for (const g of grupos.slice(0, MAX_AVISOS)) {
    const t = g.t;
    const pm = g.cotas > 0 ? g.custo / g.cotas : 0; // preço médio ponderado pelo tamanho
    const odd = pm > 0 ? (1 / pm).toFixed(2).replace(".", ",") : "-";
    const venda = String(t.side || "").toUpperCase() === "SELL";
    const nome = g.c.nome || (g.c.w.slice(0, 6) + "..." + g.c.w.slice(-4));
    const oque = `${venda ? "vendeu" : "comprou"} ${t.outcome || "?"}`;
    const { partida, mercado, campeonato } = separarTitulo(t.title || t.slug || "?");
    // a primeira linha (odd e o que foi feito) fica em negrito; os detalhes ficam na citação
    const titulo = `Odd ${odd} · ${oque}`;
    // a notificação mostra só as primeiras linhas (odd, entrada, mercado): por isso essa ordem
    const corpo = [
      `${venda ? "Recebido" : "Entrada"}: ${moeda(g.custo)}`,
      // título sem nome de mercado (só partida e campeonato): a aposta é no vencedor da partida
      `Mercado: ${mercado || "Vencedor da partida"}`,
      `Carteira: ${nome}`,
      campeonato ? `Campeonato: ${campeonato}` : null,
      `Hora: ${horaBrasilia(g.ms)}`,
    ].filter(x => x !== null).join("\n");
    // a partida tem um tópico só dela: é criado na primeira aposta e reaproveitado depois
    const chaveP = String(t.eventSlug || partida);
    const criar = async () => {
      const id = await criarTopico(env, partida);
      topicos[chaveP] = { id, nome: partida };
      topicosMudou = true;
      return id;
    };
    let topico = topicos && topicos[chaveP] ? topicos[chaveP].id : null;
    if (topicos && !topico) {
      try { topico = await criar(); }
      catch (e) { console.error("criar tópico falhou: " + limpar(env, e)); topico = null; }
    }
    let r = await avisar(env, titulo, corpo, "", topico);
    // o tópico foi apagado no Telegram: cria outro e manda de novo
    if (!r.ok && topico && /thread/i.test(r.desc)) {
      try { topico = await criar(); r = await avisar(env, titulo, corpo, "", topico); }
      catch (e) { console.error("recriar tópico falhou: " + limpar(env, e)); r = await avisar(env, titulo, corpo, "", null); }
    }
    if (r.ok) resumo.avisosOk++; else resumo.avisosFalha++;
  }
  if (topicosMudou) {
    try { await env.CFG.put(TOPICOS, JSON.stringify(topicos)); }
    catch (e) { console.error("KV topicos: gravar falhou: " + limpar(env, e)); }
  }
  if (grupos.length > MAX_AVISOS) {
    const sobra = grupos.length - MAX_AVISOS;
    await avisar(env, `+${sobra} ${sobra === 1 ? "outra aposta" : "outras apostas"}`, `Só as ${MAX_AVISOS} primeiras foram enviadas.`, "", null);
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
      // aviso avulso (botão de teste da página): título, texto e link opcional, tudo validado
      const titulo = String(b.titulo || "Aviso de teste").slice(0, 100);
      const corpo = String(b.corpo || "Teste do servidor: se você recebeu esta mensagem, o Telegram está funcionando.").slice(0, 500);
      const click = typeof b.click === "string" && /^https:\/\/[^\s]{1,280}$/.test(b.click) ? b.click : "";
      const r = await avisar(env, titulo, corpo, click, null);
      return resp(JSON.stringify({ ok: r.ok }), r.ok ? 200 : 502);
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
    if (carteiras.length) {
      const n = carteiras.length;
      aviso = (await avisar(env, "Servidor sincronizado", `Vigiando ${n} ${n === 1 ? "carteira" : "carteiras"}.`, "", null)).ok;
    }
    return resp(JSON.stringify({ carteiras: carteiras.length, aviso }));
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(vigiar(env).catch(async e => {
      console.error("vigiar falhou: " + limpar(env, e));
      try {
        const min = new Date(ev.scheduledTime).getUTCMinutes();
        if (min % 15 === 0) await avisar(env, "Monitor com erro", limpar(env, e).slice(0, 200), "", null);
      } catch (e2) { console.error("aviso de erro falhou: " + limpar(env, e2)); }
    }));
  },
};
