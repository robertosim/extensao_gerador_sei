// Gerador SEI - painel (popup).
//
// Todo o estado mora no chrome.storage.local: o popup apenas monta/ajusta
// listas e configuracoes, e cria/para a "execucao" que os content scripts
// consomem. Fechar o popup nao interrompe nada.
'use strict';

const $ = (sel, raiz) => (raiz || document).querySelector(sel);
const $$ = (sel, raiz) => Array.from((raiz || document).querySelectorAll(sel));

const URL_SEI = 'https://sei.incra.gov.br/*';
const SEI_URL = 'https://sei.incra.gov.br/sei';
const URL_PGT = 'https://pgt.incra.gov.br/*';
const PGT_URL = 'https://pgt.incra.gov.br/sipra/beneficiario';
const LIMITE_TABELA = 500;
const LIMITE_LOG = 400;
// Tipo do processo ja selecionado por padrao na aba Gerar.
const TIPO_PROCESSO_PADRAO = '100000508'; // Finalistico: Desenvolvimento de Assentamentos

let _assinatura = '';
let _timer = null;
let _toastTimer = null;
const _confirmacao = new Map();

// Controle de render: as secoes pesadas (tabelas) so sao redesenhadas quando
// a aba correspondente esta visivel; as demais ficam "sujas" e sao desenhadas
// na troca de aba. Assim a fila pode rodar sem engarrafar a interface.
let _abaAtiva = 'gerar';
let _agendado = null;
const _sujo = {
  fila: true, registros: true, log: true,
  downloads: true, keepalive: true, execucao: true
};
const _html = new Map(); // ultimo HTML por elemento (evita reflow inutil)

// ------------------------------------------------------------------ util

function esc(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('oculto');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('oculto'), 3200);
}

function marcarMsg(el, texto, classe) {
  const base = el.dataset.base !== undefined
    ? el.dataset.base
    : (el.dataset.base = el.className.replace(/\s*\b(ok|erro)\b/g, '').trim());
  el.textContent = texto || '';
  el.className = base + (classe ? ' ' + classe : '');
}

// Confirmacao em dois cliques (popups de extensao nao confiam em dialogs).
function confirmar(id, rotulo, aoConfirmar) {
  if (_confirmacao.get(id)) {
    _confirmacao.delete(id);
    aoConfirmar();
    return;
  }
  _confirmacao.set(id, true);
  toast(`Clique de novo em "${rotulo}" para confirmar`);
  setTimeout(() => _confirmacao.delete(id), 4000);
}

async function garantirAbaSEI(ativa) {
  const abas = await chrome.tabs.query({ url: URL_SEI });
  if (abas.length) {
    await chrome.tabs.update(abas[0].id, { active: ativa !== false });
    return abas[0];
  }
  return chrome.tabs.create({ url: SEI_URL, active: ativa !== false });
}

// Abre (ou reaproveita) uma aba do PGT ja na pagina do beneficiario.
// `recarregar` força um reload: a aba pode estar com o content script morto
// (extensao atualizada com a pagina aberta) e ai nada acontece.
async function garantirAbaPGT(ativa, recarregar) {
  const abas = await chrome.tabs.query({ url: URL_PGT });
  if (abas.length) {
    const aba = abas[0];
    const naPagina = /^https:\/\/pgt\.incra\.gov\.br\/sipra\/beneficiario/.test(aba.url || '');
    if (!naPagina) await chrome.tabs.update(aba.id, { url: PGT_URL, active: ativa !== false });
    else await chrome.tabs.update(aba.id, { active: ativa !== false });
    if (recarregar) {
      try { await chrome.tabs.reload(aba.id); } catch (e) { /* ignora */ }
    }
    return aba;
  }
  return chrome.tabs.create({ url: PGT_URL, active: ativa !== false });
}

async function paraBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const fatia = 0x8000;
  for (let i = 0; i < bytes.length; i += fatia) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + fatia));
  }
  return btoa(bin);
}

async function textoDoArquivo(arquivo) {
  const buffer = await arquivo.arrayBuffer();
  return GSEI.decodificarCSV(new Uint8Array(buffer));
}

// ------------------------------------------------------------------- abas

// Grava o HTML so quando ele mudou: evita relayout das tabelas a cada tique.
function aplicarHtml(el, html) {
  const chave = el.id || el.className;
  if (_html.get(chave) === html) return;
  _html.set(chave, html);
  el.innerHTML = html;
}

// Secao pesada de cada aba (renderiza apenas com a aba visivel).
const SECOES_ABA = {
  gerar: ['fila'],
  downloads: ['downloads'],
  anexar: ['registros'],
  log: ['log']
};

function abaVisivel(secao) {
  return (SECOES_ABA[_abaAtiva] || []).indexOf(secao) >= 0;
}

// Marca secoes como pendentes e agenda UM unico passo de render: varias
// mudancas de storage no mesmo instante viram um redesenho so.
function agendarRender(secoes) {
  (secoes && secoes.length ? secoes : Object.keys(_sujo)).forEach(s => {
    if (s in _sujo) _sujo[s] = true;
  });
  if (_agendado !== null) return;
  _agendado = setTimeout(() => { _agendado = null; processarRender(); }, 120);
}

// forcar=true ignora a aba visivel (usado na abertura do popup, para a
// primeira pintura sair completa; depois so a aba aberta e redesenhada).
async function processarRender(forcar) {
  try {
    if (_sujo.keepalive) { _sujo.keepalive = false; await renderKeepalive(); }
    if (_sujo.execucao) { _sujo.execucao = false; await renderExecucao(); }
    if (_sujo.downloads) { _sujo.downloads = false; await renderDownloads(); }
    // Tabelas: so com a aba aberta; caso contrario continuam sujas ate a troca.
    if (_sujo.fila && (forcar || abaVisivel('fila'))) { _sujo.fila = false; await renderFila(); }
    if (_sujo.registros && (forcar || abaVisivel('registros'))) { _sujo.registros = false; await renderRegistros(); }
    if (_sujo.log && (forcar || abaVisivel('log'))) { _sujo.log = false; await renderLog(); }
  } catch (e) {
    console.warn('[Gerador SEI] render:', e);
  }
}

// Troca de aba: a classe ja foi trocada de forma sincrona (a aba responde
// na hora) e aqui so desenhamos a secao que ficou pendente.
async function abrirAba(aba) {
  _abaAtiva = aba;
  const secao = (SECOES_ABA[aba] || [])[0];
  if (!secao || !_sujo[secao]) return;
  try {
    _sujo[secao] = false;
    if (secao === 'fila') await renderFila();
    else if (secao === 'registros') await renderRegistros();
    else if (secao === 'log') await renderLog();
    else if (secao === 'downloads') await renderDownloads();
  } catch (e) {
    _sujo[secao] = true;
    console.warn('[Gerador SEI] troca de aba:', e);
  }
}

function configurarAbas() {
  $$('.aba').forEach(botao => {
    botao.addEventListener('click', () => {
      $$('.aba').forEach(b => b.classList.toggle('ativa', b === botao));
      const alvo = `aba-${botao.dataset.aba}`;
      $$('.conteudo').forEach(c => c.classList.toggle('ativa', c.id === alvo));
      abrirAba(botao.dataset.aba);
    });
  });
}

// ---------------------------------------------------------------- selects

function preencherSelect(el, itens, valor, semCodigo) {
  const atual = valor === undefined || valor === null ? '' : String(valor);
  const temVazio = el.querySelector('option[value=""]');
  const opcoes = [];
  if (temVazio) opcoes.push('<option value="">&nbsp;</option>');
  for (const item of itens || []) {
    const codigo = String(item[0]);
    const nome = item[1];
    opcoes.push(`<option value="${esc(codigo)}">${semCodigo ? esc(nome) : esc(codigo) + ' - ' + esc(nome)}</option>`);
  }
  el.innerHTML = opcoes.join('');
  if (atual && Array.from(el.options).some(o => o.value === atual)) el.value = atual;
}

function carregarSelects() {
  preencherSelect($('#cfg-serie'), LISTAS.tiposDocumento, null, true);
  preencherSelect($('#cfg-hipotese'), LISTAS.hipotesesLegais, null);
  preencherSelect($('#cfg-hipotese-gerar'), LISTAS.hipotesesLegais, null);
  preencherSelect($('#cfg-tipo-processo'), LISTAS.tiposProcesso, null, true);
}

// ------------------------------------------------------------ config local

async function carregarConfigAnexo() {
  const cfg = Object.assign({}, GSEI.PADRAO_ANEXO, await GSEI.obter('cfg_anexo', {}));
  $('#cfg-serie').value = String(cfg.serie || '');
  $('#cfg-sigilo').value = String(cfg.sigilo || 'R');
  $('#cfg-nome-arvore').value = cfg.nome_arvore || '';
  $('#cfg-hipotese').value = String(cfg.hipotese || '');
  $('#cfg-nivel').value = String(cfg.nivel || '1');
}

async function carregarConfigGeracao() {
  const cfg = Object.assign({}, GSEI.PADRAO_GERACAO, await GSEI.obter('cfg_geracao', {}));
  const sel = $('#cfg-tipo-processo');
  sel.value = String(cfg.tipo_processo || '');
  // padrao ja selecionado: Finalistico: Desenvolvimento de Assentamentos
  if (!sel.value && Array.from(sel.options).some(o => o.value === TIPO_PROCESSO_PADRAO)) {
    sel.value = TIPO_PROCESSO_PADRAO;
  }
  $('#cfg-especificacao').value = cfg.especificacao || '';
  // guardado contra o campo sumir do HTML: cfg_geracao.interessados continua
  // valendo (o passo 7 do SEI preenche "Interessados" com ele)
  const campoInteressados = $('#cfg-interessados');
  if (campoInteressados) campoInteressados.value = cfg.interessados || '';
  $('#cfg-observacoes').value = cfg.observacoes || '';
  $('#cfg-nivel-gerar').value = String(cfg.nivel_acesso || '1');
  $('#cfg-hipotese-gerar').value = String(cfg.hipotese_legal || '4');
}

async function salvarConfigAnexo() {
  const cfg = {
    serie: $('#cfg-serie').value,
    sigilo: $('#cfg-sigilo').value,
    nome_arvore: $('#cfg-nome-arvore').value.trim(),
    hipotese: $('#cfg-hipotese').value,
    nivel: $('#cfg-nivel').value
  };
  if (!cfg.serie) { toast('Escolha o tipo do documento'); return; }
  await GSEI.definir('cfg_anexo', cfg);
  await GSEI.registrar(`Config de anexacao salva: serie=${cfg.serie}, sigilo=${cfg.sigilo}, nivel=${cfg.nivel}`);
  marcarMsg($('#cfg-anexo-msg'), 'Configuracao salva.', 'ok');
  toast('Configuracao da anexacao salva');
}

async function salvarConfigGeracao() {
  const anterior = await GSEI.obter('cfg_geracao', {});
  const campoInteressados = $('#cfg-interessados');
  const cfg = {
    tipo_processo: $('#cfg-tipo-processo').value,
    especificacao: $('#cfg-especificacao').value.trim(),
    // campo ausente no HTML: guarda o valor anterior em vez de apagar a config
    interessados: campoInteressados ? campoInteressados.value.trim()
      : String(anterior.interessados || GSEI.PADRAO_GERACAO.interessados || '').trim(),
    observacoes: $('#cfg-observacoes').value.trim(),
    nivel_acesso: $('#cfg-nivel-gerar').value,
    hipotese_legal: $('#cfg-hipotese-gerar').value
  };
  if (!cfg.tipo_processo) { toast('Escolha o tipo do processo'); return; }
  await GSEI.definir('cfg_geracao', cfg);
  await GSEI.registrar(`Config de geracao salva: tipo=${cfg.tipo_processo}, nivel=${cfg.nivel_acesso}`);
  marcarMsg($('#cfg-geracao-msg'), 'Configuracao salva.', 'ok');
  toast('Configuracao da geracao salva');
}

// -------------------------------------------------------------- CSV / PDF

// Os registros da anexacao vem do CSV carregado na aba Gerar SEI (fila)
// cruzado com os PDFs escolhidos aqui. Mantem o status de quem ja foi anexado.
async function sincronizarRegistros() {
  const fila = await GSEI.obter('fila', []);
  const pdfs = await GSEI.obter('pdfs', {});
  const atuais = await GSEI.obter('registros', []);
  const porCod = new Map();
  atuais.forEach(r => porCod.set(String(r.cod_sipra || '').trim().toUpperCase(), r));

  const registros = [];
  const vistos = new Set();

  for (const f of fila) {
    const cod = String(f.cod_beneficiario || '').trim().toUpperCase();
    if (!cod) continue;
    vistos.add(cod);
    const anterior = porCod.get(cod) || {};
    const pdf = pdfs[cod];
    registros.push({
      id: 'r' + cod,
      cod_sipra: cod,
      nome: f.nome || anterior.nome || '',
      processo_sei: f.processo_sei_original || f.processo_gerado
        || anterior.processo_sei || '',
      pdf_anexo: (pdf && pdf.nome) || anterior.pdf_anexo || '',
      anexado: anterior.anexado === undefined ? 0 : anterior.anexado,
      data_anexo: anterior.data_anexo || null
    });
  }

  for (const r of atuais) {
    const cod = String(r.cod_sipra || '').trim().toUpperCase();
    if (!cod || vistos.has(cod)) continue;
    vistos.add(cod);
    const pdf = pdfs[cod];
    registros.push(Object.assign({}, r, {
      pdf_anexo: (pdf && pdf.nome) || r.pdf_anexo || ''
    }));
  }

  await GSEI.definir('registros', registros);
  return registros;
}

// Chave de comparacao do codigo: apenas letras/digitos, para bater o codigo
// do CSV com o nome do arquivo (unidade-familiar-MS001200000001.pdf).
function chaveCod(txt) {
  return String(txt || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Localiza no nome do PDF o codigo de um registro do CSV: a referencia vem do
// proprio CSV (qualquer formato), comparada sem depender de prefixo fixo.
// Sem CSV, aceita o token generico <letras><digitos> - S00323223, MS032323,
// RO0000, SC012345 - usando sempre o token mais longo do nome.
function codDoArquivo(nome, codigos) {
  const semExt = String(nome || '').replace(/\.[Pp][Dd][Ff]$/, '');
  const alvo = chaveCod(semExt);

  let melhor = '';
  for (const cod of codigos) {
    const chave = chaveCod(cod);
    if (chave && alvo.includes(chave) && chave.length > melhor.length) melhor = cod;
  }
  if (melhor) return String(melhor).trim().toUpperCase();

  const candidatos = semExt.toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(t => /^[A-Z]{1,3}\d{4,}$/.test(t))
    .sort((a, b) => b.length - a.length);
  return candidatos[0] || '';
}

async function carregarPdfs(files) {
  try {
    const pdfs = await GSEI.obter('pdfs', {});
    const fila = await GSEI.obter('fila', []);
    const atuais = await GSEI.obter('registros', []);
    const codigos = new Set();
    for (const f of fila) {
      const c = String(f.cod_beneficiario || '').trim().toUpperCase();
      if (c) codigos.add(c);
    }
    for (const r of atuais) {
      const c = String(r.cod_sipra || '').trim().toUpperCase();
      if (c) codigos.add(c);
    }
    let carregados = 0, ignorados = 0;

    for (const arquivo of files) {
      if (!/\.pdf$/i.test(arquivo.name)) { ignorados++; continue; }
      const cod = codDoArquivo(arquivo.name, codigos);
      if (!cod) { ignorados++; continue; }
      pdfs[cod] = { nome: arquivo.name, b64: await paraBase64(await arquivo.arrayBuffer()) };
      carregados++;
    }

    await GSEI.definir('pdfs', pdfs);
    const registros = await sincronizarRegistros();
    const comPdf = registros.filter(r => (r.pdf_anexo || '').trim() !== '').length;
    const comProcesso = registros.filter(r => (r.processo_sei || '').trim() !== '').length;

    await GSEI.registrar(`PDFs de anexacao: ${carregados} carregado(s), ${ignorados} ignorado(s) | `
      + `${registros.length} registro(s) na lista (${comPdf} com PDF, ${comProcesso} com processo)`);
    marcarMsg($('#aviso-anexar'),
      `${carregados} PDF(s) carregado(s), ${ignorados} ignorado(s).`, 'ok');
    await renderRegistros();
  } catch (e) {
    marcarMsg($('#aviso-anexar'), `Erro ao ler PDFs: ${e.message}`, 'erro');
    toast('Falha ao ler os PDFs');
  }
}

async function carregarCsvGerar(arquivo) {
  try {
    const texto = await textoDoArquivo(arquivo);
    const { cabecalho, linhas } = GSEI.lerCSV(texto);
    const cCod = GSEI.acharColuna(cabecalho, 'CODIGO BENEFICIARIO', 'CODIGO DO BENEFICIARIO',
      'COD. BENEFICIARIO', 'CODIGO SIPRA');
    const cNome = GSEI.acharColuna(cabecalho, 'NOME TITULAR 1', 'BENEFICIARIO', 'NOME');
    const cProc = GSEI.acharColuna(cabecalho, 'NO PROCESSO SEI', 'N PROCESSO SEI', 'NUP', 'PROCESSO SEI');

    if (!cCod) {
      marcarMsg($('#aviso-gerar'), 'Coluna de codigo do beneficiario nao encontrada no CSV.', 'erro');
      toast('CSV sem coluna de codigo');
      return;
    }

    const fila = await GSEI.obter('fila', []);
    let inseridos = 0, atualizados = 0, ignorados = 0;

    for (const linha of linhas) {
      const cod = (linha[cCod] || '').trim();
      if (!cod) { ignorados++; continue; }
      const dados = {};
      for (const [k, v] of Object.entries(linha)) if (k) dados[k] = String(v === null ? '' : v).trim();
      const existente = fila.find(f => String(f.cod_beneficiario) === cod);
      if (!existente) {
        fila.push({
          id: 'g' + cod,
          cod_beneficiario: cod,
          nome: cNome ? (linha[cNome] || '').trim() : '',
          processo_sei_original: cProc ? (linha[cProc] || '').trim() : '',
          dados_csv: JSON.stringify(dados),
          status: 0, erro: null, processo_gerado: null, data_geracao: null,
          download: 0, erro_download: null, data_download: null
        });
        inseridos++;
      } else if (existente.status !== 1) {
        existente.nome = cNome ? (linha[cNome] || '').trim() : existente.nome;
        existente.processo_sei_original = cProc ? (linha[cProc] || '').trim() : '';
        existente.dados_csv = JSON.stringify(dados);
        existente.erro = null;
        atualizados++;
      } else {
        ignorados++;
      }
    }

    await GSEI.definir('fila', fila);
    await sincronizarRegistros();
    await GSEI.registrar(`CSV de geracao carregado: ${arquivo.name} | ${inseridos} novo(s), `
      + `${atualizados} atualizado(s), ${ignorados} ignorado(s)`);
    marcarMsg($('#aviso-gerar'),
      `${inseridos} novo(s), ${atualizados} atualizado(s), ${ignorados} ignorado(s).`, 'ok');
    $('#arquivo-gerar').textContent = arquivo.name;
    await renderFila();
    await renderRegistros();
    await renderDownloads();
  } catch (e) {
    marcarMsg($('#aviso-gerar'), `Erro ao ler CSV: ${e.message}`, 'erro');
    toast('Falha ao ler o CSV');
  }
}

// ---------------------------------------------------------------- render

async function renderRegistros() {
  const registros = await GSEI.obter('registros', []);
  const stats = GSEI.calcularStats(registros);
  const pendentes = registros.filter(r =>
    (r.anexado === 0 || r.anexado === -1)
    && (r.pdf_anexo || '').trim() !== ''
    && (r.processo_sei || '').trim() !== '').length;
  const semPdf = registros.filter(r => !(r.pdf_anexo || '').trim()).length;

  aplicarHtml($('#stats-anexar'),
    `Total: <b>${stats.total}</b> &nbsp;|&nbsp; Anexados: <b>${stats.com_pdf}</b> `
    + `&nbsp;|&nbsp; Erros: <b>${stats.erros}</b> &nbsp;|&nbsp; Sem PDF: <b>${semPdf}</b> `
    + `&nbsp;|&nbsp; Com processo SEI: <b>${stats.com_processo}</b> `
    + `&nbsp;|&nbsp; Prontos: <b>${pendentes}</b>`);

  $('#contagem-anexar').textContent = registros.length ? `(${registros.length})` : '';
  const visiveis = registros.slice(0, LIMITE_TABELA);
  aplicarHtml($('#tabela-anexar'), visiveis.map(r => {
    let classe = 'pend', texto = 'Pendente';
    if (r.anexado === 1) { classe = 'ok'; texto = 'Anexado'; }
    else if (r.anexado === -1) { classe = 'err'; texto = 'Erro'; }
    else if (!(r.pdf_anexo || '').trim()) { classe = 'err'; texto = 'Sem PDF'; }
    else if (!(r.processo_sei || '').trim()) { classe = 'err'; texto = 'Sem processo'; }
    return `<tr><td>${esc(r.cod_sipra)}</td><td>${esc(r.processo_sei)}</td>`
      + `<td>${esc(r.pdf_anexo)}</td><td class="sit ${classe}">${texto}</td></tr>`;
  }).join('') || '<tr><td colspan="4">Sem registros. Carregue o CSV na aba Gerar SEI e os PDFs aqui.</td></tr>');
}

async function renderFila() {
  const fila = await GSEI.obter('fila', []);
  const gerados = fila.filter(f => f.status === 1).length;
  const erros = fila.filter(f => f.status === -1).length;
  const pendentes = fila.filter(f => f.status === 0 || f.status === -1).length;

  aplicarHtml($('#stats-gerar'),
    `Total: <b>${fila.length}</b> &nbsp;|&nbsp; Gerados: <b>${gerados}</b> `
    + `&nbsp;|&nbsp; Erros: <b>${erros}</b> &nbsp;|&nbsp; Pendentes: <b>${pendentes}</b>`);
  $('#contagem-gerar').textContent = fila.length ? `(${fila.length})` : '';

  const visiveis = fila.slice(0, LIMITE_TABELA);
  aplicarHtml($('#tabela-gerar'), visiveis.map(f => {
    let classe = 'pend', texto = 'Pendente';
    if (f.status === 1) { classe = 'ok'; texto = 'Gerado'; }
    else if (f.status === -1) { classe = 'err'; texto = 'Erro'; }
    return `<tr><td>${esc(f.cod_beneficiario)}</td>`
      + `<td class="sit ${classe}">${texto}</td>`
      + `<td>${esc(f.processo_gerado || '')}</td>`
      + `<td>${esc(f.erro || '')}</td></tr>`;
  }).join('') || '<tr><td colspan="4">Fila vazia. Carregue o CSV.</td></tr>');
}

async function renderLog() {
  const log = await GSEI.obter('log', []);
  const linhas = log.slice(-LIMITE_LOG);
  const caixa = $('#lista-log');
  const html = linhas.map(l =>
    /ERRO|FALHA|abortad/i.test(l) ? `<span class="erro">${esc(l)}</span>` : esc(l)
  ).join('\n') || '(log vazio)';
  // log muda a cada passo: sem alteracao real nao toca no DOM (sem reflow)
  if (_html.get(caixa.id) === html) return;
  const noFim = caixa.scrollTop + caixa.clientHeight >= caixa.scrollHeight - 30;
  aplicarHtml(caixa, html);
  if (noFim) caixa.scrollTop = caixa.scrollHeight;
}

function renderBotoesGerar(ex) {
  const rodando = !!(ex && ex.ativa && ex.tipo === 'gerar');
  const ocupado = !!(ex && ex.ativa && ex.tipo !== 'gerar');
  const botao = $('#btn-iniciar-gerar');
  botao.textContent = rodando ? (ex.pausado ? 'Continuar' : 'Pausar') : 'Iniciar geracao';
  botao.disabled = ocupado;
  $('#btn-cancelar-gerar').classList.toggle('oculto', !rodando);
}

function renderBotoesDownload(ex) {
  const rodando = !!(ex && ex.ativa && ex.tipo === 'download');
  const ocupado = !!(ex && ex.ativa && ex.tipo !== 'download');
  const botao = $('#btn-baixar-espelho');
  botao.textContent = rodando ? (ex.pausado ? 'Continuar' : 'Pausar') : 'Baixar';
  botao.disabled = ocupado;
}

function renderProgressoGerar(ex) {
  const bloco = $('#progresso-gerar');
  const exibir = !!(ex && ex.tipo === 'gerar');
  bloco.classList.toggle('oculto', !exibir);
  if (!exibir) return;

  const total = Number(ex.total) || 0;
  const feitos = Number(ex.processados) || 0;
  const pct = total ? Math.min(100, Math.round((feitos / total) * 100)) : 0;
  $('#prog-preenchimento').style.width = pct + '%';
  $('#prog-pct').textContent = pct + '%';
  // o contador "gerando X de Y" so aparece enquanto esta rodando
  const contador = $('#prog-contador');
  contador.classList.toggle('oculto', !ex.ativa);
  if (ex.ativa) contador.textContent = `gerando ${feitos} de ${total || '?'}`;
}

function renderProgressoDownload(ex) {
  const bloco = $('#progresso-download');
  const exibir = !!(ex && ex.tipo === 'download');
  bloco.classList.toggle('oculto', !exibir);
  if (!exibir) return;

  const total = Number(ex.total) || 0;
  const feitos = Number(ex.processados) || 0;
  const pct = total ? Math.min(100, Math.round((feitos / total) * 100)) : 0;
  $('#dl-preenchimento').style.width = pct + '%';
  $('#dl-pct').textContent = pct + '%';
  // o contador "baixando X de Y" so aparece enquanto esta rodando
  const contador = $('#dl-contador');
  contador.classList.toggle('oculto', !ex.ativa);
  if (ex.ativa) contador.textContent = `baixando ${feitos} de ${total || '?'}`;
}

function renderBotoesAnexar(ex) {
  const rodando = !!(ex && ex.ativa && ex.tipo === 'anexar');
  const ocupado = !!(ex && ex.ativa && ex.tipo !== 'anexar');
  const botao = $('#btn-iniciar-anexar');
  botao.textContent = rodando ? (ex.pausado ? 'Continuar' : 'Pausar') : 'Iniciar anexacao';
  botao.disabled = ocupado;
  $('#btn-cancelar-anexar').classList.toggle('oculto', !rodando);
}

function renderProgressoAnexar(ex) {
  const bloco = $('#progresso-anexar');
  const exibir = !!(ex && ex.tipo === 'anexar');
  bloco.classList.toggle('oculto', !exibir);
  if (!exibir) return;

  const total = Number(ex.total) || 0;
  const feitos = Number(ex.processados) || 0;
  const pct = total ? Math.min(100, Math.round((feitos / total) * 100)) : 0;
  $('#ax-preenchimento').style.width = pct + '%';
  $('#ax-pct').textContent = pct + '%';
  // o contador "anexando X de Y" so aparece enquanto esta rodando
  const contador = $('#ax-contador');
  contador.classList.toggle('oculto', !ex.ativa);
  if (ex.ativa) contador.textContent = `anexando ${feitos} de ${total || '?'}`;
}

async function renderDownloads() {
  const fila = await GSEI.obter('fila', []);
  const ex = await GSEI.obter('execucao', null);
  const total = fila.length;
  const baixados = fila.filter(f => f.download === 1).length;
  const erros = fila.filter(f => f.download === -1).length;
  const pendentes = total - baixados - erros;
  aplicarHtml($('#stats-download'),
    `Total: <b>${total}</b> &nbsp;|&nbsp; Baixados: <b>${baixados}</b> `
    + `&nbsp;|&nbsp; Erros: <b>${erros}</b> &nbsp;|&nbsp; Pendentes: <b>${pendentes}</b>`);

  // so aparece quando ha falha para repetir e nada esta rodando
  const rodando = !!(ex && ex.ativa && ex.tipo === 'download');
  const ocupado = !!(ex && ex.ativa && ex.tipo !== 'download');
  $('#btn-retry-download').classList.toggle('oculto', !(erros > 0 && !rodando && !ocupado));
}

async function renderExecucao() {
  const ex = await GSEI.obter('execucao', null);
  const badge = $('#badge-status');
  const ehGerar = !!(ex && ex.tipo === 'gerar');

  // Cada aba mostra o proprio progresso; nao existe mais painel no topo.
  if (!ex || (!ex.ativa && !ex.status)) {
    badge.classList.add('oculto');
    renderBotoesGerar(null);
    renderProgressoGerar(null);
    renderBotoesDownload(null);
    renderProgressoDownload(null);
    renderPainelDownload(null);
    renderBotoesAnexar(null);
    renderProgressoAnexar(null);
    renderPainelAnexar(null);
    return null;
  }

  badge.classList.toggle('oculto', !ehGerar);

  const total = Number(ex.total) || 0;
  const feitos = Number(ex.processados) || 0;
  const sigla = ex.tipo === 'gerar' ? 'GERAR'
    : (ex.tipo === 'download' ? 'BAIXAR' : 'ANEXAR');
  badge.textContent = ex.pausado && ex.ativa
    ? `${sigla} pausado ${feitos}/${total || '?'}`
    : `${sigla} ${feitos}/${total || '?'}`;

  renderPainelDownload(ex.tipo === 'download' ? ex : null);
  renderPainelAnexar(ex.tipo === 'anexar' ? ex : null);
  renderBotoesGerar(ex);
  renderProgressoGerar(ex);
  renderBotoesDownload(ex);
  renderProgressoDownload(ex);
  renderBotoesAnexar(ex);
  renderProgressoAnexar(ex);

  return ex;
}

// Estado da execucao de download, desenhado so dentro da aba Downloads.
function renderPainelDownload(ex) {
  const chip = $('#dl-status');
  const texto = $('#dl-texto');
  const atual = $('#dl-atual');
  const caixa = $('#dl-erros');

  if (!ex) {
    chip.classList.add('oculto');
    texto.classList.add('oculto');
    atual.classList.add('oculto');
    caixa.classList.add('oculto');
    caixa.textContent = '';
    return;
  }

  if (ex.ativa && ex.pausado) { chip.textContent = 'pausado'; chip.className = 'chip erro'; }
  else if (ex.ativa) { chip.textContent = 'em execucao'; chip.className = 'chip'; }
  else if (ex.status === 'abortado' || ex.status === 'cancelado' || ex.status === 'parado') {
    chip.textContent = ex.status; chip.className = 'chip erro';
  } else { chip.textContent = 'concluido'; chip.className = 'chip ok'; }
  chip.classList.remove('oculto');

  const total = Number(ex.total) || 0;
  const feitos = Number(ex.processados) || 0;
  texto.classList.remove('oculto');
  texto.textContent =
    `${feitos}/${total || '?'} processados | Sucesso: ${ex.sucesso || 0} | Falha: ${ex.falha || 0}`
    + (ex.ativa ? '' : ` | Finalizado: ${ex.finalizado_em || '-'}`);

  atual.classList.remove('oculto');
  const passo = (ex.ativa && ex.passo)
    ? ` | passo ${ex.passo}: ${ex.passo_desc || '-'}`
    : '';
  atual.textContent = (ex.atual
    ? `Atual: ${ex.atual}`
    : (ex.motivo ? `Motivo: ${ex.motivo}` : (ex.iniciado_em ? `Iniciado: ${ex.iniciado_em}` : '')))
    + passo;

  const erros = (ex.erros || []).slice(-3);
  if (erros.length) {
    caixa.classList.remove('oculto');
    caixa.textContent = erros.map(e => `Passo ${e.atual || '-'}: ${e.erro}`).join('\n');
  } else {
    caixa.classList.add('oculto');
    caixa.textContent = '';
  }
}

// Estado da execucao de anexacao, desenhado so dentro da aba Anexar.
function renderPainelAnexar(ex) {
  const chip = $('#ax-status');
  const texto = $('#ax-texto');
  const atual = $('#ax-atual');
  const caixa = $('#ax-erros');

  if (!ex) {
    chip.classList.add('oculto');
    texto.classList.add('oculto');
    atual.classList.add('oculto');
    caixa.classList.add('oculto');
    caixa.textContent = '';
    return;
  }

  if (ex.ativa && ex.pausado) { chip.textContent = 'pausado'; chip.className = 'chip erro'; }
  else if (ex.ativa) { chip.textContent = 'em execucao'; chip.className = 'chip'; }
  else if (ex.status === 'abortado' || ex.status === 'cancelado' || ex.status === 'parado') {
    chip.textContent = ex.status; chip.className = 'chip erro';
  } else { chip.textContent = 'concluido'; chip.className = 'chip ok'; }
  chip.classList.remove('oculto');

  const total = Number(ex.total) || 0;
  const feitos = Number(ex.processados) || 0;
  texto.classList.remove('oculto');
  texto.textContent =
    `${feitos}/${total || '?'} processados | Sucesso: ${ex.sucesso || 0} | Falha: ${ex.falha || 0}`
    + (ex.ativa ? '' : ` | Finalizado: ${ex.finalizado_em || '-'}`);

  atual.classList.remove('oculto');
  atual.textContent = ex.atual
    ? `Atual: ${ex.atual}`
    : (ex.motivo ? `Motivo: ${ex.motivo}` : (ex.iniciado_em ? `Iniciado: ${ex.iniciado_em}` : ''));

  const erros = (ex.erros || []).slice(-3);
  if (erros.length) {
    caixa.classList.remove('oculto');
    caixa.textContent = erros.map(e => `Passo ${e.atual || '-'}: ${e.erro}`).join('\n');
  } else {
    caixa.classList.add('oculto');
    caixa.textContent = '';
  }
}

async function renderKeepalive() {
  const ka = await GSEI.obter('keepalive', GSEI.PADRAO_KEEPALIVE);
  $('#ka-ativo').checked = !!ka.ativo;
  $('#ka-intervalo').value = Number(ka.intervalo) || 60;
  const status = $('#ka-status');
  if (ka.ultimo_erro) status.textContent = `Aviso: ${ka.ultimo_erro}`;
  else if (ka.ultima_recarga) status.textContent = `Ultima recarga: ${ka.ultima_recarga} (${ka.recargas || 0}x)`;
  else status.textContent = 'Keep-alive sem execucao ainda.';
}

// --------------------------------------------------------------- execucao

function pendentesAnexar(registros) {
  return registros.filter(r => (r.anexado === 0 || r.anexado === -1)
    && (r.pdf_anexo || '').trim() !== ''
    && (r.processo_sei || '').trim() !== '').length;
}

function pendentesDownload(fila) {
  return fila.filter(f => f.download !== 1).length;
}

async function iniciar(tipo) {
  if (tipo === 'anexar') {
    const registros = await GSEI.obter('registros', []);
    const n = pendentesAnexar(registros);
    if (!n) { marcarMsg($('#aviso-anexar'), 'Nenhum registro pronto: carregue o CSV na aba Gerar SEI, os PDFs e informe o processo SEI.', 'erro'); return; }
    const cfg = Object.assign({}, GSEI.PADRAO_ANEXO, await GSEI.obter('cfg_anexo', {}));
    if (!cfg.serie) { marcarMsg($('#aviso-anexar'), 'Configure o tipo do documento antes de iniciar.', 'erro'); return; }
    await iniciarExecucao('anexar', n);
    return;
  }

  if (tipo === 'download') {
    const fila = await GSEI.obter('fila', []);
    const n = pendentesDownload(fila);
    if (!n) {
      marcarMsg($('#aviso-download'), fila.length
        ? 'Todos os espelhos ja foram baixados.'
        : 'Fila vazia: carregue o CSV na aba Gerar SEI primeiro.', 'erro');
      return;
    }
    const aba = await garantirAbaPGT(true, true).catch(() => null);
    await iniciarExecucao('download', n, { aba_pgt: aba ? aba.id : null });
    return;
  }

  const fila = await GSEI.obter('fila', []);
  const n = fila.filter(f => f.status === 0 || f.status === -1).length;
  if (!n) { marcarMsg($('#aviso-gerar'), 'Fila vazia: carregue o CSV primeiro.', 'erro'); return; }
  const cfg = Object.assign({}, GSEI.PADRAO_GERACAO, await GSEI.obter('cfg_geracao', {}));
  if (!String(cfg.tipo_processo || '').trim()) {
    marcarMsg($('#aviso-gerar'), 'Configure o Tipo do Processo antes de iniciar.', 'erro');
    return;
  }
  await iniciarExecucao('gerar', n);
}

async function iniciarExecucao(tipo, total, extra) {
  const ex = Object.assign({
    ativa: true,
    tipo: tipo,
    status: null,
    motivo: null,
    pausado: false,
    passo: 0,
    passo_ts: Date.now(),
    esperar_ate: 0,
    tentativas: 0,
    tentados: [],
    claim: null,
    item_id: null,
    atual: '',
    total: total,
    processados: 0,
    sucesso: 0,
    falha: 0,
    erros: [],
    nup: null,
    iniciado_em: GSEI.agora(),
    iniciado_ts: Date.now()
  }, extra || {});
  await GSEI.definir('execucao', ex);
  await GSEI.registrar(`${tipo.toUpperCase()} iniciado | ${total} pendente(s)`);
  if (tipo !== 'download') await garantirAbaSEI(true);
  toast(tipo === 'anexar' ? 'Anexacao iniciada'
    : (tipo === 'download' ? 'Download iniciado' : 'Geracao iniciada'));
  await renderExecucao();
  if (tipo === 'download') await renderDownloads();
}

// Pausa/retoma a execucao em andamento (o motor para no passo atual e
// reativa do mesmo ponto; os tempos do passo sao zerados no retomar).
async function pausarOuRetomar(tipo) {
  const ex = await GSEI.obter('execucao', null);
  if (!ex || !ex.ativa || ex.tipo !== tipo) return false;

  const pausado = !ex.pausado;
  const atualizacao = { pausado: pausado };
  if (!pausado) {
    atualizacao.passo_ts = Date.now();
    atualizacao.esperar_ate = Date.now() + 500;
    atualizacao.claim = null;
  }
  await GSEI.definir('execucao', Object.assign({}, ex, atualizacao));
  await GSEI.registrar(`${nomeTipo(tipo)} ${pausado ? 'pausada' : 'retomada'} pelo usuario`);
  toast(pausedToast(tipo, pausado));
  await renderExecucao();
  await renderDownloads();
  return true;
}

function nomeTipo(tipo) {
  return tipo === 'gerar' ? 'GERAR'
    : (tipo === 'download' ? 'DOWNLOAD' : 'ANEXAR');
}

function pausedToast(tipo, pausado) {
  const base = tipo === 'gerar' ? 'Geracao'
    : (tipo === 'download' ? 'Download' : 'Anexacao');
  return `${base} ${pausado ? 'pausada' : 'retomada'}`;
}

// Cancela a execucao atual mantendo a fila (nenhum registro e alterado).
async function cancelarExecucao(tipo) {
  const ex = await GSEI.obter('execucao', null);
  if (!ex || !ex.ativa || ex.tipo !== tipo) return;
  await GSEI.definir('execucao', Object.assign({}, ex, {
    ativa: false, status: 'cancelado', pausado: false, claim: null, item_id: null
  }));
  await GSEI.registrar(`${nomeTipo(tipo)} cancelada pelo usuario (fila mantida)`);
  toast(tipo === 'download' ? 'Download cancelado - fila mantida'
    : (tipo === 'gerar' ? 'Geracao cancelada - fila mantida' : 'Anexacao cancelada - fila mantida'));
  await renderExecucao();
  await renderFila();
  await renderDownloads();
}

// Cancela os downloads: para a execucao (se rodando) e zera o progresso de
// download de toda a fila (baixados e erros voltam a pendente). Os registros
// do CSV continuam na fila da aba Gerar.
async function cancelarFilaDownload() {
  const fila = await GSEI.obter('fila', []);
  if (!fila.length) { toast('Fila de downloads vazia'); return; }
  confirmar('cancelar-download', 'Cancelar', async () => {
    const ex = await GSEI.obter('execucao', null);
    if (ex && ex.ativa && ex.tipo === 'download') {
      await GSEI.definir('execucao', Object.assign({}, ex, {
        ativa: false, status: 'cancelado', pausado: false, claim: null, item_id: null
      }));
    }
    fila.forEach(f => {
      f.download = 0;
      f.erro_download = null;
      f.arquivo_download = null;
      f.data_download = null;
    });
    await GSEI.definir('fila', fila);
    await GSEI.registrar('Fila de downloads cancelada: progresso zerado (registros mantidos)');
    await renderExecucao();
    await renderFila();
    await renderDownloads();
    toast('Downloads cancelados - fila zerada');
  });
}

async function repetirFalhas(tipo) {
  if (tipo === 'anexar') {
    const registros = await GSEI.obter('registros', []);
    const n = registros.filter(r => r.anexado === -1).length;
    registros.forEach(r => { if (r.anexado === -1) r.anexado = 0; });
    await GSEI.definir('registros', registros);
    await renderRegistros();
    toast(n ? `${n} falha(s) marcada(s) para repetir` : 'Nenhuma falha para repetir');
  } else if (tipo === 'download') {
    const fila = await GSEI.obter('fila', []);
    const n = fila.filter(f => f.download === -1).length;
    fila.forEach(f => { if (f.download === -1) { f.download = 0; f.erro_download = null; } });
    await GSEI.definir('fila', fila);
    await renderDownloads();
    toast(n ? `${n} download(s) marcado(s) para repetir` : 'Nenhum download com falha');
  } else {
    const fila = await GSEI.obter('fila', []);
    const n = fila.filter(f => f.status === -1).length;
    fila.forEach(f => { if (f.status === -1) { f.status = 0; f.erro = null; } });
    await GSEI.definir('fila', fila);
    await renderFila();
    toast(n ? `${n} falha(s) marcada(s) para repetir` : 'Nenhuma falha para repetir');
  }
}

// -------------------------------------------------------------- relatorio

// Gera o relatorio da geracao em CSV: colunas originais do CSV carregado,
// resultado da geracao, do download e o vinculo com o PDF da aba Anexar.
async function exportarRelatorio() {
  const fila = await GSEI.obter('fila', []);
  if (!fila.length) { toast('Fila vazia: carregue o CSV primeiro.'); return; }

  const registros = await GSEI.obter('registros', []);
  const porCod = new Map();
  registros.forEach(r => porCod.set(String(r.cod_sipra || '').trim().toUpperCase(), r));

  const colunasCsv = [];
  const dadosPorLinha = fila.map(f => {
    let dados = {};
    try { dados = JSON.parse(f.dados_csv || '{}') || {}; } catch (e) { dados = {}; }
    for (const k of Object.keys(dados)) if (colunasCsv.indexOf(k) === -1) colunasCsv.push(k);
    return dados;
  });

  const extras = [
    'Status geracao', 'Erro geracao', 'Processo SEI gerado', 'Data geracao',
    'Status download', 'Erro download', 'Arquivo download', 'Data download',
    'PDF anexo', 'Status anexo', 'Data anexo'
  ];
  const cabecalho = colunasCsv.concat(extras);
  const situacao = (valor, ok, erro) =>
    (valor === 1 ? ok : (valor === -1 ? erro : 'Pendente'));

  const corpo = fila.map((f, i) => {
    const cod = String(f.cod_beneficiario || '').trim().toUpperCase();
    const registro = porCod.get(cod) || {};
    return colunasCsv.map(c => (dadosPorLinha[i][c] === undefined ? '' : dadosPorLinha[i][c]))
      .concat([
        situacao(f.status, 'Gerado', 'Erro'),
        f.erro || '',
        f.processo_gerado || '',
        f.data_geracao || '',
        situacao(f.download, 'Baixado', 'Erro'),
        f.erro_download || '',
        f.arquivo_download || '',
        f.data_download || '',
        registro.pdf_anexo || '',
        situacao(registro.anexado, 'Anexado', 'Erro'),
        registro.data_anexo || ''
      ]);
  });

  const escapar = (v) => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cabecalho].concat(corpo)
    .map(linha => linha.map(escapar).join(';')).join('\r\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'relatorio_gerador_sei.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  const gerados = fila.filter(f => f.status === 1).length;
  await GSEI.registrar(`Relatorio exportado: relatorio_gerador_sei.csv `
    + `(${fila.length} registro(s), ${gerados} gerado(s))`);
  toast('Relatorio relatorio_gerador_sei.csv gerado');
}

// ------------------------------------------------------------- keep-alive

async function salvarKeepalive() {
  const intervalo = Math.max(30, Number($('#ka-intervalo').value) || 60);
  $('#ka-intervalo').value = intervalo;
  const ka = await GSEI.atualizar('keepalive', GSEI.PADRAO_KEEPALIVE, {
    ativo: $('#ka-ativo').checked,
    intervalo: intervalo
  });
  chrome.runtime.sendMessage({ acao: 'configurar-keepalive' }, () => void chrome.runtime.lastError);
  await GSEI.registrar(`Keep-alive ${ka.ativo ? 'ativado' : 'desativado'} (intervalo ${intervalo}s)`);
  await renderKeepalive();
}

function recarregarAgora() {
  chrome.runtime.sendMessage({ acao: 'keepalive-agora' }, (resposta) => {
    void chrome.runtime.lastError;
    if (resposta && resposta.ok) toast('Aba do SEI recarregada');
    else toast('Keep-alive: ' + ((resposta && resposta.motivo) || 'sem resposta'));
    renderKeepalive();
  });
}

// ---------------------------------------------------------------- eventos

function configurarEventos() {
  $('#btn-salvar-cfg-anexo').addEventListener('click', salvarConfigAnexo);
  $('#btn-salvar-cfg-geracao').addEventListener('click', salvarConfigGeracao);

  $('#pdfs-anexar').addEventListener('change', (e) => {
    const arquivos = Array.from(e.target.files || []);
    if (arquivos.length) carregarPdfs(arquivos);
    e.target.value = '';
  });
  $('#csv-gerar').addEventListener('change', (e) => {
    const arquivo = e.target.files && e.target.files[0];
    if (arquivo) carregarCsvGerar(arquivo);
    e.target.value = '';
  });

  $('#btn-iniciar-anexar').addEventListener('click', async () => {
    if (await pausarOuRetomar('anexar')) return;
    await iniciar('anexar');
  });
  $('#btn-cancelar-anexar').addEventListener('click', () => cancelarExecucao('anexar'));
  $('#btn-abrir-sei-anexar').addEventListener('click', () => garantirAbaSEI(true));
  $('#btn-iniciar-gerar').addEventListener('click', async () => {
    if (await pausarOuRetomar('gerar')) return;
    await iniciar('gerar');
  });
  $('#btn-cancelar-gerar').addEventListener('click', () => cancelarExecucao('gerar'));
  $('#btn-baixar-espelho').addEventListener('click', async () => {
    if (await pausarOuRetomar('download')) return;
    await iniciar('download');
  });
  $('#btn-cancelar-download').addEventListener('click', cancelarFilaDownload);
  $('#btn-retry-download').addEventListener('click', async () => {
    await repetirFalhas('download');
    await iniciar('download');
  });
  $('#btn-abrir-pgt').addEventListener('click', () => garantirAbaPGT(true, true));

  $('#btn-retry-anexar').addEventListener('click', () => repetirFalhas('anexar'));
  $('#btn-retry-gerar').addEventListener('click', () => repetirFalhas('gerar'));

  $('#btn-limpar-anexar').addEventListener('click', () => {
    confirmar('limpar-anexar', 'Limpar', async () => {
      await GSEI.definir('registros', []);
      await GSEI.registrar('Registros de anexacao limpos pelo usuario');
      await renderRegistros();
      toast('Registros limpos');
    });
  });
  $('#btn-limpar-gerar').addEventListener('click', () => {
    confirmar('limpar-gerar', 'Limpar', async () => {
      await GSEI.definir('fila', []);
      await GSEI.registrar('Fila de geracao limpa pelo usuario');
      await renderFila();
      await renderDownloads();
      toast('Fila limpa');
    });
  });
  $('#btn-exportar-gerar').addEventListener('click', exportarRelatorio);
  $('#btn-limpar-log').addEventListener('click', async () => {
    await GSEI.limparLog();
    await renderLog();
    toast('Log limpo');
  });

  $('#ka-ativo').addEventListener('change', salvarKeepalive);
  $('#ka-intervalo').addEventListener('change', salvarKeepalive);
  $('#btn-ka-agora').addEventListener('click', recarregarAgora);
}

function iniciarMonitoramento() {
  clearInterval(_timer);
  _timer = setInterval(async () => {
    try {
      const ex = await renderExecucao();
      const assinatura = ex
        ? `${ex.tipo}|${ex.processados}|${ex.falha}|${ex.status}|${ex.pausado ? 1 : 0}|${(ex.erros || []).length}`
        : '';
      if (assinatura !== _assinatura) {
        _assinatura = assinatura;
        // Um unico passo agendado: as tabelas so redesenham com a aba aberta.
        agendarRender();
      }
    } catch (e) {
      console.warn('[Gerador SEI] monitor:', e);
    }
  }, 1200);
}

// ------------------------------------------------------------------- boot

async function iniciarPopup() {
  configurarAbas();
  configurarEventos();
  carregarSelects();

  // Registrado antes do primeiro render: nenhuma mudanca da fila se perde
  // enquanto o popup abre (as secoes continuam "sujas" ate serem redesenhadas).
  chrome.storage.onChanged.addListener((mudancas, area) => {
    if (area !== 'local') return;
    const secoes = [];
    if (mudancas.log) secoes.push('log');
    if (mudancas.registros) secoes.push('registros');
    if (mudancas.fila) secoes.push('fila', 'downloads');
    if (mudancas.execucao) secoes.push('execucao', 'downloads');
    if (mudancas.keepalive) secoes.push('keepalive');
    if (secoes.length) agendarRender(secoes);
  });

  try {
    await carregarConfigAnexo();
    await carregarConfigGeracao();
    await processarRender(true);
  } catch (e) {
    console.warn('[Gerador SEI] boot do popup:', e);
  }
  iniciarMonitoramento();
}

document.addEventListener('DOMContentLoaded', iniciarPopup);
