// Worker: vigia as carteiras da Polymarket a cada 1 minuto e avisa pelo ntfy.
// Precisa de: KV com binding "CFG", segredo "CHAVE" e Cron "* * * * *".
// Plano grátis do Cloudflare: 10 ms de CPU e 50 chamadas externas por rodada.

const DATA = "https://data-api.polymarket.com";
const ESPORT = /^(lol|cs2?|csgo|dota2?|valorant|val|r6(?:siege)?|codmw|cod|ow|rl|kog|hok|mlbb|sc2|starcraft)(?![a-z])/i;

const JANELA_S = 1800;         // últimos 30 min: se a Polymarket cair por um tempo, a busca seguinte ainda pega o que faltou
const LIMITE = 200;            // apostas por página
const MAX_PAGINAS = 3;         // páginas por carteira (passa de uma só se a carteira tiver muitas apostas na janela)
const CARTEIRAS_POR_LOTE = 4;  // consultas em paralelo; os lotes andam um após o outro
const PAUSA_MS = 300;          // pausa entre um lote e o seguinte
const TENTATIVAS = 2;          // tentativas da v2 em erro temporário (a v1 de reserva tenta uma vez)
const TIMEOUT_MS = 8000;       // espera máxima por resposta
const MAX_LEITURAS = 36;       // chamadas à Polymarket por rodada (tentativas incluídas)
const MAX_CHAMADAS = 48;       // todas as chamadas externas da rodada; o plano grátis permite 50
const MAX_AVISOS = 8;          // avisos de apostas por rodada; o resto vira um aviso-resumo
const MAX_REENVIOS = 4;        // avisos atrasados reenviados por rodada
const FILA_MAX = 50;           // avisos guardados até o ntfy aceitar
const FILA_VALIDADE_MS = 3 * 60 * 60 * 1000; // aviso que ficou mais de 3 horas na fila é descartado
const MAX_CHAVES = 600;        // apostas lembradas por carteira
const ESTADO = "estado2";      // apostas já tratadas (mesmo nome da versão anterior)
const FILA = "fila1";          // avisos que o ntfy ainda não aceitou
const vistosMem = {};          // memória desta instância: reserva caso o KV falhe
let travaMs = 0;               // impede duas rodadas ao mesmo tempo nesta instância
let v2PausaAte = 0;            // depois de um 429 da v2, a v2 fica de fora por 2 minutos (a v1 responde)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const resp = (t, s = 200) => new Response(t, { status: s, headers: CORS });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cortar = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const moeda = v => "US$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const novoRun = () => ({ chamadas: 0, leituras: 0, bloqueado: false, motivos: [] });
const falha = (run, api, motivo) => { if (run.motivos.length < 12) run.motivos.push(api + ": " + motivo); };
// a ordem gira a cada minuto: se o limite acabar, não é sempre a mesma carteira que fica sem resposta
const girar = (lista, minuto) => { const k = minuto % lista.length; return [...lista.slice(k), ...lista.slice(0, k)]; };

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

// guarda só o necessário: chaves de até 1 hora atrás, no máximo MAX_CHAVES por carteira
function enxugar(lista) {
  const corte = Math.floor(Date.now() / 1000) - 3600;
  return lista
    .filter(k => { const ts = Number(String(k).split("|")[2]) || 0; return ts === 0 || ts >= corte; })
    .slice(-MAX_CHAVES);
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

// pedido à Polymarket com tempo limite; repete só em erro temporário
async function pedir(run, url, tentativas) {
  let motivo = "";
  for (let t = 1; t <= tentativas; t++) {
    if (run.leituras >= MAX_LEITURAS || run.chamadas >= MAX_CHAMADAS) throw new Error("sem chamadas livres nesta rodada");
    run.leituras++;
    run.chamadas++;
    const ctrl = new AbortController();
    const relogio = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (r.ok) return await r.json();
      motivo = "HTTP " + r.status;
      if (r.status === 429) { if (url.includes("/v2/")) v2PausaAte = Date.now() + 120000; break; } // limite de acesso: repetir agora não adianta
      if ([400, 401, 403, 404].includes(r.status)) break; // erro definitivo: repetir não adianta
    } catch (e) {
      motivo = e && e.name === "AbortError" ? "tempo esgotado" : String(e);
    } finally {
      clearTimeout(relogio);
    }
    if (t < tentativas) await sleep(700 * t);
  }
  throw new Error(motivo);
}

// v2 primeiro (seguindo o cursor); se a primeira página falhar, usa a v1 como reserva
async function buscar(run, w, desde) {
  try {
    if (Date.now() < v2PausaAte) throw new Error("v2 em pausa (limite de acesso)");
    const esports = []; let total = 0, cursor = null, parcial = false;
    for (let p = 0; p < MAX_PAGINAS; p++) {
      let url = `${DATA}/v2/trades?user=${w}&limit=${LIMITE}&start=${desde}`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      let b;
      try { b = await pedir(run, url, TENTATIVAS); }
      catch (e) { if (p === 0) throw e; falha(run, `v2 página ${p + 1}`, e.message); parcial = true; break; }
      const lista = listaDe(b);
      total += lista.length;
      soEsports(lista, esports);
      cursor = cursorDe(b);
      if (!cursor || cursor === "LTE=" || lista.length === 0) break;
    }
    return { api: "v2", total, esports, parcial };
  } catch (e) {
    falha(run, "v2", e.message);
    let motivo = "v2: " + e.message;
    try {
      const b = await pedir(run, `${DATA}/trades?user=${w}&limit=${LIMITE}&start=${desde}`, 1);
      const lista = listaDe(b);
      const esports = []; soEsports(lista, esports);
      return { api: "v1", total: lista.length, esports, parcial: false };
    } catch (e2) { falha(run, "v1", e2.message); motivo += " | v1: " + e2.message; }
    console.error(`sem resposta para ${w.slice(0, 8)}: ${motivo}`);
    return null;
  }
}

// consulta em lotes; devolve um mapa carteira → resposta (null se não respondeu)
async function lerCarteiras(run, carteiras, desde) {
  const mapa = new Map();
  for (let i = 0; i < carteiras.length; i += CARTEIRAS_POR_LOTE) {
    const lote = carteiras.slice(i, i + CARTEIRAS_POR_LOTE);
    const respostas = await Promise.all(lote.map(c => buscar(run, c.w, desde)));
    lote.forEach((c, k) => mapa.set(c.w, respostas[k]));
    if (i + CARTEIRAS_POR_LOTE < carteiras.length) await sleep(PAUSA_MS);
  }
  return mapa;
}

// chamada com tempo limite (usada nos avisos)
async function comTempo(url, opts) {
  const ctrl = new AbortController();
  const relogio = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(relogio); }
}

// envia um aviso ao ntfy. Devolve true se entregou. Se o ntfy recusar por limite ou não responder,
// não insiste nesta rodada: o aviso fica na fila e é reenviado depois.
async function avisar(run, topico, aviso) {
  if (run.bloqueado) return false;
  const sufixo = " (topico ..." + topico.slice(-4) + ")";
  if (run.chamadas < MAX_CHAMADAS) {
    run.chamadas++;
    try {
      const r = await comTempo("https://ntfy.sh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topico, title: aviso.titulo, message: aviso.corpo, tags: [aviso.tag], ...(aviso.click ? { click: aviso.click } : {}) }),
      });
      if (r.ok) return true;
      console.error("ntfy (json) respondeu " + r.status + sufixo);
      if (r.status === 429 || r.status >= 500) { run.bloqueado = true; return false; }
    } catch (e) {
      console.error("ntfy (json) falhou: " + e);
      run.bloqueado = true;
      return false;
    }
  }
  // formato simples (reserva), só quando o JSON foi recusado por dados ruins
  if (run.chamadas >= MAX_CHAMADAS) return false;
  run.chamadas++;
  try {
    const t = aviso.titulo.normalize("NFD").replace(/[^\x20-\x7E]/g, "").trim() || "Aviso";
    const r = await comTempo("https://ntfy.sh/" + encodeURIComponent(topico), {
      method: "POST", headers: { Title: t, Tags: aviso.tag }, body: aviso.corpo,
    });
    if (r.ok) return true;
    console.error("ntfy respondeu " + r.status + sufixo);
    if (r.status === 429 || r.status >= 500) run.bloqueado = true;
    return false;
  } catch (e) {
    console.error("ntfy falhou: " + e);
    run.bloqueado = true;
    return false;
  }
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

function montarAviso(g) {
  const t = g.t;
  const pm = g.cotas > 0 ? g.custo / g.cotas : 0; // preço médio ponderado pelo tamanho
  const odd = pm > 0 ? (1 / pm).toFixed(2).replace(".", ",") : "-";
  const venda = String(t.side || "").toUpperCase() === "SELL";
  const nome = g.c.nome || (g.c.w.slice(0, 6) + "..." + g.c.w.slice(-4));
  return {
    ts: Date.now(),
    titulo: cortar(`${nome}: ${venda ? "vendeu" : "comprou"} ${t.outcome || "?"}`, 60), // curto: cabe na tela de bloqueio
    corpo: `valor ${moeda(g.custo)}${g.n > 1 ? ` em ${g.n} execuções` : ""} · odd ${odd}\n${cortar(t.title || t.slug || "", 80)}`,
    tag: venda ? "red_circle" : "green_circle",
    click: t.eventSlug ? "https://polymarket.com/event/" + t.eventSlug : "",
  };
}

function lerFila(texto) {
  try { const f = JSON.parse(texto || "[]"); return Array.isArray(f) ? f : []; }
  catch (e) { return []; }
}

async function vigiar(env, minuto) {
  const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
  if (!cfg || !cfg.topico || !cfg.carteiras || !cfg.carteiras.length) { console.log("rodada: nada para vigiar (0 carteiras ou sem topico)"); return; }
  const carteiras = [], feitas = new Set();
  for (const c of cfg.carteiras) if (c && c.w && !feitas.has(c.w)) { feitas.add(c.w); carteiras.push(c); }
  const run = novoRun();
  const estado = JSON.parse((await env.CFG.get(ESTADO)) || "{}");
  const fila = lerFila(await env.CFG.get(FILA));
  const filaAntes = JSON.stringify(fila);
  const agora = Date.now();
  const desde = Math.floor(agora / 1000) - JANELA_S;
  const resumo = { carteiras: carteiras.length, v2: 0, v1: 0, parciais: 0, erros: 0, trades: 0, novos: 0, avisosOk: 0, avisosFalha: 0, reenviados: 0, descartados: 0, fila: 0, topico: "..." + cfg.topico.slice(-4) };

  const respostas = await lerCarteiras(run, girar(carteiras, minuto), desde);
  const novas = [];
  let mudou = false;
  for (const c of carteiras) {
    const r = respostas.get(c.w);
    if (!r) { resumo.erros++; continue; }
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
  }
  resumo.novos = novas.length;

  // as apostas são marcadas como vistas antes de avisar; se o aviso não sair, ele vai para a fila
  let lista = novas;
  if (mudou) {
    try { await env.CFG.put(ESTADO, JSON.stringify(estado)); }
    catch (e) {
      // KV recusou (cota diária do plano grátis, por exemplo): avisa só o que é bem recente
      console.error("KV put falhou: " + e);
      resumo.kvFalhou = true;
      const corte = Date.now() - 75000;
      lista = novas.filter(x => paraMs(x.t.timestamp) >= corte);
      resumo.puladosKV = novas.length - lista.length;
    }
  }

  // 1) avisos da fila que o ntfy recusou antes (os mais antigos primeiro)
  const pendentes = [];
  let tentados = 0;
  for (const a of fila) {
    if (agora - a.ts > FILA_VALIDADE_MS) { resumo.descartados++; continue; }
    if (tentados < MAX_REENVIOS && !run.bloqueado) {
      tentados++;
      if (await avisar(run, cfg.topico, { ...a, corpo: "(atrasado) " + a.corpo })) { resumo.reenviados++; continue; }
    }
    pendentes.push(a);
  }

  // 2) avisos das apostas novas (no máximo MAX_AVISOS por rodada)
  const grupos = agrupar(lista);
  resumo.grupos = grupos.length;
  for (const g of grupos.slice(0, MAX_AVISOS)) {
    const aviso = montarAviso(g);
    if (await avisar(run, cfg.topico, aviso)) resumo.avisosOk++;
    else { resumo.avisosFalha++; pendentes.push(aviso); }
  }

  // 3) o que passou do limite vira um aviso-resumo
  if (grupos.length > MAX_AVISOS) {
    const resto = { ts: Date.now(), titulo: `+${grupos.length - MAX_AVISOS} outras apostas`, corpo: "Muitas apostas de uma vez. Abra a página para ver todas.", tag: "bell", click: "" };
    if (!(await avisar(run, cfg.topico, resto))) pendentes.push(resto);
  }

  // 4) aviso de falha geral: não vai para a fila (perde o sentido depois)
  if (resumo.erros === carteiras.length && minuto % 30 === 0) {
    await avisar(run, cfg.topico, { titulo: "Sem resposta da Polymarket", corpo: "Nenhuma carteira respondeu nesta rodada. O monitor continua tentando a cada minuto.", tag: "warning", click: "" });
  }

  // grava a fila só se ela mudou (poupa gravações no KV)
  const novaFila = pendentes.slice(-FILA_MAX);
  resumo.fila = novaFila.length;
  if (JSON.stringify(novaFila) !== filaAntes) {
    try { await env.CFG.put(FILA, JSON.stringify(novaFila)); }
    catch (e) { console.error("fila não foi salva: " + e); }
  }
  console.log(`novos=${resumo.novos} trades=${resumo.trades} erros=${resumo.erros} | rodada ` + JSON.stringify({ ...resumo, chamadas: run.chamadas, leituras: run.leituras, motivos: run.motivos }));
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.headers.get("Authorization") !== "Bearer " + env.CHAVE) return resp("nao autorizado", 401);
    if (new URL(req.url).pathname !== "/config" || req.method !== "POST") return resp("ok");
    let b;
    try { b = (await req.json()) || {}; } catch (e) { return resp("json invalido", 400); }
    const carteiras = [], feitas = new Set();
    for (const c of Array.isArray(b.carteiras) ? b.carteiras : []) {
      if (!c || !/^0x[0-9a-fA-F]{40}$/.test(c.w || "")) continue;
      const w = c.w.toLowerCase();
      if (feitas.has(w) || carteiras.length >= 20) continue;
      feitas.add(w);
      carteiras.push({ w, nome: String(c.nome || "").slice(0, 40) });
    }
    const topico = String(b.topico || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const novo = JSON.stringify({ carteiras, topico });
    const antigo = await env.CFG.get("cfg");
    if (antigo !== novo) {
      await env.CFG.put("cfg", novo);
      // esquece o estado de carteiras que saíram da lista
      const estado = JSON.parse((await env.CFG.get(ESTADO)) || "{}");
      const manter = new Set(carteiras.map(c => c.w));
      let limpou = false;
      for (const w of Object.keys(estado)) if (!manter.has(w)) { delete estado[w]; limpou = true; }
      if (limpou) await env.CFG.put(ESTADO, JSON.stringify(estado));
      // confirmação só quando a configuração muda (a página pode sincronizar várias vezes)
      if (topico && carteiras.length) {
        const sync = { ts: Date.now(), titulo: "Servidor sincronizado", corpo: "Vigiando " + carteiras.length + " carteira(s) a cada minuto, mesmo com a página fechada.", tag: "white_check_mark", click: "" };
        // se o ntfy recusar agora, a confirmação fica na fila e sai quando ele aceitar
        if (!(await avisar(novoRun(), topico, sync))) {
          const fila = lerFila(await env.CFG.get(FILA));
          fila.push(sync);
          await env.CFG.put(FILA, JSON.stringify(fila.slice(-FILA_MAX)));
        }
      }
    }
    return resp(JSON.stringify({ carteiras: carteiras.length }));
  },

  async scheduled(ev, env, ctx) {
    // se a rodada anterior ainda estiver rodando nesta instância, esta é pulada
    if (Date.now() - travaMs < 120000) { console.log("rodada anterior ainda em andamento: esta foi pulada"); return; }
    const meu = (travaMs = Date.now());
    const minuto = new Date(ev.scheduledTime).getUTCMinutes();
    ctx.waitUntil(vigiar(env, minuto)
      .catch(async e => {
        console.error("vigiar falhou: " + e);
        try {
          const cfg = JSON.parse((await env.CFG.get("cfg")) || "null");
          if (cfg && cfg.topico && minuto % 15 === 0) await avisar(novoRun(), cfg.topico, { titulo: "Monitor com erro", corpo: String(e).slice(0, 200), tag: "warning", click: "" });
        } catch (e2) { console.error("aviso de erro falhou: " + e2); }
      })
      .finally(() => { if (travaMs === meu) travaMs = 0; }));
  },
};
