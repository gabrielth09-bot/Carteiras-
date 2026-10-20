// Worker Polymarket -> Telegram
// Compatibilidade: KV CFG, secret CHAVE, TELEGRAM_BOT_TOKEN, variável TELEGRAM_CHAT_ID,
// Cron * * * * *, endpoints POST /config e POST /notify, payload { carteiras: [{w, nome}] }.
// Estado persistente na chave estado3; migra de estado2 e preserva topicos.
// Entrega at-least-once: uma falha de KV depois do envio pode causar duplicata, nunca uma confirmação falsa.

const DATA = "https://data-api.polymarket.com";
const ESPORT = /(?:^|[-_])(lol|league-of-legends|cs2?|csgo|counter-strike|dota2?|dota-2|valorant|val|r6(?:siege)?|codmw|cod|ow|rl|rocket-league|kog|hok|mlbb|sc2|starcraft)(?:[-_]|$)/i;

// Plano Workers Free: no máximo 50 subrequests externas por invocação.
// Deixamos folga para retentativas do Telegram e criação de tópicos.
const LIMITE_V2 = 100; // limite deliberadamente menor que o máximo da API para limitar CPU/memória
const LIMITE_V1 = 100;
const MAX_PAGINAS_POR_CARTEIRA_RODADA = 3;
const MAX_CARTEIRAS = 20;
const MAX_AVISOS_POR_RODADA = 8; // lote de envio; excedente continua na fila
const MAX_DATA_CALLS = 24;
const MAX_TOTAL_FETCHES = 48;
const MAX_CONCURRENT_FETCHES = 4; // abaixo do limite de seis conexões simultâneas do Workers
const MAX_PENDING = 3000; // ao alcançar, pausa novas consultas e drena a fila sem descartar itens
const MAX_SEEN_PER_WALLET = 1500;
const OVERLAP_SECONDS = 120;
const API_INGESTION_LAG_SECONDS = 20;
const CHECKPOINT_INTERVAL_SECONDS = 1800;
const ESTADO = "estado3";
const ESTADO_LEGADO = "estado2";
const TOPICOS = "topicos";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};
const jsonResp = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const textResp = (text, status = 200) => new Response(text, {
  status, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
});

function novoOrcamento() { return { total: 0, data: 0 }; }
class OrcamentoEsgotado extends Error {
  constructor(msg = "orcamento de requisicoes da rodada esgotado") { super(msg); this.name = "OrcamentoEsgotado"; }
}
async function fetchControlado(url, init, orcamento, tipo = "outro") {
  if (orcamento.total >= MAX_TOTAL_FETCHES) throw new OrcamentoEsgotado();
  if (tipo === "data" && orcamento.data >= MAX_DATA_CALLS) {
    throw new OrcamentoEsgotado("orcamento de consultas a Polymarket esgotado");
  }
  orcamento.total++;
  if (tipo === "data") orcamento.data++;
  return fetch(url, init);
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function paraMs(ts) {
  if (ts === null || ts === undefined || ts === "") return 0;
  const n = Number(ts);
  if (Number.isFinite(n) && n !== 0) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(String(ts).trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(parsed) ? 0 : parsed;
}
function normalizar(t) {
  if (!t || typeof t !== "object") return null;
  return {
    conditionId: t.conditionId || t.condition_id || "",
    eventSlug: t.eventSlug || t.event_slug || "",
    slug: t.slug || "",
    title: t.title || t.market || "",
    outcome: t.outcome || t.outcome_name || "?",
    side: t.side || "",
    size: t.size,
    price: t.price,
    timestamp: t.timestamp || t.block_timestamp || t.match_time || t.created_at || 0,
    transactionHash: t.transactionHash || t.transaction_hash || t.txHash || t.tx_hash || "",
  };
}
// Mantém a chave compatível com estado3 produzido pela versão anterior, para não duplicar a fila antiga.
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
  if (Array.isArray(body)) return body; // compatibilidade com a API v1
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.events)) return body.events;
  throw new Error("resposta inesperada da Data API: lista de trades ausente");
}
function eEsports(t) {
  // Não deixa um eventSlug não relacionado esconder um slug de mercado que identifica e-sports.
  const slugs = [t.eventSlug, t.event_slug, t.slug, t.marketSlug, t.market_slug]
    .filter(x => typeof x === "string" && x.trim());
  return slugs.some(s => ESPORT.test(s));
}
function soEsports(rows) {
  const out = [];
  for (const t of rows) {
    if (!t || typeof t !== "object" || !eEsports(t)) continue;
    const n = normalizar(t);
    if (n) out.push(n);
  }
  return out;
}
function montarUrlTrades(w, start, end, cursor = null, api = "v2", offset = 0) {
  const v2 = api === "v2";
  const u = new URL(DATA + (v2 ? "/v2/trades" : "/trades"));
  u.searchParams.set("user", w);
  u.searchParams.set("limit", String(v2 ? LIMITE_V2 : LIMITE_V1));
  u.searchParams.set("start", String(start));
  u.searchParams.set("end", String(end));
  if (v2 && cursor) u.searchParams.set("cursor", String(cursor));
  // O endpoint legado usa offset. O cursor v2 não deve ser misturado a offset.
  if (!v2 && offset > 0) u.searchParams.set("offset", String(offset));
  return u.toString();
}

const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pausa = ms => new Promise(resolve => setTimeout(resolve, ms));
const moeda = v => "US$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const limpar = (env, e) => {
  const token = env.TELEGRAM_BOT_TOKEN;
  const secret = env.CHAVE;
  let s = String(e);
  if (token) s = s.split(token).join("***");
  if (secret) s = s.split(secret).join("***");
  return s;
};
function horaBrasilia(ms) {
  if (!ms) return "-";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toISOString().slice(11, 19);
  }
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

// Confronto só é reconhecido quando há dois lados explicitamente separados por vs/versus.
function extrairConfronto(texto) {
  const s = String(texto || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const m = s.match(/^(.+?)\s+(?:vs\.?|versus)\s+(.+?)(?:\s+(?:[-–—|])\s+.*)?$/i);
  if (!m) return null;
  const limparLado = value => String(value || "")
    .replace(/\s*\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:|–—-]+|[\s:|–—-]+$/g, "")
    .trim();
  const esquerda = limparLado(m[1]);
  const direita = limparLado(m[2]);
  if (!esquerda || !direita || /^(?:o\/u|over|under|yes|no)$/i.test(esquerda)) return null;
  return `${esquerda} vs ${direita}`.slice(0, 100);
}

function nomeDoJogo(partida) {
  return extrairConfronto(partida) || String(partida || "").trim();
}

// Em handicap, a seleção comprada identifica o time; o sinal da linha não é exibido.
function formatarLinhaMercado(mercado, outcome) {
  const m = String(mercado || "").trim();
  const escolha = String(outcome || "?").trim();
  const fallback = `${m || "Vencedor da partida"} — ${escolha}`;
  const match = m.match(/^(Map\s+\d+\s+Handicap|Map\s+Handicap|Handicap)\s*:\s*(.+?)\s*\(([+-]?\d+(?:[.,]\d+)?)\)\s*$/i);
  if (!match) return fallback;
  if (!escolha || /^(yes|no|sim|não|true|false)$/i.test(escolha)) return fallback;
  const timeDoTitulo = match[2].trim();
  const normalizarLado = value => String(value).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  const mesmoLado = normalizarLado(escolha) === normalizarLado(timeDoTitulo);
  const nomeMercado = match[1].replace(/\s+/g, " ").trim();
  const timeEscolhido = mesmoLado ? timeDoTitulo : escolha;
  return `${nomeMercado} — ${timeEscolhido}`;
}

function chaveTexto(valor) {
  return String(valor || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
const NOMES_JOGO_ESPORTS = new Set([
  "counter strike", "counter strike 2", "counter strike global offensive", "cs2", "csgo", "cs go",
  "dota", "dota 2", "league of legends", "lol", "valorant", "val", "rocket league",
  "rainbow six", "rainbow six siege", "r6 siege", "call of duty", "cod", "overwatch",
  "overwatch 2", "starcraft", "starcraft 2", "starcraft ii", "mobile legends", "mlbb",
  "honor of kings", "king of glory", "arena of valor", "age of empires", "esports", "e sports"
]);
function nomeGenericoDeJogo(valor) {
  return NOMES_JOGO_ESPORTS.has(chaveTexto(valor));
}
// Evita que o nome do próprio jogo (ex.: "Dota 2" ou "Counter Strike") seja exibido como campeonato.
// Se o título combinar jogo e torneio, remove apenas o segmento que identifica o jogo.
function normalizarCampeonato(valor) {
  if (typeof valor !== "string" || !valor.trim()) return null;
  const partes = valor.trim().split(/\s+(?:-|–|—|\|)\s+/).map(p => p.trim()).filter(Boolean);
  const validas = partes.filter(p => !nomeGenericoDeJogo(p) && !/^(esports|e-sports|gaming)$/i.test(p));
  const resultado = validas.join(" - ").replace(/^campeonato\s*:\s*/i, "").trim();
  return resultado && !nomeGenericoDeJogo(resultado) ? resultado : null;
}
function primeiroCampeonato(...valores) {
  for (const v of valores) {
    if (Array.isArray(v)) {
      const achado = primeiroCampeonato(...v);
      if (achado) return achado;
      continue;
    }
    if (v && typeof v === "object") {
      const achado = primeiroCampeonato(v.label, v.title, v.name, v.subtitle, v.ticker);
      if (achado) return achado;
      continue;
    }
    const nome = normalizarCampeonato(v);
    if (nome) return nome;
  }
  return null;
}
function extrairDadosEvento(evento) {
  if (!evento || typeof evento !== "object") return { confronto: null, campeonato: null, evento: null };
  const confronto = [evento.title, evento.name, evento.subtitle, evento.ticker, evento.slug]
    .map(extrairConfronto).find(Boolean) || null;
  const serieRaw = evento.series;
  const serie = Array.isArray(serieRaw) ? serieRaw[0] : serieRaw;
  const torneio = evento.tournament || evento.competition || evento.league;
  const campeonato = primeiroCampeonato(
    evento.seriesTitle, evento.series_title, evento.tournamentName, evento.tournament_name,
    evento.competitionName, evento.competition_name, evento.leagueName, evento.league_name,
    evento.championshipName, evento.championship_name,
    typeof serie === "object" && serie ? serie.title : null,
    typeof serie === "object" && serie ? serie.name : null,
    typeof serie === "object" && serie ? serie.subtitle : null,
    typeof serie === "object" && serie ? serie.ticker : null,
    torneio,
    evento.tags
  );
  return { confronto, campeonato, evento };
}

async function buscarMetadadosEvento(eventSlug, orcamento, cache) {
  const slug = String(eventSlug || "").trim();
  if (!slug || slug.length > 300) return null;
  if (cache.has(slug)) return cache.get(slug);
  const url = `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`;
  const r = await fetchControlado(url, { headers: { Accept: "application/json" } }, orcamento, "gamma");
  if (!r.ok) {
    cache.set(slug, null);
    return null;
  }
  let raw;
  try { raw = await r.json(); } catch (_) {
    cache.set(slug, null);
    return null;
  }
  const evento = Array.isArray(raw) ? raw[0] : raw;
  const meta = extrairDadosEvento(evento);
  cache.set(slug, meta);
  return meta;
}

function inicioDaPartida(meta, conditionId) {
  const evento = meta && meta.evento;
  if (!evento || typeof evento !== "object") return 0;
  const mercados = Array.isArray(evento.markets) ? evento.markets : [];
  const mercado = mercados.find(m => m && String(m.conditionId || m.condition_id || "").toLowerCase() === String(conditionId || "").toLowerCase());
  // gameStartTime é a fonte preferida para o horário previsto do jogo.
  const candidato = primeiroTexto(
    mercado && mercado.gameStartTime, mercado && mercado.game_start_time,
    mercado && mercado.eventStartTime, mercado && mercado.event_start_time,
    mercado && mercado.startTime, mercado && mercado.start_time,
    evento.gameStartTime, evento.game_start_time,
    evento.eventStartTime, evento.event_start_time,
    evento.startTime, evento.start_time
  );
  return paraMs(candidato);
}

async function resolverNomeTopico(t, partida, orcamento, cache) {
  const direto = extrairConfronto(partida) || extrairConfronto(t && t.title);
  if (direto) return direto;
  const eventSlug = String((t && t.eventSlug) || "").trim();
  if (!eventSlug) return null;
  try {
    const meta = await buscarMetadadosEvento(eventSlug, orcamento, cache);
    return meta && meta.confronto ? meta.confronto : null;
  } catch (e) {
    console.warn("metadados do evento indisponiveis; nao sera criado topico com nome de mercado: " + String(e).slice(0, 120));
    return null;
  }
}

async function enviarTelegram(env, texto, html, topico, orcamento) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, status: 0, desc: "faltam token ou chat", espera: 0 };
  }
  const body = { chat_id: env.TELEGRAM_CHAT_ID, text: texto, link_preview_options: { is_disabled: true } };
  if (html) body.parse_mode = "HTML";
  if (topico) body.message_thread_id = topico;
  try {
    const r = await fetchControlado(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, orcamento, "telegram");
    let d = null;
    try { d = await r.json(); } catch (_) {}
    return {
      ok: r.ok && !!d && d.ok === true,
      status: r.status,
      desc: d && d.description ? String(d.description).slice(0, 160) : "",
      espera: Number((d && d.parameters && d.parameters.retry_after) || r.headers.get("Retry-After") || 0),
    };
  } catch (e) {
    return { ok: false, status: 0, desc: limpar(env, e), espera: 0 };
  }
}
async function avisar(env, titulo, corpo, click, topico, orcamento) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("telegram: faltam TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID");
    return { ok: false, desc: "faltam o token ou o chat" };
  }
  const link = click ? "\n" + click : "";
  const htmlText = titulo ? `<b>${esc(titulo)}</b>\n<blockquote>${esc(corpo)}</blockquote>${esc(link)}` : `${esc(corpo)}${esc(link)}`;
  const plainText = titulo ? `${titulo}\n${corpo}${link}` : `${corpo}${link}`;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    let r = await enviarTelegram(env, htmlText, true, topico, orcamento);
    if (!r.ok && r.status === 400 && /parse entities|can't parse|cant parse|unsupported start tag|unsupported end tag/i.test(r.desc)) {
      r = await enviarTelegram(env, plainText, false, topico, orcamento);
    }
    if (r.ok) return { ok: true, desc: "" };
    if (r.status !== 429 && r.status < 500 && r.status !== 0) return { ok: false, desc: r.desc };
    if (tentativa === 0 && orcamento.total < MAX_TOTAL_FETCHES) {
      await pausa(Math.min(Math.max(Number(r.espera) || 1, 1), 5) * 1000);
      continue;
    }
    return { ok: false, desc: r.desc };
  }
  return { ok: false, desc: "falha de entrega ao Telegram" };
}
async function criarTopico(env, nome, orcamento) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error("faltam token ou chat");
  const r = await fetchControlado(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/createForumTopic`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, name: String(nome).slice(0, 100) }),
  }, orcamento, "telegram");
  let d = null;
  try { d = await r.json(); } catch (_) {}
  if (!r.ok || !d || d.ok !== true || !d.result) {
    throw new Error(d && d.description ? String(d.description).slice(0, 160) : "HTTP " + r.status);
  }
  return d.result.message_thread_id;
}
async function renomearTopico(env, topico, nome, orcamento) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error("faltam token ou chat");
  const r = await fetchControlado(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editForumTopic`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: topico, name: String(nome).slice(0, 100) }),
  }, orcamento, "telegram");
  let d = null;
  try { d = await r.json(); } catch (_) {}
  if (r.ok && d && d.ok === true) return true;
  if (d && /not modified/i.test(String(d.description || ""))) return true;
  throw new Error(d && d.description ? String(d.description).slice(0, 160) : "HTTP " + r.status);
}

async function lerTopicos(env) {
  const raw = await env.CFG.get(TOPICOS);
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("formato invalido");
    return value;
  } catch (e) {
    console.error("KV topicos: leitura falhou; avisos serao enviados ao topico geral: " + limpar(env, e));
    return null;
  }
}

function idTopico(valor) {
  if (valor && typeof valor === "object") return valor.id || null;
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : null;
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
    const price = Number(t.price) || 0;
    const ms = paraMs(t.timestamp);
    g.cotas += size;
    g.custo += size * price;
    g.ids.push(item.id);
    if (ms && (!g.ms || ms < g.ms)) g.ms = ms;
    if (!g.t.title && t.title) g.t = t;
  }
  // Prioriza os grupos mais antigos para não deixar um mercado de baixo volume eternamente na fila.
  return [...grupos.values()].sort((a, b) => (a.ms || 0) - (b.ms || 0));
}

function normalizarChaves(valor) {
  if (Array.isArray(valor)) return [...new Set(valor.filter(x => typeof x === "string"))];
  // Algumas versões antigas guardavam um mapa chave -> true em vez de uma lista.
  if (valor && typeof valor === "object") return Object.keys(valor).filter(k => valor[k]);
  return [];
}
async function carregarEstado(env) {
  const raw = await env.CFG.get(ESTADO);
  if (raw) {
    let s;
    try { s = JSON.parse(raw); } catch (_) { throw new Error("JSON invalido em " + ESTADO + "; estado mantido para evitar perder alertas"); }
    if (!s || typeof s !== "object" || !s.seen || typeof s.seen !== "object" || !Array.isArray(s.pending)) {
      throw new Error("formato invalido em " + ESTADO + "; estado mantido para evitar perder alertas");
    }
    const pendingMap = new Map();
    for (const p of s.pending) {
      if (!p || typeof p.id !== "string" || !p.c || typeof p.c.w !== "string" || !p.t || typeof p.t !== "object") {
        throw new Error("item invalido na fila pendente; estado mantido para evitar perder alertas");
      }
      if (!pendingMap.has(p.id)) pendingMap.set(p.id, p);
    }
    const seen = {};
    for (const [w, keys] of Object.entries(s.seen)) seen[w] = normalizarChaves(keys);
    const sync = s.sync && typeof s.sync === "object" ? s.sync : {};
    // A presença de um ciclo no KV significa que o cursor foi persistido em uma execução anterior.
    for (const p of Object.values(sync)) if (p && p.cycle && typeof p.cycle === "object") p.cycle.persisted = true;
    return {
      version: 4,
      seen,
      pending: [...pendingMap.values()],
      sync,
      checkpointAt: Number(s.checkpointAt) || Math.floor(Date.now() / 1000),
    };
  }
  const legacyRaw = await env.CFG.get(ESTADO_LEGADO);
  let legacy = {};
  if (legacyRaw) {
    try {
      const parsed = JSON.parse(legacyRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) legacy = parsed;
      else console.error("estado2 tem formato desconhecido; a chave antiga foi preservada");
    } catch (e) { console.error("estado2 nao pode ser migrado: " + limpar(env, e)); }
  }
  const seen = {};
  for (const [w, keys] of Object.entries(legacy)) seen[w] = normalizarChaves(keys);
  return { version: 4, seen, pending: [], sync: {}, checkpointAt: Math.floor(Date.now() / 1000) };
}
function progressoInicial(since) { return { watermark: since - 1, cycle: null }; }
function iniciarCiclo(progresso, since, agora) {
  const start = Math.max(since, (Number(progresso.watermark) || (since - 1)) - OVERLAP_SECONDS);
  const end = agora - API_INGESTION_LAG_SECONDS;
  if (end < start) return false;
  progresso.cycle = { start, end, api: "v2", cursor: null, offset: 0, pages: 0, persisted: false };
  return true;
}
function temMaisDaResposta(api, body, rows) {
  if (api === "v2") return cursorDe(body);
  // Endpoint legado: se a pagina veio cheia, tenta a pagina seguinte por offset.
  return rows.length >= LIMITE_V1 ? `v1:${rows.length}` : null;
}
function chavePendentePresente(state, id) { return state.pending.some(p => p.id === id); }

async function pedirPaginaV2(w, cycle, orcamento) {
  const url = montarUrlTrades(w, cycle.start, cycle.end, cycle.cursor, "v2", 0);
  const r = await fetchControlado(url, { headers: { Accept: "application/json" } }, orcamento, "data");
  if (!r.ok) {
    let message = "HTTP " + r.status;
    try { const body = await r.json(); if (body && body.error) message = String(body.error).slice(0, 160); } catch (_) {}
    const e = new Error(message); e.status = r.status; throw e;
  }
  const body = await r.json();
  const rows = listaDe(body);
  if (rows.length >= LIMITE_V2 && !cursorDe(body)) {
    throw new Error("pagina v2 cheia sem cursor; ciclo nao confirmado para evitar pular trades");
  }
  return { body, rows, api: "v2" };
}
async function pedirPaginaV1(w, cycle, orcamento) {
  const offset = Number(String(cycle.cursor || "v1:0").split(":")[1]) || 0;
  const url = montarUrlTrades(w, cycle.start, cycle.end, null, "v1", offset);
  const r = await fetchControlado(url, { headers: { Accept: "application/json" } }, orcamento, "data");
  if (!r.ok) {
    let message = "HTTP " + r.status;
    try { const body = await r.json(); if (body && body.error) message = String(body.error).slice(0, 160); } catch (_) {}
    const e = new Error(message); e.status = r.status; throw e;
  }
  const body = await r.json();
  return { body, rows: listaDe(body), api: "v1", offset };
}

async function buscarProcessarPagina(c, state, pendingIds, orcamento, flags) {
  const w = c.w;
  const progress = state.sync[w];
  const cycle = progress.cycle;
  if (!cycle) return { ok: false, more: false, attempted: false };
  let page;
  try {
    if (cycle.api === "v1") {
      page = await pedirPaginaV1(w, cycle, orcamento);
    } else {
      try {
        page = await pedirPaginaV2(w, cycle, orcamento);
      } catch (e) {
        // Falhas transitórias/restrição de recursos não devem provocar consulta de reserva em duplicidade.
        const terminalV2 = e && [400, 404, 405].includes(Number(e.status));
        if (cycle.pages > 0 || !terminalV2) throw e;
        console.error(`v2 recusou a consulta da carteira ${w.slice(0, 6)}...; tentando v1: ${limpar(flags.env, e)}`);
        page = await pedirPaginaV1(w, { ...cycle, cursor: "v1:0" }, orcamento);
      }
    }
  } catch (e) {
    flags.erros++;
    console.error(`consulta de trades falhou para ${w.slice(0, 6)}...: ${limpar(flags.env, e)}`);
    return { ok: false, more: false, attempted: true };
  }

  const rows = soEsports(page.rows);
  const seenArray = Array.isArray(state.seen[w]) ? state.seen[w] : [];
  const seen = new Set(seenArray);
  let seenChanged = false;
  const cycleStartMs = cycle.start * 1000;
  const cycleEndMs = cycle.end * 1000 + 999;
  const sinceMs = Number(c.since) * 1000;

  for (const t of rows) {
    const ms = paraMs(t.timestamp);
    // Sem timestamp não é possível respeitar a regra de não alertar operações anteriores à ativação.
    if (!ms || ms < sinceMs || ms < cycleStartMs || ms > cycleEndMs) continue;
    const k = chave(t);
    if (!seen.has(k)) { seen.add(k); seenChanged = true; }
    const id = idPendente(w, t);
    if (pendingIds.has(id)) continue;
    if (state.seen[w] && state.seen[w].includes(k)) continue;
    state.pending.push({ id, c: { w, nome: String(c.nome || "").slice(0, 40) }, t });
    pendingIds.add(id);
    flags.novos++;
    flags.dirty = true;
  }
  if (seenChanged) {
    state.seen[w] = [...seen].slice(-MAX_SEEN_PER_WALLET);
    flags.dirty = true;
  }

  flags.trades += page.rows.length;
  if (page.api === "v2") flags.pagesV2++; else flags.pagesV1++;
  const more = temMaisDaResposta(page.api, page.body, page.rows);
  cycle.api = page.api;
  cycle.pages = (Number(cycle.pages) || 0) + 1;
  if (page.api === "v2") {
    cycle.cursor = more ? String(more) : null;
    cycle.offset = 0;
  } else {
    const offset = Number(page.offset || 0);
    cycle.offset = offset;
    cycle.cursor = more ? `v1:${offset + page.rows.length}` : null;
  }
  if (cycle.cursor) {
    cycle.persisted = true;
    flags.dirty = true; // Cursor persistente para continuar paginação na próxima execução.
    return { ok: true, more: true, attempted: true };
  }

  const cycleHadBeenPersisted = cycle.persisted === true;
  progress.watermark = cycle.end;
  progress.cycle = null;
  if (cycleHadBeenPersisted) flags.dirty = true; // Remove ciclo persistido e confirma o checkpoint concluído.
  flags.completados++;
  return { ok: true, more: false, attempted: true };
}

async function vigiar(env) {
  const orcamento = novoOrcamento();
  const rawCfg = await env.CFG.get("cfg");
  let cfg;
  try { cfg = rawCfg ? JSON.parse(rawCfg) : null; }
  catch (_) { throw new Error("JSON invalido na configuracao cfg; nenhuma carteira foi alterada"); }
  if (cfg && (!Array.isArray(cfg.carteiras))) throw new Error("formato invalido em cfg.carteiras");
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  let carteiras = cfg && Array.isArray(cfg.carteiras) ? cfg.carteiras.slice(0, MAX_CARTEIRAS) : [];
  let cfgDirty = false;
  carteiras = carteiras.filter(c => c && /^0x[0-9a-fA-F]{40}$/.test(c.w || "")).map(c => {
    let since = Number(c.since);
    if (!Number.isFinite(since) || since <= 0) { since = Math.ceil(nowMs / 1000); cfgDirty = true; }
    return { w: c.w.toLowerCase(), nome: String(c.nome || "").slice(0, 40), since };
  });
  if (cfgDirty) await env.CFG.put("cfg", JSON.stringify({ ...(cfg || {}), carteiras }));

  const state = await carregarEstado(env);
  const flags = { env, dirty: false, novos: 0, erros: 0, completados: 0, trades: 0, pagesV2: 0, pagesV1: 0 };
  const existingSync = state.sync && typeof state.sync === "object" ? state.sync : {};
  state.sync = existingSync;
  const activeWallets = new Set(carteiras.map(c => c.w));
  const queuedWallets = new Set(state.pending.map(p => p.c.w.toLowerCase()));
  // Limpeza de estado antigo dentro da gravação periódica, não no POST /config,
  // para evitar que uma gravação concorrente da configuração sobrescreva estado recém-atualizado.
  for (const w of Object.keys(state.seen)) {
    if (!activeWallets.has(w.toLowerCase()) && !queuedWallets.has(w.toLowerCase())) {
      delete state.seen[w]; flags.dirty = true;
    }
  }
  for (const w of Object.keys(state.sync)) {
    if (!activeWallets.has(w.toLowerCase()) && !queuedWallets.has(w.toLowerCase())) {
      delete state.sync[w]; flags.dirty = true;
    }
  }
  for (const c of carteiras) {
    if (!state.sync[c.w] || typeof state.sync[c.w] !== "object") {
      state.sync[c.w] = progressoInicial(c.since);
      flags.dirty = true;
    } else {
      const p = state.sync[c.w];
      if (!Number.isFinite(Number(p.watermark))) { p.watermark = c.since - 1; flags.dirty = true; }
      if (!Object.prototype.hasOwnProperty.call(p, "cycle")) p.cycle = null;
    }
  }

  const resumo = {
    carteiras: carteiras.length, v2: 0, v1: 0, erros: 0, trades: 0, novos: 0,
    avisosOk: 0, avisosFalha: 0, pendentes: state.pending.length, paginasIncompletas: 0,
    fetchData: 0, fetchTotal: 0, backlogPausado: false,
  };
  const pendingIds = new Set(state.pending.map(p => p.id));

  // Backlog alto: não avança cursores nem consulta mais operações; primeiro drena a fila.
  if (state.pending.length < MAX_PENDING && carteiras.length) {
    // Um ciclo novo é preparado em memória; ciclos com cursor são persistidos quando necessário.
    for (const c of carteiras) {
      const p = state.sync[c.w];
      if (!p.cycle) iniciarCiclo(p, c.since, nowSec);
    }
    const ordemInicial = carteiras.map((_, i) => i);
    const rotacao = carteiras.length ? Math.floor(nowSec / 60) % carteiras.length : 0;
    const ordem = [...ordemInicial.slice(rotacao), ...ordemInicial.slice(0, rotacao)];
    const chamadasRodada = new Map(carteiras.map(c => [c.w, 0]));
    const bloqueadas = new Set();

    await mapLimit(ordem, MAX_CONCURRENT_FETCHES, async i => {
      const c = carteiras[i];
      const cycleBefore = state.sync[c.w].cycle;
      if (!cycleBefore || cycleBefore.end < cycleBefore.start) return;
      const r = await buscarProcessarPagina(c, state, pendingIds, orcamento, flags);
      if (r.attempted) chamadasRodada.set(c.w, 1);
      if (!r.ok) bloqueadas.add(c.w);
      if (r.ok && r.more) resumo.paginasIncompletas++;
    });

    // Paginacao adicional justa: no maximo 8 chamadas extras de dados, em ordem rotativa.
    while (orcamento.data < MAX_DATA_CALLS && orcamento.total < MAX_TOTAL_FETCHES) {
      const candidatos = ordem.map(i => carteiras[i]).filter(c => {
        const p = state.sync[c.w];
        return p && p.cycle && p.cycle.cursor && (chamadasRodada.get(c.w) || 0) < MAX_PAGINAS_POR_CARTEIRA_RODADA && !bloqueadas.has(c.w);
      });
      if (!candidatos.length) break;
      const batch = candidatos.slice(0, Math.min(MAX_CONCURRENT_FETCHES, MAX_DATA_CALLS - orcamento.data));
      if (!batch.length) break;
      await mapLimit(batch, MAX_CONCURRENT_FETCHES, async c => {
        const r = await buscarProcessarPagina(c, state, pendingIds, orcamento, flags);
        chamadasRodada.set(c.w, (chamadasRodada.get(c.w) || 0) + (r.attempted ? 1 : 0));
        if (!r.ok) bloqueadas.add(c.w);
        if (r.ok && r.more) resumo.paginasIncompletas++;
      });
    }
  } else if (state.pending.length >= MAX_PENDING) {
    resumo.backlogPausado = true;
    console.warn(`backlog com ${state.pending.length} itens; novas consultas pausadas para priorizar a fila`);
  }

  // Prepara tópicos de todo o lote e persiste o mapa UMA vez antes dos envios.
  // A cache de metadados também será reutilizada para campeonato e hora de início.
  const grupos = agruparPendentes(state.pending);
  const lote = grupos.slice(0, MAX_AVISOS_POR_RODADA);
  const topicos = lote.length ? await lerTopicos(env) : null;
  const topicByGroup = new Map();
  const groupsNeedingTopicCommit = new Set();
  const metadadosEventos = new Map();
  // Alguns títulos de mercado incluem o torneio e outros, da mesma partida, incluem apenas o jogo.
  // Aproveita um nome válido encontrado em qualquer mercado do lote para padronizar os alertas do evento.
  const campeonatosPorEvento = new Map();
  for (const grupo of lote) {
    const slugEvento = String(grupo.t && grupo.t.eventSlug || "").trim();
    if (!slugEvento || campeonatosPorEvento.has(slugEvento)) continue;
    const nome = normalizarCampeonato(separarTitulo(grupo.t.title || grupo.t.slug || "?").campeonato);
    if (nome) campeonatosPorEvento.set(slugEvento, nome);
  }
  let topicosMudou = false;
  if (topicos) {
    for (const g of lote) {
      const t = g.t;
      const tituloMercado = t.title || t.slug || "?";
      const { partida } = separarTitulo(tituloMercado);
      const keyTopic = String(t.eventSlug || partida);
      const salvo = topicos[keyTopic];
      const salvoNome = salvo && typeof salvo === "object" ? String(salvo.nome || "") : "";
      let topicId = idTopico(salvo);
      let nomeTopico = extrairConfronto(salvoNome);
      if (!nomeTopico) nomeTopico = await resolverNomeTopico(t, partida, orcamento, metadadosEventos);

      if (!topicId) {
        if (!nomeTopico) {
          console.warn("topico nao criado: confronto nao identificado com seguranca para " + String(t.eventSlug || partida).slice(0, 120));
          topicByGroup.set(g, { id: null, keyTopic, nome: null });
          continue;
        }
        try {
          topicId = await criarTopico(env, nomeTopico, orcamento);
          topicos[keyTopic] = { id: topicId, nome: nomeTopico };
          topicosMudou = true;
          groupsNeedingTopicCommit.add(g);
        } catch (e) {
          console.error("criar topico falhou: " + limpar(env, e));
          topicId = null;
        }
      } else if (nomeTopico && nomeTopico !== salvoNome) {
        try {
          await renomearTopico(env, topicId, nomeTopico, orcamento);
          topicos[keyTopic] = { id: topicId, nome: nomeTopico };
          topicosMudou = true;
          groupsNeedingTopicCommit.add(g);
        } catch (e) {
          console.error("renomear topico falhou; o alerta sera enviado ao topico existente: " + limpar(env, e));
          nomeTopico = salvoNome || nomeTopico;
        }
      }
      if (!nomeTopico && topicId && salvoNome) nomeTopico = salvoNome;
      topicByGroup.set(g, { id: topicId, keyTopic, nome: nomeTopico });
    }
  }
  let topicosCommitOk = true;
  if (topicosMudou) {
    try { await env.CFG.put(TOPICOS, JSON.stringify(topicos)); }
    catch (e) {
      topicosCommitOk = false;
      console.error("KV topicos: gravacao falhou; alertas que precisem de um topico novo serao adiados: " + limpar(env, e));
    }
  }

  // Envio é separado da descoberta; filas que falham continuam persistidas para a próxima rodada.
  const entregues = new Set();
  for (let indiceGrupo = 0; indiceGrupo < lote.length; indiceGrupo++) {
    const g = lote[indiceGrupo];
    if (orcamento.total >= MAX_TOTAL_FETCHES) break;
    if (groupsNeedingTopicCommit.has(g) && !topicosCommitOk) continue;
    const t = g.t;
    const pm = g.cotas > 0 ? g.custo / g.cotas : 0;
    const odd = pm > 0 ? (1 / pm).toFixed(2).replace(".", ",") : "-";
    const venda = String(t.side || "").toUpperCase() === "SELL";
    const nomeCarteira = g.c.nome || (g.c.w.slice(0, 6) + "..." + g.c.w.slice(-4));
    const { partida, mercado, campeonato } = separarTitulo(t.title || t.slug || "?");
    let metaEvento = t.eventSlug ? metadadosEventos.get(String(t.eventSlug).trim()) || null : null;
    // Só consulta a Gamma se houver margem para preservar o envio de todo o lote.
    const reservaEnviosRestantes = (lote.length - indiceGrupo) * 2;
    if (!metaEvento && t.eventSlug && orcamento.total + 1 + reservaEnviosRestantes <= MAX_TOTAL_FETCHES) {
      try { metaEvento = await buscarMetadadosEvento(t.eventSlug, orcamento, metadadosEventos); }
      catch (e) { console.warn("nao foi possivel consultar metadados para enriquecer o alerta: " + String(e).slice(0, 120)); }
    }
    const mercadoMensagem = mercado || (t.title && PARECE_MERCADO.test(t.title) && !extrairConfronto(t.title) ? t.title : null);
    const inicioMs = inicioDaPartida(metaEvento, t.conditionId);
    const campeonatoMensagem = normalizarCampeonato(metaEvento && metaEvento.campeonato)
      || normalizarCampeonato(campeonato)
      || campeonatosPorEvento.get(String(t.eventSlug || "").trim())
      || null;
    // Sem título personalizado: tudo é texto simples para facilitar copiar a mensagem.
    const titulo = "";
    const linhas = [
      `${nomeCarteira} — ${moeda(g.custo)}`,
      "",
      formatarLinhaMercado(mercadoMensagem, t.outcome),
      "",
      `Odd da compra: ${odd}`,
      `Horário da aposta: ${horaBrasilia(g.ms)}`,
      campeonatoMensagem ? `Campeonato: ${campeonatoMensagem}` : null,
      inicioMs ? `Início da partida: ${horaBrasilia(inicioMs).slice(0, 5)}` : null,
      "───────────────────",
    ].filter(x => x !== null);
    const corpo = linhas.join("\n");
    const prepared = topicByGroup.get(g) || { id: null, keyTopic: String(t.eventSlug || partida), nome: null };
    let topicId = prepared.id;
    let result = await avisar(env, titulo, corpo, "", topicId, orcamento);
    if (!result.ok && topicId && /thread/i.test(result.desc) && topicos) {
      try {
        const nomeSubstituto = extrairConfronto(prepared.nome) || extrairConfronto(partida) || (metaEvento && metaEvento.confronto);
        if (!nomeSubstituto) throw new Error("confronto nao identificado; recusando criar topico com nome de mercado");
        const replacement = await criarTopico(env, nomeSubstituto, orcamento);
        topicos[prepared.keyTopic] = { id: replacement, nome: nomeSubstituto };
        // Tente persistir o tópico substituto antes de marcar a notificação como entregue.
        await env.CFG.put(TOPICOS, JSON.stringify(topicos));
        topicId = replacement;
        result = await avisar(env, titulo, corpo, "", topicId, orcamento);
      } catch (e) {
        console.error("recriar topico falhou: " + limpar(env, e));
        result = await avisar(env, titulo, corpo, "", null, orcamento);
      }
    }
    if (result.ok) {
      resumo.avisosOk++;
      for (const id of g.ids) entregues.add(id);
    } else {
      resumo.avisosFalha++;
      console.error("aviso permanece na fila: " + limpar(env, result.desc || "sem descricao"));
    }
  }
  if (entregues.size) {
    state.pending = state.pending.filter(p => !entregues.has(p.id));
    flags.dirty = true;
  }

  // Checkpoint em lote para evitar escrita KV a cada minuto sem novas operacoes.
  const precisaCheckpoint = nowSec - (Number(state.checkpointAt) || nowSec) >= CHECKPOINT_INTERVAL_SECONDS;
  if (precisaCheckpoint) flags.dirty = true;
  if (flags.dirty) {
    state.version = 4;
    state.checkpointAt = nowSec;
    resumo.fetchData = orcamento.data;
    resumo.fetchTotal = orcamento.total;
    resumo.novos = flags.novos;
    resumo.pendentes = state.pending.length;
    try {
      await env.CFG.put(ESTADO, JSON.stringify(state));
    } catch (e) {
      // At-least-once: se o envio já foi aceito pelo Telegram, o próximo ciclo pode repetir a mensagem.
      console.error("KV estado: gravacao falhou; fila antiga preservada onde o KV permitir: " + limpar(env, e));
    }
  } else {
    resumo.fetchData = orcamento.data;
    resumo.fetchTotal = orcamento.total;
    resumo.novos = flags.novos;
    resumo.pendentes = state.pending.length;
  }
  resumo.erros += flags.erros;
  resumo.trades = flags.trades;
  resumo.v2 = flags.pagesV2;
  resumo.v1 = flags.pagesV1;
  console.log(`novos=${resumo.novos} trades=${resumo.trades} erros=${resumo.erros} | rodada ` + JSON.stringify(resumo));

  // Alerta operacional limitado a uma vez por quarto de hora.
  if (resumo.erros > 0 && Math.floor(nowSec / 60) % 15 === 0 && orcamento.total < MAX_TOTAL_FETCHES) {
    await avisar(env, "Falha parcial de monitoramento",
      `${resumo.erros} consulta(s) falharam nesta rodada. Veja os logs do Worker; a fila pendente foi mantida.`, "", null, orcamento);
  }
}

function normalizarListaConfig(lista, antigoCfg, agora) {
  const antiga = new Map((Array.isArray(antigoCfg && antigoCfg.carteiras) ? antigoCfg.carteiras : [])
    .filter(c => c && /^0x[0-9a-fA-F]{40}$/.test(c.w || ""))
    .map(c => [c.w.toLowerCase(), c]));
  const vistos = new Set();
  const result = [];
  for (const c of lista) {
    if (result.length >= MAX_CARTEIRAS) break;
    if (!c || !/^0x[0-9a-fA-F]{40}$/.test(c.w || "")) continue;
    const w = c.w.toLowerCase();
    if (vistos.has(w)) continue;
    vistos.add(w);
    const old = antiga.get(w);
    let since = Number(old && old.since);
    if (!Number.isFinite(since) || since <= 0) since = Math.ceil(agora / 1000);
    result.push({ w, nome: String(c.nome || "").slice(0, 40), since });
  }
  return result;
}

let scheduledRunning = false;

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.CHAVE || req.headers.get("Authorization") !== `Bearer ${env.CHAVE}`) return textResp("nao autorizado", 401);
    const pathname = new URL(req.url).pathname;
    if (req.method !== "POST") return textResp("metodo nao permitido", 405);
    if (pathname !== "/config" && pathname !== "/notify") return textResp("nao encontrado", 404);
    let body;
    try { body = await req.json(); } catch (_) { return jsonResp({ ok: false, error: "json invalido" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResp({ ok: false, error: "json invalido" }, 400);
    const orcamento = novoOrcamento();

    if (pathname === "/notify") {
      const title = String(body.titulo || "Aviso de teste").slice(0, 100);
      const text = String(body.corpo || "Teste do servidor: se você recebeu esta mensagem, o Telegram está funcionando.").slice(0, 500);
      const click = typeof body.click === "string" && /^https:\/\/[^\s]{1,280}$/.test(body.click) ? body.click : "";
      const result = await avisar(env, title, text, click, null, orcamento);
      return jsonResp({ ok: result.ok }, result.ok ? 200 : 502);
    }

    if (!Object.prototype.hasOwnProperty.call(body, "carteiras") || !Array.isArray(body.carteiras)) {
      return jsonResp({ ok: false, error: "carteiras deve ser uma lista" }, 400);
    }
    if (body.carteiras.length > MAX_CARTEIRAS) {
      return jsonResp({ ok: false, error: `maximo de ${MAX_CARTEIRAS} carteiras` }, 400);
    }
    if (body.carteiras.some(c => !c || typeof c.w !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c.w))) {
      return jsonResp({ ok: false, error: "uma ou mais carteiras tem endereco invalido" }, 400);
    }
    let oldCfg = {};
    const oldRaw = await env.CFG.get("cfg");
    if (oldRaw) {
      try { oldCfg = JSON.parse(oldRaw) || {}; }
      catch (_) { return jsonResp({ ok: false, error: "configuracao existente invalida; nenhuma alteracao realizada" }, 409); }
    }
    const carteiras = normalizarListaConfig(body.carteiras, oldCfg, Date.now());
    const topico = String(body.topico || oldCfg.topico || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    try {
      await env.CFG.put("cfg", JSON.stringify({ carteiras, topico }));
    } catch (e) {
      console.error("KV config: gravacao falhou: " + limpar(env, e));
      return jsonResp({ ok: false, error: "nao foi possivel salvar a configuracao no KV" }, 503);
    }

    // A limpeza do estado de carteiras removidas acontece dentro do Cron, junto da gravação de estado,
    // para evitar duas rotinas escrevendo a mesma chave KV simultaneamente.

    let aviso = null;
    if (carteiras.length) {
      aviso = (await avisar(env, "Servidor sincronizado",
        `Vigiando ${carteiras.length} ${carteiras.length === 1 ? "carteira" : "carteiras"}.`, "", null, orcamento)).ok;
    }
    return jsonResp({ ok: true, carteiras: carteiras.length, aviso });
  },
  async scheduled(event, env, ctx) {
    // Protege contra sobreposição no mesmo isolate; KV não oferece lock/compare-and-swap global.
    if (scheduledRunning) {
      console.warn("rodada ignorada: outra execucao ainda esta ativa neste isolate");
      return;
    }
    scheduledRunning = true;
    ctx.waitUntil((async () => {
      try {
        await vigiar(env);
      } catch (error) {
        console.error("vigiar falhou: " + limpar(env, error));
        try {
          const minute = new Date(event.scheduledTime).getUTCMinutes();
          if (minute % 15 === 0 && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
            const budget = novoOrcamento();
            await avisar(env, "Monitor com erro", limpar(env, error).slice(0, 200), "", null, budget);
          }
        } catch (secondary) { console.error("aviso de erro falhou: " + limpar(env, secondary)); }
      } finally {
        scheduledRunning = false;
      }
    })());
  },
};
