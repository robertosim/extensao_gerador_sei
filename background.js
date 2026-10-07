// Gerador SEI - service worker (MV3).
//
// Responsabilidades:
//   * inicializar chaves padrao do chrome.storage.local;
//   * keep-alive das abas do SEI e do PGT (alarms independentes);
//   * badge do icone com o progresso da execucao;
//   * responder mensagens do popup (keep-alive).
//
// O motor de automacao roda nos content scripts; este arquivo nunca bloqueia.
'use strict';

importScripts('comum.js');

const ALARME_KEEPALIVE = 'gsei-keepalive';
const ALARME_KEEPALIVE_PGT = 'gsei-keepalive-pgt';
const ALARME_TICK = 'gsei-tick';
const SEI_URL = 'https://sei.incra.gov.br/sei';
const URL_SEI = 'https://sei.incra.gov.br/*';
const URL_PGT = 'https://pgt.incra.gov.br/*';
const PGT_URL = 'https://pgt.incra.gov.br/sipra/beneficiario';

// Dois keep-alives independentes (SEI e PGT): mesma chave/rotulo em todo o
// codigo (GSEI.CHAVES_KEEPALIVE). O nome do alarme do SEI nao muda para nao
// perder a preferencia ja gravada em instalacoes existentes.
const ALVOS_KEEPALIVE = {
  sei: { rotulo: 'SEI', alarme: ALARME_KEEPALIVE, url: SEI_URL, padrao: URL_SEI },
  pgt: { rotulo: 'PGT', alarme: ALARME_KEEPALIVE_PGT, url: PGT_URL, padrao: URL_PGT }
};

function alvoKeepalive(alvo) {
  return ALVOS_KEEPALIVE[alvo] || ALVOS_KEEPALIVE.sei;
}

async function inicializar() {
  const padroes = {
    registros: [],
    fila: [],
    pdfs: {},
    log: [],
    keepalive: GSEI.PADRAO_KEEPALIVE,
    keepalive_pgt: GSEI.PADRAO_KEEPALIVE,
    execucao: null
  };
  const atuais = await chrome.storage.local.get(Object.keys(padroes));
  const novos = {};
  for (const chave of Object.keys(padroes)) {
    if (atuais[chave] === undefined) novos[chave] = padroes[chave];
  }
  if (Object.keys(novos).length) await chrome.storage.local.set(novos);
}

async function agendarKeepalive() {
  for (const alvo of Object.keys(GSEI.CHAVES_KEEPALIVE)) {
    const ka = await GSEI.obterKeepalive(alvo);
    const segundos = Math.max(30, Number(ka.intervalo) || 60);
    await chrome.alarms.create(alvoKeepalive(alvo).alarme,
      { periodInMinutes: segundos / 60 });
  }
}

async function keepaliveUmaVez(alvo, origem) {
  const meta = alvoKeepalive(alvo);
  const rotulo = meta.rotulo;
  const prefixo = `KEEPALIVE${alvo === 'pgt' ? ' PGT' : ''}`;
  const ka = await GSEI.obterKeepalive(alvo);
  if (!ka.ativo) return { ok: false, motivo: 'desativado' };

  const ex = await GSEI.obter('execucao', null);
  if (ex && ex.ativa) {
    await GSEI.atualizarKeepalive(alvo,
      { ultimo_erro: 'Pausado: execucao em andamento' });
    return { ok: false, motivo: 'ocupado' };
  }

  try {
    const abas = await chrome.tabs.query({ url: meta.padrao });
    const agora = new Date().toLocaleString('pt-BR');

    if (abas.length) {
      const aba = abas.find(a => !/login/i.test(a.url || '')) || abas[0];
      const url = aba.url || '';
      const expirada = /login/i.test(url);
      await chrome.tabs.reload(aba.id);
      await GSEI.atualizarKeepalive(alvo, {
        ultima_recarga: agora,
        recargas: (Number(ka.recargas) || 0) + 1,
        ultimo_url: url,
        ultimo_erro: expirada ? 'Sessao expirada (redirecionou para login)' : null
      });
      await GSEI.registrar(expirada
        ? `${prefixo}: AVISO - aba do ${rotulo} em pagina de login; refazer login manualmente`
        : `${prefixo}: aba recarregada${origem ? ' (' + origem + ')' : ''}: ${url.slice(0, 80)}`);
      return { ok: true, url };
    }

    await chrome.tabs.create({ url: meta.url });
    await GSEI.atualizarKeepalive(alvo, {
      ultima_recarga: agora,
      recargas: (Number(ka.recargas) || 0) + 1,
      ultimo_url: meta.url,
      ultimo_erro: null
    });
    await GSEI.registrar(`${prefixo}: nenhuma aba do ${rotulo} aberta: criando uma`);
    return { ok: true, url: meta.url };
  } catch (e) {
    await GSEI.atualizarKeepalive(alvo, { ultimo_erro: String(e && e.message || e) });
    await GSEI.registrar(`${prefixo}: erro ao recarregar ${rotulo}: ${e}`, 'ERRO');
    return { ok: false, motivo: String(e && e.message || e) };
  }
}

async function agendarTick(ativa) {
  if (ativa) {
    // Minimo permitido pelo Chrome: 30s. Garante progresso em aba oculta.
    await chrome.alarms.create(ALARME_TICK, { periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(ALARME_TICK);
  }
}

let _ultimoReloadPgt = 0;

async function enviarTick() {
  try {
    const [abasSei, abasPgt] = await Promise.all([
      chrome.tabs.query({ url: URL_SEI }),
      chrome.tabs.query({ url: URL_PGT })
    ]);

    const respostasSei = await Promise.all(abasSei.map(aba =>
      chrome.tabs.sendMessage(aba.id, { acao: 'tick' })
        .then(() => true)
        .catch(() => false)));

    const respostas = await Promise.all(abasPgt.map(aba =>
      chrome.tabs.sendMessage(aba.id, { acao: 'tick' })
        .then(() => true)
        .catch(() => false)));

    await verificarAbaPGT(abasPgt);
    await reanimarAbaPGT(abasPgt, respostas);
    await reanimarAbaSei(abasSei, respostasSei);

    // Abas abertas depois do inicio da execucao tambem precisam da protecao.
    const ex = await GSEI.obter('execucao', null);
    // sincroniza a protecao contra discard (inclusive a liberacao ao final)
    await protegerAbas(!!(ex && ex.ativa));
  } catch (e) { console.warn('[Gerador SEI] enviarTick:', e); }
}

// A automacao morre se a aba for descartada (Memory Saver): o content script
// some junto. Enquanto a execucao roda, as abas do SEI/PGT ficam com
// autoDiscardable=false (coluna "Auto Discardable" do chrome://discards).
async function protegerAbas(ativa) {
  try {
    const abas = await chrome.tabs.query({ url: [URL_SEI, URL_PGT] });
    await Promise.all(abas.map(aba =>
      chrome.tabs.update(aba.id, { autoDiscardable: !ativa }).catch(() => null)));
  } catch (e) { console.warn('[Gerador SEI] protegerAbas:', e); }
}

let _ultimoReloadSei = 0;

// Aba do SEI sem resposta ao tick: o content script morreu (extensao
// recarregada com a pagina aberta) ou a aba esta congelada. Recarrega para
// reinjetar o motor/descongelar; o estado volta do chrome.storage.local.
async function reanimarAbaSei(abasSei, respostas) {
  try {
    if (!abasSei || !abasSei.length) return;
    const ex = await GSEI.obter('execucao', null);
    if (!ex || !ex.ativa || (ex.tipo !== 'gerar' && ex.tipo !== 'anexar')) return;
    if (Date.now() - _ultimoReloadSei < 60000) return; // no maximo 1x por minuto

    // Aba congelada nao executa nada (nem o tick remoto); recarregar e a
    // unica forma de descongelar, pois nao existe API publica de unfreeze.
    const congelada = abasSei.find(a => a.frozen && a.status !== 'loading');
    if (congelada) {
      _ultimoReloadSei = Date.now();
      await chrome.tabs.reload(congelada.id);
      await GSEI.registrar('Aba do SEI congelada pelo Chrome (freeze): recarregada', 'AVISO');
      return;
    }

    if (respostas && respostas.some(r => r)) return;
    const alvo = abasSei.find(a => a.status !== 'loading');
    if (!alvo) return;

    _ultimoReloadSei = Date.now();
    await chrome.tabs.reload(alvo.id);
    await GSEI.registrar('Aba do SEI sem motor ativo: pagina recarregada para reinjetar o script');
  } catch (e) { console.warn('[Gerador SEI] reanimarAbaSei:', e); }
}

// Aba do PGT aberta mas ninguem responde o tick: o content script morreu
// (extensao recarregada com a pagina aberta). Recarrega para injetar o motor.
async function reanimarAbaPGT(abasPgt, respostas) {
  try {
    if (!abasPgt || !abasPgt.length) return;

    const ex = await GSEI.obter('execucao', null);
    if (!ex || !ex.ativa || ex.tipo !== 'download') return;
    if (Date.now() - _ultimoReloadPgt < 60000) return; // no maximo 1x por minuto

    const congelada = abasPgt.find(a => a.frozen && a.status !== 'loading');
    if (congelada) {
      _ultimoReloadPgt = Date.now();
      await chrome.tabs.reload(congelada.id);
      await GSEI.registrar('Aba do PGT congelada pelo Chrome (freeze): recarregada', 'AVISO');
      return;
    }

    if (respostas && respostas.some(r => r)) return;
    if (abasPgt[0].status === 'loading') return;

    _ultimoReloadPgt = Date.now();
    await chrome.tabs.reload(abasPgt[0].id);
    await GSEI.registrar('Aba do PGT sem motor ativo: pagina recarregada para reinjetar o script');
  } catch (e) { console.warn('[Gerador SEI] reanimarAbaPGT:', e); }
}

// Se a execucao de download ficou orfa (aba do PGT fechada), aborta em vez de
// deixar o badge preso em "em andamento" para sempre.
async function verificarAbaPGT(abasPgt) {
  try {
    const ex = await GSEI.obter('execucao', null);
    if (!ex || !ex.ativa || ex.tipo !== 'download') return;
    if (abasPgt && abasPgt.length) return;
    if (Date.now() - (ex.iniciado_ts || Date.now()) < 60000) return;

    await chrome.storage.local.set({
      execucao: Object.assign({}, ex, {
        ativa: false, status: 'abortado', motivo: 'Aba do PGT fechada',
        claim: null, item_id: null, atual: ''
      })
    });
    await GSEI.registrar('DOWNLOAD abortado: a aba do PGT foi fechada', 'ERRO');
  } catch (e) { console.warn('[Gerador SEI] verificarAbaPGT:', e); }
}

// --------------------------------------------------------------- downloads

// Pasta destino dentro da pasta de downloads padrao do sistema.
const PASTA_DOWNLOADS = 'arquivos_pgt';
const _baixando = new Map(); // id do download -> { item_id, arquivo, url }
const _baixados = new Map(); // id do download -> { item_id, ok, erro, arquivo }

function guardarBaixado(id, estado) {
  _baixados.set(id, estado);
  while (_baixados.size > 200) {
    _baixados.delete(_baixados.keys().next().value);
  }
}

function sanitizarNome(relativo) {
  return String(relativo || '')
    .split('/')
    .map(seg => seg.replace(/[<>:"|?*\\]+/g, '_').replace(/^\.+$/, '_').trim())
    .filter(Boolean)
    .join('/');
}

// Nomes pedidos por nos via chrome.downloads.download: com um listener em
// onDeterminingFilename registrado, o Chrome so mantem o nome pedido se o
// proprio listener devolver - sem sugestao ele cai no nome da URL
// (ex.: "relatorio.pdf" em vez de "arquivos_pgt/espelho.pdf").
const _pedidos = new Map();

function lembrarPedido(url, nome) {
  const chave = String(url || '');
  if (!chave) return;
  _pedidos.set(chave, { nome, ts: Date.now() });
  if (_pedidos.size > 30) {
    for (const [k, v] of _pedidos) {
      if (Date.now() - v.ts > 300000) _pedidos.delete(k);
    }
  }
}

function esquecerPedido(url) {
  _pedidos.delete(String(url || ''));
}

// Consome o nome pedido para este download (finalUrl cobre redirecionamentos).
function pegarPedido(item) {
  const a = String(item && item.url || '');
  const b = String(item && item.finalUrl || '');
  const reg = _pedidos.get(a) || (b && b !== a ? _pedidos.get(b) : null);
  if (!reg) return null;
  _pedidos.delete(a);
  if (b) _pedidos.delete(b);
  return Date.now() - reg.ts > 300000 ? null : reg.nome;
}

async function baixarArquivo(msg) {
  const url = String(msg && msg.url || '');
  if (!/^https:\/\/pgt\.incra\.gov\.br\//i.test(url)) {
    return { ok: false, motivo: 'URL fora do dominio do PGT' };
  }
  const filename = sanitizarNome(msg.filename || `${PASTA_DOWNLOADS}/espelho.pdf`);
  if (!filename.toLowerCase().endsWith('.pdf')) {
    return { ok: false, motivo: 'Nome de arquivo invalido (esperado .pdf)' };
  }
  lembrarPedido(url, filename);
  try {
    const id = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
    _baixando.set(id, { item_id: msg.item_id, arquivo: filename, url, ts: Date.now() });
    _baixados.delete(id);
    await GSEI.registrar(`DOWNLOAD solicitado: ${filename}`);
    return { ok: true, id };
  } catch (e) {
    esquecerPedido(url);
    const motivo = String(e && e.message || e);
    await GSEI.registrar(`DOWNLOAD nao iniciado (${filename}): ${motivo}`, 'ERRO');
    return { ok: false, motivo };
  }
}

// Cobre https://pgt.incra.gov.br/... e tambem blob:https://pgt.incra.gov.br/...
function ehDownloadDoPgt(url) {
  return String(url || '').toLowerCase().includes('pgt.incra.gov.br');
}

function ehDownloadAceitavel(item) {
  if (!item) return false;
  return ehDownloadDoPgt(item.url) || ehDownloadDoPgt(item.finalUrl);
}

// Caminho relativo ao diretorio de downloads: "arquivos_pgt/<nome original>"
// (ex.: unidade-familiar-1467635.pdf). Caminho ja vindo da pasta e mantido.
function caminhoNaPasta(atual) {
  if (!atual) return null;
  const ja = String(atual).replace(/\\/g, '/');
  if (ja.includes(`/${PASTA_DOWNLOADS}/`) || ja.startsWith(`${PASTA_DOWNLOADS}/`)) return atual;
  const sep = String(atual).includes('\\') ? '\\' : '/';
  const partes = String(atual).split(/[\\/]/);
  const nome = partes.pop();
  if (!nome) return null;
  partes.push(PASTA_DOWNLOADS);
  partes.push(nome);
  return partes.join(sep);
}

// Sugestao de nome aceita pelo Chrome: relativa ao diretorio de downloads,
// sem "..", sem caracteres invalidos e sempre dentro de "arquivos_pgt".
function caminhoSugerido(sugestao) {
  const limpo = String(sugestao || 'espelho.pdf')
    .split(/[\\/]/)
    .map(seg => seg.replace(/[<>:"|?*]+/g, '_').replace(/^\.+$/, '_').trim())
    .filter(Boolean)
    .join('/');
  return caminhoNaPasta(limpo || 'espelho.pdf');
}

// Basename da URL do download, para quando item.filename ainda estiver vazio.
function nomePelaUrl(item) {
  try {
    const bruto = String(item && (item.finalUrl || item.url) || '');
    if (!bruto || /^blob:|^data:/i.test(bruto)) return '';
    const u = new URL(bruto);
    return decodeURIComponent(u.pathname.split('/').pop() || '');
  } catch (e) { return ''; }
}

// Intercepta o download no momento em que o Chrome define o arquivo: aponta
// direto para "arquivos_pgt/<nome original>". O 2o argumento do evento e a
// FUNCAO de sugestao (nao uma string de nome) - por isso ele se chama
// "sugerir" e recebe um OBJETO ({ filename, conflictAction }); o nome
// provisorio do arquivo esta em item.filename. A sugestao e relativa a pasta
// de downloads (caminho absoluto o Chrome ignora). A API nao tem
// chrome.downloads.move, entao este e o unico ponto onde o destino pode ser
// definido.
chrome.downloads.onDeterminingFilename.addListener((item, sugerir) => {
  // Nome provisorio que o Chrome gerou (pode vir como caminho absoluto).
  const provisorio = String(item && item.filename || '');
  const base = provisorio.split(/[\\/]/).pop() || nomePelaUrl(item);
  try {
    if (ehDownloadAceitavel(item)) {
      // pedido (chrome.downloads.download) > provisorio > URL > espelho.pdf
      const nome = pegarPedido(item) || base || 'espelho.pdf';
      sugerir({ filename: caminhoSugerido(nome), conflictAction: 'uniquify' });
      return;
    }
    // Fora do PGT: devolve o nome que o proprio Chrome ja tinha gerado, para
    // nao mexer no download de ninguem (sem sugestao o nome pedido pelo
    // chamador se perde quando ha listener registrado).
    if (base) sugerir({ filename: base, conflictAction: 'uniquify' });
  } catch (e) {
    try {
      if (base) sugerir({ filename: base, conflictAction: 'uniquify' });
    } catch (e2) { /* ignora: o Chrome usa o nome provisorio */ }
  }
});

function caminhoRelativo(caminho) {
  const s = String(caminho || '');
  const i = s.replace(/\\/g, '/').indexOf(PASTA_DOWNLOADS);
  return i >= 0 ? s.slice(i) : s;
}

// Conclui um download detectado: confirma o destino e avisa o PGT.
async function finalizarDownload(id, alteracao) {
  const meta = _baixando.get(id);
  if (!meta) return;
  _baixando.delete(id);

  if (alteracao && alteracao.state === 'interrupted') {
    const estado = {
      item_id: meta.item_id, ok: false,
      erro: String(alteracao.error || 'interrompido'),
      arquivo: meta.arquivo || null, ts: Date.now()
    };
    guardarBaixado(id, estado);
    await notificarPgt(estado);
    await GSEI.registrar(`DOWNLOAD falhou (${meta.arquivo || meta.url}): ${estado.erro}`, 'ERRO');
    return;
  }

  let arquivo = meta.arquivo || null;
  if (!arquivo) {
    // Download disparado pela pagina do PGT: o destino ja foi definido por
    // onDeterminingFilename; aqui so confirmamos onde o Chrome gravou.
    try {
      const itens = await chrome.downloads.search({ id });
      const it = itens && itens[0];
      arquivo = (it && it.filename) || null;
      if (arquivo && caminhoNaPasta(arquivo) !== arquivo) {
        await GSEI.registrar(
          `DOWNLOAD salvo fora de ${PASTA_DOWNLOADS}: ${arquivo} (renomeie/mova manualmente)`, 'AVISO');
      }
    } catch (e) {
      arquivo = arquivo || null;
      await GSEI.registrar(
        `DOWNLOAD: caminho nao confirmado (${String(e && e.message || e)})`, 'AVISO');
    }
  }

  const estado = { item_id: meta.item_id, ok: true, erro: null, arquivo: caminhoRelativo(arquivo), ts: Date.now() };
  guardarBaixado(id, estado);
  await notificarPgt(estado);
  await GSEI.registrar(`DOWNLOAD concluido: ${estado.arquivo || arquivo}`);
}

// Estado de um download: primeiro o que ficou em memoria; se o service worker
// reiniciou, consulta o proprio Chrome (chrome.downloads.search).
async function estadoDeDownload(id) {
  const guardado = _baixados.get(id);
  if (guardado) return guardado;
  try {
    const itens = await chrome.downloads.search({ id: id });
    const item = itens && itens[0];
    if (!item) return null;
    if (item.state === 'complete') {
      return { item_id: null, ok: true, erro: null, arquivo: caminhoRelativo(item.filename) };
    }
    if (item.state === 'interrupted') {
      return { item_id: null, ok: false, erro: item.error || 'interrompido', arquivo: caminhoRelativo(item.filename) };
    }
    return null; // ainda em andamento
  } catch (e) {
    return null;
  }
}

// Estado do download disparado pela propria pagina do PGT depois de `desde`.
async function estadoDesde(desde, item_id) {
  const limite = Number(desde) || 0;
  let melhor = null;
  for (const estado of _baixados.values()) {
    if (!estado.ts || estado.ts < limite) continue;
    if (item_id !== null && item_id !== undefined && estado.item_id !== item_id) continue;
    if (!melhor || estado.ts > melhor.ts) melhor = estado;
  }
  if (melhor) return melhor;
  try {
    const itens = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 5 });
    const alvo = (itens || []).find(it => it.startTime
      && new Date(it.startTime).getTime() >= limite
      && (ehDownloadDoPgt(it.url) || ehDownloadDoPgt(it.finalUrl)));
    if (alvo && alvo.state === 'complete') {
      return { item_id: null, ok: true, erro: null, arquivo: caminhoRelativo(alvo.filename) };
    }
    if (alvo && alvo.state === 'interrupted') {
      return { item_id: null, ok: false, erro: String(alvo.error || 'interrompido'), arquivo: null };
    }
  } catch (e) { /* sem permissao de downloads */ }
  return null;
}

async function notificarPgt(estado) {
  try {
    const abas = await chrome.tabs.query({ url: URL_PGT });
    await Promise.all(abas.map(aba =>
      chrome.tabs.sendMessage(aba.id, Object.assign({ acao: 'pgt-download-fim' }, estado))
        .catch(() => null)));
  } catch (e) { console.warn('[Gerador SEI] notificarPgt:', e); }
}

// O clique em "Baixar relatorio" dispara o download pelo proprio navegador:
// o background identifica, confirma o destino em "arquivos_pgt" e reporta.
async function registrarMeta(id, origem) {
  if (_baixando.has(id) || _baixados.has(id)) return null;
  try {
    const itens = await chrome.downloads.search({ id });
    const it = itens && itens[0];
    if (!it) return null;
    if (!ehDownloadAceitavel(it) && !/\.pdf$/i.test(it.filename || '')) return null;
    const ex = await GSEI.obter('execucao', null);
    if (!ex || !ex.ativa || ex.tipo !== 'download') return null;

    const meta = {
      item_id: ex.item_id,
      item_cod: ex.item_cod || null,
      item_nome: ex.item_nome || null,
      arquivo: null,
      url: it.url,
      ts: Date.now()
    };
    _baixando.set(id, meta);
    if (origem === 'criado') {
      await GSEI.registrar(`DOWNLOAD detectado no PGT (${it.filename || it.url})`);
    }
    return meta;
  } catch (e) { return null; }
}

chrome.downloads.onCreated.addListener(async (item) => {
  try {
    if (!ehDownloadAceitavel(item) && !/\.pdf$/i.test(item.filename || '')) return;
    const meta = await registrarMeta(item.id, 'criado');
    if (!meta) return;
    if (item.state === 'complete') {
      await finalizarDownload(item.id, { state: 'complete' });
    } else if (item.state === 'interrupted') {
      await finalizarDownload(item.id, { state: 'interrupted', error: item.error });
    }
  } catch (e) { console.warn('[Gerador SEI] downloads.onCreated:', e); }
});

chrome.downloads.onChanged.addListener(async (delta) => {
  try {
    // Se a meta ainda nao existiu (corrida com o onCreated ou restart do SW),
    // recupera o download pelo proprio Chrome antes de decidir.
    if (!_baixando.has(delta.id)) {
      const meta = await registrarMeta(delta.id, 'tardio');
      if (!meta) return;
    }
    if (delta.error && delta.error.current) {
      await finalizarDownload(delta.id, { state: 'interrupted', error: delta.error.current });
      return;
    }
    if (delta.state && delta.state.current === 'complete') {
      await finalizarDownload(delta.id, { state: 'complete' });
    }
  } catch (e) { console.warn('[Gerador SEI] downloads.onChanged:', e); }
});

async function atualizarBadge(execucao) {
  const ex = execucao !== undefined ? execucao : await GSEI.obter('execucao', null);
  if (ex && ex.ativa) {
    const cor = ex.tipo === 'gerar' ? '#1d4ed8'
      : (ex.tipo === 'download' ? '#b45309' : '#1a7f37');
    await chrome.action.setBadgeBackgroundColor({ color: cor });
    await chrome.action.setBadgeText({ text: String(ex.processados || 0) });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ------------------------------------------------------------------ eventos

chrome.runtime.onInstalled.addListener(async () => {
  await inicializar();
  await agendarKeepalive();
  await atualizarBadge();
  const ex = await GSEI.obter('execucao', null);
  await agendarTick(!!(ex && ex.ativa));
  // sincroniza a protecao contra discard (inclusive a liberacao ao final)
  await protegerAbas(!!(ex && ex.ativa));
});

chrome.runtime.onStartup.addListener(async () => {
  await inicializar();
  await agendarKeepalive();
  await atualizarBadge();
  const ex = await GSEI.obter('execucao', null);
  await agendarTick(!!(ex && ex.ativa));
  // sincroniza a protecao contra discard (inclusive a liberacao ao final)
  await protegerAbas(!!(ex && ex.ativa));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === ALARME_KEEPALIVE) await keepaliveUmaVez('sei', 'alarme');
    else if (alarm.name === ALARME_KEEPALIVE_PGT) await keepaliveUmaVez('pgt', 'alarme');
    else if (alarm.name === ALARME_TICK) await enviarTick();
  } catch (e) { console.warn('[Gerador SEI] alarme:', alarm.name, e); }
});

chrome.storage.onChanged.addListener((mudancas, area) => {
  if (area !== 'local') return;
  if (mudancas.execucao) {
    const ex = mudancas.execucao.newValue;
    atualizarBadge(ex);
    agendarTick(!!(ex && ex.ativa));
    // Protege/desprotege so na virada de ativa (o restante das escritas em
    // "execucao" acontece a cada passo); o tick de 30s cobre abas novas.
    const antes = !!(mudancas.execucao.oldValue && mudancas.execucao.oldValue.ativa);
    const agora = !!(ex && ex.ativa);
    if (antes !== agora) protegerAbas(agora);
  }
  if (mudancas.keepalive || mudancas.keepalive_pgt) agendarKeepalive();
});

chrome.runtime.onMessage.addListener((mensagem, remetente, responder) => {
  if (!mensagem || !mensagem.acao) return false;

  if (mensagem.acao === 'baixar-arquivo') {
    baixarArquivo(mensagem)
      .then(responder)
      .catch(e => responder({ ok: false, motivo: String(e && e.message || e) }));
    return true; // resposta assincrona
  }

  if (mensagem.acao === 'status-baixar') {
    const promessa = mensagem.desde
      ? estadoDesde(mensagem.desde, mensagem.item_id)
      : estadoDeDownload(mensagem.id);
    promessa
      .then(responder)
      .catch(() => responder({ ok: true, estado: null }));
    return true; // resposta assincrona
  }

  if (mensagem.acao === 'keepalive-agora') {
    keepaliveUmaVez(mensagem.alvo || 'sei', 'manual')
      .then(responder)
      .catch(e => responder({ ok: false, motivo: String(e) }));
    return true; // resposta assincrona
  }

  if (mensagem.acao === 'configurar-keepalive') {
    agendarKeepalive().then(() => responder({ ok: true })).catch(e => responder({ ok: false, motivo: String(e) }));
    return true;
  }

  if (mensagem.acao === 'status') {
    Promise.all([
      GSEI.obter('execucao', null),
      GSEI.obterKeepalive('sei'),
      GSEI.obterKeepalive('pgt')
    ]).then(([execucao, keepalive, keepalive_pgt]) =>
      responder({ ok: true, execucao, keepalive, keepalive_pgt }));
    return true;
  }

  return false;
});

inicializar()
  .then(agendarKeepalive)
  .then(async () => {
    await atualizarBadge();
    const ex = await GSEI.obter('execucao', null);
    await agendarTick(!!(ex && ex.ativa));
    // sincroniza a protecao contra discard (inclusive a liberacao ao final)
    await protegerAbas(!!(ex && ex.ativa));
  })
  .catch(e => console.warn('[Gerador SEI] init:', e));
