/* Finanças — versão instalável do Painel Financeiro 2026.
   Faz o painel conversar com a planilha pela PONTE (Google Apps Script), no lugar do conector do claude.ai.
   Dentro do claude.ai este arquivo não faz nada. */
(function () {
  'use strict';
  if (window.claude && window.claude.use) return;

  var CFG = 'pf-app-cfg', DADOS = 'pf-app-dados', NAO_INSTALAR = 'pf-app-sem-instalar';
  var ls = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { } }
  };
  function getCfg() { try { var c = JSON.parse(ls.get(CFG) || 'null'); return c && c.u ? c : null; } catch (e) { return null; } }
  function setCfg(c) { var old = getCfg(); if (!old || old.u !== c.u || (old.k || '') !== (c.k || '')) { ls.del(DADOS); store = {}; } return ls.set(CFG, JSON.stringify(c.k ? { u: c.u, k: c.k } : { u: c.u })); }
  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function unb64(s) { return decodeURIComponent(escape(atob(s))); }
  /* aceita o link de configuração inteiro (…#cfg=XXXX) ou só o código XXXX */
  function parseCfg(text) {
    text = String(text || '').trim(); if (!text) return null;
    var m = /cfg=([^&\s#]+)/.exec(text), code = m ? m[1] : text;
    try { var c = JSON.parse(unb64(decodeURIComponent(code))); if (c && c.u) return c.k ? { u: String(c.u).trim(), k: String(c.k).trim() } : { u: String(c.u).trim() }; } catch (e) { }
    return null;
  }
  function shareLink(c) { return location.origin + location.pathname + '#cfg=' + encodeURIComponent(b64(JSON.stringify(c.k ? { u: c.u, k: c.k } : { u: c.u }))); }

  var store = (function () { try { return JSON.parse(ls.get(DADOS) || '{}') || {}; } catch (e) { return {}; } })();

  /* abriu pelo link de configuração: guarda e limpa o endereço (a chave não fica na barra) */
  (function fromHash() {
    if (!/[#&]cfg=/.test(location.hash || '')) return;
    var c = parseCfg(location.hash);
    if (c) setCfg(c);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
  })();

  /* ---------- conversa com a ponte ---------- */
  async function call(params, cfg) {
    var c = cfg || getCfg();
    if (!c) throw { code: 'not_granted', message: 'O app ainda não está ligado à planilha.' };
    var ctl = window.AbortController ? new AbortController() : null;
    var to = ctl ? setTimeout(function () { ctl.abort(); }, 40000) : null;
    var r, txt;
    try {
      r = await fetch(c.u, {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal: ctl ? ctl.signal : undefined,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(c.k ? Object.assign({ k: c.k }, params) : params)
      });
      txt = await r.text();
    } catch (e) {
      throw { code: 'server_unavailable', message: navigator.onLine === false ? 'Sem internet agora.' : 'A planilha não respondeu. Tente de novo em instantes.' };
    } finally { if (to) clearTimeout(to); }
    var j = null;
    try { j = JSON.parse(txt); } catch (e) { }
    if (!j) throw { code: 'upstream_error', message: /<html/i.test(txt || '') ? 'A ponte pediu login: no Apps Script, a implantação precisa estar com "Quem pode acessar: Qualquer pessoa".' : 'A ponte respondeu de um jeito inesperado (' + (r && r.status) + ').' };
    if (!j.ok) throw { code: j.code || 'tool_error', message: j.message || 'Erro na planilha.' };
    return j;
  }

  /* leituras pedidas ao mesmo tempo viram um pedido só */
  var queue = null;
  function read(range) {
    return new Promise(function (res, rej) {
      if (!queue) { queue = []; setTimeout(flush, 25); }
      queue.push({ range: range, res: res, rej: rej });
    });
  }
  function flush() {
    var q = queue; queue = null;
    var ranges = [];
    q.forEach(function (i) { if (ranges.indexOf(i.range) < 0) ranges.push(i.range); });
    call({ a: 'read', ranges: ranges }).then(function (j) {
      var d = j.data || {};
      q.forEach(function (i) { i.res(Array.isArray(d[i.range]) ? d[i.range] : []); });
    }, function (err) { q.forEach(function (i) { i.rej(err); }); });
  }

  /* última leitura de cada aba fica guardada no celular: o app abre na hora e funciona sem sinal */
  var tSave = null;
  function remember(range, values) {
    store[range] = { t: Date.now(), v: values };
    clearTimeout(tSave);
    tSave = setTimeout(function () { ls.set(DADOS, JSON.stringify(store)); }, 400);
  }

  var watchers = [], poll = null, every = 90000, lastRun = 0, failed = false;
  function runAll() { lastRun = Date.now(); watchers.slice().forEach(function (w) { w.run(); }); }
  function startPoll(ms) {
    if (ms && ms >= 15000 && ms < every) { every = ms; clearInterval(poll); poll = null; }
    if (!poll) poll = setInterval(function () { if (document.visibilityState !== 'hidden' && watchers.length) runAll(); }, every);
  }
  function wake() { if (watchers.length && (failed || Date.now() - lastRun > 8000)) runAll(); }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') wake(); });
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', function (e) { if (e.persisted) wake(); });

  var mcp = {
    callTool: async function (server, tool, args) {
      args = args || {};
      if (tool === 'get_values') return { payload: { range: args.range, values: await read(args.range) } };
      if (tool === 'update_values') { await call({ a: 'write', range: args.range, values: args.values }); return { payload: { status: 'success', updatedRange: args.range } }; }
      throw { code: 'tool_error', message: 'O app não sabe fazer: ' + tool };
    },
    watchTool: function (server, tool, args, cb, opts) {
      var range = args && args.range, alive = true;
      var w = {
        run: function () {
          read(range).then(function (v) {
            if (!alive) return;
            failed = false; remember(range, v);
            cb({ type: 'data', result: { payload: { range: range, values: v }, cache: { storedAt: Date.now() } } });
          }, function (err) {
            if (!alive) return;
            failed = true; cb({ type: 'error', error: err });
            if (err && err.code === 'not_granted') showSetup('A chave não confere com a da planilha. Configure de novo.');
          });
        }
      };
      watchers.push(w);
      var hit = store[range];
      if (hit && Array.isArray(hit.v)) setTimeout(function () { if (alive) cb({ type: 'data', result: { payload: { range: range, values: hit.v }, cache: { storedAt: hit.t } } }); }, 0);
      lastRun = Date.now(); w.run(); startPoll(opts && opts.refetchInterval);
      return function () { alive = false; var i = watchers.indexOf(w); if (i >= 0) watchers.splice(i, 1); };
    },
    invalidate: function () { runAll(); return Promise.resolve(); }
  };

  window.claude = { use: async function (name) { return name === 'mcp' && getCfg() ? mcp : null; } };

  /* ---------- instalação ---------- */
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/i.test(ua);
  function standalone() { try { return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; } catch (e) { return false; } }
  var promptEv = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); promptEv = e; pill(); });
  window.addEventListener('appinstalled', function () { promptEv = null; var p = document.getElementById('pfInst'); if (p) p.remove(); });
  var IOS_STEPS = '<li>Toque em <b>Compartilhar</b> (o quadrado com a seta para cima; se não aparecer, toque antes em <b>•••</b>).</li><li>Escolha <b>Adicionar à Tela de Início</b>.</li><li>Deixe <b>Abrir como app web</b> ligado e toque em <b>Adicionar</b>.</li>';
  function howTo(configured) {
    if (isIOS) return configured
      ? '<ol><li>Toque em <b>Copiar link de configuração</b> (abaixo).</li>' + IOS_STEPS + '<li>Abra pelo ícone <b>Finanças</b>. Se ele pedir, cole o link: no iPhone o app instalado tem memória própria, separada do Safari.</li></ol><div class="row"><button type="button" data-c="copy">Copiar link de configuração</button></div>'
      : '<ol>' + IOS_STEPS + '<li>Abra pelo ícone <b>Finanças</b> e ligue à planilha lá dentro. O app instalado não enxerga o que é feito aqui no Safari.</li></ol>';
    if (isAndroid) return '<ol><li>No Chrome, toque no menu <b>⋮</b> (canto de cima).</li><li>Toque em <b>Instalar app</b> (ou <b>Adicionar à tela inicial</b> → <b>Instalar</b>).</li><li>Abra pelo ícone <b>Finanças</b>.</li></ol>';
    return '<p>No computador, use o ícone de instalar na barra de endereço do Chrome ou do Edge. No celular, abra este endereço no Safari (iPhone) ou no Chrome (Android).</p>';
  }

  /* ---------- telas ---------- */
  var css = '' +
    '.pfx{position:fixed;inset:0;z-index:999;display:grid;place-items:center;padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom));background:rgba(8,14,28,.66);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}' +
    '.pfx .cb{width:min(460px,100%);max-height:100%;overflow:auto;background:var(--surface,#fff);color:var(--ink,#0f1a30);border-radius:16px;padding:22px 20px 20px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:400 14px/1.45 var(--f-body,system-ui,sans-serif)}' +
    '.pfx h2{font:600 21px/1.2 var(--f-display,system-ui,sans-serif);letter-spacing:-.01em;margin:0 0 6px}' +
    '.pfx p{margin:0 0 10px;color:var(--ink-2,#414d68);font-size:13.5px}' +
    '.pfx ol{margin:6px 0 0;padding-left:20px;color:var(--ink-2,#414d68);font-size:13.5px}.pfx li{margin:5px 0}' +
    '.pfx label{display:block;font:500 11px/1.2 var(--f-mono,monospace);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3,#69758f);margin:14px 0 6px}' +
    '.pfx input,.pfx textarea{display:block;width:100%;box-sizing:border-box;border:1px solid var(--line,#d6ddea);border-radius:10px;padding:11px 12px;font:400 16px/1.3 var(--f-body,system-ui,sans-serif);background:var(--surface-2,#f5f7fb);color:inherit}' +
    '.pfx textarea{height:76px;resize:vertical;font-size:14px;word-break:break-all}' +
    '.pfx input:focus,.pfx textarea:focus{outline:none;border-color:var(--accent,#2a4fc4);box-shadow:0 0 0 3px var(--accent-soft,#e1e8fb)}' +
    '.pfx button{min-height:44px;border-radius:10px;border:1px solid var(--line,#d6ddea);background:var(--surface,#fff);color:inherit;font:600 14px var(--f-body,system-ui,sans-serif);padding:0 14px;cursor:pointer}' +
    '.pfx .pri{background:var(--accent,#2a4fc4);border-color:var(--accent,#2a4fc4);color:var(--accent-ink,#fff);width:100%;margin-top:16px}' +
    '.pfx .pri:disabled{opacity:.6}' +
    '.pfx .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.pfx .row button{flex:1 1 140px}' +
    '.pfx .msg{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:13px}' +
    '.pfx .ok{background:var(--good-soft,#dcf2e6);color:var(--good,#127a4c)}.pfx .bad{background:var(--bad-soft,#fbe1de);color:var(--bad,#b3261e)}' +
    '.pfx .or{display:flex;align-items:center;gap:10px;margin:16px 0 0;color:var(--ink-3,#69758f);font:500 11px var(--f-mono,monospace);letter-spacing:.08em;text-transform:uppercase}.pfx .or:before,.pfx .or:after{content:"";flex:1;border-top:1px solid var(--line,#d6ddea)}' +
    '.pfx .tip{margin-top:16px;padding:12px 14px;border-radius:12px;background:var(--surface-2,#f5f7fb);border:1px solid var(--line-2,#e6ebf3)}.pfx .tip-h{display:block;margin-bottom:2px;color:var(--ink,#0f1a30)}' +
    '.pfx hr{border:0;border-top:1px solid var(--line,#d6ddea);margin:18px 0 14px}' +
    '.pfx .x{float:right;min-height:34px;width:34px;padding:0;border-radius:8px;margin:-6px -6px 0 8px}' +
    '.pfx .lnk{background:none;border:0;padding:0;min-height:0;color:var(--bad,#b3261e);font-weight:500;text-decoration:underline;margin-top:14px}' +
    '.cfg-lnk{background:none;border:0;padding:0;color:inherit;font:inherit;text-decoration:underline;cursor:pointer}' +
    '#pfInst{position:fixed;right:max(12px,env(safe-area-inset-right));bottom:calc(14px + env(safe-area-inset-bottom));z-index:70;display:flex;align-items:center;border-radius:99px;background:var(--accent,#2a4fc4);color:var(--accent-ink,#fff);box-shadow:0 8px 26px rgba(0,0,0,.28);font:600 13.5px var(--f-body,system-ui,sans-serif)}' +
    '#pfInst button{background:none;border:0;color:inherit;font:inherit;min-height:42px;cursor:pointer}#pfInst .go{padding:0 6px 0 16px}#pfInst .no{padding:0 14px 0 8px;opacity:.75;font-size:15px}';
  function el(h) { var d = document.createElement('div'); d.innerHTML = h; return d.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function modal(html) {
    var box = el('<div class="pfx" role="dialog" aria-modal="true"><div class="cb">' + html + '</div></div>');
    document.body.appendChild(box);
    return box;
  }

  function showSetup(msg) {
    if (document.getElementById('cfgBox')) return;
    var c = getCfg();
    var tip = standalone() ? '' : '<div class="tip"><b class="tip-h">' + (isIOS && !c ? 'No iPhone, instale antes de ligar' : 'Para instalar como app') + '</b>' + howTo(!!c) + '</div>';
    var tipFirst = isIOS && !c && tip;
    var box = modal(
      (c ? '<button type="button" class="x" data-c="close" aria-label="Fechar">✕</button>' : '') +
      '<h2>' + (c ? 'Configuração do app' : 'Ligar o app à planilha') + '</h2>' +
      '<p>' + (c ? 'Este celular está ligado à planilha.' : 'Só uma vez em cada celular. Cole o link de configuração que chegou no WhatsApp, ou o endereço da ponte.') + '</p>' +
      (tipFirst ? tip : '') +
      (msg ? '<div class="msg bad">' + esc(msg) + '</div>' : '') +
      (c ? '' : '<label for="cfgL">Link de configuração</label><textarea id="cfgL" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Cole o link aqui"></textarea><div class="or">ou</div>') +
      '<label for="cfgU">Endereço da ponte (termina em /exec)</label><input id="cfgU" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(c ? c.u : '') + '">' +
      '<button type="button" class="pri" data-c="save">' + (c ? 'Testar e salvar' : 'Ligar à planilha') + '</button><div id="cfgMsg" aria-live="polite"></div>' +
      (c ? '<hr><p><b>Instalar em outro celular:</b> mande o link de configuração. Quem abrir já entra ligado à planilha. Ele funciona como uma senha: mande só para quem pode mexer nas finanças.</p><div class="row"><button type="button" data-c="share">Enviar link</button><button type="button" data-c="copy">Copiar link</button></div>' + tip +
        '<button type="button" class="lnk" data-c="off">Desligar este celular da planilha</button>' : (tipFirst ? '' : tip))
    );
    box.id = 'cfgBox';
    box.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-c]'); if (!b) return;
      var out = document.getElementById('cfgMsg'), cur = getCfg();
      var say = function (cls, h) { out.innerHTML = '<div class="msg ' + cls + '">' + h + '</div>'; };
      switch (b.dataset.c) {
        case 'close': box.remove(); return;
        case 'off':
          if (!window.confirm('Desligar este celular? O app esquece o endereço da ponte e os dados guardados.')) return;
          ls.del(CFG); ls.del(DADOS); location.reload(); return;
        case 'share': {
          var link = shareLink(cur);
          if (navigator.share) { try { await navigator.share({ title: 'Finanças', text: 'App Finanças: abra este link no celular e instale.', url: link }); return; } catch (err) { if (err && err.name === 'AbortError') return; } }
          window.open('https://wa.me/?text=' + encodeURIComponent('App Finanças: abra este link no celular e instale. ' + link), '_blank', 'noopener');
          return;
        }
        case 'copy': {
          var l = shareLink(cur);
          try { await navigator.clipboard.writeText(l); b.textContent = 'Copiado ✓'; } catch (err) { window.prompt('Copie o link:', l); }
          return;
        }
        case 'save': {
          var lf = document.getElementById('cfgL'), raw = lf ? lf.value.trim() : '', next;
          if (raw) {
            next = parseCfg(raw);
            if (!next) { say('bad', 'Esse texto não é um link de configuração. Peça o link de novo ou preencha o endereço e a chave.'); return; }
          } else {
            next = { u: document.getElementById('cfgU').value.trim() };
            if (cur && cur.k && cur.u === next.u) next.k = cur.k;
            if (!/^https:\/\/script\.google(usercontent)?\.com\/\S+/.test(next.u)) { say('bad', 'O endereço da ponte começa com https://script.google.com/ e termina em /exec.'); return; }
          }
          b.disabled = true; var lbl = b.textContent; b.textContent = 'Testando…';
          try {
            var j = await call({ a: 'ping' }, next);
            setCfg(next);
            say('ok', 'Ligado à planilha <b>' + esc(j.planilha) + '</b>. Abrindo…');
            setTimeout(function () { location.reload(); }, 900);
          } catch (err) {
            b.disabled = false; b.textContent = lbl;
            var why = err && err.code === 'not_granted' ? 'A ponte pediu uma chave. Use o link de configuração.'
              : err && err.code === 'server_unavailable' ? (navigator.onLine === false ? 'Sem internet agora.' : 'Não consegui falar com a ponte. Confira se o endereço termina em <b>/exec</b> e se a implantação está com <b>Quem pode acessar: Qualquer pessoa</b>.')
              : esc((err && err.message) || 'Não deu certo.');
            say('bad', why);
          }
          return;
        }
      }
    });
  }

  function showHowTo() {
    var box = modal('<button type="button" class="x" aria-label="Fechar">✕</button><h2>Instalar o app</h2>' + howTo(!!getCfg()));
    box.addEventListener('click', async function (e) {
      if (e.target === box || e.target.closest('.x')) { box.remove(); return; }
      var b = e.target.closest('[data-c="copy"]'); if (!b) return;
      var l = shareLink(getCfg());
      try { await navigator.clipboard.writeText(l); b.textContent = 'Link copiado ✓'; } catch (err) { window.prompt('Copie o link:', l); }
    });
  }
  function pill() {
    if (standalone() || ls.get(NAO_INSTALAR) || !getCfg() || document.getElementById('pfInst') || !document.body) return;
    if (!promptEv && !isIOS && !isAndroid) return;
    var p = el('<div id="pfInst"><button type="button" class="go">Instalar o app</button><button type="button" class="no" aria-label="Agora não">✕</button></div>');
    document.body.appendChild(p);
    p.querySelector('.go').addEventListener('click', async function () {
      if (promptEv) { var ev = promptEv; promptEv = null; ev.prompt(); try { await ev.userChoice; } catch (e) { } p.remove(); return; }
      showHowTo();
    });
    p.querySelector('.no').addEventListener('click', function () { ls.set(NAO_INSTALAR, '1'); p.remove(); });
  }

  window.PFApp = { showSetup: showSetup, showHowTo: showHowTo };

  function addLinks() {
    var foot = document.getElementById('foot');
    if (foot && !foot.querySelector('.cfg-lnk')) {
      var s = el('<span><button type="button" class="cfg-lnk">⚙ Configurar app</button></span>');
      foot.appendChild(s); s.firstChild.addEventListener('click', function () { showSetup(); });
    }
    var rf = document.querySelector('.rail-foot');
    if (rf && !rf.querySelector('.cfg-lnk')) {
      var a = el('<button type="button" class="cfg-lnk" style="text-align:left;color:var(--rail-ink);font-weight:500;text-decoration:none">⚙ Configurar app</button>');
      rf.appendChild(a); a.addEventListener('click', function () { showSetup(); });
    }
  }
  document.addEventListener('DOMContentLoaded', function () {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    if (standalone()) document.documentElement.classList.add('is-app');
    addLinks();
    var foot = document.getElementById('foot');
    if (foot && window.MutationObserver) new MutationObserver(addLinks).observe(foot, { childList: true });
    if (!getCfg() || /[#&]config\b/.test(location.hash)) showSetup();
    else setTimeout(pill, 2500);
  });

  /* app instalável: guarda os arquivos do app no celular para abrir rápido, mesmo sem sinal */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { }); });
  }
})();
