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

  // Dois keep-alives independentes (SEI e PGT): mesma forma do padrao acima,
  // cada alvo com a propria chave no chrome.storage.local. A chave "keepalive"
  // continua sendo a do SEI (preferencia ja gravada por versoes antigas).
  CHAVES_KEEPALIVE: { sei: 'keepalive', pgt: 'keepalive_pgt' },

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

  // ----------------------------------------------------------- keep-alive
  chaveKeepalive(alvo) {
    return GSEI.CHAVES_KEEPALIVE[alvo] || GSEI.CHAVES_KEEPALIVE.sei;
  },

  async obterKeepalive(alvo) {
    return GSEI.obter(GSEI.chaveKeepalive(alvo), GSEI.PADRAO_KEEPALIVE);
  },

  async atualizarKeepalive(alvo, mudanca) {
    return GSEI.atualizar(GSEI.chaveKeepalive(alvo), GSEI.PADRAO_KEEPALIVE, mudanca);
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

  // ------------------------------------------------------------- coringas
  // Apelidos amigaveis: chave normalizada -> campos (primeiro com valor
  // vence). Cobrem as duas tabelas: cod_sipra (aba Anexar) e
  // cod_beneficiario (aba Gerar). Os NUPs aceitam tambem o NUP gerado e o
  // NUP do CSV, que e o que existe na fila da aba Gerar.
  ALIASES_CORINGA: {
    'codigo sipra': ['cod_sipra', 'cod_beneficiario'],
    'cod sipra': ['cod_sipra', 'cod_beneficiario'],
    'codsipra': ['cod_sipra', 'cod_beneficiario'],
    'codigo beneficiario': ['cod_sipra', 'cod_beneficiario'],
    'codigo do beneficiario': ['cod_sipra', 'cod_beneficiario'],
    'cod beneficiario': ['cod_sipra', 'cod_beneficiario'],
    'nome titular 1': ['nome'],
    'nome titular': ['nome'],
    'nome beneficiario': ['nome'],
    'nome': ['nome'],
    'beneficiario': ['nome'],
    'titular': ['nome'],
    'titular 1': ['nome'],
    'n processo sei': ['processo_sei', 'processo_gerado', 'processo_sei_original'],
    'no processo sei': ['processo_sei', 'processo_gerado', 'processo_sei_original'],
    'numero processo sei': ['processo_sei', 'processo_gerado', 'processo_sei_original'],
    'processo sei': ['processo_sei', 'processo_gerado', 'processo_sei_original'],
    'processo': ['processo_sei', 'processo_gerado', 'processo_sei_original'],
    'nup': ['processo_sei', 'processo_gerado', 'processo_sei_original'],
    'nup processo': ['processo_sei', 'processo_gerado', 'processo_sei_original'],
    'processo_sei': ['processo_sei', 'processo_gerado', 'processo_sei_original'],
    'pdf anexo': ['pdf_anexo'],
    'pdf': ['pdf_anexo'],
    'arquivo': ['pdf_anexo'],
    'pdf_anexo': ['pdf_anexo'],
    'tipo documento': ['tipo_documento_nome', 'tipo_documento'],
    'tipo do documento': ['tipo_documento_nome', 'tipo_documento'],
    'tipo': ['tipo_documento_nome', 'tipo_documento'],
    'serie': ['tipo_documento', 'tipo_documento_nome'],
    'tipo_documento': ['tipo_documento'],
    'tipo_documento_nome': ['tipo_documento_nome'],
    'hipotese legal': ['hipotese_legal_nome', 'hipotese_legal'],
    'hipotese': ['hipotese_legal_nome', 'hipotese_legal'],
    'hipotese_legal': ['hipotese_legal'],
    'hipotese_legal_nome': ['hipotese_legal_nome'],
    'nivel acesso': ['nivel_acesso'],
    'nivel de acesso': ['nivel_acesso'],
    'nivel': ['nivel_acesso'],
    'nivel_acesso': ['nivel_acesso'],
    'data anexo': ['data_anexo'],
    'data_anexo': ['data_anexo'],
    'data geracao': ['data_geracao'],
    'data download': ['data_download']
  },

  temValor(v) {
    return v !== undefined && v !== null && String(v).trim() !== '';
  },

  // Linha do CSV (JSON em dados_csv) virando {coluna: valor}.
  colunasCsv(bruto) {
    if (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) return bruto;
    if (typeof bruto === 'string' && bruto.trim()) {
      try {
        const obj = JSON.parse(bruto);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
      } catch (e) { /* dados_csv ilegivel: sem colunas de CSV */ }
    }
    return {};
  },

  /**
   * Monta {chave normalizada: valor} para resolver os coringas {{...}}.
   *
   * Tres fontes, nesta ordem de precedencia:
   *   1. colunas da propria tabela/registro (cod_sipra/cod_beneficiario,
   *      nome, processo_sei, pdf_anexo, ...);
   *   2. colunas do CSV (guardadas em dados_csv como JSON) - so preenchem
   *      chaves que a tabela nao tem (ou que tem vazio);
   *   3. apelidos amigaveis ({{Código SIPRA}}, {{Nome Titular 1}}, {{NUP}},
   *      {{Serie}}, ...).
   *
   * Fonte com valor vazio nao bloqueia a proxima.
   */
  fonteCoringas(registro, dadosCsv) {
    let campos = {};
    if (typeof registro === 'string') {
      campos = { cod_sipra: registro };
    } else if (registro && typeof registro === 'object' && !Array.isArray(registro)) {
      campos = registro;
    }

    const bruto = dadosCsv !== undefined && dadosCsv !== null ? dadosCsv : campos.dados_csv;
    const colunas = GSEI.colunasCsv(bruto);

    const mapa = {};
    for (const [chave, valor] of Object.entries(campos)) {
      if (chave === 'dados_csv') continue;
      const norm = GSEI.normalizarCoringa(chave);
      if (norm) mapa[norm] = valor;
    }
    for (const [chave, valor] of Object.entries(colunas)) {
      const norm = GSEI.normalizarCoringa(chave);
      if (norm && !GSEI.temValor(mapa[norm])) mapa[norm] = valor;
    }
    for (const [apelido, alvos] of Object.entries(GSEI.ALIASES_CORINGA)) {
      if (GSEI.temValor(mapa[apelido])) continue;
      for (const alvo of alvos) {
        if (GSEI.temValor(campos[alvo])) { mapa[apelido] = campos[alvo]; break; }
      }
    }
    return mapa;
  },

  /**
   * Valor nao-vazio da chave normalizada ('' quando nao ha).
   *
   * Primeiro a busca exata; se nada casar, a difusa: a chave como trecho do
   * nome da coluna e depois por subconjunto de tokens (regra que a aba Gerar
   * ja usava: "{{Nome Titular}}" acha a coluna "NOME TITULAR 1"). A coluna
   * so vence quando tem valor: coringa com dado vazio cai na proxima fonte.
   */
  buscarCoringa(chaveNorm, mapa) {
    if (!chaveNorm) return '';
    const mapaNorm = mapa || {};
    const direto = mapaNorm[chaveNorm];
    if (GSEI.temValor(direto)) return direto;
    for (const [k, v] of Object.entries(mapaNorm)) {
      if (GSEI.temValor(v) && k.indexOf(chaveNorm) !== -1) return v;
    }
    const alvo = new Set(String(chaveNorm).split(' ').filter(Boolean));
    if (alvo.size) {
      for (const [k, v] of Object.entries(mapaNorm)) {
        if (!GSEI.temValor(v)) continue;
        const tokens = new Set(k.split(' ').filter(Boolean));
        if ([...alvo].every(t => tokens.has(t))) return v;
      }
    }
    return '';
  },

  /**
   * Mesla campos coringas {{...}} com valores do registro: colunas da
   * propria tabela, colunas do CSV (dados_csv) e apelidos.
   * Ex.: "TD {{Código SIPRA}} - Lote {{Lote}}" -> "TD SC0123 - Lote 12"
   *
   * Coringa sem valor no registro fica visivel no texto (em vez de virar
   * string vazia), assim a coluna "Nome na Arvore" nunca some e o problema
   * (falta de CSV, por exemplo) aparece na cara.
   */
  processarNomeArvore(template, registro, dadosCsv) {
    if (!template) return template || '';
    const mapa = GSEI.fonteCoringas(registro, dadosCsv);
    return String(template).replace(/\{\{\s*(.*?)\s*\}\}/g, (m, interno) => {
      const valor = GSEI.buscarCoringa(GSEI.normalizarCoringa(interno), mapa);
      return GSEI.temValor(valor) ? String(valor) : m;
    });
  },

  /**
   * Renderiza coringas na geracao do documento (mesma regra de
   * renderizar_template em sei.py): partes separadas por ' - ' que
   * ficarem vazias sao descartadas junto com o separador.
   * Ex.: "{{Nome Titular 1}} - {{Nome Titular 2}}" com so um titular.
   */
  renderizarTemplate(template, registro, dadosCsv) {
    if (template === null || template === undefined) return '';
    const tpl = String(template).trim();
    if (!tpl) return '';

    const mapa = GSEI.fonteCoringas(registro, dadosCsv);
    const coringa = (m, interno) => {
      const valor = GSEI.buscarCoringa(GSEI.normalizarCoringa(interno), mapa);
      return GSEI.temValor(valor) ? String(valor) : '';
    };

    return tpl.split(/\s+-\s+/)
      .map(parte => String(parte).replace(/\{\{\s*(.*?)\s*\}\}/g, coringa)
        .replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' - ');
  },

  /** Coringas do template que nao tem dado no registro (ex.: ['Lote']). */
  coringasFaltantes(template, registro, dadosCsv) {
    if (!template) return [];
    const mapa = GSEI.fonteCoringas(registro, dadosCsv);
    const faltando = [];
    String(template).replace(/\{\{\s*(.*?)\s*\}\}/g, (m, interno) => {
      const valor = GSEI.buscarCoringa(GSEI.normalizarCoringa(interno), mapa);
      if (!GSEI.temValor(valor) && faltando.indexOf(m) === -1) faltando.push(m);
      return m;
    });
    return faltando;
  },

  // ------------------------------------------------------------ pendencias
  // O que falta POR REGISTRO antes de anexar (mesma leitura de
  // pendencias_anexar/diagnostico_pendencias em sei.py): sem PDF, sem NUP e
  // coringa do nome na arvore sem dado.
  pendenciasRegistros(registros, cfg) {
    const templateCfg = (cfg && cfg.nome_arvore || '').trim();
    const pendentes = (registros || []).filter(r => r.anexado === 0 || r.anexado === -1);
    const saida = [];
    for (const r of pendentes) {
      const faltas = [];
      if (!GSEI.temValor(r.pdf_anexo)) faltas.push('sem PDF (carregue os PDFs na aba Anexar)');
      if (!GSEI.temValor(r.processo_sei)) faltas.push('sem numero de processo (gere o NUP na aba Gerar)');
      const template = (r.nome_arvore || '').trim() || templateCfg;
      const semDado = template ? GSEI.coringasFaltantes(template, r) : [];
      if (semDado.length) faltas.push('coringa sem dado: ' + semDado.join(', '));
      if (faltas.length) saida.push({ cod: r.cod_sipra || '', faltas: faltas });
    }
    return saida;
  },

  // Resumo no estilo do app: so o que BLOQUEIA a anexacao.
  diagnosticoPendencias(registros) {
    const pendentes = (registros || []).filter(r => r.anexado === 0 || r.anexado === -1);
    if (!pendentes.length) return 'Nenhum registro pendente para anexar';
    const comPdf = pendentes.filter(r => GSEI.temValor(r.pdf_anexo)).length;
    const prontos = pendentes.filter(r =>
      GSEI.temValor(r.pdf_anexo) && GSEI.temValor(r.processo_sei)).length;
    const partes = [];
    if (comPdf - prontos > 0) {
      partes.push(`${comPdf - prontos} sem numero de processo (gere o NUP na aba Gerar)`);
    }
    if (pendentes.length - comPdf > 0) {
      partes.push(`${pendentes.length - comPdf} sem PDF (carregue os PDFs na aba Anexar)`);
    }
    if (!partes.length) return 'Todos os registros pendentes estao prontos para anexar';
    return 'Nenhum registro pronto para anexar: ' + partes.join(' | ');
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
