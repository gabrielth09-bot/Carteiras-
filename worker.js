// Worker Polymarket -> Telegram (versao com fila persistente e limites controlados)
// Mantem as configuracoes existentes: CFG, CHAVE, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
// Cron * * * * *, endpoints /config e /notify.
//
// Comportamento importante:
// - A primeira consulta de cada carteira apenas estabelece a linha de base, sem alertas antigos.
// - O excedente de alertas NAO e descartado: fica em fila no KV e sera enviado nas rodadas seguintes.
// - O estado e atualizado somente quando ha mudancas relevantes, nao uma vez por aposta.
// - O uso de fetch externo e limitado por rodada para respeitar o plano Workers Free.
// - Em caso de queda entre enviar uma mensagem e salvar o estado, pode haver duplicata (at-least-once),
//   preferivel a perder silenciosamente uma notificacao.

const DATA = "https://data-api.polymarket.com";
const ESPORT = /^(lol|cs2?|csgo|dota2?|valorant|val|r6(?:siege)?|codmw|cod|ow|rl|kog|hok|mlbb|sc2|starcraft)(?![a-z])/i;
const JANELA_S = 900; // mantem a janela original de 15 minutos e evita avisos antigos apos a migracao
const LIMITE_V2 = 1000; // limite maximo documentado para Data API v2
const LIMITE_V1 = 200;  // reserva conservadora para a API antiga
const MAX_PAGINAS = 3;
const MAX_CARTEIRAS = 20;
const MAX_AVISOS_POR_RODADA = 8; // e um lote maximo, NAO um limite que descarte o restante
const MAX_DATA_CALLS = 30; // 20 consultas iniciais + ate 10 paginacoes/reservas por rodada
const MAX_TOTAL_FETCHES = 48; // reserva chamadas para Telegram e criacao de topicos
const ESTADO = "estado3"; // novo estado: seen + fila pendente no mesmo objeto
const ESTADO_LEGADO = "estado2";
const TOPICOS = "topicos";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const resp = (t, s = 200) => new Response(t, { status: s, headers: CORS });

function novoOrcamento() { return { total: 0, data: 0 }; }
class OrcamentoEsgotado extends Error { constructor(msg = "orcamento de requisicoes da rodada esgotado") { super(msg); this.name = "OrcamentoEsgotado"; } }
async function fetchControlado(url, init, orcamento, tipo = "outro") {
  if (orcamento.total >= MAX_TOTAL_FETCHES) throw new OrcamentoEsgotado();
  if (tipo === "data" && orcamento.data >= MAX_DATA_CALLS) throw new OrcamentoEsgotado("orcamento de consultas a Polymarket esgotado");
  orcamento.total++;
  if (tipo === "data") orcamento.data++;
  return fetch(url, init);
}

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
function idPendente(w, t) { return `${w}|${chave(t)}`; }
function cursorDe(body) {
  if (!body || typeof body !== "object") return null;
  const p = body.pagination || body.meta || {};
  return p.next_cursor || p.nextCursor || body.next_cursor || body.nextCursor || null;
}
function listaDe(body) {
  return Array.isArray(body) ? body : (body && (body.data || body.events) || []);
}
function soEsports(lista) {
  const saida = [];
  for (const t of lista) {
    if (!t || typeof t !== "object") continue;
    const slug = t.eventSlug || t.event_slug || t.slug || "";
    if (ESPORT.test(slug)) {
      const n = normalizar(t);
      if (n) saida.push(n);
    }
  }
  return saida;
}
function montarUrlTrades(w, desde, cursor = null, v2 = true) {
  const path = v2 ? "/v2/trades" : "/trades";
  const u = new URL(DATA + path);
  u.searchParams.set("user", w);
  u.searchParams.set("limit", String(v2 ? LIMITE_V2 : LIMITE_V1));
  u.searchParams.set("start", String(desde));
  if (cursor) u.searchParams.set("cursor", String(cursor));
  return u.toString();
}
async function buscarPrimeira(c, desde, orcamento) {
  try {
    const r = await fetchControlado(montarUrlTrades(c.w, desde, null, true), undefined, orcamento, "data");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const b = await r.json();
    const lista = listaDe(b);
    return {
      api: "v2", total: lista.length, esports: soEsports(lista), cursor: cursorDe(b), pages: 1,
      incompleto: lista.length >= LIMITE_V2 && !cursorDe(b), erro: "",
    };
  } catch (e) {
    if (e instanceof OrcamentoEsgotado) return { api: null, total: 0, esports: [], cursor: null, pages: 0, erro: String(e), reservaPendente: true };
    return { api: null, total: 0, esports: [], cursor: null, pages: 0, erro: String(e) };
  }
}
async function buscarReserva(c, desde, orcamento) {
  try {
    const r = await fetchControlado(montarUrlTrades(c.w, desde, null, false), undefined, orcamento, "data");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const b = await r.json();
    const lista = listaDe(b);
    return { api: "v1", total: lista.length, esports: soEsports(lista), cursor: null, pages: 1,
      incompleto: lista.length >= LIMITE_V1, erro: "" };
  } catch (e) {
    return { api: null, total: 0, esports: [], cursor: null, pages: 0, erro: String(e) };
  }
}
async function buscarProximaPagina(c, atual, desde, orcamento) {
  try {
    const r = await fetchControlado(montarUrlTrades(c.w, desde, atual.cursor, true), undefined, orcamento, "data");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const b = await r.json();
    const lista = listaDe(b);
    atual.total += lista.length;
    atual.esports.push(...soEsports(lista));
    atual.pages++;
    atual.cursor = cursorDe(b);
    if (!atual.cursor && lista.length >= LIMITE_V2) atual.incompleto = true;
    return true;
  } catch (e) {
    atual.erroPagina = String(e);
    return false;
  }
}

const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pausa = ms => new Promise(r => setTimeout(r, ms));
const moeda = v => "US$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const limpar = (env, e) => { const tok = env.TELEGRAM_BOT_TOKEN; return tok ? String(e).split(tok).join("***") : String(e); };
function horaBrasilia(ms) {
  if (!ms) return "-";
  const d = new Date(ms - 3 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
const PARECE_MERCADO = /\b(winner|moneyline|handicap|spread|total|kills?|first blood|over|under)\b|\b(map|mapa|game|jogo|round|set)\s*\d+\b/i;
const ROTULO_MERCADO = /^(map handicap|handicap|map \d+ handicap|total maps|total kills|map \d+ winner|first blood)\s*:/i;
function separarTitulo(titulo) {
  const partes = String(titulo).split(" - ").map(p => p.trim());
  let partida = partes[0];
  let mercado = null;
  const rotulo = partida.match(/^([^:]+):\s*(.+)$/);
  if (rotulo && ROTULO_MERCADO.test(partida)) {
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
function nomeDoJogo(partida) {
  const i = partida.search(/\s+vs\s+/i);
  if (i < 0) return partida;
  const esq = partida.slice(0, i).replace(/^.*:\s*/, "");
  const dir = partida.slice(i).replace(/^\s+vs\s+/i, "");
  const limpa = s => s.replace(/\s*\([^)]*\)/g, "").trim();
  return `${limpa(esq)} vs ${limpa(dir)}`;
}

async function enviarTelegram(env, texto, html, topico, orcamento) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, status: 0, desc: "faltam token ou chat", espera: 0 };
  const corpo = { chat_id: env.TELEGRAM_CHAT_ID, text: texto, link_preview_options: { is_disabled: true } };
  if (html) corpo.parse_mode = "HTML";
  if (topico) corpo.message_thread_id = topico;
  try {
    const r = await fetchControlado("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
    }, orcamento, "telegram");
    let d = null;
    try { d = await r.json(); } catch (_) {}
    return { ok: r.ok && !!d && d.ok === true, status: r.status,
      desc: d && d.description ? String(d.description).slice(0, 120) : "",
      espera: d && d.parameters && d.parameters.retry_after ? Number(d.parameters.retry_after) : 0 };
  } catch (e) {
    return { ok: false, status: 0, desc: String(e), espera: 0 };
  }
}
async function avisar(env, titulo, corpo, click, topico, orcamento) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("telegram: faltam TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID");
    return { ok: false, desc: "faltam o token ou o chat" };
  }
  const link = click ? "\n" + click : "";
  const textoHtml = `<b>${esc(titulo)}</b>\n<blockquote>${esc(corpo)}</blockquote>${esc(link)}`;
  const textoPlano = `${titulo}\n${corpo}${link}`;
  let desc = "";
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    let r = await enviarTelegram(env, textoHtml, true, topico, orcamento);
    if (!r.ok && r.status === 400 && !/thread/i.test(r.desc)) {
      r = await enviarTelegram(env, textoPlano, false, topico, orcamento);
    }
    if (r.ok) return { ok: true, desc: "" };
    desc = r.desc;
    if (r.status === 429 || r.status >= 500 || r.status === 0) {
      if (tentativa === 0 && orcamento.total < MAX_TOTAL_FETCHES) {
        await pausa(Math.min(Math.max(r.espera || 1, 1), 5) * 1000);
        continue;
      }
    }
    return { ok: false, desc };
  }
  return { ok: false, desc };
}
async function criarTopico(env, nome, orcamento) {
  const r = await fetchControlado("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/createForumTopic", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, name: String(nome).slice(0, 100) }),
  }, orcamento, "telegram");
  let d = null;
  try { d = await r.json(); } catch (_) {}
  if (!d || d.ok !== true || !d.result) throw new Error(d && d.description ? String(d.description).slice(0, 120) : "HTTP " + r.status);
  return d.result.message_thread_id;
}
async function lerTopicos(env) {
  try { return JSON.parse((await env.CFG.get(TOPICOS)) || "{}") || {}; }
  catch (e) { console.error("KV topicos: leitura falhou: " + limpar(env, e)); return null; }
}

function agruparPendentes(pendentes) {
  const grupos = new Map();
  for (const item of pendentes) {
    const t = item.t;
    const k = [item.c.w, t.conditionId, t.outcome, String(t.side || "").toUpperCase()].join("|");
    let g = grupos.get(k);
    if (!g) {
      g = { c: item.c, t, cotas: 0, custo: 0, ms: 0, ids: [] };
      grupos.set(k, g);
    }
    const size = Number(t.size) || 0;
    const preco = Number(t.price) || 0;
    const ms = paraMs(t.timestamp);
    g.cotas += size;
    g.custo += size * preco;
    g.ids.push(item.id);
    if (ms && (!g.ms || ms < g.ms)) { g.ms = ms; if (!g.t.title && t.title) g.t = t; }
  }
  return [...grupos.values()].sort((x, y) => y.custo - x.custo);
}

async function carregarEstado(env) {
  const raw = await env.CFG.get(ESTADO);
  if (raw) {
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object" || !s.seen || typeof s.seen !== "object" || !Array.isArray(s.pending)) {
      throw new Error("formato invalido em " + ESTADO + "; estado nao foi reinicializado para evitar perder alertas");
    }
    return { version: 3, seen: s.seen, pending: s.pending };
  }
  // Migra a lista vista pelo Worker antigo. Mantem as carteiras marcadas e inicia a fila vazia.
  const legado = JSON.parse((await env.CFG.get(ESTADO_LEGADO)) || "{}");
  return { version: 3, seen: legado && typeof legado === "object" ? legado : {}, pending: [] };
}

async function vigiar(env) {
  const orcamento = novoOrcamento();
  const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
  if (!cfg || !Array.isArray(cfg.carteiras) || !cfg.carteiras.length) {
    console.log("rodada: nada para vigiar (0 carteiras)");
    return;
  }
  const carteiras = cfg.carteiras.slice(0, MAX_CARTEIRAS);
  const estado = await carregarEstado(env);
  const desde = Math.floor(Date.now() / 1000) - JANELA_S;
  const resumo = { carteiras: carteiras.length, v2: 0, v1: 0, erros: 0, trades: 0, novos: 0, avisosOk: 0, avisosFalha: 0, pendentes: estado.pending.length, paginacaoIncompleta: 0 };

  // Primeira pagina para todas as carteiras primeiro; as chamadas extra sao distribuidas
  // de forma rotativa para que carteiras no fim da lista nao fiquem sempre sem reserva/paginacao.
  const respostas = await Promise.all(carteiras.map(c => buscarPrimeira(c, desde, orcamento)));
  const inicio = carteiras.length ? Math.floor(Date.now() / 60000) % carteiras.length : 0;
  const ordem = carteiras.map((_, i) => (i + inicio) % carteiras.length);
  for (const i of ordem) {
    const c = carteiras[i];
    if (respostas[i].api) continue;
    const reserva = await buscarReserva(c, desde, orcamento);
    if (reserva.api) respostas[i] = reserva;
  }
  // No maximo uma pagina extra por carteira em cada passada; repete em ordem rotativa ate
  // esgotar o orcamento ou os cursores, respeitando MAX_PAGINAS por carteira.
  let houveProgresso = true;
  while (houveProgresso && orcamento.data < MAX_DATA_CALLS) {
    houveProgresso = false;
    for (const i of ordem) {
      const r = respostas[i];
      if (!r || r.api !== "v2" || !r.cursor || r.pages >= MAX_PAGINAS || orcamento.data >= MAX_DATA_CALLS) continue;
      const ok = await buscarProximaPagina(carteiras[i], r, desde, orcamento);
      houveProgresso = houveProgresso || ok;
    }
  }

  const pendingIds = new Set(estado.pending.map(p => p.id));
  let mudouEstado = false;
  for (let i = 0; i < carteiras.length; i++) {
    const c = carteiras[i];
    const r = respostas[i];
    if (!r || !r.api) { resumo.erros++; continue; }
    resumo[r.api]++;
    resumo.trades += r.total;
    if (r.incompleto || (r.api === "v2" && r.cursor)) resumo.paginacaoIncompleta++;
    const esports = r.esports || [];
    const primeira = !Object.prototype.hasOwnProperty.call(estado.seen, c.w);
    const chavesAgora = esports.map(chave);
    if (primeira) {
      // A linha de base nao dispara alertas antigos na primeira consulta da carteira.
      estado.seen[c.w] = chavesAgora;
      mudouEstado = true;
      continue;
    }
    const vistos = new Set(Array.isArray(estado.seen[c.w]) ? estado.seen[c.w] : []);
    const novosNestaResposta = new Set();
    for (const t of esports) {
      const k = chave(t);
      const id = idPendente(c.w, t);
      if (vistos.has(k) || pendingIds.has(id) || novosNestaResposta.has(id)) continue;
      novosNestaResposta.add(id);
      estado.pending.push({ id, c: { w: c.w, nome: String(c.nome || "").slice(0, 40) }, t });
      pendingIds.add(id);
      resumo.novos++;
      mudouEstado = true;
    }
    if (novosNestaResposta.size) estado.seen[c.w] = chavesAgora;
  }

  const grupos = agruparPendentes(estado.pending);
  const topicos = grupos.length ? await lerTopicos(env) : null;
  let topicosMudou = false;
  const entregues = new Set();
  for (const g of grupos.slice(0, MAX_AVISOS_POR_RODADA)) {
    if (orcamento.total >= MAX_TOTAL_FETCHES) break;
    const t = g.t;
    const pm = g.cotas > 0 ? g.custo / g.cotas : 0;
    const odd = pm > 0 ? (1 / pm).toFixed(2).replace(".", ",") : "-";
    const venda = String(t.side || "").toUpperCase() === "SELL";
    const nomeCarteira = g.c.nome || (g.c.w.slice(0, 6) + "..." + g.c.w.slice(-4));
    const oque = `${venda ? "vendeu" : "comprou"} ${t.outcome || "?"}`;
    const { partida, mercado, campeonato } = separarTitulo(t.title || t.slug || "?");
    const titulo = `Odd ${odd} · ${oque}`;
    const corpo = [
      `${venda ? "Valor bruto da venda" : "Valor bruto da compra"}: ${moeda(g.custo)}`,
      `Mercado: ${mercado || "Vencedor da partida"}`,
      `Carteira: ${nomeCarteira}`,
      campeonato ? `Campeonato: ${campeonato}` : null,
      `Hora: ${horaBrasilia(g.ms)}`,
    ].filter(x => x !== null).join("\n");
    const chaveP = String(t.eventSlug || partida);
    let topico = topicos && topicos[chaveP] ? topicos[chaveP].id : null;
    if (topicos && !topico) {
      try {
        topico = await criarTopico(env, nomeDoJogo(partida), orcamento);
        topicos[chaveP] = { id: topico, nome: nomeDoJogo(partida) };
        topicosMudou = true;
      } catch (e) {
        console.error("criar tópico falhou: " + limpar(env, e));
        topico = null; // entrega na conversa geral em vez de bloquear a notificacao
      }
    }
    let r = await avisar(env, titulo, corpo, "", topico, orcamento);
    if (!r.ok && topico && /thread/i.test(r.desc) && topicos) {
      try {
        topico = await criarTopico(env, nomeDoJogo(partida), orcamento);
        topicos[chaveP] = { id: topico, nome: nomeDoJogo(partida) };
        topicosMudou = true;
        r = await avisar(env, titulo, corpo, "", topico, orcamento);
      } catch (e) {
        console.error("recriar tópico falhou: " + limpar(env, e));
        r = await avisar(env, titulo, corpo, "", null, orcamento);
      }
    }
    if (r.ok) {
      resumo.avisosOk++;
      for (const id of g.ids) entregues.add(id);
    } else {
      resumo.avisosFalha++;
      console.error("aviso pendente para proxima rodada: " + (r.desc || "sem descricao"));
    }
  }

  if (topicosMudou) {
    try { await env.CFG.put(TOPICOS, JSON.stringify(topicos)); }
    catch (e) { console.error("KV topicos: gravacao falhou: " + limpar(env, e)); }
  }
  if (entregues.size) {
    estado.pending = estado.pending.filter(p => !entregues.has(p.id));
    mudouEstado = true;
  }
  resumo.pendentes = estado.pending.length;
  if (mudouEstado) {
    try { await env.CFG.put(ESTADO, JSON.stringify(estado)); }
    catch (e) {
      // Se o estado nao puder ser salvo, o lote entregue pode reaparecer (duplicata), mas a fila
      // antiga nao e apagada e nao se marca no log que a gravacao ocorreu.
      console.error("KV estado: gravacao falhou; uma notificacao pode repetir na proxima rodada: " + limpar(env, e));
    }
  }
  console.log(`novos=${resumo.novos} trades=${resumo.trades} erros=${resumo.erros} dataFetches=${orcamento.data} totalFetches=${orcamento.total} | rodada ` + JSON.stringify(resumo));
  // Falhas em algumas carteiras nao devem ficar invisiveis: alerta operacional no maximo
  // a cada 15 minutos. A mensagem e secundaria; alertas de apostas e fila continuam prioritarios.
  if (resumo.erros > 0 && new Date().getUTCMinutes() % 15 === 0 && orcamento.total < MAX_TOTAL_FETCHES) {
    await avisar(env, "Falha parcial de monitoramento",
      `${resumo.erros} de ${carteiras.length} carteiras nao puderam ser consultadas nesta rodada. Consulte os logs do Worker.`,
      "", null, orcamento);
  }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!env.CHAVE || req.headers.get("Authorization") !== "Bearer " + env.CHAVE) return resp("nao autorizado", 401);
    const caminho = new URL(req.url).pathname;
    if (req.method !== "POST" || (caminho !== "/config" && caminho !== "/notify")) return resp("ok");
    let b;
    try { b = await req.json(); } catch (_) { return resp("json invalido", 400); }
    if (!b || typeof b !== "object") return resp("json invalido", 400);
    const orcamento = novoOrcamento();

    if (caminho === "/notify") {
      const titulo = String(b.titulo || "Aviso de teste").slice(0, 100);
      const corpo = String(b.corpo || "Teste do servidor: se você recebeu esta mensagem, o Telegram está funcionando.").slice(0, 500);
      const click = typeof b.click === "string" && /^https:\/\/[^\s]{1,280}$/.test(b.click) ? b.click : "";
      const r = await avisar(env, titulo, corpo, click, null, orcamento);
      return resp(JSON.stringify({ ok: r.ok }), r.ok ? 200 : 502);
    }

    const carteiras = (Array.isArray(b.carteiras) ? b.carteiras : [])
      .filter(c => c && /^0x[0-9a-fA-F]{40}$/.test(c.w || ""))
      .slice(0, MAX_CARTEIRAS)
      .map(c => ({ w: c.w.toLowerCase(), nome: String(c.nome || "").slice(0, 40) }));
    const antigo = JSON.parse((await env.CFG.get("cfg")) || "null") || {};
    const topico = String(b.topico || antigo.topico || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    await env.CFG.put("cfg", JSON.stringify({ carteiras, topico }));

    // Limpa carteiras removidas do estado antigo e novo, mas preserva alertas ja enfileirados.
    const manter = new Set(carteiras.map(c => c.w));
    try {
      const legado = JSON.parse((await env.CFG.get(ESTADO_LEGADO)) || "{}");
      let mudou = false;
      for (const w of Object.keys(legado)) if (!manter.has(w)) { delete legado[w]; mudou = true; }
      if (mudou) await env.CFG.put(ESTADO_LEGADO, JSON.stringify(legado));
    } catch (e) { console.error("limpeza estado antigo falhou: " + limpar(env, e)); }
    try {
      const raw = await env.CFG.get(ESTADO);
      if (raw) {
        const estado = JSON.parse(raw);
        let mudou = false;
        for (const w of Object.keys(estado.seen || {})) if (!manter.has(w)) { delete estado.seen[w]; mudou = true; }
        if (mudou) await env.CFG.put(ESTADO, JSON.stringify(estado));
      }
    } catch (e) { console.error("limpeza estado falhou: " + limpar(env, e)); }

    let aviso = null;
    if (carteiras.length) {
      aviso = (await avisar(env, "Servidor sincronizado", `Vigiando ${carteiras.length} ${carteiras.length === 1 ? "carteira" : "carteiras"}.`, "", null, orcamento)).ok;
    }
    return resp(JSON.stringify({ carteiras: carteiras.length, aviso }));
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(vigiar(env).catch(async e => {
      console.error("vigiar falhou: " + limpar(env, e));
      try {
        const min = new Date(ev.scheduledTime).getUTCMinutes();
        if (min % 15 === 0) {
          const orcamento = novoOrcamento();
          await avisar(env, "Monitor com erro", limpar(env, e).slice(0, 200), "", null, orcamento);
        }
      } catch (e2) { console.error("aviso de erro falhou: " + limpar(env, e2)); }
    }));
  },
};
