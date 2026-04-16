// ── DvPages — app.js ──

var editor = null;
var currentFilename = '';
var editIdMap = {}; // editId -> {lineStart, col, tagName, textPreview}
var editIdCounter = 0;
var unfunnelActive = false;
var unfunnelDelayMs = null; // null = desativado, 0 = instantâneo, N = ms máximo
var selectedEditId = null;
var selectedTagName = '';
var _history = []; // pilha de snapshots para desfazer
var _historyMax = 50;

// ── HISTÓRICO / DESFAZER ──
function pushHistory() {
  var html = editor ? editor.getValue() : null;
  if (!html) return;
  // Evita duplicata: não salva se igual ao topo
  if (_history.length && _history[_history.length - 1] === html) return;
  _history.push(html);
  if (_history.length > _historyMax) _history.shift();
  updateUndoBtn();
}

function undo() {
  if (_history.length === 0) { setStatus('Nada para desfazer', ''); return; }
  var prev = _history.pop();
  editor.setValue(prev, -1);
  syncPreview(prev);
  updateUndoBtn();
  setStatus('Desfeito', 'ok');
}

function updateUndoBtn() {
  var btn = document.getElementById('btn-undo');
  if (!btn) return;
  btn.disabled = _history.length === 0;
  btn.title = _history.length === 0 ? 'Nada para desfazer' : 'Desfazer (' + _history.length + ' passo' + (_history.length > 1 ? 's' : '') + ')';
}

// ── BOOT ──
document.addEventListener('DOMContentLoaded', function () {
  initAce();
  initDropzone();
  initPreviewMessages();
  initPasteShortcut();
});

// ── PASTE PANEL ──
function showPastePanel() {
  var panel = document.getElementById('paste-panel');
  panel.style.display = 'flex';
  setTimeout(function() { document.getElementById('paste-input').focus(); }, 50);
}

function hidePastePanel() {
  document.getElementById('paste-panel').style.display = 'none';
}

function loadFromPaste() {
  var html = document.getElementById('paste-input').value.trim();
  if (!html) return;
  hidePastePanel();
  pushHistory();
  currentFilename = 'pagina.html';
  document.getElementById('filename-badge').value = currentFilename;
  var processed = injectEditIds(html);
  editor.setValue(processed, -1);
  syncPreview(processed);
  showEditor();
  setStatus('HTML carregado', 'ok');
}

function initPasteShortcut() {
  document.addEventListener('keydown', function(e) {
    // Nunca interceptar se o foco está dentro da textarea de paste
    if (e.target && e.target.id === 'paste-input') return;
    var dropzone = document.getElementById('dropzone');
    if (!dropzone.classList.contains('hidden') && e.ctrlKey && e.key === 'v') {
      e.preventDefault();
      showPastePanel();
    }
    // Ctrl+Z fora do editor Ace (o Ace já tem o próprio undo)
    if (e.ctrlKey && e.key === 'z' && e.target && e.target.id !== 'ace-editor') {
      var main = document.getElementById('main');
      if (!main.classList.contains('hidden')) {
        e.preventDefault();
        undo();
      }
    }
  });
}

// ── ACE EDITOR ──
function initAce() {
  editor = ace.edit('ace-editor');
  editor.setTheme('ace/theme/one_dark');
  editor.session.setMode('ace/mode/html');
  editor.setOptions({
    fontSize: '13px',
    showPrintMargin: false,
    enableBasicAutocompletion: true,
    enableLiveAutocompletion: false,
    wrap: false,
    tabSize: 2,
  });

  // Live preview update on edit (debounced)
  var previewTimer = null;
  editor.session.on('change', function () {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      syncPreview(editor.getValue());
    }, 600);
  });
}

// ── DROPZONE ──
function initDropzone() {
  var card = document.getElementById('drop-card');
  var fileInput = document.getElementById('file-input');

  card.addEventListener('dragover', function (e) {
    e.preventDefault();
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', function () {
    card.classList.remove('drag-over');
  });
  card.addEventListener('drop', function (e) {
    e.preventDefault();
    card.classList.remove('drag-over');
    var file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });

  fileInput.addEventListener('change', function (e) {
    if (e.target.files[0]) uploadFile(e.target.files[0]);
  });

  // toolbar open
  var fileInput2 = document.getElementById('file-input2');
  fileInput2.addEventListener('change', function (e) {
    if (e.target.files[0]) uploadFile(e.target.files[0]);
  });
}

// ── UPLOAD FILE ──
function uploadFile(file) {
  setStatus('Carregando...', '');
  var reader = new FileReader();
  reader.onload = function(e) {
    pushHistory();
    currentFilename = file.name;
    document.getElementById('filename-badge').value = file.name;
    var html = injectEditIds(e.target.result);
    editor.setValue(html, -1);
    syncPreview(html);
    showEditor();
    setStatus('Arquivo carregado', 'ok');
  };
  reader.onerror = function() { setStatus('Erro ao ler arquivo', 'err'); };
  reader.readAsText(file, 'utf-8');
}

function showEditor() {
  document.getElementById('dropzone').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
  var bridge = document.getElementById('ai-bridge');
  var btn = document.getElementById('btn-ai-bridge');
  if (bridge && bridge.classList.contains('hidden')) {
    bridge.classList.remove('hidden');
    if (btn) btn.classList.add('active');
  }
  var badge = document.getElementById('filename-badge');
  if (badge) badge.removeAttribute('readonly');
}

function renameFile(val) {
  val = val.trim();
  if (!val) val = currentFilename || 'pagina.html';
  if (!val.match(/\.html?$/i)) val += '.html';
  currentFilename = val;
  document.getElementById('filename-badge').value = val;
  setStatus('Renomeado para ' + val, 'ok');
  setTimeout(function() { setStatus('', ''); }, 2000);
}

// ── INJECT EDIT IDS ──
// Assigns data-edit-id to each HTML element opening tag
// Also builds editIdMap with line/col positions
function injectEditIds(htmlStr) {
  editIdMap = {};
  editIdCounter = 0;

  var lines = htmlStr.split('\n');
  // Build cumulative char offsets per line
  var lineOffsets = [0];
  for (var i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }

  function charToPos(charIdx) {
    for (var ln = 0; ln < lineOffsets.length - 1; ln++) {
      if (charIdx < lineOffsets[ln + 1]) {
        return { row: ln, col: charIdx - lineOffsets[ln] };
      }
    }
    return { row: lines.length - 1, col: 0 };
  }

  // Replace each opening tag, tracking positions
  var result = '';
  var lastIndex = 0;
  var tagRegex = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+(?:[^"'>\/]|"[^"]*"|'[^']*')*)*)(\s*\/?>)/g;
  var match;

  while ((match = tagRegex.exec(htmlStr)) !== null) {
    var tagName = match[1].toLowerCase();
    // Skip void elements and script/style content tags that shouldn't be selected
    if (['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'].indexOf(tagName) !== -1) {
      continue;
    }

    var id = editIdCounter++;
    var pos = charToPos(match.index);

    // Extract text preview from nearby context
    editIdMap[id] = {
      row: pos.row,
      col: pos.col,
      tagName: tagName,
      charIndex: match.index
    };

    // We need to insert data-edit-id into the tag
    // match[0] is the full match, match[1] tag name, match[2] attrs, match[3] closing
    var newTag = '<' + match[1] + match[2] + ' data-edit-id="' + id + '"' + match[3];
    result += htmlStr.slice(lastIndex, match.index) + newTag;
    lastIndex = match.index + match[0].length;

    // Recalculate offsets after insertion (track offset delta)
    // Actually we just build result, positions refer to ORIGINAL string
  }
  result += htmlStr.slice(lastIndex);
  return result;
}

// ── UNFUNNELIZER ──
function toggleUnfunnelizer() {
  if (unfunnelActive) {
    // Desativar
    unfunnelActive = false;
    unfunnelDelayMs = null;
    document.getElementById('btn-unfunnel').classList.remove('active');
    syncPreview(editor.getValue());
    setStatus('Delays restaurados', '');
  } else {
    // Ativar
    var input = document.getElementById('unfunnel-delay');
    var val = input.value.trim();
    unfunnelDelayMs = (val === '') ? 0 : Math.max(0, parseFloat(val) * 1000);
    unfunnelActive = true;
    document.getElementById('btn-unfunnel').classList.add('active');
    syncPreview(editor.getValue());
    var label = unfunnelDelayMs === 0 ? 'instantâneo' : (val + 's');
    setStatus('Unfunnelizado — ' + label, 'ok');
  }
}

function buildUnfunnelizerScript(maxMs) {
  var isInstant = (maxMs === 0);

  // CSS: modo instantâneo remove durations também (CSS animations completam em 1ms)
  var css = isInstant
    ? '*, *::before, *::after { animation-delay: 0s !important; animation-duration: 0.001s !important; transition-delay: 0s !important; transition-duration: 0.001s !important; }'
    : '*, *::before, *::after { animation-delay: 0s !important; transition-delay: 0s !important; }';

  // Cálculo do delay para setTimeout override:
  // - Modo instantâneo: delays longos (>500ms) viram 100ms. Curtos ficam como estão.
  //   Isso evita loop infinito em funções que se re-agendam (ex: waitForPlayer a cada 300ms).
  // - Modo simulação: limita ao máximo configurado
  var delayCalc = isInstant
    ? '(+(delay)||0) > 500 ? 100 : (+(delay)||0)'
    : 'Math.min(+(delay)||0, _max)';

  // Force-reveal: para modo instantâneo, força visibilidade de elementos delayed
  // no DOMContentLoaded. Necessário porque o player de vídeo não inicializa no
  // sandbox do iframe, então os eventos de 'play' nunca disparam.
  var forceRevealLines = isInstant ? [
    '  function _forceReveal() {',
    '    var sel = \'#delayed, .delayed, [id*="delay"], [class*="delay"]\';',
    '    var els = document.querySelectorAll(sel);',
    '    for (var i = 0; i < els.length; i++) {',
    '      var el = els[i];',
    '      el.style.display = "block";',
    '      el.style.opacity = "1";',
    '      el.style.visibility = "visible";',
    '    }',
    '  }',
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", _forceReveal);',
    '  } else { _oST(_forceReveal, 0); }',
  ] : [];

  return [
    '<script id="__unfunnelizer__">',
    '(function() {',
    '  var _max = ' + maxMs + ';',
    '  var _oST = window.setTimeout;',
    '  var _oSI = window.setInterval;',
    '  window.setTimeout = function(fn, delay) {',
    '    var a = Array.prototype.slice.call(arguments, 2);',
    '    var d = ' + delayCalc + ';',
    '    return _oST.apply(window, [fn, d].concat(a));',
    '  };',
    '  window.setInterval = function(fn, delay) {',
    '    var a = Array.prototype.slice.call(arguments, 2);',
    '    return _oSI.apply(window, [fn, +(delay)||0].concat(a));',
    '  };',
  ].concat(forceRevealLines).concat([
    '  function _injectCss() {',
    '    var s = document.createElement("style");',
    '    s.id = "__unfunnel_css__";',
    '    s.textContent = "' + css.replace(/"/g, '\\"') + '";',
    '    (document.head || document.documentElement).appendChild(s);',
    '  }',
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", _injectCss);',
    '  } else { _injectCss(); }',
    '})();',
    '<\/script>'
  ]).join('\n');
}

function injectAtHeadStart(html, script) {
  // Case-insensitive: suporta <head>, <HEAD>, <Head lang="..."> etc.
  var headMatch = html.match(/<head(\s[^>]*)?>/i);
  if (headMatch) {
    var idx = html.indexOf(headMatch[0]) + headMatch[0].length;
    return html.slice(0, idx) + '\n' + script + '\n' + html.slice(idx);
  }
  var bodyMatch = html.match(/<body(\s[^>]*)?>/i);
  if (bodyMatch) {
    var idx2 = html.indexOf(bodyMatch[0]) + bodyMatch[0].length;
    return html.slice(0, idx2) + '\n' + script + '\n' + html.slice(idx2);
  }
  return script + '\n' + html;
}

// ── SYNC PREVIEW ──
function syncPreview(html) {
  var result = html;
  if (unfunnelActive && unfunnelDelayMs !== null) {
    result = injectAtHeadStart(result, buildUnfunnelizerScript(unfunnelDelayMs));
  }
  var injected = injectInteractionScript(result);
  var frame = document.getElementById('preview-frame');
  frame.srcdoc = injected;
}

function injectInteractionScript(html) {
  var script = [
    '<script id="__pagelens_script__">',
    '(function() {',
    '  var _sel = null, _hov = null;',
    '  function getClean(el) {',
    '    var c = el.cloneNode(true);',
    '    c.removeAttribute("data-edit-id");',
    '    c.querySelectorAll("[data-edit-id]").forEach(function(x){x.removeAttribute("data-edit-id");});',
    '    ["outline","outlineOffset","outline-offset"].forEach(function(p){c.style[p]="";});',
    '    return c.outerHTML;',
    '  }',
    '  function buildCrumbs(el) {',
    '    var path = [];',
    '    var cur = el;',
    '    while (cur && cur.tagName && cur.tagName !== "HTML") {',
    '      var s = cur.tagName.toLowerCase();',
    '      if (cur.id) s += "#" + cur.id;',
    '      else if (cur.className && typeof cur.className === "string") {',
    '        var cls = cur.className.trim().split(/\\s+/).slice(0,2).join(".");',
    '        if (cls) s += "." + cls;',
    '      }',
    '      path.unshift({label: s, editId: cur.getAttribute("data-edit-id")});',
    '      cur = cur.parentElement;',
    '    }',
    '    return path;',
    '  }',
    '  document.addEventListener("mouseover", function(e) {',
    '    if (_hov && _hov !== _sel) { _hov.style.outline=""; }',
    '    if (e.target !== _sel && e.target.tagName !== "HTML" && e.target.tagName !== "BODY") {',
    '      e.target.style.outline = "2px dashed #3b82f6";',
    '    }',
    '    _hov = e.target;',
    '  }, true);',
    '  document.addEventListener("mouseout", function(e) {',
    '    if (e.target !== _sel) e.target.style.outline = "";',
    '  }, true);',
    '  document.addEventListener("click", function(e) {',
    '    if (e.target.tagName === "A") e.preventDefault();',
    '    if (_sel) _sel.style.outline = "";',
    '    _sel = e.target;',
    '    _sel.style.outline = "2px solid #e94560";',
    '    var editId = e.target.getAttribute("data-edit-id");',
    '    window.parent.postMessage({',
    '      type: "elementSelected",',
    '      editId: editId,',
    '      tagName: e.target.tagName,',
    '      textPreview: (e.target.textContent||"").trim().substring(0,80),',
    '      crumbs: buildCrumbs(e.target)',
    '    }, "*");',
    '    e.stopPropagation();',
    '  }, true);',
    '})();',
    '<\/script>'
  ].join('\n');

  if (html.indexOf('</body>') !== -1) {
    return html.replace('</body>', script + '</body>');
  }
  return html + script;
}

// ── RECEIVE MESSAGES FROM IFRAME ──
function initPreviewMessages() {
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'elementSelected') return;
    var editId = e.data.editId;
    var tagName = (e.data.tagName || '').toLowerCase();
    var crumbs = e.data.crumbs || [];

    // Armazena para o AI Bridge
    selectedEditId = editId;
    selectedTagName = tagName;
    updateBridgeSelection(crumbs);

    // Update breadcrumb
    updateBreadcrumb(crumbs);

    // Jump editor to element
    if (editId !== null && editIdMap[editId]) {
      jumpEditorTo(editIdMap[editId]);
    }
  });
}

// ── AI BRIDGE ──
function toggleAiBridge() {
  var panel = document.getElementById('ai-bridge');
  var btn = document.getElementById('btn-ai-bridge');
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    btn.classList.add('active');
    document.getElementById('aib-instruction').focus();
  } else {
    panel.classList.add('hidden');
    btn.classList.remove('active');
  }
}

function updateBridgeSelection(crumbs) {
  var el = document.getElementById('aib-element-info');
  if (!el) return;
  if (crumbs && crumbs.length > 0) {
    el.textContent = crumbs.map(function(c){ return c.label; }).join(' › ');
    el.className = 'aib-element active';
    // Re-insere o dot
    var dot = document.createElement('span');
    dot.className = 'aib-dot';
    el.insertBefore(dot, el.firstChild);
  }
}

// Encontra os limites do elemento no HTML pelo data-edit-id
function findElementBounds(html, editId, tagName) {
  var searchStr = 'data-edit-id="' + editId + '"';
  var attrPos = html.indexOf(searchStr);
  if (attrPos === -1) return null;

  var openStart = html.lastIndexOf('<', attrPos);
  if (openStart === -1) return null;

  var openEnd = html.indexOf('>', attrPos);
  if (openEnd === -1) return null;
  openEnd += 1;

  // Self-closing ou void element
  var voids = ['br','hr','img','input','meta','link','area','base','col','embed','param','source','track','wbr'];
  if (html[openEnd - 2] === '/' || voids.indexOf(tagName) !== -1) {
    return { start: openStart, end: openEnd };
  }

  // Conta profundidade para achar o fechamento correto
  var openTag = '<' + tagName;
  var closeTag = '</' + tagName;
  var depth = 1;
  var pos = openEnd;

  while (depth > 0 && pos < html.length) {
    var nextOpen = html.indexOf(openTag, pos);
    var nextClose = html.indexOf(closeTag, pos);

    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Confirma que é a mesma tag (não <divx> ao buscar <div)
      var ch = html[nextOpen + openTag.length];
      if (ch === ' ' || ch === '>' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '/') {
        depth++;
      }
      pos = nextOpen + 1;
    } else {
      depth--;
      if (depth === 0) {
        var closeEnd = html.indexOf('>', nextClose);
        if (closeEnd === -1) break;
        return { start: openStart, end: closeEnd + 1 };
      }
      pos = nextClose + 1;
    }
  }
  return null;
}

function getCleanElementHtml(editId, tagName) {
  var html = editor.getValue();
  var bounds = findElementBounds(html, editId, tagName);
  if (!bounds) return '';
  return html.slice(bounds.start, bounds.end)
             .replace(/\s+data-edit-id="[^"]*"/g, '');
}

function prepareBridgePrompt() {
  var instruction = document.getElementById('aib-instruction').value.trim();
  if (!instruction) { setStatus('Digite uma instrução primeiro', 'err'); return; }
  if (!selectedEditId) { setStatus('Clique em um elemento no preview primeiro', 'err'); return; }

  var elementHtml = getCleanElementHtml(selectedEditId, selectedTagName);
  if (!elementHtml) { setStatus('Elemento não encontrado no código', 'err'); return; }

  var prompt = [
    'Você é especialista em HTML/CSS. Edite APENAS o elemento abaixo conforme a instrução.',
    'Retorne SOMENTE o HTML modificado, sem explicações, sem markdown, sem ```html.',
    '',
    'INSTRUÇÃO: ' + instruction,
    '',
    'ELEMENTO ATUAL:',
    elementHtml
  ].join('\n');

  // Copia pro clipboard
  var ta = document.createElement('textarea');
  ta.value = prompt;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch(e) {}
  document.body.removeChild(ta);

  setStatus('Prompt copiado! Abra uma IA acima, cole e traga o resultado aqui.', 'ok');
  document.getElementById('aib-result').focus();
}

function applyBridgeResult() {
  var newHtml = document.getElementById('aib-result').value.trim();
  if (!newHtml) { setStatus('Cole o HTML da IA primeiro', 'err'); return; }
  if (!selectedEditId) { setStatus('Nenhum elemento selecionado', 'err'); return; }

  var current = editor.getValue();
  var bounds = findElementBounds(current, selectedEditId, selectedTagName);
  if (!bounds) { setStatus('Elemento não encontrado — selecione novamente no preview', 'err'); return; }

  pushHistory();
  // Remove data-edit-id do HTML colado (serão re-injetados)
  var cleanNew = newHtml.replace(/\s+data-edit-id="[^"]*"/g, '');
  var updated = current.slice(0, bounds.start) + cleanNew + current.slice(bounds.end);

  var withIds = injectEditIds(updated);
  editor.setValue(withIds, -1);
  syncPreview(withIds);

  document.getElementById('aib-result').value = '';
  document.getElementById('aib-instruction').value = '';
  selectedEditId = null;
  selectedTagName = '';
  var info = document.getElementById('aib-element-info');
  info.textContent = 'Clique em um elemento no preview para selecionar';
  info.className = 'aib-element';
  var dot = document.createElement('span');
  dot.className = 'aib-dot';
  info.insertBefore(dot, info.firstChild);

  setStatus('Elemento atualizado com sucesso', 'ok');
}

// ── JUMP EDITOR TO ELEMENT ──
function jumpEditorTo(info) {
  if (!info) return;
  var row = info.row;
  var col = info.col;
  editor.scrollToLine(row, true, true, function () {});
  editor.selection.moveCursorTo(row, col);
  editor.selection.selectLine();
  editor.focus();
}

// ── BREADCRUMB ──
function updateBreadcrumb(crumbs) {
  var el = document.getElementById('breadcrumb');
  el.innerHTML = '';
  crumbs.forEach(function (crumb, idx) {
    var span = document.createElement('span');
    span.className = 'crumb' + (idx === crumbs.length - 1 ? ' active' : '');
    span.textContent = crumb.label;
    if (crumb.editId && editIdMap[crumb.editId]) {
      span.addEventListener('click', function () {
        jumpEditorTo(editIdMap[crumb.editId]);
      });
    }
    el.appendChild(span);
    if (idx < crumbs.length - 1) {
      var sep = document.createElement('span');
      sep.textContent = ' › ';
      el.appendChild(sep);
    }
  });
}

// ── TOOLBAR ACTIONS ──
function openFile() {
  document.getElementById('file-input2').click();
}

function exportFile() {
  exportDownload();
}

function exportDownload() {
  var html = editor.getValue();
  var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = currentFilename || 'pagina.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  closeExportMenu();
  setStatus('Baixado!', 'ok');
}

function exportCopy() {
  var html = editor.getValue();
  navigator.clipboard.writeText(html).then(function() {
    closeExportMenu();
    setStatus('HTML copiado!', 'ok');
    setTimeout(function() { setStatus('', ''); }, 2500);
  });
}

function exportSave() {
  var html = editor.getValue();
  var filename = currentFilename || 'sem-titulo.html';
  closeExportMenu();
  fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: filename, html: html })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) {
      setStatus('Salvo na nuvem!', 'ok');
      setTimeout(function() { setStatus('', ''); }, 2500);
    } else {
      setStatus('Erro ao salvar', 'err');
    }
  }).catch(function() {
    setStatus('Sem conexão', 'err');
  });
}

// ── MY FILES PANEL ──
function openMyFiles() {
  var panel = document.getElementById('myfiles-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  fetch('/api/files').then(function(r) { return r.json(); }).then(function(files) {
    var list = document.getElementById('myfiles-list');
    if (!list) return;
    if (!files.length) {
      list.innerHTML = '<div class="myfiles-empty">Nenhum arquivo salvo ainda.</div>';
      return;
    }
    list.innerHTML = files.map(function(f) {
      var date = new Date(f.updated_at).toLocaleDateString('pt-BR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
      return '<div class="myfiles-item" onclick="loadCloudFile(\'' + f.id + '\',\'' + f.filename.replace(/'/g,'') + '\')">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
        '<span class="myfiles-name">' + f.filename + '</span>' +
        '<span class="myfiles-date">' + date + '</span>' +
        '</div>';
    }).join('');
  });
}

function closeMyFiles() {
  var panel = document.getElementById('myfiles-panel');
  if (panel) panel.style.display = 'none';
}

function loadCloudFile(id, filename) {
  fetch('/api/load/' + id).then(function(r) { return r.json(); }).then(function(d) {
    if (d.html) {
      pushHistory();
      currentFilename = d.filename || filename;
      document.getElementById('filename-badge').value = currentFilename;
      var processed = injectEditIds(d.html);
      editor.setValue(processed, -1);
      syncPreview(processed);
      showEditor();
      closeMyFiles();
      setStatus('Carregado da nuvem', 'ok');
      setTimeout(function() { setStatus('', ''); }, 2500);
    }
  });
}

function toggleExportMenu(e) {
  e.stopPropagation();
  var wrap = document.getElementById('export-wrap');
  if (wrap) wrap.classList.toggle('open');
}
function closeExportMenu() {
  var wrap = document.getElementById('export-wrap');
  if (wrap) wrap.classList.remove('open');
}
document.addEventListener('click', function(e) {
  var wrap = document.getElementById('export-wrap');
  if (wrap && !wrap.contains(e.target)) closeExportMenu();
});

function forceRefreshPreview() {
  syncPreview(editor.getValue());
  setStatus('Preview atualizado', 'ok');
  setTimeout(function () { setStatus('', ''); }, 2000);
}

// ── STATUS ──
function setStatus(msg, type) {
  var el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = type ? 'status-msg ' + type : 'status-msg';
  if (msg && type === 'ok') {
    setTimeout(function () {
      if (el.textContent === msg) { el.textContent = ''; el.className = 'status-msg'; }
    }, 3000);
  }
}

// ── TEMPLATE MODAL ──
var VSL_TEMPLATE = [
'# VSL / Advertorial HTML — Template Guide',
'',
'> **Como usar:** Cole este arquivo no começo da conversa (ou diga "leia meu guide VSL") antes de pedir uma nova página. Claude deve seguir a estrutura e, principalmente, **reaproveitar o bloco de delay do vídeo** e a **lógica de urgência** — que são as partes que dão trabalho pra reconstruir.',
'',
'> **Sobre visual (cores, fontes, imagens):** tudo é ajustável por produto. Sempre pergunte antes ou deixe o usuário definir. Os defaults aparecem só como referência do que já funcionou.',
'',
'---',
'',
'## 1. Princípios base (sempre seguir)',
'',
'- **HTML único, self-contained.** CSS e JS inline no mesmo arquivo.',
'- **Mobile-first.** `clamp()` em headlines, grids que colapsam pra 1 coluna.',
'- **Zero dependências JS.** Só o player do Converteai + fontes do Google.',
'- **Tracking script da dvsupplements no `<head>`:**',
'  ```html',
'  <script src="https://trk.dvsupplements.com/track.js?rtkcmpid=XXXXX"></script>',
'  ```',
'- **Links de checkout** apontando para `https://trk.dvsupplements.com/click/1`, `/2`, `/3`.',
'',
'---',
'',
'## 2. Anatomia da página (ordem fixa)',
'',
'```',
'1.  Breaking bar (tarja fina no topo)',
'2.  Top image (imagem hero full-width)',
'3.  Headline block (H1 grande + live dot)',
'4.  Video section (vturb-smartplayer)',
'──────── [DELAY — tudo abaixo nasce oculto] ────────',
'5.  Urgency widget (timer + stock)',
'6.  Bottles / pricing (3 cards, "BEST VALUE" no principal)',
'7.  Product info + author quote',
'8.  Guarantee box',
'9.  Ingredients grid',
'10. CTA band #1',
'11. FAQ accordion',
'12. CTA band #2',
'──────── [fim do bloco delayed] ────────',
'13. Artigo jornalístico (sempre visível)',
'14. Quotes band',
'15. FB Comments replica (sempre visível)',
'```',
'',
'**Regra:** vídeo + artigo + FB comments **sempre visíveis**. Tudo entre eles fica no `#delayed`.',
'',
'---',
'',
'## 3. ⚠️ CRÍTICO — Delay do vídeo Converteai / vturb-smartplayer',
'',
'O player `<vturb-smartplayer>` tem comportamento imprevisível: às vezes expõe `window.smartplayer.instances`, às vezes só um `<video>` no shadow DOM. Por isso precisa de **4 camadas de fallback**. **Nunca simplificar** — já testamos, quebra.',
'',
'### HTML',
'```html',
'<vturb-smartplayer id="ab-XXXXXXXXXX" style="display:block;margin:0 auto;width:100%;"></vturb-smartplayer>',
'',
'<script>',
'var s=document.createElement("script");',
's.src="https://scripts.converteai.net/XXXXX/ab-test/XXXXX/player.js",',
's.async=!0,document.head.appendChild(s);',
'</script>',
'',
'<div id="delayed" class="delayed">',
'  <!-- urgency, bottles, FAQ, etc -->',
'</div>',
'',
'<style>',
'.delayed{display:none;opacity:0;transition:opacity .9s ease;}',
'.delayed.show{display:block;opacity:1;}',
'</style>',
'```',
'',
'### JS — copiar literal (dentro de um IIFE)',
'```js',
'(function(){',
'  var fired=false;',
'  var DELAY=2700000; // 45min produção | 10000 = 10s teste',
'',
'  function reveal(){',
'    if(fired)return; fired=true;',
'    var el=document.getElementById(\'delayed\');',
'    el.style.display=\'block\';',
'    setTimeout(function(){el.style.opacity=\'1\';},60);',
'    initUrgency();',
'  }',
'  function scheduleReveal(){ if(!fired) setTimeout(reveal,DELAY); }',
'',
'  // CAMADA 1 — API oficial Converteai',
'  (function waitForPlayer(){',
'    var sp=window.smartplayer;',
'    if(sp && sp.instances && sp.instances.length>0){',
'      var p=sp.instances[0];',
'      if(typeof p.on===\'function\'){',
'        p.on(\'play\', scheduleReveal);',
'        p.on(\'playing\', scheduleReveal);',
'        p.on(\'timeupdate\', function(){ if(!fired) scheduleReveal(); });',
'        return;',
'      }',
'    }',
'    setTimeout(waitForPlayer,300);',
'  })();',
'',
'  // CAMADA 2 — MutationObserver pro <video> no shadow DOM',
'  function watchVideo(v){',
'    if(!v||v._w)return; v._w=true;',
'    v.addEventListener(\'play\', scheduleReveal);',
'    v.addEventListener(\'playing\', scheduleReveal);',
'  }',
'  new MutationObserver(function(muts){',
'    muts.forEach(function(m){',
'      m.addedNodes.forEach(function(n){',
'        if(!n||n.nodeType!==1)return;',
'        if(n.tagName===\'VIDEO\') watchVideo(n);',
'        else n.querySelectorAll(\'video\').forEach(watchVideo);',
'      });',
'    });',
'  }).observe(document.documentElement,{childList:true,subtree:true});',
'',
'  // CAMADA 3 — polling 400ms checando currentTime direto',
'  var pc=0;',
'  var poll=setInterval(function(){',
'    pc++;',
'    var vturb=document.querySelector(\'vturb-smartplayer\');',
'    var v=null;',
'    if(vturb){',
'      if(vturb.shadowRoot) v=vturb.shadowRoot.querySelector(\'video\');',
'      if(!v) v=vturb.querySelector(\'video\');',
'    }',
'    if(!v) v=document.querySelector(\'video\');',
'    if(v){',
'      watchVideo(v);',
'      if(!v.paused && !v.ended && v.currentTime>1) scheduleReveal();',
'    }',
'    var sp=window.smartplayer;',
'    if(sp && sp.instances && sp.instances.length>0){',
'      var p=sp.instances[0];',
'      if(p && typeof p.on===\'function\' && !p._hooked){',
'        p._hooked=true;',
'        p.on(\'play\', scheduleReveal);',
'        p.on(\'playing\', scheduleReveal);',
'        p.on(\'timeupdate\', function(){ if(!fired) scheduleReveal(); });',
'      }',
'    }',
'    if(pc>600) clearInterval(poll);',
'  },400);',
'',
'  // CAMADA 4 — eventos nativos capturing + postMessage',
'  document.addEventListener(\'play\', function(e){ if(e.target.tagName===\'VIDEO\') scheduleReveal(); },true);',
'  document.addEventListener(\'playing\', function(e){ if(e.target.tagName===\'VIDEO\') scheduleReveal(); },true);',
'  window.addEventListener(\'message\',function(e){',
'    try{',
'      var d=typeof e.data===\'string\'?JSON.parse(e.data):e.data;',
'      if(!d)return;',
'      var ev=d.event||d.type||d.eventName||(d.data&&d.data.event)||\'\';\',',
'      var act=d.action||(d.data&&d.data.action)||\'\';\',',
'      if(ev===\'play\'||ev===\'playing\'||ev===\'started\'||act===\'play\') scheduleReveal();',
'    }catch(e){}',
'  });',
'',
'  // initUrgency() — ver seção 4',
'})();',
'```',
'',
'**Regras:**',
'- `DELAY=2700000` em produção, `10000` em teste.',
'- Manter TODAS as 4 camadas.',
'- `initUrgency()` só roda após o reveal (não gastar sessionStorage antes).',
'',
'---',
'',
'## 4. Urgency widget (timer + stock fake)',
'',
'HTML com IDs `vw-date`, `vw-h`, `vw-m`, `vw-s`, `vw-stock`, `vw-bar`, `vw-warn`.',
'',
'```js',
'function initUrgency(){',
'  var now=new Date(),et=new Date(now.toLocaleString(\'en-US\',{timeZone:\'America/New_York\'}));',
'  document.getElementById(\'vw-date\').textContent=',
'    String(et.getMonth()+1).padStart(2,\'0\')+\'/\'+String(et.getDate()).padStart(2,\'0\');',
'',
'  var TK=\'vsl_end_v6\',end;',
'  try{end=parseInt(sessionStorage.getItem(TK))||0;}catch(e){end=0;}',
'  if(!end||end<Date.now()){ end=Date.now()+8460000; try{sessionStorage.setItem(TK,end);}catch(e){} }',
'  function tick(){',
'    var d=Math.max(0,Math.floor((end-Date.now())/1000));',
'    if(d<=0){ end=Date.now()+(1800+Math.random()*900)*1000; try{sessionStorage.setItem(TK,end);}catch(e){} d=Math.floor((end-Date.now())/1000); }',
'    document.getElementById(\'vw-h\').textContent=String(Math.floor(d/3600)).padStart(2,\'0\');',
'    document.getElementById(\'vw-m\').textContent=String(Math.floor((d%3600)/60)).padStart(2,\'0\');',
'    document.getElementById(\'vw-s\').textContent=String(d%60).padStart(2,\'0\');',
'  }',
'  setInterval(tick,1000); tick();',
'',
'  var SK=\'vsl_stk_v6\',NK=\'vsl_nxt_v6\',PK=\'vsl_ph_v6\';',
'  var MAX=119,THR=38,MIN=7,stock,nxt,phase;',
'  try{stock=parseInt(sessionStorage.getItem(SK));nxt=parseInt(sessionStorage.getItem(NK));phase=parseInt(sessionStorage.getItem(PK));}catch(e){}',
'  if(!stock||isNaN(stock))stock=MAX;',
'  if(!phase||isNaN(phase))phase=(stock>THR)?1:2;',
'  if(!nxt||isNaN(nxt)||nxt<Date.now())nxt=Date.now()+gi();',
'  function gi(){',
'    if(phase===1) return 1300+Math.random()*700;',
'    var r=stock/THR;',
'    if(r>0.7) return 28000+Math.random()*14000;',
'    if(r>0.4) return 65000+Math.random()*35000;',
'    if(r>0.2) return 130000+Math.random()*70000;',
'    return 260000+Math.random()*140000;',
'  }',
'  function da(){ return phase===1?(Math.floor(Math.random()*2)+2):1; }',
'  function rs(){',
'    var el=document.getElementById(\'vw-stock\'),bar=document.getElementById(\'vw-bar\'),w=document.getElementById(\'vw-warn\');',
'    el.textContent=stock;',
'    el.classList.toggle(\'vw-low\',stock<=20);',
'    bar.style.width=Math.max(5,(stock/MAX)*100)+\'%\';',
'    if(stock<=15) w.textContent=\'Last units — almost sold out!\';',
'    else if(stock<=THR) w.textContent=\'Critical — reserving fast!\';',
'    else w.textContent=\'Units being reserved right now\';',
'    try{sessionStorage.setItem(SK,stock);sessionStorage.setItem(NK,nxt);sessionStorage.setItem(PK,phase);}catch(e){}',
'  }',
'  function cs(){',
'    if(Date.now()<nxt||stock<=MIN)return;',
'    if(phase===1&&stock<=THR) phase=2;',
'    stock=Math.max(MIN,stock-da());',
'    nxt=Date.now()+gi();',
'    rs();',
'  }',
'  rs(); setInterval(cs,500);',
'}',
'```',
'',
'**⚠️ Bumpar as chaves** (`_v6` → `_v7`) toda vez que mudar `MAX/THR/MIN`.',
'',
'---',
'',
'## 5. Outros padrões reaproveitáveis',
'',
'### Bottles/pricing',
'3 cards, mobile colapsa pra 1 coluna. Ordem: **6 bottles (best value) → 3 bottles → 2 bottles**. Selo "BEST VALUE" via `::before` no card principal.',
'',
'### FAQ accordion (zero dep)',
'```html',
'<div class="faq-q" onclick="toggleFaq(this)">Pergunta? <span class="arr">▼</span></div>',
'<div class="faq-a">Resposta.</div>',
'```',
'```js',
'window.toggleFaq=function(q){ q.classList.toggle(\'open\'); q.nextElementSibling.classList.toggle(\'open\'); };',
'```',
'',
'### FB Comments replica',
'- Cabeçalho azul FB `#1877F2` com SVG do F',
'- **Avatares em base64 JPEG inline** (URLs externas quebram)',
'- Respostas indentadas: `.fi.rep { padding-left:44px }` + avatar 28px',
'- `@Nome` vira `<b>` azul FB',
'- Botão Like vira azul quando clicado:',
'```js',
'window.lt=function(btn){',
'  var it=btn.closest(\'.fi\'), cn=it.querySelector(\'.lkn\'), b=parseInt(cn.getAttribute(\'data-c\'));',
'  if(btn.classList.contains(\'on\')){ btn.classList.remove(\'on\'); btn.textContent=\'Like\'; cn.textContent=b; }',
'  else{ btn.classList.add(\'on\'); btn.textContent=\'Liked\'; cn.textContent=b+1; }',
'};',
'```',
'',
'### CTA band (botão pulsante)',
'```css',
'@keyframes py{0%,100%{box-shadow:0 0 0 0 rgba(245,200,0,.55)}65%{box-shadow:0 0 0 14px rgba(245,200,0,0)}}',
'.cta-btn{animation:py 2.5s ease-in-out infinite;}',
'```',
'',
'---',
'',
'## 6. Defaults visuais (só referência — ajustar por produto)',
'',
'- **Dourado/amarelo destaque:** `#f5c800` (botões, preços, timer)',
'- **Dourado suave:** `#c9a84c` (bordas)',
'- **Preto seções dark:** `#0d0d0d`',
'- **Vermelho breaking:** `#c0392b`',
'- **Verde shipping:** `#4caf50`',
'- **Fonts Google:** `Playfair Display`, `Bebas Neue`, `Barlow Condensed`, `Barlow`',
'',
'---',
'',
'## 7. Checklist antes de entregar',
'',
'- [ ] Tracking script no `<head>` com `rtkcmpid` correto',
'- [ ] `DELAY=2700000` (não deixar em teste!)',
'- [ ] 4 camadas de detecção de play presentes',
'- [ ] sessionStorage keys bumpadas se mudou MAX/THR/MIN',
'- [ ] Links dos botões em `/click/1`, `/2`, `/3`',
'- [ ] Artigo + FB comments FORA do `#delayed`',
'- [ ] Urgency + bottles + FAQ DENTRO do `#delayed`',
'- [ ] Avatares FB em base64 inline',
'- [ ] Mobile testado',
'',
'---',
'',
'## 8. Variáveis por produto (pergunta ao usuário)',
'',
'Quando for criar um VSL novo, confirma com o usuário:',
'',
'- Nome do produto',
'- Tema visual / cor principal',
'- Preços dos 3 packs + preços riscados',
'- Manchete "breaking"',
'- Nome do autor/doutor + citação',
'- Lista de ingredientes (8 cards)',
'- `rtkcmpid` (tracking)',
'- `ab-XXXXX` (ID do player Converteai)',
'- Imagens (hero, 3 bottles em ângulos, payment methods) — pode sugerir se não tiver'
].join('\n');

function showTemplateModal() {
  var modal = document.getElementById('template-modal');
  var ta = document.getElementById('template-content');
  ta.value = VSL_TEMPLATE;
  modal.classList.remove('hidden');
  ta.scrollTop = 0;
}

function hideTemplateModal() {
  document.getElementById('template-modal').classList.add('hidden');
  document.getElementById('tpl-copy-msg').textContent = '';
}

function copyTemplate() {
  var ta = document.getElementById('template-content');
  ta.select();
  var ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {}
  if (!ok && navigator.clipboard) {
    navigator.clipboard.writeText(ta.value);
    ok = true;
  }
  var msg = document.getElementById('tpl-copy-msg');
  msg.textContent = ok ? 'Copiado! Cole no início da conversa com o Claude.' : 'Selecione o texto manualmente e copie.';
  setTimeout(function() { msg.textContent = ''; }, 4000);
}

// ── KEYBOARD SHORTCUTS ──
document.addEventListener('keydown', function (e) {
  if (e.key === 'F5') {
    e.preventDefault();
    forceRefreshPreview();
  }
  if (e.key === 'Escape') {
    document.getElementById('template-modal').classList.add('hidden');
    var bridge = document.getElementById('ai-bridge');
    if (bridge && !bridge.classList.contains('hidden')) toggleAiBridge();
    closeUserMenu();
  }
});

// ── USER MENU ──
function toggleUserMenu() {
  var menu = document.getElementById('user-menu');
  if (!menu) return;
  menu.classList.toggle('open');
}
function closeUserMenu() {
  var menu = document.getElementById('user-menu');
  if (menu) menu.classList.remove('open');
}
document.addEventListener('click', function(e) {
  var menu = document.getElementById('user-menu');
  if (menu && !menu.contains(e.target)) closeUserMenu();
});
