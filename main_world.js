// Executa no MUNDO DA PAGINA: aceita alertas/confirmacoes do SEI somente
// enquanto a extensao esta automatizando (o mundo isolado sinaliza via evento
// DOM, que cruza a fronteira entre mundos).
'use strict';

(function () {
  let ativoAte = 0;

  const originalAlert = window.alert;
  const originalConfirm = window.confirm;
  const originalPrompt = window.prompt;

  function ativo() {
    return Date.now() < ativoAte;
  }

  document.addEventListener('gsei-automacao', function (e) {
    try {
      const ms = (e && e.detail && e.detail.tempo) || 120000;
      ativoAte = Date.now() + ms;
    } catch (err) { /* ignora */ }
  }, true);

  document.addEventListener('gsei-alerta', function (e) {
    try {
      console.log('[Gerador SEI] alerta do SEI:', e && e.detail);
    } catch (err) { /* ignora */ }
  }, true);

  window.alert = function (msg) {
    if (ativo()) {
      document.dispatchEvent(new CustomEvent('gsei-alerta', { detail: String(msg) }));
      return;
    }
    return originalAlert.call(window, msg);
  };

  window.confirm = function (msg) {
    if (ativo()) {
      document.dispatchEvent(new CustomEvent('gsei-alerta', { detail: String(msg) }));
      return true;
    }
    return originalConfirm.call(window, msg);
  };

  window.prompt = function (msg, padrao) {
    if (ativo()) return padrao === undefined ? '' : padrao;
    return originalPrompt.call(window, msg, padrao);
  };

  // ------------------------------------------------------------------- RPC
  // O content script (mundo isolado) nao enxerga as funcoes declaradas pela
  // pagina. Ele despacha um CustomEvent e aqui executamos na janela real.
  function responder(id, ok, erro, valor) {
    try {
      document.dispatchEvent(new CustomEvent('gsei-rpc-resultado', {
        detail: { id: id, ok: ok, erro: erro, valor: valor }
      }));
    } catch (err) { /* ignora */ }
  }

  document.addEventListener('gsei-rpc', function (e) {
    let id = null;
    try {
      const dados = (e && e.detail) || {};
      id = dados.id;
      const fn = dados.nome ? window[dados.nome] : null;
      if (typeof fn !== 'function') {
        responder(id, false, (dados.nome || 'funcao') + ' nao existe na pagina', null);
        return;
      }
      const args = Array.isArray(dados.args) ? dados.args : [];
      const valor = fn.apply(window, args);
      const tipo = typeof valor;
      responder(id, true, null,
        (tipo === 'string' || tipo === 'number' || tipo === 'boolean') ? valor : null);
    } catch (err) {
      responder(id, false, String((err && err.message) || err), null);
    }
  }, true);
})();
