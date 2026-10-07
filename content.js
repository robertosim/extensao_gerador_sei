// Gerador SEI - motor de automacao no SEI (content script, todos os frames).
//
// A execucao e uma maquina de estados persistida em chrome.storage.local
// (chave "execucao"): sobrevive a navegacao, ao fechamento do popup e a
// terminacao do service worker. Cada frame verifica se ele e o alvo do passo
// atual e, em caso positivo, reivindica o passo e executa.
'use strict';

const SEI_URL = 'https://sei.incra.gov.br/sei';
const MEU_FRAME = Math.random().toString(36).slice(2);
const CLAIM_MS = 6000;
const TICK_MS = 600;
const PASSO_TIMEOUT_MS = 90000;
const ESPERA_PADRAO = 1500;

// ------------------------------------------------------------------ helpers

function ehTopo() {
  try { return window === window.top; } catch (e) { return false; }
}

function dormir(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function docsAcessiveis() {
  const lista = [];
  const andar = (w) => {
    try { lista.push(w.document); } catch (e) { /* frame de outra origem */ }
    let n = 0;
    try { n = w.frames.length; } catch (e) { n = 0; }
    for (let i = 0; i < n; i++) {
      try { andar(w.frames[i]); } catch (e) { /* ignora */ }
    }
  };
  try { andar(window); } catch (e) { /* ignora */ }
  return lista;
}

function acharEmTodos(seletor) {
  for (const doc of docsAcessiveis()) {
    try {
      const el = doc.querySelector(seletor);
      if (el) return el;
    } catch (e) { /* seletor invalido */ }
  }
  return null;
}

// Chama exibirTiposProcedimento() direto no window de qualquer frame
// acessivel (a pagina do SEI e same-origin). Evita clicar em links
// href="javascript:...", que a CSP da pagina bloqueia.
function chamarExibirTipos() {
  for (const doc of docsAcessiveis()) {
    try {
      const win = doc.defaultView;
      if (win && typeof win.exibirTiposProcedimento === 'function') {
        win.exibirTiposProcedimento('T');
        return true;
      }
    } catch (e) { /* proximo doc */ }
  }
  return false;
}

// Executa uma chamada simples do tipo `nome('argumento')` (texto que o SEI
// coloca em href/onclick javascript:) direto no window do frame.
function executarChamadaSimples(win, texto) {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*\(\s*(['"]?)(.*?)\2\s*\)\s*;?\s*$/
    .exec(String(texto || ''));
  if (!m) return false;
  try {
    const fn = win[m[1]];
    if (typeof fn !== 'function') return false;
    fn.call(win, m[3]);
    return true;
  } catch (e) { return false; }
}

function executarChamadaNosFrames(texto) {
  for (const doc of docsAcessiveis()) {
    try {
      if (executarChamadaSimples(doc.defaultView, texto)) return true;
    } catch (e) { /* proximo doc */ }
  }
  return false;
}

function clicarExterno() {
  for (const doc of docsAcessiveis()) {
    try {
      const links = Array.from(doc.querySelectorAll('a.ancoraOpcao'));
      const alvo = links.find(a => (a.getAttribute('href') || '').includes('documento_receber'))
        || links.find(a => /externo/i.test(a.textContent || ''));
      if (alvo) { alvo.click(); return true; }
    } catch (e) { /* proximo doc */ }
  }
  return false;
}

function setValor(el, valor) {
  el.focus();
  el.value = valor === undefined || valor === null ? '' : String(valor);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function preencherCampo(seletores, termos, valor) {
  for (const sel of seletores) {
    try {
      const el = document.querySelector(sel);
      if (el) { setValor(el, valor); return true; }
    } catch (e) { /* proximo seletor */ }
  }
  if (termos && termos.length) {
    const cands = Array.from(document.querySelectorAll('textarea, input[type="text"]'));
    const el = cands.find(e => termos.some(
      t => ((e.id || '') + ' ' + (e.name || '')).toLowerCase().includes(t)));
    if (el) { setValor(el, valor); return true; }
  }
  return false;
}

function selecionarOpcao(sel, valor) {
  const el = document.querySelector(sel);
  if (!el) return false;
  el.value = String(valor);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function nivelAtual() {
  try {
    const r = document.querySelector('input[name="rdoNivelAcesso"]:checked');
    return r ? (r.id || r.value || '') : '';
  } catch (e) { return ''; }
}

function selecionarNivel(id) {
  let r = document.getElementById(id);
  if (!r) {
    r = Array.from(document.querySelectorAll('input[name="rdoNivelAcesso"]'))
      .find(x => (x.id || '') === id);
  }
  if (!r) return { ok: false, motivo: 'radio nao encontrado' };
  if (r.disabled) return { ok: false, motivo: 'radio desabilitado pelo SEI' };
  // checked=true previo cancela o evento change; entao dispara change manual
  if (r.checked) r.dispatchEvent(new Event('change', { bubbles: true }));
  else r.click();
  const atual = nivelAtual();
  return { ok: atual === id, atual };
}

function pressionarEnter() {
  const alvos = [];
  docsAcessiveis().forEach(doc => {
    const ativo = doc.activeElement;
    alvos.push(ativo && ativo !== doc.body ? ativo : doc.body);
  });
  for (const alvo of alvos) {
    if (!alvo) continue;
    for (const tipo of ['keydown', 'keypress', 'keyup']) {
      try {
        alvo.dispatchEvent(new KeyboardEvent(tipo, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
      } catch (e) { /* ignora */ }
    }
  }
}

function mensagensSEI(seletor) {
  const achadas = [];
  for (const doc of docsAcessiveis()) {
    try {
      doc.querySelectorAll(seletor).forEach(el => {
        const visivel = !!el.offsetParent || el.getClientRects().length > 0;
        const texto = (el.innerText || el.textContent || '').trim();
        if (visivel && texto) achadas.push(texto);
      });
    } catch (e) { /* ignora */ }
  }
  return Array.from(new Set(achadas));
}

function sinalizarAutomacao() {
  try {
    document.dispatchEvent(new CustomEvent('gsei-automacao', { detail: { tempo: 180000 } }));
  } catch (e) { /* ignora */ }
}

// --------------------------------------------------------------------- RPC
// Ponte para as funcoes da propria pagina (mundo MAIN): o content script nao
// enxerga alterarNivelAcesso()/selecionarFormatoDigitalizado() direto.
let _rpcSeq = 0;
const _rpcPendentes = new Map();

document.addEventListener('gsei-rpc-resultado', (evento) => {
  const dados = (evento && evento.detail) || {};
  const resolver = _rpcPendentes.get(dados.id);
  if (resolver) { _rpcPendentes.delete(dados.id); resolver(dados); }
});

function chamarNaPagina(nome, args, esperaMs) {
  return new Promise((resolve) => {
    const id = `${MEU_FRAME}-${++_rpcSeq}`;
    const limite = setTimeout(() => {
      _rpcPendentes.delete(id);
      resolve({ ok: false, erro: 'timeout da RPC' });
    }, esperaMs || 4000);
    _rpcPendentes.set(id, (dados) => { clearTimeout(limite); resolve(dados); });
    try {
      document.dispatchEvent(new CustomEvent('gsei-rpc', {
        detail: { id, nome, args: args || [] }
      }));
    } catch (e) {
      clearTimeout(limite);
      _rpcPendentes.delete(id);
      resolve({ ok: false, erro: String((e && e.message) || e) });
    }
  });
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

// ---------------------------------------------------------------- contexto

async function montarContexto(ex) {
  const ctx = { ex, registro: null, cfg: null, erros: [] };

  if (ex.tipo === 'anexar') {
    const registros = await GSEI.obter('registros', []);
    ctx.registro = registros.find(r => r.id === ex.item_id) || null;
    ctx.cfg = Object.assign({}, GSEI.PADRAO_ANEXO, await GSEI.obter('cfg_anexo', {}));
    if (ctx.registro) {
      const template = (ctx.registro.nome_arvore || '').trim() || ctx.cfg.nome_arvore;
      ctx.nomeArvore = GSEI.processarNomeArvore(template, ctx.registro);
      ctx.nivel = GSEI.NIVEIS[String(ctx.cfg.nivel)] || GSEI.NIVEIS['1'];
    }
  } else {
    const fila = await GSEI.obter('fila', []);
    ctx.registro = fila.find(r => r.id === ex.item_id) || null;
    ctx.cfg = Object.assign({}, GSEI.PADRAO_GERACAO,
      await GSEI.obter('cfg_geracao', {}));
    if (ctx.registro) {
      // os templates resolvem colunas da tabela, do CSV (dados_csv) e
      // apelidos, tudo a partir do proprio registro
      ctx.especificacao = GSEI.renderizarTemplate(ctx.cfg.especificacao, ctx.registro);
      ctx.interessados = GSEI.renderizarTemplate(ctx.cfg.interessados, ctx.registro);
      ctx.observacoes = GSEI.renderizarTemplate(ctx.cfg.observacoes, ctx.registro);
    } else {
      ctx.especificacao = GSEI.renderizarTemplate(ctx.cfg.especificacao, {});
      ctx.interessados = GSEI.renderizarTemplate(ctx.cfg.interessados, {});
      ctx.observacoes = GSEI.renderizarTemplate(ctx.cfg.observacoes, {});
    }
    ctx.nivel = GSEI.NIVEIS[String(ctx.cfg.nivel_acesso)] || GSEI.NIVEIS['1'];
  }
  return ctx;
}

async function carregarPdf(cod) {
  const pdfs = await GSEI.obter('pdfs', {});
  return pdfs[cod] || null;
}

// ------------------------------------------------------------ passos anexar

const PASSOS_ANEXAR = [
  {
    n: 1, onde: 'topo', desc: 'Acessar SEI', espera: 5000, timeout: 60000,
    exec: () => {
      const u = String(location.href).toLowerCase();
      // Sessao expirada: nao navega, o passo 2 acusa e aborta a execucao.
      if (u.includes('login')) return true;
      // Ja esta na raiz do SEI: nao recarrega (evita loop de reload).
      if (location.href === SEI_URL || location.href === SEI_URL + '/') return true;
      location.assign(SEI_URL);
      return false; // espera a navegacao; o novo documento avanca o passo
    }
  },
  {
    n: 2, onde: 'topo', desc: 'Verificar sessao', espera: 1500,
    exec: () => {
      const url = String(location.href).toLowerCase();
      if (url.includes('login')) {
        const erro = new Error('Sessao expirada: faca login no SEI e reinicie a anexacao');
        erro.global = true;
        throw erro;
      }
      return true;
    }
  },
  {
    n: 3, onde: 'frame', requer: '#txtPesquisaRapida', desc: 'Pesquisar processo',
    espera: 6000,
    exec: (ctx) => {
      const el = document.querySelector('#txtPesquisaRapida');
      if (!el) return false;
      const numero = (ctx.registro && ctx.registro.processo_sei) || '';
      if (!numero) {
        const e2 = new Error('Registro sem numero de processo SEI');
        throw e2;
      }
      setValor(el, numero);
      for (const tipo of ['keydown', 'keypress', 'keyup']) {
        try {
          el.dispatchEvent(new KeyboardEvent(tipo, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
          }));
        } catch (e) { /* ignora */ }
      }
      setTimeout(() => {
        try { if (el.form && el.form.requestSubmit) el.form.requestSubmit(); }
        catch (e) { /* documento ja navegou */ }
      }, 400);
      return true;
    }
  },
  {
    n: 4, onde: 'topo', desc: 'Localizar botao de incluir documento', espera: 4000,
    exec: () => {
      if (acharEmTodos('img[title="Registrar Documento Externo"], img[title="Incluir Documento"]')) {
        return true;
      }
      // O formulario ja pode estar aberto direto (sem o botao visivel).
      if (acharEmTodos('#selSerie')) return true;
      // Fallback do app: clicar em 'Externo' no ifrArvore/ifrVisualizacao.
      if (clicarExterno()) return false;
      const temFrames = (() => { try { return window.frames.length > 0; } catch (e) { return false; } })();
      if (!temFrames || docsAcessiveis().length <= 1) {
        // sem frames acessiveis: o frame interno cuida do proximo passo
        return true;
      }
      return false;
    }
  },
  {
    n: 5, onde: 'frame', requer: 'img[title="Registrar Documento Externo"], img[title="Incluir Documento"]',
    desc: 'Clicar em incluir documento', espera: 6000,
    exec: () => {
      const el = document.querySelector('img[title="Registrar Documento Externo"], img[title="Incluir Documento"]');
      if (!el) return false;
      el.click();
      return true;
    }
  },
  {
    n: 6, onde: 'topo', desc: 'Escolher Externo no formulario de tipo', espera: 5000,
    exec: () => { clicarExterno(); return true; }
  },
  {
    n: 7, onde: 'frame', requer: '#selSerie', desc: 'Formulario de anexacao encontrado',
    espera: 1500, exec: () => true
  },
  {
    n: 8, onde: 'frame', requer: '#selSerie', desc: 'Tipo do documento', espera: 2500,
    exec: (ctx) => {
      if (!selecionarOpcao('#selSerie', ctx.cfg.serie)) return false;
      return true;
    }
  },
  {
    n: 9, onde: 'frame', requer: '#selSerie', desc: 'Data de elaboracao',
    espera: 1500,
    exec: () => {
      const el = document.querySelector('#txtDataElaboracao');
      if (!el) throw new Error('Campo #txtDataElaboracao nao encontrado no formulario');
      const hoje = new Date();
      const dd = String(hoje.getDate()).padStart(2, '0');
      const mm = String(hoje.getMonth() + 1).padStart(2, '0');
      setValor(el, `${dd}/${mm}/${hoje.getFullYear()}`);
      return true;
    }
  },
  {
    n: 10, onde: 'frame', requer: '#selSerie', desc: 'Nome na arvore', espera: 1500,
    exec: (ctx) => {
      const el = document.querySelector('#txtNomeArvore');
      if (!el) throw new Error('Campo #txtNomeArvore nao encontrado no formulario');
      setValor(el, ctx.nomeArvore);
      return true;
    }
  },
  {
    n: 11, onde: 'frame', requer: '#selSerie', desc: 'Formato nato-digital', espera: 2500,
    exec: async () => {
      const el = document.getElementById('optNato');
      if (!el) throw new Error('Radio #optNato (formato) nao encontrado');
      el.checked = true;
      el.click();
      const ret = await chamarNaPagina('selecionarFormatoDigitalizado');
      if (!ret.ok) console.log('[Gerador SEI] selecionarFormatoDigitalizado:', ret.erro);
      return true;
    }
  },
  {
    n: 12, onde: 'frame', requer: '#selSerie', desc: 'Nivel de acesso',
    espera: 3500,
    exec: (ctx) => {
      if (!document.querySelector('input[name="rdoNivelAcesso"]')) return false;
      const ret = selecionarNivel(ctx.nivel.id);
      if (!ret.ok && ret.motivo !== 'radio desabilitado pelo SEI') return false;
      return true;
    }
  },
  {
    n: 13, onde: 'frame', requer: '#selSerie', desc: 'Aguardar hipotese legal (AJAX)',
    espera: 1500,
    exec: async (ctx) => {
      const alvo = String(ctx.cfg.hipotese || '').trim();
      if (!alvo || alvo === 'null') return true;
      const sel = document.querySelector('#selHipoteseLegal');
      if (!sel) return false;
      if (Array.from(sel.options).some(o => o.value === alvo)) return true;
      // opcoes ainda nao vieram via ajax: pede para a propria pagina recarregar
      // (a cada 3 tentativas para nao martelar o endpoint)
      if (((ctx.ex && ctx.ex.tentativas) || 0) % 3 === 0) await chamarNaPagina('alterarNivelAcesso');
      return false;
    }
  },
  {
    n: 14, onde: 'frame', requer: '#selSerie', desc: 'Grau de sigilo', espera: 1500,
    exec: (ctx) => {
      const el = document.querySelector('#selGrauSigilo');
      const sigilo = (ctx.cfg.sigilo || '').trim();
      if (!el || !sigilo || sigilo === 'null') return true;
      el.style.display = 'block';
      el.value = sigilo;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  },
  {
    n: 15, onde: 'frame', requer: '#selSerie', desc: 'Hipotese legal', espera: 1500,
    exec: (ctx) => {
      const alvo = String(ctx.cfg.hipotese || '').trim();
      if (!alvo || alvo === 'null') return true;
      const sel = document.querySelector('#selHipoteseLegal');
      if (!sel) return false;
      if (!selecionarOpcao('#selHipoteseLegal', alvo)) return false;
      return true;
    }
  },
  {
    n: 16, onde: 'frame', requer: '#selSerie', desc: 'Anexar PDF', espera: 9000,
    pdf: true,
    exec: async (ctx) => {
      const el = document.querySelector('#filArquivo');
      if (!el) throw new Error('Campo #filArquivo nao encontrado no formulario');
      if (!ctx.pdf) {
        throw new Error('PDF nao encontrado para o codigo ' + (ctx.registro.cod_sipra || '?'));
      }
      const bin = Uint8Array.from(atob(ctx.pdf.b64), c => c.charCodeAt(0));
      const arquivo = new File([bin], ctx.pdf.nome, { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(arquivo);
      el.files = dt.files;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  },
  {
    n: 17, onde: 'frame', requer: '#selSerie', desc: 'Clicar em Salvar', espera: 6000,
    exec: () => {
      const el = document.querySelector('#btnSalvar');
      if (!el) throw new Error('Botao #btnSalvar nao encontrado no formulario');
      el.click();
      return true;
    }
  },
  {
    n: 18, onde: 'topo', desc: 'Verificar resultado no SEI', espera: 2000,
    exec: () => {
      const erros = mensagensSEI('.infraMensagemErro');
      if (erros.length) throw new Error('SEI retornou erro: ' + erros.join(' | ').slice(0, 300));
      const sucessos = mensagensSEI('.infraMensagemSucesso');
      if (sucessos.length) console.log('[Gerador SEI] mensagem SEI:', sucessos);
      return true;
    }
  },
  {
    n: 19, onde: 'topo', desc: 'Confirmar', espera: 1500,
    exec: () => { pressionarEnter(); return true; }
  },
  {
    n: 20, onde: 'topo', desc: 'Concluir item', espera: 1500,
    exec: () => true, concluir: true
  }
];

// -------------------------------------------------------------- passos gerar

const FORM_GERAR = '#txtDescricao, #txtEspecificacao, textarea[id*="Especificacao"], #txtInteressados, #btnSalvar';

const PASSOS_GERAR = [
  {
    n: 1, onde: 'topo', desc: 'Acessar SEI', espera: 5000, timeout: 60000,
    exec: () => {
      const u = String(location.href).toLowerCase();
      if (u.includes('login')) return true;
      if (location.href === SEI_URL || location.href === SEI_URL + '/') return true;
      location.assign(SEI_URL);
      return false;
    }
  },
  {
    n: 2, onde: 'topo', desc: 'Verificar sessao', espera: 1500,
    exec: () => {
      const url = String(location.href).toLowerCase();
      if (url.includes('login')) {
        const erro = new Error('Sessao expirada: faca login no SEI e reinicie a geracao');
        erro.global = true;
        throw erro;
      }
      return true;
    }
  },
  {
    n: 3, onde: 'frame', requer: 'a[link="procedimento_escolher_tipo"], a[href*="procedimento_escolher_tipo"]',
    desc: 'Clicar em Iniciar Processo', espera: 5000,
    exec: () => {
      let el = document.querySelector('a[link="procedimento_escolher_tipo"]')
        || document.querySelector('a[href*="procedimento_escolher_tipo"]');
      if (!el) return false;
      el.click();
      return true;
    }
  },
  {
    n: 4, onde: 'topo', desc: 'Escolher tipo de processo', espera: 5000, timeout: 120000,
    exec: (ctx) => {
      const tipo = String(ctx.cfg.tipo_processo || '').trim();
      if (!tipo) throw new Error('Tipo do processo nao configurado');
      const codigo = /^\d+$/.test(tipo) ? tipo : '';

      let link = null;
      const tabela = acharEmTodos('#tblTipoProcedimento');
      if (tabela) {
        const doc = tabela.ownerDocument;
        if (codigo) {
          link = doc.querySelector(`a[href*="id_tipo_procedimento=${codigo}"]`)
            || doc.querySelector(`[href*="id_tipo_procedimento=${codigo}"]`);
        }
        if (!link) {
          link = Array.from(doc.querySelectorAll('a[href]'))
            .find(a => (a.textContent || '').trim().includes(tipo));
        }
      }

      if (link) {
        link.click();
        return true;
      }

      // Tabela ainda nao existe ou o tipo nao esta visivel: exibe todos.
      // A CSP do SEI (script-src sem 'unsafe-inline') bloqueia href
      // "javascript:": chama a funcao direto no window do frame em vez de
      // clicar no link; o clique so acontece quando o href nao e um script.
      const exibir = acharEmTodos('#ancExibirTiposProcedimento')
        || acharEmTodos('a[onclick*="exibirTiposProcedimento"]');

      if (chamarExibirTipos()) return false;

      if (exibir) {
        const href = exibir.getAttribute('href') || '';
        const ehScript = /^\s*javascript:/i.test(href);
        const chamada = ehScript
          ? href.replace(/^\s*javascript:/i, '')
          : (exibir.getAttribute('onclick') || '');
        if (chamada && executarChamadaNosFrames(chamada)) return false;
        if (!ehScript) { exibir.click(); return false; }
      }

      for (const doc of docsAcessiveis()) {
        try {
          const win = doc.defaultView;
          if (win && typeof win.exibirTiposProcedimento === 'function') {
            win.exibirTiposProcedimento('T');
            return false;
          }
        } catch (e) { /* proximo doc */ }
      }
      if (!tabela) return false;
      throw new Error(`Tipo "${tipo}" nao encontrado na tabela de tipos`);
    }
  },
  {
    n: 5, onde: 'frame', requer: FORM_GERAR,
    desc: 'Formulario de geracao encontrado', espera: 1500, exec: () => true
  },
  {
    n: 6, onde: 'frame', requer: FORM_GERAR,
    desc: 'Especificacao', espera: 1000,
    exec: (ctx) => {
      const ok = preencherCampo(
        ['#txtDescricao', 'input[id="txtDescricao"]', '#txtEspecificacao',
          'textarea[id*="Especificacao"]', 'input[id*="Especificacao"]'],
        ['especificacao', 'descricao'], ctx.especificacao);
      if (!ok) throw new Error('Campo Especificacao nao encontrado no formulario');
      return true;
    }
  },
  {
    n: 7, onde: 'frame', requer: FORM_GERAR,
    desc: 'Interessados', espera: 1000, opcional: true,
    exec: (ctx) => {
      preencherCampo(['#txtInteressados', 'textarea[id*="Interessado"]', 'input[id*="Interessado"]'],
        ['interessado'], ctx.interessados);
      return true;
    }
  },
  {
    n: 8, onde: 'frame', requer: FORM_GERAR,
    desc: 'Observacoes', espera: 1000, opcional: true,
    exec: (ctx) => {
      preencherCampo(['#txaObservacoes', '#txtObservacoes', 'textarea[id*="bservac"]',
        'textarea[id*="Observac"]', 'input[id*="bservac"]', 'input[id*="Observac"]'],
        ['observacoes', 'bservac', 'observacao'], ctx.observacoes);
      return true;
    }
  },
  {
    n: 9, onde: 'frame', requer: FORM_GERAR, desc: 'Nivel de acesso',
    espera: 4000,
    exec: (ctx) => {
      if (!document.querySelector('input[name="rdoNivelAcesso"]')) return false;
      const ret = selecionarNivel(ctx.nivel.id);
      if (!ret.ok && ret.motivo !== 'radio desabilitado pelo SEI') return false;
      return true;
    }
  },
  {
    n: 10, onde: 'frame', requer: FORM_GERAR, desc: 'Hipotese legal', espera: 2000,
    exec: async (ctx) => {
      const alvo = String(ctx.cfg.hipotese_legal || '').trim();
      if (!alvo || alvo === 'null') return true;
      const sel = document.querySelector('#selHipoteseLegal');
      if (!sel) return false;
      if (Array.from(sel.options).some(o => o.value === alvo)) {
        return selecionarOpcao('#selHipoteseLegal', alvo);
      }
      // opcoes vazias: o SEI so as carrega apos alterarNivelAcesso() (ajax)
      if (((ctx.ex && ctx.ex.tentativas) || 0) % 3 === 0) await chamarNaPagina('alterarNivelAcesso');
      return false;
    }
  },
  {
    n: 11, onde: 'frame', requer: FORM_GERAR,
    desc: 'Revalidar campos apos troca de nivel', espera: 1000,
    exec: (ctx) => {
      // A troca de nivel pode recarregar o formulario e limpar os campos.
      const alvo = ctx.especificacao || '';
      const atual = (document.querySelector('#txtDescricao')
        || document.querySelector('#txtEspecificacao')
        || document.querySelector('textarea[id*="Especificacao"]'));
      if (atual && (atual.value || '').trim() !== alvo.trim()) {
        preencherCampo(['#txtDescricao', '#txtEspecificacao', 'textarea[id*="Especificacao"]'],
          ['especificacao', 'descricao'], alvo);
        preencherCampo(['#txtInteressados', 'textarea[id*="Interessado"]'],
          ['interessado'], ctx.interessados);
      }
      return true;
    }
  },
  {
    n: 12, onde: 'frame', requer: FORM_GERAR, desc: 'Confirmar nivel de acesso',
    espera: 1500,
    exec: (ctx) => {
      if (!document.querySelector('input[name="rdoNivelAcesso"]')) return false;
      const atual = nivelAtual();
      if (atual !== ctx.nivel.id) {
        throw new Error('Nivel de acesso NAO aplicado no radio (SEI: '
          + (atual || '(nenhum)') + ' | configurado: ' + ctx.nivel.id + ' ' + ctx.nivel.nome + ')');
      }
      return true;
    }
  },
  {
    n: 13, onde: 'frame', requer: FORM_GERAR,
    desc: 'Clicar em Salvar', espera: 6000,
    exec: () => {
      const el = document.querySelector('#btnSalvar')
        || document.querySelector('#btnInfraSalvar')
        || document.querySelector('input[value="Salvar"]');
      if (!el) throw new Error('Botao Salvar nao encontrado no formulario');
      el.click();
      return true;
    }
  },
  {
    n: 14, onde: 'topo', desc: 'Verificar mensagens de erro do SEI', espera: 2500,
    exec: () => {
      const avisos = mensagensSEI('.infraAviso, #divInfraAviso');
      if (avisos.length) console.log('[Gerador SEI] aviso SEI:', avisos);
      const erros = mensagensSEI('.infraMensagemErro');
      if (erros.length) throw new Error('SEI retornou erro: ' + erros.join(' | ').slice(0, 300));
      return true;
    }
  },
  {
    n: 15, onde: 'topo', desc: 'Capturar NUP do processo', espera: 2500,
    exec: () => {
      const padrao = /\d{3,8}\.\d{3,8}\/\d{4}-\d{2}/;
      // o SEI quebra o numero com <br>/espaco; junta digitos e separadores
      const juntar = t => String(t || '').replace(/\s+/g, '');

      const achar = (txt) => {
        if (!txt) return null;
        const m = padrao.exec(String(txt)) || padrao.exec(juntar(txt));
        return m ? m[0] : null;
      };

      // 1) titulo/URL da pagina
      const fontes = [document.title, location.href];
      // 2) no selecionado da arvore
      for (const doc of docsAcessiveis()) {
        try {
          doc.querySelectorAll('.infraArvoreNoSelecionado, [class*="ArvoreNoSelecionado"]')
            .forEach(el => fontes.push((el.innerText || el.textContent || '').trim()));
        } catch (e) { /* ignora */ }
      }
      for (const fonte of fontes) {
        const nup = achar(fonte);
        if (nup) return { ok: true, nup };
      }

      // 3) fallback: corpo do frame quando ha exatamente um NUP distinto
      if (tentativasNUP() >= 2) {
        for (const doc of docsAcessiveis()) {
          try {
            const corpo = doc.body ? (doc.body.innerText || '') : '';
            const achados = Array.from(new Set(corpo.match(new RegExp(padrao, 'g')) || []));
            if (achados.length === 1) return { ok: true, nup: achados[0] };
          } catch (e) { /* ignora */ }
        }
      }
      return false;
    }
  },
  {
    n: 16, onde: 'topo', desc: 'Concluir item', espera: 1500,
    exec: () => true, concluir: true
  }
];

let _tentativasNUP = 0;
function tentativasNUP() { return _tentativasNUP; }

function passosDe(tipo) {
  return tipo === 'gerar' ? PASSOS_GERAR : PASSOS_ANEXAR;
}

function proximoPasso(ex, atual) {
  const lista = passosDe(ex.tipo);
  const idx = lista.findIndex(p => p.n === atual.n);
  return idx >= 0 && idx + 1 < lista.length ? lista[idx + 1].n : 0;
}

// ------------------------------------------------------------------ fluxo

let _tick = false;

function alvoDoPasso(passo) {
  if (passo.onde === 'topo') return ehTopo();
  try { return !!document.querySelector(passo.requer); }
  catch (e) { return false; }
}

async function reivindicar(passo, item) {
  const atual = await lerExecucao();
  if (!atual || !atual.ativa || atual.passo !== passo.n || atual.item_id !== item) return null;
  const agora = Date.now();
  const claim = atual.claim;
  if (claim && claim.passo === passo.n && claim.item === item
    && agora - claim.ts < CLAIM_MS && claim.frame !== MEU_FRAME) return null;
  await chrome.storage.local.set({
    execucao: Object.assign({}, atual, { claim: { passo: passo.n, item, ts: agora, frame: MEU_FRAME } })
  });
  return atual;
}

async function falhaItem(msg, global) {
  const ex = await lerExecucao();
  if (!ex || !ex.ativa) return;
  await GSEI.registrar(`${(ex.tipo || '').toUpperCase()} [${ex.atual || '-'}] FALHA: ${msg}`, 'ERRO');

  if (ex.tipo === 'anexar') {
    const registros = await GSEI.obter('registros', []);
    const alvo = registros.find(r => r.id === ex.item_id);
    // falha zera a data_anexo (a coluna so mostra data de anexo de sucesso)
    if (alvo) { alvo.anexado = -1; alvo.data_anexo = null; }
    await GSEI.definir('registros', registros);
  } else {
    const fila = await GSEI.obter('fila', []);
    const alvo = fila.find(r => r.id === ex.item_id);
    if (alvo) { alvo.status = -1; alvo.erro = msg; }
    await GSEI.definir('fila', fila);
  }

  const parcial = {
    falha: (ex.falha || 0) + 1,
    processados: (ex.processados || 0) + 1,
    tentados: (ex.tentados || []).concat(ex.item_id === null || ex.item_id === undefined
      ? [] : [ex.item_id]),
    erros: (ex.erros || []).concat([{ atual: ex.atual, erro: msg }]).slice(-50),
    claim: null
  };

  if (global) {
    await finalizar(ex, parcial, 'abortado', msg);
    return;
  }

  await gravarExecucao(Object.assign(parcial, {
    passo: 0, passo_ts: Date.now(), esperar_ate: Date.now() + 1500, tentativas: 0,
    item_id: null, atual: ''
  }));
}

async function concluirItem(ex) {
  if (!ex || !ex.ativa) return;
  if (ex.tipo === 'anexar') {
    const registros = await GSEI.obter('registros', []);
    const alvo = registros.find(r => r.id === ex.item_id);
    if (alvo) {
      alvo.anexado = 1;
      alvo.data_anexo = new Date().toISOString().slice(0, 19).replace('T', ' ');
    }
    await GSEI.definir('registros', registros);
    await GSEI.registrar(`ANEXAR [${ex.atual || '-'}] SUCESSO: documento anexado`);
  } else {
    const fila = await GSEI.obter('fila', []);
    const alvo = fila.find(r => r.id === ex.item_id);
    if (alvo) {
      alvo.status = 1;
      alvo.processo_gerado = ex.nup || '';
      alvo.erro = null;
      alvo.data_geracao = new Date().toISOString().slice(0, 19).replace('T', ' ');
    }
    await GSEI.definir('fila', fila);
    await GSEI.registrar(`GERAR [${ex.atual || '-'}] SUCESSO: NUP ${ex.nup || ''}`);
  }

  await gravarExecucao({
    sucesso: (ex.sucesso || 0) + 1,
    processados: (ex.processados || 0) + 1,
    tentados: (ex.tentados || []).concat(ex.item_id === null || ex.item_id === undefined
      ? [] : [ex.item_id]),
    passo: 0, passo_ts: Date.now(), esperar_ate: Date.now() + 1500, tentativas: 0,
    item_id: null, atual: '', nup: null, claim: null
  });
}

async function iniciarProximoItem(ex) {
  const tentados = new Set(ex.tentados || []);
  let pendentes = [];

  if (ex.tipo === 'anexar') {
    const registros = await GSEI.obter('registros', []);
    pendentes = registros.filter(r => (r.anexado === 0 || r.anexado === -1)
      && !tentados.has(r.id)
      && (r.pdf_anexo || '').trim() !== ''
      && (r.processo_sei || '').trim() !== '');
  } else {
    const fila = await GSEI.obter('fila', []);
    pendentes = fila.filter(r => (r.status === 0 || r.status === -1) && !tentados.has(r.id));
  }

  if (!pendentes.length) {
    await finalizar(ex, {}, 'concluido');
    return;
  }

  const item = pendentes[0];
  const atual = ex.tipo === 'anexar'
    ? `${item.cod_sipra} - ${item.nome || ''}`
    : `${item.cod_beneficiario} - ${item.nome || ''}`;

  if (!ex.total) {
    await gravarExecucao({ total: pendentes.length });
  }

  await GSEI.registrar(`${(ex.tipo || '').toUpperCase()} [${item.cod_sipra || item.cod_beneficiario || '-'}] Processando: ${atual}`);
  await gravarExecucao({
    item_id: item.id,
    atual,
    passo: passosDe(ex.tipo)[0].n,
    passo_ts: Date.now(),
    esperar_ate: Date.now() + 1000,
    tentativas: 0,
    nup: null,
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
    finalizado_em: new Date().toLocaleString('pt-BR')
  });
  if (status === 'concluido') novo.passo = 0;
  await chrome.storage.local.set({ execucao: novo });
  await GSEI.registrar(
    `${(ex.tipo || '').toUpperCase()} Finalizado | Sucesso: ${novo.sucesso || 0} | Falha: ${novo.falha || 0}`
    + (motivo ? ` | ${motivo}` : ''));
}

async function executarPasso(passo, ex) {
  sinalizarAutomacao();
  let ctx;
  try {
    ctx = await montarContexto(ex);
  } catch (e) {
    await falhaItem(`Erro ao montar contexto: ${e.message}`, false);
    return;
  }
  if (!ctx.registro) {
    await falhaItem('Registro nao encontrado mais (fila alterada durante a execucao)', false);
    return;
  }

  if (passo.pdf && !ctx.pdf) {
    ctx.pdf = await carregarPdf(ctx.registro.cod_sipra || ctx.registro.cod_beneficiario || '');
  }

  if (passo.n === 15 && ex.tipo === 'gerar') _tentativasNUP = (ex.tentativas || 0);

  let ret;
  try {
    ret = passo.exec(ctx);
    if (ret && typeof ret.then === 'function') ret = await ret;
  } catch (e) {
    await falhaItem(`PASSO ${passo.n} (${passo.desc}): ${e.message}`, !!e.global);
    return;
  }

  if (ret === false) {
    await gravarExecucao({
      tentativas: (ex.tentativas || 0) + 1,
      esperar_ate: Date.now() + 2500,
      claim: null
    });
    return;
  }

  if (ret && typeof ret === 'object' && ret.ok && passo.n === 15 && ex.tipo === 'gerar') {
    await gravarExecucao({ nup: ret.nup });
  }

  await GSEI.registrar(
    `${(ex.tipo || '').toUpperCase()} [${ex.atual || '-'}] PASSO ${passo.n}: ${passo.desc}`);

  if (passo.concluir) {
    await concluirItem(await lerExecucao());
    return;
  }

  await gravarExecucao({
    passo: proximoPasso(ex, passo),
    passo_ts: Date.now(),
    esperar_ate: Date.now() + (passo.espera || ESPERA_PADRAO),
    tentativas: 0,
    claim: null
  });
}

async function rodarTick() {
  const ex = await lerExecucao();
  if (!ex || !ex.ativa) return;
  // O tipo "download" e do pgt.js (aba do PGT); o motor do SEI nao o trata.
  if (ex.tipo !== 'gerar' && ex.tipo !== 'anexar') return;
  if (ex.pausado) return;

  const agora = Date.now();
  if (agora < (ex.esperar_ate || 0)) return;

  const lista = passosDe(ex.tipo);
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
    await falhaItem(`Timeout no passo ${passo.n} (${passo.desc}) apos ${Math.round(timeout / 1000)}s`, false);
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
    else console.error('[Gerador SEI] erro no tick:', e);
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

// Extensao atualizada/recarregada: este content script ficou com a API do
// chrome invalidada. Para o motor e recarrega a pagina; o novo script continua
// do mesmo ponto (o estado esta no chrome.storage.local).
function pararPorContextoInvalido(erro) {
  if (_recarregando) return;
  _recarregando = true;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  console.warn('[Gerador SEI] contexto da extensao invalidado; recarregando a pagina:', erro);
  setTimeout(() => { try { location.reload(); } catch (e) { /* ignora */ } }, 600);
}

// ------------------------------------------------------------- congelamento
// Chrome 133+ (Energy Saver) congela abas de fundo de alto uso de CPU: o
// motor para junto porque timers e mensagens deixam de rodar. Manter um
// Web Lock ativo e uma das isencoes oficiais (CannotFreezeReason::
// kHoldingWebLock em freezing_policy.cc do Chromium). O lock e "shared" para
// que todos os frames do SEI (mesma origem) o mantenham sem competir.
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
        // a execucao voltou antes de o lock ser liberado: pede de novo
        if (_lockAtiva) setTimeout(() => manterDescongelada(true), 0);
      }
    }).catch(() => { _lockPedido = false; });
  } catch (e) { _lockPedido = false; }
}

// Page Lifecycle: "freeze"/"resume" chegam no document. O log explica no
// momento em que a automacao parou (e quando ela voltou).
document.addEventListener('freeze', () => {
  if (!_timer) return;
  GSEI.registrar('Aba congelada pelo Chrome (Energy Saver): automacao pausada', 'AVISO')
    .catch(() => {});
});
document.addEventListener('resume', () => {
  if (!_timer) return;
  GSEI.registrar('Aba descongelada pelo Chrome: automacao retomada').catch(() => {});
  tick();
});

async function avaliarTrabalho() {
  try {
    const ex = await lerExecucao();
    const ativo = !!(ex && ex.ativa && (ex.tipo === 'gerar' || ex.tipo === 'anexar'));
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
    else console.warn('[Gerador SEI] avaliarTrabalho:', e);
  }
}

chrome.storage.onChanged.addListener((mudancas, area) => {
  try {
    if (area === 'local' && mudancas.execucao) avaliarTrabalho();
  } catch (e) {
    if (contextoInvalido(e)) pararPorContextoInvalido(e);
  }
});

// Coracao extra: em aba oculta o Chrome reduz os timers da pagina; o service
// worker manda este "tick" para o motor continuar girando mesmo assim.
chrome.runtime.onMessage.addListener((mensagem) => {
  try {
    if (mensagem && mensagem.acao === 'tick') tick();
  } catch (e) {
    if (contextoInvalido(e)) pararPorContextoInvalido(e);
    else console.warn('[Gerador SEI] tick remoto:', e);
  }
  return false;
});

avaliarTrabalho();
