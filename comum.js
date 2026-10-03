// Gerador SEI - helpers compartilhados (popup, background e content script).
'use strict';

const GSEI = {
  // ---------------------------------------------------------------- storage
  PADRAO_ANEXO: {
    serie: '82',
    sigilo: 'R',
    nome_arvore: 'CCIR',
    hipotese: '4',
    nivel: '1'
  },

  PADRAO_GERACAO: {
    tipo_processo: '100000508',
    especificacao: '{{Nome Titular 1}}',
    interessados: '{{Nome Titular 1}}',
    observacoes: '',
    nivel_acesso: '1',
    hipotese_legal: '4'
  },

  PADRAO_KEEPALIVE: {
    ativo: true,
    intervalo: 60,
    ultima_recarga: null,
    recargas: 0,
    ultimo_erro: null,
    thread_ativa: false
  },

  NIVEIS: {
    '0': { id: 'optPublico', nome: 'Publico' },
    '1': { id: 'optRestrito', nome: 'Restrito' },
    '2': { id: 'optSigiloso', nome: 'Sigiloso' }
  },

  async obter(chave, padrao) {
    const obj = await chrome.storage.local.get(chave);
    const valor = obj[chave];
    if (valor === undefined || valor === null) return padrao;
    if (padrao && typeof padrao === 'object' && !Array.isArray(padrao) && typeof valor === 'object') {
      return Object.assign({}, padrao, valor);
    }
    return valor;
  },

  async definir(chave, valor) {
    await chrome.storage.local.set({ [chave]: valor });
    return valor;
  },

  async atualizar(chave, padrao, mudanca) {
    const atual = await GSEI.obter(chave, padrao);
    const novo = Object.assign({}, atual, mudanca);
    await chrome.storage.local.set({ [chave]: novo });
    return novo;
  },

  async apagar(chaves) {
    await chrome.storage.local.remove(chaves);
  },

  // ------------------------------------------------------------------- log
  async registrar(mensagem, nivel) {
    const texto = `[${new Date().toLocaleString('pt-BR')}] ${nivel ? nivel + ': ' : ''}${mensagem}`;
    const log = await GSEI.obter('log', []);
    log.push(texto);
    const cortado = log.length > 500 ? log.slice(-300) : log;
    await chrome.storage.local.set({ log: cortado });
    console.log('[Gerador SEI]', texto);
    return texto;
  },

  async limparLog() {
    await chrome.storage.local.set({ log: [] });
  },

  // -------------------------------------------------------- texto/templates
  normalizar(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  },

  normalizarColuna(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  },

  normalizarCoringa(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * Mescla {{...}} com os campos do registro (mesma regra de app.py).
   * Ex.: "TD {{Código SIPRA}} {{Nome Titular 1}}" -> "TD SC0123 JOAO SILVA"
   */
  processarNomeArvore(template, registro) {
    if (!template) return template || '';
    const dados = registro || {};
    const mapa = {
      'codigo sipra': dados.cod_sipra, 'cod sipra': dados.cod_sipra,
      'cod_sipra': dados.cod_sipra, 'codsipra': dados.cod_sipra,
      'codigo beneficiario': dados.cod_sipra, 'codigo do beneficiario': dados.cod_sipra,
      'cod beneficiario': dados.cod_sipra,
      'nome titular 1': dados.nome, 'nome titular': dados.nome,
      'nome beneficiario': dados.nome, 'nome': dados.nome,
      'beneficiario': dados.nome, 'titular': dados.nome, 'titular 1': dados.nome,
      'n processo sei': dados.processo_sei, 'no processo sei': dados.processo_sei,
      'numero processo sei': dados.processo_sei, 'processo sei': dados.processo_sei,
      'processo': dados.processo_sei, 'nup': dados.processo_sei,
      'nup processo': dados.processo_sei, 'processo_sei': dados.processo_sei,
      'pdf anexo': dados.pdf_anexo, 'pdf': dados.pdf_anexo,
      'arquivo': dados.pdf_anexo, 'pdf_anexo': dados.pdf_anexo,
      'tipo documento': dados.tipo_documento_nome || dados.tipo_documento,
      'tipo do documento': dados.tipo_documento_nome || dados.tipo_documento,
      'tipo': dados.tipo_documento_nome || dados.tipo_documento,
      'serie': dados.tipo_documento, 'tipo_documento': dados.tipo_documento,
      'tipo_documento_nome': dados.tipo_documento_nome,
      'hipotese legal': dados.hipotese_legal_nome || dados.hipotese_legal,
      'hipotese': dados.hipotese_legal_nome || dados.hipotese_legal,
      'hipotese_legal': dados.hipotese_legal,
      'hipotese_legal_nome': dados.hipotese_legal_nome,
      'nivel acesso': dados.nivel_acesso, 'nivel de acesso': dados.nivel_acesso,
      'nivel': dados.nivel_acesso, 'nivel_acesso': dados.nivel_acesso,
      'data anexo': dados.data_anexo, 'data': dados.data_anexo,
      'data_anexo': dados.data_anexo
    };
    return String(template).replace(/\{\{\s*(.*?)\s*\}\}/g, (m, interno) => {
      const chave = GSEI.normalizarCoringa(interno);
      let valor = mapa[chave];
      if (valor === undefined || valor === null) valor = dados[chave];
      return valor === undefined || valor === null ? '' : String(valor);
    });
  },

  /**
   * Renderiza coringas do CSV (mesma regra de renderizar_template em sei.py):
   * partes separadas por ' - ' que ficarem vazias sao descartadas.
   */
  renderizarTemplate(template, dados) {
    if (template === null || template === undefined) return '';
    const tpl = String(template).trim();
    if (!tpl) return '';

    const dadosNorm = {};
    for (const [k, v] of Object.entries(dados || {})) {
      dadosNorm[GSEI.normalizar(k)] = v === null || v === undefined ? '' : String(v).trim();
    }

    const valor = (chave) => {
      const c = GSEI.normalizar(chave);
      if (!c) return '';
      if (dadosNorm[c]) return dadosNorm[c];
      for (const [k, v] of Object.entries(dadosNorm)) {
        if ((c && k.includes(c)) || (k && c.includes(k))) return v;
      }
      const cTokens = new Set(c.split(' '));
      for (const [k, v] of Object.entries(dadosNorm)) {
        const kTokens = new Set(k.split(' '));
        if (v && [...cTokens].every(t => kTokens.has(t))) return v;
      }
      return '';
    };

    return tpl.split(/\s+-\s+/)
      .map(parte => String(parte).replace(/\{\{\s*(.*?)\s*\}\}/g, (m, c) => valor(c))
        .replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' - ');
  },

  // ------------------------------------------------------------------ CSV
  decodificarCSV(raw) {
    const buffer = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    for (const enc of ['utf-8', 'windows-1252', 'latin-1']) {
      try {
        return new TextDecoder(enc, { fatal: false }).decode(buffer);
      } catch (e) { /* proximo encoding */ }
    }
    return new TextDecoder('utf-8').decode(buffer);
  },

  lerCSV(conteudo) {
    const amostra = conteudo.slice(0, 4096);
    let delimitador = ';';
    const temPontoEVirgula = amostra.indexOf(';') !== -1;
    const temVirgula = amostra.indexOf(',') !== -1;
    if (temVirgula && !temPontoEVirgula) delimitador = ',';
    if (amostra.indexOf('\t') !== -1 && !temVirgula && !temPontoEVirgula) delimitador = '\t';

    const linhas = conteudo.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
      .filter(l => l.trim() !== '');
    if (linhas.length === 0) return { cabecalho: [], linhas: [] };

    const dividir = (linha) => {
      const partes = [];
      let atual = '';
      let aspas = false;
      for (let i = 0; i < linha.length; i++) {
        const ch = linha[i];
        if (ch === '"') {
          if (aspas && linha[i + 1] === '"') { atual += '"'; i++; }
          else aspas = !aspas;
        } else if (ch === delimitador && !aspas) {
          partes.push(atual); atual = '';
        } else atual += ch;
      }
      partes.push(atual);
      return partes.map(p => p.trim());
    };

    const cabecalho = dividir(linhas[0]);
    const dados = [];
    for (let i = 1; i < linhas.length; i++) {
      const partes = dividir(linhas[i]);
      const obj = {};
      cabecalho.forEach((col, idx) => { obj[col] = partes[idx] !== undefined ? partes[idx] : ''; });
      dados.push(obj);
    }
    return { cabecalho, linhas: dados };
  },

  acharColuna(cabecalho, ...candidatas) {
    const norm = {};
    cabecalho.forEach(c => { norm[GSEI.normalizarColuna(c)] = c; });
    for (const cand of candidatas) {
      const alvo = GSEI.normalizarColuna(cand);
      if (norm[alvo]) return norm[alvo];
    }
    for (const cand of candidatas) {
      const alvo = GSEI.normalizarColuna(cand);
      for (const [ncol, orig] of Object.entries(norm)) {
        if (ncol.indexOf(alvo) !== -1) return orig;
      }
    }
    return null;
  },

  // ------------------------------------------------------------ estatisticas
  calcularStats(registros) {
    const total = registros.length;
    const comPdf = registros.filter(r => r.anexado === 1).length;
    const erros = registros.filter(r => r.anexado === -1).length;
    const comProcesso = registros.filter(r => (r.processo_sei || '').trim() !== '').length;
    return {
      total,
      com_pdf: comPdf,
      erros,
      sem_pdf: total - comPdf - erros,
      com_processo: comProcesso
    };
  },

  agora() {
    return new Date().toLocaleString('pt-BR');
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSEI };
}
