/* AlexMenus web editor — vanilla JS SPA (js-yaml v4 is the only external dep).
 *
 * DATA FLOW
 *   load:  #k=<code>&w=<worker-url>  ->  GET <w>/<k>  ->  bundle {v,menus:[{id,yaml}]}
 *          -> jsyaml.load(each yaml) -> plain JS objects held in state.menus[i].obj
 *   edit:  the structured UI (grid + slot editor) and the raw-YAML textarea mutate obj
 *   save:  jsyaml.dump(each obj) -> bundle {v:1,menus:[{id,yaml}]} -> POST <w>/post
 *          -> { key } -> show "/am apply <key>"
 * The only network calls are that initial GET and the save POST. Everything else is client-side.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ constants
  const ICON_BASE = 'https://assets.mcasset.cloud/1.21.11/assets/minecraft/textures/';
  const BUNDLE_VERSION = 1;

  // click-kind id -> Russian label
  const CLICK_KINDS = [
    ['left', 'ЛКМ'], ['right', 'ПКМ'], ['middle', 'СКМ'],
    ['shift_left', 'Shift+ЛКМ'], ['shift_right', 'Shift+ПКМ'],
    ['drop', 'Выброс (Q)'], ['any', 'Любой клик']
  ];

  // common item-flags exposed as checkboxes (hide-all handled separately)
  const HIDE_FLAGS = [
    'HIDE_ATTRIBUTES', 'HIDE_ENCHANTS', 'HIDE_UNBREAKABLE', 'HIDE_ADDITIONAL_TOOLTIP',
    'HIDE_DYE', 'HIDE_ARMOR_TRIM', 'HIDE_DESTROYS', 'HIDE_PLACED_ON'
  ];

  // action type -> Russian label (order = <select> order)
  const ACTION_TYPES = [
    ['run_command', 'Команда'], ['message', 'Сообщение'], ['open_menu', 'Открыть меню'],
    ['sound', 'Звук'], ['give_item', 'Выдать предмет'], ['refresh', 'Обновить'],
    ['close', 'Закрыть'], ['back', 'Назад'], ['conditional', 'Условие (JSON)']
  ];

  // ------------------------------------------------------------------ state
  const state = {
    workerBase: '',   // decoded Worker base URL (from hash `w`)
    code: '',         // paste code (from hash `k`)
    menus: [],        // [{ id, obj }]  — obj = parsed menu object
    sel: -1,          // index of the selected menu
    slot: null,       // selected slot index (int) or null
    raw: false        // raw-YAML mode active?
  };

  // ------------------------------------------------------------------ tiny DOM helpers
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  const current = () => (state.sel >= 0 ? state.menus[state.sel] : null);

  // ================================================================== INIT
  function init() {
    wireStaticUi();
    const hash = parseHash();
    if (!hash.k || !hash.w) {
      // No link params -> friendly empty state explaining how to open the editor.
      show('empty-state');
      return;
    }
    state.code = hash.k;
    state.workerBase = hash.w;
    loadBundle();
  }

  // Parse location.hash: `#k=<code>&w=<worker-url-encoded>`
  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    const p = new URLSearchParams(raw);
    let w = p.get('w') || '';
    try { w = decodeURIComponent(w); } catch (e) { /* already decoded */ }
    w = w.replace(/\/+$/, ''); // trim trailing slash
    return { k: (p.get('k') || '').trim(), w: w.trim() };
  }

  // show exactly one of the top-level views; the editor view = topbar + layout together
  function show(view) {
    $('empty-state').hidden = view !== 'empty-state';
    $('loading').hidden = view !== 'loading';
    const editor = view === 'editor';
    $('topbar').hidden = !editor;
    $('layout').hidden = !editor;
  }

  // ================================================================== LOAD  (GET <w>/<k>)
  async function loadBundle() {
    show('loading');
    try {
      const res = await fetch(state.workerBase + '/' + state.code, { method: 'GET' });
      if (res.status === 404) return failLoad('Код истёк или неверный. Запроси новую ссылку через /am editor.');
      if (!res.ok) return failLoad('Сервер вернул ошибку ' + res.status + '. Попробуй ещё раз.');

      const bundle = await res.json();
      const list = (bundle && Array.isArray(bundle.menus)) ? bundle.menus : [];
      state.menus = list.map((m) => ({ id: String(m.id), obj: safeLoad(m.yaml, m.id) }));

      if (!state.menus.length) return failLoad('В бандле нет меню. Создай меню кнопкой «＋».', true);

      state.sel = 0;
      state.slot = null;
      show('editor');
      renderAll();
    } catch (e) {
      failLoad('Не удалось связаться с сервером (сеть/CORS). ' + (e && e.message ? e.message : ''));
    }
  }

  // parse one menu's yaml string; on failure return {} and warn (raw mode can still fix it)
  function safeLoad(yaml, id) {
    try {
      const o = jsyaml.load(yaml || '');
      return (o && typeof o === 'object') ? o : {};
    } catch (e) {
      toast('Меню «' + id + '»: ошибка YAML, открыто пустым', 'err');
      return {};
    }
  }

  // show empty-state card with an error message; `allowNew` lets the user start from scratch
  function failLoad(msg, allowNew) {
    $('es-msg').textContent = msg;
    show('empty-state');
    if (allowNew) {
      // let the user build menus even without a valid bundle
      state.menus = [];
      state.sel = -1;
      show('editor');
      renderAll();
    }
  }

  // ================================================================== SAVE  (POST <w>/post)
  async function saveBundle() {
    if (!commitRaw()) return; // flush raw editor; abort if its YAML is invalid
    if (!state.menus.length) { toast('Нет меню для сохранения', 'err'); return; }

    const btn = $('save-btn');
    btn.disabled = true;
    try {
      const menus = state.menus.map((m) => ({
        id: m.id,
        yaml: jsyaml.dump(m.obj, { lineWidth: -1, noRefs: true, indent: 2 })
      }));
      const bundle = JSON.stringify({ v: BUNDLE_VERSION, menus });

      const res = await fetch(state.workerBase + '/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bundle
      });
      if (!res.ok) throw new Error('POST /post -> ' + res.status);
      const out = await res.json();
      if (!out || !out.key) throw new Error('в ответе нет key');
      openSaveModal(out.key);
    } catch (e) {
      toast('Не удалось сохранить: ' + (e && e.message ? e.message : 'сеть'), 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ================================================================== RENDER
  function renderAll() {
    renderSidebar();
    renderCenter();
    renderProps();
    syncRawMode();
    const m = current();
    $('cur-menu-id').textContent = m ? m.id : '—';
  }

  // ---------- sidebar (menu list) ----------
  function renderSidebar() {
    const listEl = $('menu-list');
    clear(listEl);
    state.menus.forEach((m, i) => {
      const li = el('li', 'menu-item' + (i === state.sel ? ' active' : ''));
      li.append(el('span', 'mi-id', m.id));
      li.append(el('span', 'chip', m.obj && m.obj.type ? m.obj.type : '?'));
      li.onclick = () => selectMenu(i);
      listEl.append(li);
    });
    const has = state.menus.length > 0;
    $('dup-menu-btn').disabled = !has;
    $('del-menu-btn').disabled = !has;
  }

  function selectMenu(i) {
    if (i === state.sel) return;
    if (!commitRaw()) return; // don't switch away from invalid raw YAML
    state.sel = i;
    state.slot = null;
    renderAll();
  }

  // ---------- center (toolbar + slot grid) ----------
  function renderCenter() {
    const m = current();
    const title = $('menu-title');
    const rowsField = $('rows-field');
    if (!m) { title.value = ''; rowsField.hidden = true; clear($('slot-grid')); return; }

    const type = m.obj.type || 'chest';
    title.value = m.obj.title != null ? String(m.obj.title) : '';
    title.oninput = () => { m.obj.title = title.value; };

    if (type === 'chest') {
      rowsField.hidden = false;
      const rows = rowsOf(m.obj);
      const inp = $('menu-rows');
      inp.value = rows;
      inp.onchange = () => {
        let v = parseInt(inp.value, 10);
        if (isNaN(v)) v = 1;
        v = Math.max(1, Math.min(6, v));
        m.obj.rows = v;
        inp.value = v;
        if (state.slot != null && state.slot >= v * 9) state.slot = null;
        renderGrid();
        renderProps();
      };
    } else {
      rowsField.hidden = true;
    }
    renderGrid();
  }

  // chest = rows*9 cells; inventory = 27; other types -> note (edit via raw YAML)
  function renderGrid() {
    const m = current();
    const grid = $('slot-grid');
    const hint = $('grid-hint');
    clear(grid);
    if (!m) return;

    const type = m.obj.type || 'chest';
    if (type !== 'chest' && type !== 'inventory') {
      grid.style.display = 'none';
      hint.textContent = 'Тип «' + type + '» редактируется через «Сырой YAML» (кнопка сверху).';
      return;
    }
    grid.style.display = 'grid';
    hint.textContent = 'Клик по ячейке — выбрать / создать элемент.';

    const count = type === 'inventory' ? 27 : rowsOf(m.obj) * 9;
    const items = m.obj.items || {};
    for (let s = 0; s < count; s++) {
      grid.append(buildCell(items[String(s)], s));
    }
  }

  function buildCell(item, slot) {
    const cell = el('div', 'cell');
    cell.append(el('span', 'cell-num', String(slot)));
    if (item) {
      cell.classList.add('filled');
      cell.append(buildIcon(item.material, 'cell-ic', 'cell-txt'));
    }
    if (state.slot === slot) cell.classList.add('selected');
    cell.onclick = () => onCellClick(slot);
    return cell;
  }

  // select a slot; create a default element on an empty cell (per spec)
  function onCellClick(slot) {
    const m = current();
    if (!m) return;
    if (!m.obj.items || typeof m.obj.items !== 'object') m.obj.items = {};
    if (!m.obj.items[String(slot)]) m.obj.items[String(slot)] = { material: 'STONE' };
    state.slot = slot;
    renderGrid();
    renderProps();
  }

  // ---------- right panel (slot editor) ----------
  function renderProps() {
    const m = current();
    const empty = $('slot-empty');
    const body = $('slot-editor');
    const item = (m && state.slot != null && m.obj.items) ? m.obj.items[String(state.slot)] : null;

    if (!item) { empty.hidden = false; body.hidden = true; return; }
    empty.hidden = true; body.hidden = false;

    $('slot-num').textContent = String(state.slot);

    // material (+ live icon)
    const fMat = $('f-material');
    fMat.value = item.material != null ? String(item.material) : '';
    setMatIcon(item.material);
    fMat.oninput = () => { item.material = fMat.value; };
    fMat.onchange = () => { setMatIcon(item.material); renderGrid(); };

    // cmd (custom-model-data) — kept as string
    const fCmd = $('f-cmd');
    fCmd.value = item.cmd != null ? String(item.cmd) : '';
    fCmd.oninput = () => { setOrDel(item, 'cmd', fCmd.value); };

    // name
    const fName = $('f-name');
    fName.value = item.name != null ? String(item.name) : '';
    fName.oninput = () => { setOrDel(item, 'name', fName.value); };

    // lore (one line per row)
    const fLore = $('f-lore');
    fLore.value = Array.isArray(item.lore) ? item.lore.join('\n') : (item.lore ? String(item.lore) : '');
    fLore.oninput = () => {
      const lines = fLore.value.split('\n');
      if (fLore.value.trim() === '') delete item.lore;
      else item.lore = lines;
    };

    renderFlags(item);
    renderClicks(item);
  }

  function renderFlags(item) {
    const wrap = $('f-flags');
    clear(wrap);
    const flags = Array.isArray(item.flags) ? item.flags : [];
    HIDE_FLAGS.forEach((flag) => {
      const lab = el('label', 'check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = flags.indexOf(flag) !== -1;
      cb.onchange = () => {
        let arr = Array.isArray(item.flags) ? item.flags.slice() : [];
        if (cb.checked) { if (arr.indexOf(flag) === -1) arr.push(flag); }
        else { arr = arr.filter((f) => f !== flag); }
        if (arr.length) item.flags = arr; else delete item.flags;
      };
      lab.append(cb, el('span', null, flag.replace('HIDE_', '')));
      wrap.append(lab);
    });

    const hideAll = $('f-hideall');
    hideAll.checked = item['hide-all'] === true;
    hideAll.onchange = () => {
      if (hideAll.checked) item['hide-all'] = true; else delete item['hide-all'];
    };
  }

  // ---------- clicks editor (per click-kind: list of action rows) ----------
  function renderClicks(item) {
    const wrap = $('f-clicks');
    clear(wrap);
    if (!item.clicks || typeof item.clicks !== 'object') item.clicks = {};

    CLICK_KINDS.forEach(([kind, label]) => {
      const actions = Array.isArray(item.clicks[kind]) ? item.clicks[kind] : null;
      const block = el('div', 'click-kind');

      const head = el('div', 'ck-head');
      head.append(el('span', 'ck-name' + (actions ? '' : ' empty'), label));
      head.append(el('span', 'faint', actions ? actions.length + ' дейст.' : ''));
      block.append(head);

      const bodyEl = el('div', 'ck-body');
      if (actions) {
        actions.forEach((a, idx) => bodyEl.append(buildActionRow(item, kind, idx)));
      }
      const add = el('button', 'btn small add-action', '＋ действие');
      add.onclick = () => {
        if (!Array.isArray(item.clicks[kind])) item.clicks[kind] = [];
        item.clicks[kind].push({ type: 'run_command', command: '', as: 'player' });
        renderClicks(item);
      };
      bodyEl.append(add);
      block.append(bodyEl);
      wrap.append(block);
    });
  }

  function buildActionRow(item, kind, idx) {
    const actions = item.clicks[kind];
    const a = actions[idx];
    const row = el('div', 'action-row');

    const top = el('div', 'action-top');
    const sel = el('select', 'in');
    ACTION_TYPES.forEach(([val, lab]) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = lab;
      sel.append(o);
    });
    sel.value = a.type || 'run_command';
    sel.onchange = () => { actions[idx] = defaultAction(sel.value); renderClicks(item); };

    const del = el('button', 'btn icon', '×');
    del.title = 'Удалить действие';
    del.onclick = () => {
      actions.splice(idx, 1);
      if (!actions.length) delete item.clicks[kind];
      renderClicks(item);
    };
    top.append(sel, del);
    row.append(top);

    const fields = el('div', 'action-fields');
    buildActionFields(fields, a);
    row.append(fields);
    return row;
  }

  function defaultAction(type) {
    switch (type) {
      case 'run_command': return { type, command: '', as: 'player' };
      case 'message': return { type, text: '' };
      case 'open_menu': return { type, menu: '' };
      case 'sound': return { type, sound: '' };
      case 'give_item': return { type, material: 'STONE', amount: 1 };
      case 'conditional': return { type, requirement: '', then: [], else: [] };
      default: return { type }; // refresh, close, back
    }
  }

  // build the per-type field inputs for one action; each input mutates `a` directly
  function buildActionFields(box, a) {
    const t = a.type;
    if (t === 'run_command') {
      box.append(textField('Команда (без /)', a.command, (v) => { a.command = v; }));
      box.append(selectField('От имени', a.as || 'player',
        [['player', 'игрок'], ['console', 'консоль']], (v) => { a.as = v; }));
    } else if (t === 'message') {
      box.append(textField('Текст (MiniMessage)', a.text, (v) => { a.text = v; }));
    } else if (t === 'open_menu') {
      box.append(textField('ID меню', a.menu, (v) => { a.menu = v; }));
    } else if (t === 'sound') {
      box.append(textField('Звук', a.sound, (v) => { a.sound = v; }));
    } else if (t === 'give_item') {
      const line = el('div', 'inline');
      line.append(textField('Материал', a.material, (v) => { a.material = v; }));
      line.append(numField('Кол-во', a.amount, (v) => { a.amount = v; }));
      box.append(line);
      box.append(textField('Имя (необяз.)', a.name, (v) => { setOrDel(a, 'name', v); }));
      box.append(textField('cmd (необяз.)', a.cmd, (v) => { setOrDel(a, 'cmd', v); }));
    } else if (t === 'conditional') {
      // raw-JSON escape hatch for the requirement + then/else branches
      const ta = document.createElement('textarea');
      ta.className = 'in area';
      ta.spellcheck = false;
      ta.value = JSON.stringify(
        { requirement: a.requirement || '', then: a.then || [], else: a.else || [] }, null, 2);
      ta.onchange = () => {
        try {
          const parsed = JSON.parse(ta.value);
          a.requirement = parsed.requirement != null ? parsed.requirement : '';
          a.then = Array.isArray(parsed.then) ? parsed.then : [];
          a.else = Array.isArray(parsed.else) ? parsed.else : [];
          ta.style.borderColor = '';
        } catch (e) {
          ta.style.borderColor = 'var(--danger)';
        }
      };
      box.append(labelWrap('requirement / then / else (JSON)', ta));
    }
    // refresh, close, back -> no fields
  }

  // ---------- small field factories ----------
  function labelWrap(label, inputNode) {
    const f = el('label', 'field');
    f.append(el('span', 'lbl', label), inputNode);
    return f;
  }
  function textField(label, val, onset) {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'in';
    inp.value = val != null ? String(val) : '';
    inp.oninput = () => onset(inp.value);
    return labelWrap(label, inp);
  }
  function numField(label, val, onset) {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'in'; inp.min = '1';
    inp.value = (val != null && val !== '') ? val : 1;
    inp.oninput = () => { let n = parseInt(inp.value, 10); onset(isNaN(n) ? 1 : n); };
    return labelWrap(label, inp);
  }
  function selectField(label, val, opts, onset) {
    const sel = el('select', 'in');
    opts.forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; sel.append(o);
    });
    sel.value = val;
    sel.onchange = () => onset(sel.value);
    return labelWrap(label, sel);
  }
  // set obj[key]=val, or delete the key when the value is empty (keeps YAML tidy)
  function setOrDel(obj, key, val) {
    if (val == null || String(val).trim() === '') delete obj[key];
    else obj[key] = val;
  }

  // ================================================================== ICONS (best-effort)
  // Try textures/item/<name>.png, then block/<name>.png; on failure show short material text.
  function buildIcon(material, imgCls, txtCls) {
    const name = String(material || '').toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '').trim();
    if (!name) return el('span', txtCls, '?');
    const urls = [ICON_BASE + 'item/' + name + '.png', ICON_BASE + 'block/' + name + '.png'];
    const img = document.createElement('img');
    img.className = imgCls;
    img.loading = 'lazy';
    img.alt = '';
    let stage = 0;
    img.onerror = () => {
      stage += 1;
      if (stage < urls.length) { img.src = urls[stage]; return; }
      const span = el('span', txtCls, shortMat(name));
      if (img.parentNode) img.parentNode.replaceChild(span, img);
    };
    img.src = urls[0];
    return img;
  }
  function shortMat(name) { return String(name || '?').split(':').pop().slice(0, 12); }

  function setMatIcon(material) {
    const holder = $('mat-ic');
    clear(holder);
    if (material && String(material).trim()) holder.append(buildIcon(material, null, 'mi-txt'));
  }

  // ================================================================== RAW-YAML MODE
  function syncRawMode() {
    const layout = $('layout');
    $('raw-toggle').setAttribute('aria-pressed', state.raw ? 'true' : 'false');
    layout.classList.toggle('raw-mode', state.raw);
    $('raw-wrap').hidden = !state.raw;
    if (state.raw) dumpRaw();
  }

  function dumpRaw() {
    const m = current();
    $('raw-yaml').value = m ? jsyaml.dump(m.obj, { lineWidth: -1, noRefs: true, indent: 2 }) : '';
    hideRawErr();
  }

  // parse the textarea back into the current menu object; returns false if invalid
  function commitRaw() {
    if (!state.raw) return true;
    const m = current();
    if (!m) return true;
    try {
      const o = jsyaml.load($('raw-yaml').value);
      m.obj = (o && typeof o === 'object') ? o : {};
      hideRawErr();
      return true;
    } catch (e) {
      showRawErr(e && e.message ? e.message : 'ошибка YAML');
      return false;
    }
  }

  function toggleRaw() {
    if (state.raw) {
      // leaving raw mode: keep old object if the YAML is invalid
      if (!commitRaw()) { toast('Исправь YAML, затем выключи режим', 'err'); return; }
      state.raw = false;
      renderAll();
    } else {
      if (!current()) { toast('Нет выбранного меню', 'err'); return; }
      state.raw = true;
      syncRawMode();
    }
  }

  function showRawErr(msg) { const e = $('raw-err'); e.textContent = 'YAML: ' + msg; e.hidden = false; }
  function hideRawErr() { $('raw-err').hidden = true; }

  // ================================================================== MENU CRUD
  function openNewMenu() {
    $('nm-id').value = '';
    $('nm-err').hidden = true;
    setNmType('chest');
    $('newmenu-modal').hidden = false;
    $('nm-id').focus();
  }
  function setNmType(type) {
    document.querySelectorAll('#nm-types .type-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.type === type);
    });
  }
  function selectedNmType() {
    const a = document.querySelector('#nm-types .type-card.active');
    return a ? a.dataset.type : 'chest';
  }
  function createMenu() {
    const id = $('nm-id').value.trim();
    const err = $('nm-err');
    if (!id) { err.textContent = 'Укажи ID меню.'; err.hidden = false; return; }
    if (/\s/.test(id)) { err.textContent = 'ID без пробелов.'; err.hidden = false; return; }
    if (state.menus.some((m) => m.id === id)) { err.textContent = 'Меню с таким ID уже есть.'; err.hidden = false; return; }

    const type = selectedNmType();
    const obj = type === 'inventory'
      ? { type: 'inventory', title: '<white>' + id, items: {} }
      : { type: 'chest', title: '<white>' + id, rows: 3, items: {} };

    state.menus.push({ id, obj });
    state.sel = state.menus.length - 1;
    state.slot = null;
    $('newmenu-modal').hidden = true;
    renderAll();
    toast('Меню «' + id + '» создано', 'ok');
  }

  function duplicateMenu() {
    const m = current();
    if (!m) return;
    if (!commitRaw()) return;
    let id = m.id + '_copy';
    let n = 2;
    while (state.menus.some((x) => x.id === id)) { id = m.id + '_copy' + n; n += 1; }
    const clone = JSON.parse(JSON.stringify(m.obj)); // plain data -> safe deep clone
    state.menus.push({ id, obj: clone });
    state.sel = state.menus.length - 1;
    state.slot = null;
    renderAll();
    toast('Дубликат: «' + id + '»', 'ok');
  }

  function deleteMenu() {
    const m = current();
    if (!m) return;
    if (!window.confirm('Удалить меню «' + m.id + '»? Действие применится после сохранения.')) return;
    state.menus.splice(state.sel, 1);
    state.sel = state.menus.length ? Math.max(0, state.sel - 1) : -1;
    state.slot = null;
    state.raw = false;
    renderAll();
    if (!state.menus.length) $('cur-menu-id').textContent = '—';
  }

  // ================================================================== SLOT actions
  function clearSlot() {
    const m = current();
    if (!m || state.slot == null) return;
    if (m.obj.items) delete m.obj.items[String(state.slot)];
    renderGrid();
    renderProps();
  }

  // ================================================================== SAVE modal
  function openSaveModal(key) {
    $('sm-cmd').textContent = '/am apply ' + key;
    $('save-modal').hidden = false;
  }
  function copyCode() {
    const text = $('sm-cmd').textContent;
    const done = () => toast('Скопировано', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
    } else { legacyCopy(text, done); }
  }
  function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Не удалось скопировать', 'err'); }
    ta.remove();
  }

  // ================================================================== TOASTS
  function toast(msg, kind) {
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    $('toasts').append(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 3200);
  }

  // ================================================================== helpers
  function rowsOf(obj) {
    let r = parseInt(obj && obj.rows, 10);
    if (isNaN(r)) r = 3;
    return Math.max(1, Math.min(6, r));
  }

  // ================================================================== static wiring
  function wireStaticUi() {
    $('save-btn').onclick = saveBundle;
    $('raw-toggle').onclick = toggleRaw;
    $('raw-yaml').addEventListener('blur', commitRaw);

    $('new-menu-btn').onclick = openNewMenu;
    $('dup-menu-btn').onclick = duplicateMenu;
    $('del-menu-btn').onclick = deleteMenu;
    $('clear-slot-btn').onclick = clearSlot;

    // new-menu modal
    $('nm-create').onclick = createMenu;
    $('nm-cancel').onclick = () => { $('newmenu-modal').hidden = true; };
    document.querySelectorAll('#nm-types .type-card').forEach((c) => {
      c.onclick = () => setNmType(c.dataset.type);
    });
    $('nm-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') createMenu(); });

    // save modal
    $('sm-copy').onclick = copyCode;
    $('sm-close').onclick = () => { $('save-modal').hidden = true; };

    // close overlays on backdrop click / Esc
    document.querySelectorAll('.overlay').forEach((ov) => {
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.hidden = true; });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.overlay').forEach((o) => (o.hidden = true));
    });
  }

  // go
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
