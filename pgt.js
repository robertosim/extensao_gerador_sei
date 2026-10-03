// Gerador SEI - motor de downloads do PGT (content script da aba do PGT).
//
// Baixa o "Espelho da Unidade Familiar" de cada beneficiario da fila, dentro
// de https://pgt.incra.gov.br. Usa a mesma maquina de estados persistida em
// chrome.storage.local (chave "execucao", tipo "download") do content.js:
// sobrevive a reload, a troca de aba e ao fechamento do popup.
//
// O fluxo por beneficiario e:
//   1 abrir a busca  -> 2 digitar o codigo + clicar em Pesquisar
//   -> 3 aguardar o resultado
//   -> 4 clicar em detalhar  -> 5 achar "Baixar relatorio"  -> 6 clicar
//   -> 7 aguardar o navegador concluir (o background grava o arquivo).
'use strict';

const PGT_URL = 'https://pgt.incra.gov.br/sipra/beneficiario';
const MEU_ABA = 'pgt-' + Math.random().toString(36).slice(2);
const TICK_MS = 600;
const CLAIM_MS = 6000;
const PASSO_TIMEOUT_MS = 120000;
const PASSO_TIMEOUT_DOWNLOAD_MS = 300000;
const ESPERA_PADRAO = 1500;

// ------------------------------------------------------------------ helpers

function dormir(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function texto(el) {
  if (!el) return '';
  return String(el.textContent || '').replace(/\s+/g, ' ').trim();
}

function visivel(el) {
  if (!el || !el.isConnected) return false;
  let no = el;
  for (let i = 0; no && no !== document.documentElement && i < 8; i++) {
    if (no.hidden) return false;
    try {
      const est = getComputedStyle(no);
      if (est.display === 'none' || est.visibility === 'hidden') return false;
    } catch (e) { /* ignora */ }
    no = no.parentElement;
  }
  return true;
}

function setValor(el, valor) {
  el.focus();
  const v = valor === undefined || valor === null ? '' : String(valor);
  if (v && el.value) {
    // limpa o conteudo anterior antes de digitar o codigo
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Tecla Enter DENTRO do input: e o Enter que dispara a busca no PGT.
function pressionarEnter(el) {
  try { el.focus(); } catch (e) { /* ignora */ }
  const init = {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13,
    bubbles: true, cancelable: true, composed: true, repeat: false, view: window
  };
  for (const tipo of ['keydown', 'keypress', 'keyup']) {
    try { el.dispatchEvent(new KeyboardEvent(tipo, init)); } catch (e) { /* ignora */ }
  }
}

// Dispara a busca clicando no botao "Pesquisar" (o Enter nao funciona neste
// PGT); se o botao nao existir, cai para o Enter como ultimo recurso.
async function dispararBusca(campo) {
  const botao = botaoPesquisar();
  if (botao) {
    botao.click();
    return 'botao Pesquisar';
  }
  if (campo) pressionarEnter(campo);
  return 'Enter (botao Pesquisar ausente)';
}

function estaNaLista() {
  const caminho = location.pathname;
  if (/detalhar|login|logon/i.test(caminho)) return false;
  return /\/sipra\//.test(caminho);
}

function estaNoLogin() {
  return /login|logon|autentic/i.test(location.pathname + location.search)
    || !!document.querySelector('input[type="password"]');
}

// O elemento precisa ser o <input> de verdade (o id pode estar no wrapper).
function campoUtil(el) {
  if (!el) return null;
  if (/^(input|textarea|select)$/i.test(el.tagName || '')) return el;
  const interno = el.querySelector ? el.querySelector('input, textarea, select') : null;
  return interno || null;
}

// A busca global do cabecalho (combobox "O que voce procura?", id dinamico do
// tipo "searchbox-90072") nunca e o campo de codigo do beneficiario: se o
// codigo cai la, a fila simplesmente para (a busca devolve nada e o passo fica
// esperando ate estourar o timeout). Os sinais abaixo nao dependem do id.
function ehBuscaGlobal(el) {
  if (!el || !el.getAttribute) return false;
  if (el.getAttribute('role') === 'combobox') return true;
  if (/search-results/i.test(el.getAttribute('aria-controls') || '')) return true;
  const descritivo = [el.id || '', el.name || '', el.getAttribute('placeholder') || ''].join(' ');
  if (/o que voce procura|searchbox|busca global|pesquisa global/i.test(descritivo)) return true;
  return false;
}

// Regiao de cabecalho/menu: descarta candidatos ambiguos. O campo oficial
// #codigoBeneficiario continua sendo aceito mesmo que a pagina o renderize
// perto de um <header>/nav.
function ehEmCabecalho(el) {
  if (!el || !el.closest) return false;
  try {
    return !!el.closest(
      'header, [role="banner"], nav, app-header, .br-header, #header, .topbar, .navbar');
  } catch (e) { return false; }
}

// Texto do campo sem acento/maiuscula: casa "Codigo ..." com "codigo".
function descritivoCampo(el) {
  if (!el) return '';
  const attr = (n) => (el.getAttribute ? String(el.getAttribute(n) || '') : '');
  return GSEI.normalizar(
    [el.id || '', attr('name'), attr('formcontrolname'), attr('placeholder')].join(' ')
  ).toLowerCase();
}

// Fora da lista exata so serve um input que fale de codigo/cod benef.
function ehCampoCodigo(el) {
  return /cod[\s_-]?(benef|igo)/.test(descritivoCampo(el));
}

// Campo do codigo do beneficiario. Alvo oficial:
// <input id="codigoBeneficiario" formcontrolname="codigo">. A busca global do
// cabecalho e descartada na hora; se o campo certo nao estiver na pagina,
// devolvemos null (o passo tenta de novo) em vez de digitar o codigo no
// primeiro input disponivel.
function campoBusca() {
  const exatos = [
    'input#codigoBeneficiario',
    '#codigoBeneficiario',
    'input[formcontrolname="codigo" i]',
    'input[formcontrolname*="codigo" i]'
  ];
  const parecidos = [
    'input[id*="codigo" i]', 'input[name*="codigo" i]',
    'input[id*="cod_benef" i]', 'input[name*="cod_benef" i]',
    'input[placeholder*="codigo" i]'
  ];
  for (const grupo of [exatos, parecidos]) {
    for (const sel of grupo) {
      let achado = [];
      try { achado = Array.from(document.querySelectorAll(sel)); } catch (e) { achado = []; }
      for (const bruto of achado) {
        if (bruto.type === 'hidden' || !visivel(bruto)) continue;
        if (ehBuscaGlobal(bruto)) continue;
        const alvo = campoUtil(bruto);
        if (!alvo || !visivel(alvo) || ehBuscaGlobal(alvo)) continue;
        if (grupo === parecidos && (!ehCampoCodigo(alvo) || ehEmCabecalho(alvo))) continue;
        return alvo;
      }
    }
  }

  // Ultimo recurso: inputs ao redor do botao "Pesquisar" que falem de codigo.
  // So ali, nunca "o primeiro input visivel" (isso enchia a busca global).
  const pesquisar = botaoPesquisar();
  if (!pesquisar) return null;
  const bloco = pesquisar.closest(
    'form, section, [role="search"], .br-card, [class*="card" i], [class*="busca" i]')
    || pesquisar.parentElement;
  if (!bloco || !bloco.querySelectorAll) return null;
  const candidatos = Array.from(bloco.querySelectorAll('input'))
    .filter(e => e.type !== 'hidden' && visivel(e) && !ehBuscaGlobal(e)
      && !ehEmCabecalho(e) && ehCampoCodigo(e));
  return candidatos[0] || null;
}

// Botao "Pesquisar" da busca: <button type="submit" class="br-button primary">.
function botaoPesquisar() {
  const textoDe = (e) => GSEI.normalizar(String(e.textContent || e.value || ''));
  let botoes = [];
  try {
    botoes = Array.from(document.querySelectorAll(
      'button, input[type="submit"], [role="button"], a'))
      .filter(e => visivel(e) && !ehBuscaGlobal(e));
  } catch (e) { botoes = []; }

  const exatos = botoes.filter(e => textoDe(e) === 'pesquisar');
  if (exatos.length) return exatos.find(e => e.tagName === 'BUTTON') || exatos[0];
  const comTexto = botoes.find(e => /^pesquis/.test(textoDe(e)));
  if (comTexto) return comTexto;
  return botoes.find(e => /fa-search|fa-magnifying-glass/.test(e.innerHTML || '')) || null;
}

// Botao "Baixar relatorio" da pagina de detalhe
// (<button class="br-button secondary"><em class="fa fa-download"></em> Baixar relatorio).
function botaoBaixarRelatorio() {
  const textoDe = (e) => GSEI.normalizar(String(e.textContent || e.value || ''));
  let candidatos = [];
  try {
    candidatos = Array.from(document.querySelectorAll(
      'button, a, input[type="button"], [role="button"]'));
  } catch (e) { candidatos = []; }
  const visiveis = candidatos.filter(e => visivel(e) && /baixar relat/.test(textoDe(e)));
  if (!visiveis.length) return null;
  return visiveis.find(e => /fa-download|fa-arrow-down/.test(e.innerHTML || ''))
    || visiveis.find(e => e.tagName === 'BUTTON')
    || visiveis[0];
}

// Icone de detalhe do resultado:
// <a class="br-button circle small" title="Detalhar"
//    href="/sipra/detalhar-unidade-familiar/1467635"><em class="fa-eye fas"></em></a>
function linksDetalhe() {
  try {
    return Array.from(document.querySelectorAll(
      'a[href*="/sipra/detalhar-unidade-familiar"], a[href*="detalhar-unidade-familiar"]'))
      .filter(a => visivel(a));
  } catch (e) { return []; }
}

// True quando o texto contem o codigo como palavra inteira (evita "123"
// casar com "1234").
function contemCodigo(t, cod) {
  const alvo = String(cod || '').trim();
  if (!t || !alvo) return false;
  if (t.includes(alvo)) {
    const re = new RegExp('(^|\\D)' + alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\D|$)');
    return re.test(t);
  }
  return false;
}

// O link de detalhe da linha que contem o codigo pesquisado.
function linkDoCodigo(cod) {
  const alvo = String(cod || '').trim();
  const links = linksDetalhe();
  if (!links.length) return null;
  if (alvo) {
    const comCod = links.filter(a => {
      const linha = a.closest('tr, [role="row"], li, mat-row')
        || (a.parentElement && a.parentElement.parentElement);
      return linha && contemCodigo(texto(linha), alvo);
    });
    if (comCod.length) return comCod[0];
  }
  if (links.length === 1 && (!alvo || codigoVisivel(alvo))) return links[0];
  return null;
}

function codigoVisivel(cod) {
  const alvo = String(cod || '').trim();
  if (!alvo) return false;
  try {
    const candidatos = Array.from(document.querySelectorAll('td, span, div, li, a, p, label'));
    return candidatos.some(e => visivel(e) && texto(e).length < 400 && contemCodigo(texto(e), alvo));
  } catch (e) { return false; }
}

function mensagemBusca() {
  const re = /nenhum registro|nao encontrado|não encontrado|nenhum resultado|sem resultado|nenhuma informacao|nao ha dados|acesso negado/i;
  let candidatos = [];
  try {
    candidatos = Array.from(document.querySelectorAll(
      '[role="alert"], .erro, .alerta, .alert, .mensagem, .msg, .aviso, span, p, div'));
  } catch (e) { candidatos = []; }
  for (const el of candidatos) {
    if (!visivel(el)) continue;
    const t = texto(el);
    if (t && t.length < 300 && re.test(t)) return t;
  }
  return null;
}

// ------------------------------------------------------------------ estado

async function lerExecucao() {
  return GSEI.obter('execucao', null);
}

async function gravarExecucao(parcial) {
  const atual = await lerExecucao();
  if (!atual) return null;
  const novo = Object.assign({}, atual, parcial);
  await chrome.storage.local.set({ execucao: novo });
  return novo;
}

async function montarContexto(ex) {
  const fila = await GSEI.obter('fila', []);
  const item = fila.find(f => f.id === ex.item_id) || null;
  return {
    ex,
    item,
    cod: item ? item.cod_beneficiario : '',
    nome: item ? item.nome : ''
  };
}

// --------------------------------------------------------- conclusoes/falhas

async function falhaItem(msg, global) {
  const ex = await lerExecucao();
  if (!ex || !ex.ativa) return;
  await GSEI.registrar(`DOWNLOAD [${ex.atual || '-'}] FALHA: ${msg}`, 'ERRO');

  const fila = await GSEI.obter('fila', []);
  const alvo = fila.find(f => f.id === ex.item_id);
  if (alvo) {
    alvo.download = -1;
    alvo.erro_download = msg;
    alvo.data_download = new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  await GSEI.definir('fila', fila);

  const parcial = {
    falha: (ex.falha || 0) + 1,
    processados: (ex.processados || 0) + 1,
    tentados: (ex.tentados || []).concat(
      ex.item_id === null || ex.item_id === undefined ? [] : [ex.item_id]),
    erros: (ex.erros || []).concat([{ atual: ex.atual, erro: msg }]).slice(-50),
    claim: null
  };

  if (global) {
    await finalizar(ex, parcial, 'abortado', msg);
    return;
  }

  await gravarExecucao(Object.assign(parcial, {
    passo: 0, passo_desc: null, passo_ts: Date.now(), esperar_ate: Date.now() + 1500, tentativas: 0,
    item_id: null, atual: '', link: null, baixar_id: null, baixar_desde: null
  }));
}

async function concluirItem(ex) {
  if (!ex || !ex.ativa) return;
  const fila = await GSEI.obter('fila', []);
  const alvo = fila.find(f => f.id === ex.item_id);
  if (alvo) {
    alvo.download = 1;
    alvo.erro_download = null;
    alvo.arquivo_download = ex.arquivo_download || null;
    alvo.data_download = new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  await GSEI.definir('fila', fila);
  await GSEI.registrar(`DOWNLOAD [${ex.atual || '-'}] SUCESSO: ${ex.arquivo_download || 'espelho salvo'}`);

  await gravarExecucao({
    sucesso: (ex.sucesso || 0) + 1,
    processados: (ex.processados || 0) + 1,
    tentados: (ex.tentados || []).concat(
      ex.item_id === null || ex.item_id === undefined ? [] : [ex.item_id]),
    passo: 0, passo_desc: null, passo_ts: Date.now(), esperar_ate: Date.now() + 1500, tentativas: 0,
    item_id: null, atual: '', claim: null, link: null, baixar_id: null,
    baixar_desde: null,
    arquivo_download: null
  });
}

async function iniciarProximoItem(ex) {
  const tentados = new Set(ex.tentados || []);
  const fila = await GSEI.obter('fila', []);
  const pendentes = fila.filter(f => f.download !== 1 && !tentados.has(f.id));

  if (!pendentes.length) {
    await finalizar(ex, {}, 'concluido');
    return;
  }

  const item = pendentes[0];
  const atual = `${item.cod_beneficiario} - ${item.nome || ''}`;

  if (!ex.total) await gravarExecucao({ total: pendentes.length });

  _diag = '';
  _buscaExtra = false;
  _buscaExtra2 = false;

  await GSEI.registrar(`DOWNLOAD [${item.cod_beneficiario || '-'}] Processando: ${atual}`);
  await gravarExecucao({
    item_id: item.id,
    atual,
    item_cod: item.cod_beneficiario || null,
    item_nome: item.nome || null,
    passo: PASSOS_DOWNLOAD[0].n,
    passo_desc: PASSOS_DOWNLOAD[0].desc,
    passo_ts: Date.now(),
    esperar_ate: Date.now() + 1000,
    tentativas: 0,
    link: null,
    baixar_id: null,
    baixar_desde: null,
    arquivo_download: null,
    claim: null
  });
}

async function finalizar(ex, parcial, status, motivo) {
  const novo = Object.assign({}, ex, parcial || {}, {
    ativa: false,
    status: status || 'concluido',
    motivo: motivo || null,
    atual: '',
    claim: null,
    item_id: null,
    link: null,
    baixar_id: null,
    baixar_desde: null,
    finalizado_em: new Date().toLocaleString('pt-BR')
  });
  if (status === 'concluido') novo.passo = 0;
  await chrome.storage.local.set({ execucao: novo });
  await GSEI.registrar(
    `DOWNLOAD Finalizado | Sucesso: ${novo.sucesso || 0} | Falha: ${novo.falha || 0}`
    + (motivo ? ` | ${motivo}` : ''));
}

// ------------------------------------------------------------------- passos

// Diagnostico do ultimo passo; entra na mensagem de timeout.
let _diag = '';
// Fallback: se o botao Pesquisar nao responder, clica de novo depois.
let _buscaExtra = false;
// Segundo clique no botao Pesquisar.
let _buscaExtra2 = false;

const PASSOS_DOWNLOAD = [
  {
    n: 1,
    onde: 'topo',
    desc: 'abrir a busca de beneficiarios',
    espera: 1200,
    exec: async () => {
      if (estaNoLogin()) {
        const erro = new Error('Sessao expirada no PGT: refaca o login manualmente');
        erro.global = true;
        throw erro;
      }
      if (!estaNaLista()) {
        location.assign(PGT_URL);
        return true;
      }
      return true;
    }
  },
  {
    n: 2,
    onde: 'topo',
    desc: 'digitar o codigo e clicar em Pesquisar',
    espera: 1500,
    exec: async (ctx) => {
      if (!estaNaLista()) {
        _diag = `fora da pagina de busca (${location.pathname})`;
        return false;
      }
      const campo = campoBusca();
      // cinto e suspensorio: nunca digitar na busca global do cabecalho
      if (!campo || ehBuscaGlobal(campo) || /^searchbox/i.test(campo.id || '')) {
        _diag = 'campo #codigoBeneficiario nao encontrado';
        return false;
      }
      try { campo.focus(); } catch (e) { /* ignora */ }
      setValor(campo, ctx.cod);
      // aceita mascara/formatadores: compara sem acentos, espacos e simbolos
      const escrito = GSEI.normalizar(campo.value).replace(/\s+/g, '');
      const esperado = GSEI.normalizar(ctx.cod).replace(/\s+/g, '');
      if (escrito !== esperado) {
        _diag = `valor nao aceito pelo campo #${campo.id || campo.name || '?'} `
          + `(valor atual: "${campo.value}")`;
        return false;
      }
      await dormir(150);
      const modo = await dispararBusca(campo);
      _diag = `codigo ${ctx.cod} digitado em #${campo.id || campo.name || '?'}; `
        + `busca disparada via ${modo}`;
      return true;
    }
  },
  {
    n: 3,
    onde: 'topo',
    desc: 'aguardar o resultado da busca',
    exec: async (ctx) => {
      const links = linksDetalhe();
      const link = linkDoCodigo(ctx.cod);
      if (link) {
        _diag = `resultado do codigo ${ctx.cod}; ${links.length} link(s) de detalhe`;
        return true;
      }

      const t = ctx.ex.tentativas || 0;
      const msg = mensagemBusca();

      // 1) refaz a busca pelo botao Pesquisar
      if (t >= 3 && !_buscaExtra) {
        _buscaExtra = true;
        const campo = campoBusca();
        if (campo) {
          setValor(campo, ctx.cod);
          await dormir(150);
          const modo = await dispararBusca(campo);
          _diag = `busca repetida via ${modo}`;
          return false;
        }
        _diag = 'campo do codigo sumiu da pagina';
        return false;
      }

      // 2) insistindo: so clica em Pesquisar de novo
      if (t >= 8 && !_buscaExtra2) {
        _buscaExtra2 = true;
        const pesquisar = botaoPesquisar();
        if (pesquisar) {
          pesquisar.click();
          _diag = 'clique repetido no botao Pesquisar';
          return false;
        }
      }

      // 3) mensagem de "nao encontrado" so desiste depois de varias tentativas
      if (msg && t >= 12) {
        throw new Error(`Codigo ${ctx.cod} nao localizado no PGT: ${msg}`);
      }

      _diag = `sem resultado (tentativa ${t}, links detalhe=${links.length}, `
        + `codigo na pagina=${codigoVisivel(ctx.cod)}, `
        + `campo=${campoBusca() ? '#' + (campoBusca().id || '?') : 'ausente'}, `
        + `botaoPesquisar=${!!botaoPesquisar()}, `
        + `mensagem=${msg || 'nenhuma'})`;
      return false;
    }
  },
  {
    n: 4,
    onde: 'topo',
    desc: 'clicar no icone de detalhar o beneficiario',
    espera: 4000,
    exec: async (ctx) => {
      const link = linkDoCodigo(ctx.cod);
      if (!link) {
        _diag = `link de detalhe nao achado (links=${linksDetalhe().length})`;
        return false;
      }
      link.click();
      _diag = `detalhe aberto: ${link.getAttribute('href') || ''}`;
      return true;
    }
  },
  {
    n: 5,
    onde: 'topo',
    desc: 'localizar o botao Baixar relatorio',
    exec: async () => {
      if (!botaoBaixarRelatorio()) {
        _diag = `botao "Baixar relatorio" ausente em ${location.pathname} `
          + `(botoes na pagina: ${document.querySelectorAll('button').length})`;
        return false;
      }
      _diag = 'botao "Baixar relatorio" encontrado';
      return true;
    }
  },
  {
    n: 6,
    onde: 'topo',
    desc: 'clicar em Baixar relatorio',
    espera: 2500,
    exec: async (ctx) => {
      const botao = botaoBaixarRelatorio();
      if (!botao) {
        _diag = 'botao "Baixar relatorio" sumiu antes do clique';
        return false;
      }
      // marca o horario ANTES do clique: o download pode terminar em milissegundos
      await gravarExecucao({ baixar_desde: Date.now() });
      botao.click();
      await GSEI.registrar(`DOWNLOAD [${ctx.cod || '-'}] "Baixar relatorio" clicado`);
      _diag = 'clique em "Baixar relatorio" disparado';
      return true;
    }
  },
  {
    n: 7,
    onde: 'topo',
    desc: 'aguardar a conclusao do download',
    timeout: PASSO_TIMEOUT_DOWNLOAD_MS,
    concluir: true,
    exec: async (ctx) => {
      let resultado = _concluidos.get(ctx.ex.item_id) || null;
      if (!resultado && (ctx.ex.tentativas || 0) >= 1 && ctx.ex.baixar_desde) {
        resultado = await consultarStatus(ctx.ex.baixar_desde, ctx.ex.item_id);
        if (resultado) _concluidos.set(ctx.ex.item_id, resultado);
      }
      if (!resultado) {
        _diag = `download nao confirmado (${ctx.ex.tentativas || 0} verificacao(oes))`;
        return false;
      }
      if (!resultado.ok) throw new Error(resultado.erro || 'Falha ao baixar o espelho');
      await gravarExecucao({ arquivo_download: resultado.arquivo || null });
      _diag = `download concluido: ${resultado.arquivo || 'sem nome'}`;
      return true;
    }
  }
];

function passosDe() {
  return PASSOS_DOWNLOAD;
}

function proximoPasso(ex, atual) {
  const lista = passosDe();
  const idx = lista.findIndex(p => p.n === atual.n);
  return idx >= 0 && idx + 1 < lista.length ? lista[idx + 1].n : 0;
}

// ------------------------------------------------------------------ fluxo

let _tick = false;

// Resultados dos downloads iniciados pelo background (id -> estado).
const _concluidos = new Map();

async function consultarStatus(desde, item_id) {
  try {
    const resp = await chrome.runtime.sendMessage({ acao: 'status-baixar', desde, item_id });
    if (resp && resp.ok && resp.estado) return resp.estado;
  } catch (e) { /* sem resposta: tenta de novo no proximo tick */ }
  return null;
}

function alvoDoPasso(passo) {
  return passo.onde === 'topo';
}

async function reivindicar(passo, item) {
  const atual = await lerExecucao();
  if (!atual || !atual.ativa || atual.passo !== passo.n || atual.item_id !== item) return null;
  const agora = Date.now();
  const claim = atual.claim;
  if (claim && claim.passo === passo.n && claim.item === item
    && agora - claim.ts < CLAIM_MS && claim.frame !== MEU_ABA) return null;
  await chrome.storage.local.set({
    execucao: Object.assign({}, atual,
      { claim: { passo: passo.n, item, ts: agora, frame: MEU_ABA } })
  });
  return atual;
}

async function executarPasso(passo, ex) {
  let ctx;
  try {
    ctx = await montarContexto(ex);
  } catch (e) {
    await falhaItem(`Erro ao montar contexto: ${e.message}`, false);
    return;
  }
  if (!ctx.item) {
    await falhaItem('Registro nao encontrado mais (fila alterada durante a execucao)', false);
    return;
  }

  let ret;
  try {
    ret = passo.exec(ctx);
    if (ret && typeof ret.then === 'function') ret = await ret;
  } catch (e) {
    console.warn('[Gerador SEI] PGT passo', passo.n, 'erro:', e.message);
    await falhaItem(`PASSO ${passo.n} (${passo.desc}): ${e.message}`, !!e.global);
    return;
  }

  if (ret === false) {
    console.info('[Gerador SEI] PGT passo', passo.n, 'aguardando |', _diag);
    await gravarExecucao({
      tentativas: (ex.tentativas || 0) + 1,
      esperar_ate: Date.now() + 2500,
      claim: null
    });
    return;
  }

  console.info('[Gerador SEI] PGT passo', passo.n, 'ok');
  await GSEI.registrar(`DOWNLOAD [${ex.atual || '-'}] PASSO ${passo.n}: ${passo.desc}`);

  if (passo.concluir) {
    await concluirItem(await lerExecucao());
    return;
  }

  const proximo = listaDoPasso(proximoPasso(ex, passo));
  await gravarExecucao({
    passo: proximo ? proximo.n : 0,
    passo_desc: proximo ? proximo.desc : null,
    passo_ts: Date.now(),
    esperar_ate: Date.now() + (passo.espera || ESPERA_PADRAO),
    tentativas: 0,
    claim: null
  });
}

function listaDoPasso(n) {
  if (!n) return null;
  return PASSOS_DOWNLOAD.find(p => p.n === n) || null;
}

async function rodarTick() {
  const ex = await lerExecucao();
  if (!ex || !ex.ativa || ex.tipo !== 'download') return;
  if (ex.pausado) return;

  const agora = Date.now();
  if (agora < (ex.esperar_ate || 0)) return;

  const lista = passosDe();
  const passo = lista.find(p => p.n === ex.passo);

  if (!passo) {
    if (ex.passo === 0) await iniciarProximoItem(ex);
    else await finalizar(ex, {}, 'concluido');
    return;
  }

  if (ex.item_id === null || ex.item_id === undefined) {
    await iniciarProximoItem(ex);
    return;
  }

  const timeout = passo.timeout || PASSO_TIMEOUT_MS;
  if (agora - (ex.passo_ts || agora) > timeout) {
    const detalhe = _diag ? ` | ${_diag}` : '';
    await falhaItem(
      `Timeout no passo ${passo.n} (${passo.desc}) apos ${Math.round(timeout / 1000)}s${detalhe}`,
      false);
    return;
  }

  if (!alvoDoPasso(passo)) return;

  const garantido = await reivindicar(passo, ex.item_id);
  if (!garantido) return;

  await executarPasso(passo, garantido);
}

async function tick() {
  if (_tick) return;
  _tick = true;
  try {
    await rodarTick();
  } catch (e) {
    if (contextoInvalido(e)) pararPorContextoInvalido(e);
    else console.error('[Gerador SEI] erro no tick do PGT:', e);
  } finally {
    _tick = false;
  }
}

// ------------------------------------------------------------------- boot

let _timer = null;
let _recarregando = false;

function contextoInvalido(e) {
  return /Extension context invalidated/i.test(String((e && e.message) || e || ''));
}

// A extensao foi atualizada/recarregada e este content script ficou com a API
// do chrome invalidada. Para o motor e recarrega a aba: a pagina nova ganha um
// script novo e continua do mesmo ponto (o estado fica no chrome.storage.local).
function pararPorContextoInvalido(erro) {
  if (_recarregando) return;
  _recarregando = true;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  console.warn('[Gerador SEI] contexto da extensao invalidado; recarregando a pagina do PGT:', erro);
  setTimeout(() => { try { location.reload(); } catch (e) { /* ignora */ } }, 600);
}

// ------------------------------------------------------------- congelamento
// Chrome 133+ (Energy Saver) congela abas de fundo de alto uso de CPU: o
// motor para junto porque timers e mensagens deixam de rodar. Manter um
// Web Lock ativo e uma das isencoes oficiais (CannotFreezeReason::
// kHoldingWebLock em freezing_policy.cc do Chromium).
const NOME_LOCK = 'gsei-execucao';
let _lockAtiva = false;
let _lockPedido = false;

function manterDescongelada(ativo) {
  _lockAtiva = !!ativo;
  if (!_lockAtiva || _lockPedido) return;
  _lockPedido = true;
  try {
    navigator.locks.request(NOME_LOCK, { mode: 'shared' }, async () => {
      try {
        while (_lockAtiva) await dormir(1000);
      } finally {
        _lockPedido = false;
        if (_lockAtiva) setTimeout(() => manterDescongelada(true), 0);
      }
    }).catch(() => { _lockPedido = false; });
  } catch (e) { _lockPedido = false; }
}

// Page Lifecycle: "freeze"/"resume" chegam no document. O log explica no
// momento em que a automacao parou (e quando ela voltou).
document.addEventListener('freeze', () => {
  if (!_timer) return;
  GSEI.registrar('Aba do PGT congelada pelo Chrome (Energy Saver): automacao pausada', 'AVISO')
    .catch(() => {});
});
document.addEventListener('resume', () => {
  if (!_timer) return;
  GSEI.registrar('Aba do PGT descongelada pelo Chrome: automacao retomada').catch(() => {});
  tick();
});

async function avaliarTrabalho() {
  try {
    const ex = await lerExecucao();
    const ativo = !!(ex && ex.ativa && ex.tipo === 'download');
    manterDescongelada(ativo);
    if (ativo && !_timer) {
      _timer = setInterval(tick, TICK_MS);
      tick();
    } else if (!ativo && _timer) {
      clearInterval(_timer);
      _timer = null;
    }
  } catch (e) {
    if (contextoInvalido(e)) pararPorContextoInvalido(e);
    else console.warn('[Gerador SEI] avaliarTrabalho (PGT):', e);
  }
}

chrome.storage.onChanged.addListener((mudancas, area) => {
  try {
    if (area === 'local' && mudancas.execucao) avaliarTrabalho();
  } catch (e) {
    if (contextoInvalido(e)) pararPorContextoInvalido(e);
    else console.warn('[Gerador SEI] storage.onChanged (PGT):', e);
  }
});

chrome.runtime.onMessage.addListener((mensagem) => {
  try {
    if (!mensagem || !mensagem.acao) return false;
    if (mensagem.acao === 'tick') { tick(); return false; }
    if (mensagem.acao === 'pgt-download-fim') {
      if (mensagem.item_id !== null && mensagem.item_id !== undefined) {
        _concluidos.set(mensagem.item_id, {
          ok: !!mensagem.ok,
          erro: mensagem.erro || null,
          arquivo: mensagem.arquivo || null
        });
      }
      tick();
      return false;
    }
  } catch (e) {
    if (contextoInvalido(e)) pararPorContextoInvalido(e);
    else console.warn('[Gerador SEI] tick remoto (PGT):', e);
  }
  return false;
});

avaliarTrabalho();
