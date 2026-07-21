/* AlexMenus web editor — vanilla JS SPA (js-yaml v4 is the only external dep).
 *
 * DATA FLOW
 *   load:  #<code>            (bare, clean link)  -> worker = DEFAULT_WORKER
 *          #k=<code>&w=<url>  (legacy, back-compat) -> worker from w=
 *          -> GET <w>/<k> -> bundle {v,menus:[{id,yaml}]}
 *          -> jsyaml.load(each yaml) -> plain JS objects held in state.menus[i].obj
 *   edit:  the structured UI (grid + slot editor) and the raw-YAML textarea mutate obj.
 *          Multi-select: edits in the right panel apply to ALL selected slots (bulk).
 *   save:  jsyaml.dump(each obj) -> bundle {v:1,menus:[{id,yaml}]} -> POST <w>/post
 *          -> { key } -> show "/am apply <key>"
 * The only network calls are that initial GET and the save POST. Everything else is client-side.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ constants
  const ICON_BASE = 'https://assets.mcasset.cloud/1.21.11/assets/minecraft/textures/';
  const MODEL_BASE = 'https://assets.mcasset.cloud/1.21.11/assets/minecraft/models/';
  const ITEMDEF_BASE = 'https://assets.mcasset.cloud/1.21.11/assets/minecraft/items/'; // 1.21.4 item-definitions
  // face-texture priority lists for resolving a cube's top/side from a model's textures map
  const TOP_KEYS = ['up', 'top', 'end', 'all', 'side', 'north', 'texture', 'particle', 'wall', 'cross'];
  const SIDE_KEYS = ['side', 'north', 'west', 'south', 'east', 'all', 'texture', 'particle', 'wall', 'up', 'top'];
  const modelCache = new Map();   // model path -> Promise<json|null>  (dedupes CDN fetches)
  const itemDefCache = new Map(); // item name -> Promise<json|null>   (1.21.4 item-definitions)
  const BUNDLE_VERSION = 1;

  // Default paste-service Worker, used when the link is the clean `#<code>` form (no w=).
  const DEFAULT_WORKER = 'https://alexmenus-paste.alextorx2020.workers.dev';

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
    workerBase: '',        // Worker base URL (from hash `w`, or DEFAULT_WORKER)
    code: '',              // paste code (from hash)
    menus: [],             // [{ id, obj }]  — obj = parsed menu object
    sel: -1,               // index of the selected menu
    selected: new Set(),   // set of selected slot indices (ints)
    active: null,          // the slot shown in the right panel (int) or null
    clipboard: null,       // internal copy buffer (a cloned element object)
    raw: false,            // raw-YAML mode active?
    graph: false           // navigation-graph view active?
  };

  // transient drag-select bookkeeping
  const drag = { pending: false, moved: false, startSlot: null };

  // graph-view bookkeeping (node positions persist across renders so drags stick)
  const graphPos = {};         // menu/ghost id -> { x, y } center
  let graphNodes = [];         // current node list
  let graphEdges = [];         // [{ from, to, node(SVG el) }]

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
  function resetSelection() { state.selected = new Set(); state.active = null; }

  // ================================================================== INIT
  function init() {
    wireStaticUi();
    const hash = parseHash();
    if (!hash.k) {
      // No code -> friendly empty state explaining how to open the editor.
      show('empty-state');
      return;
    }
    state.code = hash.k;
    state.workerBase = hash.w;
    loadBundle();
  }

  // Parse location.hash. Supports two forms:
  //   `#<code>`               (bare/clean link) -> code = whole fragment, worker = DEFAULT_WORKER
  //   `#k=<code>&w=<url-enc>`  (legacy)          -> code from k=, worker from w= (or DEFAULT_WORKER)
  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '').trim();
    if (!raw) return { k: '', w: DEFAULT_WORKER };

    if (/(?:^|&)[kw]=/.test(raw)) {           // param form: contains a k= or w=
      const p = new URLSearchParams(raw);
      let w = p.get('w') || '';
      if (w) { try { w = decodeURIComponent(w); } catch (e) { /* already decoded */ } }
      w = (w || DEFAULT_WORKER).replace(/\/+$/, '');
      return { k: (p.get('k') || '').trim(), w: w.trim() };
    }
    // bare form: the entire fragment is the paste code
    return { k: raw, w: DEFAULT_WORKER.replace(/\/+$/, '') };
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
      resetSelection();
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
      state.menus = [];
      state.sel = -1;
      resetSelection();
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
    renderMenuSettings();
    renderProps();
    syncModes();
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
    resetSelection();
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
      const inp = $('menu-rows');
      inp.value = rowsOf(m.obj);
      inp.onchange = () => {
        let v = parseInt(inp.value, 10);
        if (isNaN(v)) v = 1;
        v = Math.max(1, Math.min(6, v));
        m.obj.rows = v;
        inp.value = v;
        // drop selection/active that fell outside the new grid
        state.selected = new Set([...state.selected].filter((s) => s < v * 9));
        if (state.active != null && state.active >= v * 9) state.active = null;
        renderGrid();
        renderProps();
      };
    } else {
      rowsField.hidden = true;
    }
    renderGrid();
  }

  // ---------- menu-settings (top-level menu keys the plugin supports) ----------
  function renderMenuSettings() {
    const m = current();
    const box = $('menu-settings');
    if (!m) { box.hidden = true; return; }
    box.hidden = false;

    const perm = $('ms-permission');
    perm.value = m.obj.permission != null ? String(m.obj.permission) : '';
    perm.oninput = () => setOrDel(m.obj, 'permission', perm.value);

    const cmds = $('ms-commands');
    cmds.value = Array.isArray(m.obj.commands) ? m.obj.commands.join(', ') : (m.obj.commands != null ? String(m.obj.commands) : '');
    cmds.oninput = () => {
      const list = cmds.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length) m.obj.commands = list; else delete m.obj.commands;
    };

    const desc = $('ms-cmd-desc');
    desc.value = m.obj['command-description'] != null ? String(m.obj['command-description']) : '';
    desc.oninput = () => setOrDel(m.obj, 'command-description', desc.value);

    // show-in-help defaults to true; write `false` only when unchecked (omit true to keep YAML clean)
    const help = $('ms-show-help');
    help.checked = m.obj['show-in-help'] !== false;
    help.onchange = () => { if (help.checked) delete m.obj['show-in-help']; else m.obj['show-in-help'] = false; };
  }

  // chest = rows*9 cells; inventory = 27; other types -> note (edit via raw YAML)
  function renderGrid() {
    const m = current();
    const grid = $('slot-grid');
    const hint = $('grid-hint');
    clear(grid);
    if (!m) { updateSelCounter(); return; }

    const type = m.obj.type || 'chest';
    if (type !== 'chest' && type !== 'inventory') {
      grid.style.display = 'none';
      hint.textContent = 'Тип «' + type + '» редактируется через «Сырой YAML» (кнопка сверху).';
      $('sel-count').hidden = true;
      return;
    }
    grid.style.display = 'grid';
    hint.textContent = 'ЛКМ — выбрать · Ctrl — добавить · Shift — диапазон · тянуть — рамкой · ПКМ — меню';

    const count = type === 'inventory' ? 27 : rowsOf(m.obj) * 9;
    const items = m.obj.items || {};
    resetIconObserver(); // new lazy-icon observer for this grid generation
    for (let s = 0; s < count; s++) grid.append(buildCell(items[String(s)], s));
    scheduleIconFallback(grid);
    updateSelCounter();
  }

  function buildCell(item, slot) {
    const cell = el('div', 'cell');
    cell.dataset.slot = String(slot);
    cell.append(el('span', 'cell-num', String(slot)));
    if (item) {
      cell.classList.add('filled');
      cell.append(makeIconHolder(item.material, 40, 'cell-txt', true));
    }
    if (state.selected.has(slot)) cell.classList.add('selected');
    if (state.active === slot) cell.classList.add('active');
    cell.addEventListener('mousedown', (e) => onCellMouseDown(e, slot));
    cell.addEventListener('mouseenter', (e) => onCellMouseEnter(e, slot));
    cell.addEventListener('contextmenu', (e) => onCellContext(e, slot));
    return cell;
  }

  // ---------- selection interactions ----------
  // Plain click: select only this cell (+create element). Ctrl/Cmd: toggle in selection.
  // Shift: rectangular range from active to this cell. Drag: rubber-select a fresh region.
  function onCellMouseDown(e, slot) {
    if (e.button !== 0) return;   // left only; right is handled by contextmenu
    hideContextMenu();
    const m = current();
    if (!m) return;
    drag.pending = true; drag.moved = false; drag.startSlot = slot;

    if (e.shiftKey && state.active != null) {
      selectRange(state.active, slot);
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selected.has(slot)) state.selected.delete(slot);
      else state.selected.add(slot);
      state.active = slot;
    } else {
      ensureElement(slot);        // plain click on empty cell creates an element
      state.selected = new Set([slot]);
      state.active = slot;
    }
    renderGrid();
    renderProps();
  }

  function onCellMouseEnter(e, slot) {
    if (!drag.pending) return;
    drag.moved = true;
    state.selected.add(slot);
    state.active = slot;
    paintSelection();             // lightweight: update classes, don't rebuild the grid mid-drag
  }

  function onDocMouseUp() {
    if (!drag.pending) return;
    drag.pending = false;
    if (drag.moved) renderProps(); // finalize the right panel for the dragged selection
  }

  function onCellContext(e, slot) {
    e.preventDefault();
    const m = current();
    if (!m) return;
    // if the right-clicked cell isn't part of the selection, select just it first
    if (!state.selected.has(slot)) { state.selected = new Set([slot]); }
    state.active = slot;
    renderGrid();
    renderProps();
    openContextMenu(e.clientX, e.clientY);
  }

  // rectangular bounding box between two slots in the 9-wide grid
  function selectRange(a, b) {
    const W = 9, cnt = gridCount();
    const ar = Math.floor(a / W), ac = a % W, br = Math.floor(b / W), bc = b % W;
    const r0 = Math.min(ar, br), r1 = Math.max(ar, br), c0 = Math.min(ac, bc), c1 = Math.max(ac, bc);
    state.selected = new Set();
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const s = r * W + c;
      if (s < cnt) state.selected.add(s);
    }
    state.active = b;
  }

  // update .selected / .active classes without rebuilding cells (used during drag)
  function paintSelection() {
    $('slot-grid').querySelectorAll('.cell').forEach((c) => {
      const s = parseInt(c.dataset.slot, 10);
      c.classList.toggle('selected', state.selected.has(s));
      c.classList.toggle('active', state.active === s);
    });
    updateSelCounter();
  }

  function updateSelCounter() {
    const n = state.selected.size;
    const e = $('sel-count');
    if (n > 1) { e.hidden = false; e.textContent = n + ' выделено'; }
    else e.hidden = true;
  }

  // ---------- right panel (slot editor, with bulk-apply to all selected) ----------
  function renderProps() {
    const m = current();
    const empty = $('slot-empty');
    const body = $('slot-editor');
    if (!m || state.active == null) { empty.hidden = false; body.hidden = true; return; }

    const real = (m.obj.items && m.obj.items[String(state.active)]) || null;
    const disp = real || {};      // display values come from the active slot (blank if empty)
    empty.hidden = true; body.hidden = false;

    // bulk banner: shown when edits will touch more than one slot
    const n = targetSlots().length;
    const banner = $('bulk-banner');
    if (n > 1) { banner.hidden = false; banner.textContent = 'Правки применяются к ' + n + ' слотам'; }
    else banner.hidden = true;

    $('slot-num').textContent = n > 1 ? (state.active + ' + ещё ' + (n - 1)) : String(state.active);

    // material (+ live icon) — bulk
    const fMat = $('f-material');
    fMat.value = disp.material != null ? String(disp.material) : '';
    setMatIcon(disp.material);
    fMat.oninput = () => applyBulk((it) => { it.material = fMat.value; }, false);
    fMat.onchange = () => { setMatIcon(fMat.value); renderGrid(); };

    // cmd (custom-model-data) — bulk
    const fCmd = $('f-cmd');
    fCmd.value = disp.cmd != null ? String(disp.cmd) : '';
    fCmd.oninput = () => applyBulk((it) => setOrDel(it, 'cmd', fCmd.value), false);

    // name — bulk
    const fName = $('f-name');
    fName.value = disp.name != null ? String(disp.name) : '';
    fName.oninput = () => applyBulk((it) => setOrDel(it, 'name', fName.value), false);

    // lore (one line per row) — bulk
    const fLore = $('f-lore');
    fLore.value = Array.isArray(disp.lore) ? disp.lore.join('\n') : (disp.lore ? String(disp.lore) : '');
    fLore.oninput = () => applyBulk((it) => {
      if (fLore.value.trim() === '') delete it.lore;
      else it.lore = fLore.value.split('\n');
    }, false);

    renderFlags(disp);
    renderClicks(disp);
  }

  function renderFlags(disp) {
    const wrap = $('f-flags');
    clear(wrap);
    const flags = Array.isArray(disp.flags) ? disp.flags : [];
    HIDE_FLAGS.forEach((flag) => {
      const lab = el('label', 'check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = flags.indexOf(flag) !== -1;
      cb.onchange = () => applyBulk((it) => {
        let arr = Array.isArray(it.flags) ? it.flags.slice() : [];
        if (cb.checked) { if (arr.indexOf(flag) === -1) arr.push(flag); }
        else { arr = arr.filter((f) => f !== flag); }
        if (arr.length) it.flags = arr; else delete it.flags;
      }, false);
      lab.append(cb, el('span', null, flag.replace('HIDE_', '')));
      wrap.append(lab);
    });

    const hideAll = $('f-hideall');
    hideAll.checked = disp['hide-all'] === true;
    hideAll.onchange = () => applyBulk((it) => {
      if (hideAll.checked) it['hide-all'] = true; else delete it['hide-all'];
    }, false);
  }

  // ---------- clicks editor (per click-kind: list of action rows) ----------
  // Reads from the active slot; structural changes mutate the active element and, when
  // more than one slot is selected, propagate the whole clicks object to all targets.
  function renderClicks(disp) {
    const wrap = $('f-clicks');
    clear(wrap);
    const clicks = (disp && disp.clicks && typeof disp.clicks === 'object') ? disp.clicks : {};

    CLICK_KINDS.forEach(([kind, label]) => {
      const actions = Array.isArray(clicks[kind]) ? clicks[kind] : null;
      const block = el('div', 'click-kind');

      const head = el('div', 'ck-head');
      head.append(el('span', 'ck-name' + (actions ? '' : ' empty'), label));
      head.append(el('span', 'faint', actions ? actions.length + ' дейст.' : ''));
      block.append(head);

      const bodyEl = el('div', 'ck-body');
      if (actions) actions.forEach((a, idx) => bodyEl.append(buildActionRow(kind, idx)));

      const add = el('button', 'btn small add-action', '＋ действие');
      add.onclick = () => {
        const real = ensureActiveElement();
        if (!real.clicks) real.clicks = {};
        if (!Array.isArray(real.clicks[kind])) real.clicks[kind] = [];
        real.clicks[kind].push({ type: 'run_command', command: '', as: 'player' });
        propagateClicksIfBulk();
        renderGrid();   // active may have become filled
        renderProps();
      };
      bodyEl.append(add);
      block.append(bodyEl);
      wrap.append(block);
    });
  }

  function buildActionRow(kind, idx) {
    const real = activeItem();
    const actions = real.clicks[kind];
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
    sel.onchange = () => { actions[idx] = defaultAction(sel.value); propagateClicksIfBulk(); renderProps(); };

    const del = el('button', 'btn icon', '×');
    del.title = 'Удалить действие';
    del.onclick = () => {
      actions.splice(idx, 1);
      if (!actions.length) delete real.clicks[kind];
      if (!Object.keys(real.clicks).length) delete real.clicks;
      propagateClicksIfBulk();
      renderProps();
    };
    top.append(sel, del);
    row.append(top);

    const fields = el('div', 'action-fields');
    buildActionFields(fields, a); // field inputs mutate `a`; #f-clicks delegated listener propagates
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

  // ================================================================== BULK-EDIT helpers
  // The slots a right-panel edit writes to = the selection ∪ the active slot.
  function targetSlots() {
    const s = new Set(state.selected);
    if (state.active != null) s.add(state.active);
    return [...s];
  }
  // active slot's element (may be null if the active slot is empty)
  function activeItem() {
    const m = current();
    if (!m || state.active == null || !m.obj.items) return null;
    return m.obj.items[String(state.active)] || null;
  }
  // ensure an element exists at the active slot, return it
  function ensureActiveElement() {
    const m = current();
    if (!m) return null;
    if (!m.obj.items) m.obj.items = {};
    const k = String(state.active);
    if (!m.obj.items[k]) m.obj.items[k] = { material: 'STONE' };
    return m.obj.items[k];
  }
  function ensureElement(slot) {
    const m = current();
    if (!m) return;
    if (!m.obj.items) m.obj.items = {};
    if (!m.obj.items[String(slot)]) m.obj.items[String(slot)] = { material: 'STONE' };
  }
  // element objects for every target slot (creating a default where empty)
  function targetItems() {
    const m = current();
    if (!m) return [];
    if (!m.obj.items) m.obj.items = {};
    return targetSlots().map((slot) => {
      const k = String(slot);
      if (!m.obj.items[k]) m.obj.items[k] = { material: 'STONE' };
      return m.obj.items[k];
    });
  }
  function filledCount() {
    const m = current();
    return (m && m.obj.items) ? Object.keys(m.obj.items).length : 0;
  }
  // apply a mutation to every target element; regrid only if the filled set changed (or forced)
  function applyBulk(fn, forceGrid) {
    const before = filledCount();
    targetItems().forEach(fn);
    updateSelCounter();
    if (forceGrid || filledCount() !== before) renderGrid();
  }
  // copy the active slot's clicks object to all other target slots (bulk clicks editing)
  function propagateClicks() {
    const src = activeItem();
    if (!src) return;
    const clone = src.clicks ? JSON.parse(JSON.stringify(src.clicks)) : null;
    targetItems().forEach((it) => {
      if (it === src) return;
      if (clone === null) delete it.clicks;
      else it.clicks = JSON.parse(JSON.stringify(clone));
    });
  }
  function propagateClicksIfBulk() { if (targetSlots().length > 1) propagateClicks(); }

  // ================================================================== ICONS (model-JSON aware)
  // In MC 1.21.11 models/item/<block>.json 404s for block-items, so a naive item/block texture
  // probe misses most blocks. Instead we resolve via the model JSON: redirect item -> block model,
  // walk the parent chain accumulating textures, and classify flat (layer0) / cube / cross / blank.
  // CDN CORS is `*`, so fetch() of the model JSON works. Results are cached per material.

  const stripNs = (s) => String(s == null ? '' : s).replace(/^minecraft:/, '');
  const texUrl = (p) => ICON_BASE + stripNs(p) + '.png';

  function fetchModelJson(path) {
    if (modelCache.has(path)) return modelCache.get(path);
    const p = fetch(MODEL_BASE + path + '.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    modelCache.set(path, p);
    return p;
  }
  // follow #ref indirection inside a textures map to a concrete texture path (or null)
  function resolveRef(val, tex) {
    let v = stripNs(val), d = 0;
    while (v && v[0] === '#' && d < 12) { v = stripNs(tex[v.slice(1)]); d++; }
    return (v && v[0] !== '#') ? v : null;
  }
  function pickFace(keys, tex) {
    for (const k of keys) if (k in tex) { const r = resolveRef(tex[k], tex); if (r) return r; }
    return null;
  }
  function finishCube(tex) {
    const top = pickFace(TOP_KEYS, tex), side = pickFace(SIDE_KEYS, tex);
    if (!top && !side) return { kind: 'blank' };
    const front = ('front' in tex) ? resolveRef(tex.front, tex) : null;
    return { kind: 'cube', top: top || side, side: side || top, front };
  }
  // walk a model file (by path) up its parent chain -> {kind:'flat'|'cube'|'blank'} | null if missing
  async function walkModel(startPath) {
    let model = await fetchModelJson(startPath);
    if (!model) return null;
    const tex = {};
    for (let hops = 0; model && hops < 14; hops++) {
      if (model.textures) for (const k in model.textures) if (!(k in tex)) tex[k] = model.textures[k];
      if (tex.layer0) { const t = resolveRef(tex.layer0, tex); return t ? { kind: 'flat', tex: t } : { kind: 'blank' }; }
      const parent = stripNs(model.parent || '');
      if (parent.startsWith('builtin/') || parent.startsWith('item/template_')) return { kind: 'blank' };
      if (parent === 'block/cross' || parent === 'block/tinted_cross') {
        const t = pickFace(['cross', 'plant', 'rail', 'texture'], tex);
        return t ? { kind: 'flat', tex: t } : finishCube(tex);
      }
      if (parent === 'item/generated' || parent === 'item/handheld') return finishCube(tex);
      if (parent === '' || parent.startsWith('block/cube') || parent.startsWith('block/template_') || parent.endsWith('_inventory')
        || parent.startsWith('block/orientable') || parent.startsWith('block/stairs') || parent.startsWith('block/slab')
        || parent === 'block/block' || parent === 'block/leaves') return finishCube(tex);
      model = await fetchModelJson(parent);
    }
    return finishCube(tex);
  }

  // 1.21.4 item-definitions live under items/<name>.json as { model: <item-model> }.
  function fetchItemDef(name) {
    if (itemDefCache.has(name)) return itemDefCache.get(name);
    const p = fetch(ITEMDEF_BASE + name + '.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    itemDefCache.set(name, p);
    return p;
  }
  // find the FIRST nested minecraft:model node's model-path (recursing over dispatch containers).
  // Tints are ignored entirely (potions/spawn eggs etc. -> just the base layer0 texture, no tint).
  function findFirstModelPath(node) {
    if (!node || typeof node !== 'object') return null;
    if (stripNs(node.type || '') === 'model' && typeof node.model === 'string') return stripNs(node.model);
    const kids = [];
    if (Array.isArray(node.cases)) node.cases.forEach((c) => kids.push(c && c.model));
    if (node.fallback) kids.push(node.fallback);
    if (node.on_true) kids.push(node.on_true);
    if (node.on_false) kids.push(node.on_false);
    if (Array.isArray(node.entries)) node.entries.forEach((e) => kids.push(e && e.model));
    if (Array.isArray(node.models)) node.models.forEach((m) => kids.push(m));
    for (const k of kids) { const r = findFirstModelPath(k); if (r) return r; }
    return null;
  }
  async function resolveViaItemDef(name) {
    const def = await fetchItemDef(name);
    if (!def || !def.model) return null;
    const modelPath = findFirstModelPath(def.model);
    return modelPath ? await walkModel(modelPath) : null;
  }
  // does a texture exist? (fetch, since CORS is *). used only for the final broadened probe.
  async function probeTexture(path) {
    try { const r = await fetch(ICON_BASE + path + '.png'); return r.ok; } catch (e) { return false; }
  }

  // classify a material -> {kind:'flat',tex} | {kind:'cube',top,side,front} | {kind:'blank'}
  async function resolveIconModel(name) {
    // 1) legacy item model (item/<name>.json)
    let res = await walkModel('item/' + name);
    if (res && res.kind !== 'blank') return res;
    // 2) 1.21.4 item-definition -> first nested model path -> resolve that model
    const defRes = await resolveViaItemDef(name);
    if (defRes && defRes.kind !== 'blank') return defRes;
    // 3) block model (many blocks have no item model)
    res = (await walkModel('block/' + name)) || (await walkModel('block/' + name + '_inventory'));
    if (res && res.kind !== 'blank') return res;
    // 4) broadened texture probe before giving up to text
    for (const p of ['item/' + name, 'block/' + name, 'item/' + name + '_00']) {
      if (await probeTexture(p)) return { kind: 'flat', tex: p };
    }
    return { kind: 'blank' }; // truly texture-less entity item (chest/bed/skull/banner/shield/...)
  }

  // build a 3D CSS cube: top face, left = side, right = front (or side)
  function buildCube(top, side, front) {
    const cube = el('div', 'cube');
    const mk = (cls, p) => {
      const d = el('div', 'face ' + cls);
      if (p) d.style.backgroundImage = "url('" + texUrl(p) + "')";
      cube.appendChild(d);
    };
    mk('top', top); mk('left', side); mk('right', front || side);
    return cube;
  }

  function shortMat(name) { return String(name || '?').split(':').pop().slice(0, 12); }

  // resolved-icon cache (name -> {kind,...}) so grid rebuilds are synchronous & flicker-free
  const iconResultCache = new Map();
  let iconObserver = null;

  // fresh observer per grid render; disconnecting the old one releases detached cell holders
  function resetIconObserver() {
    if (iconObserver) iconObserver.disconnect();
    if ('IntersectionObserver' in window) {
      iconObserver = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { iconObserver.unobserve(e.target); loadIcon(e.target); }
        });
      }, { rootMargin: '300px' });
    } else {
      iconObserver = null;
    }
  }

  // Safety net for environments where IntersectionObserver never fires (e.g. a background/hidden
  // tab): if nothing has loaded shortly after a grid build, eager-load. In a normal visible tab IO
  // fires within a frame, so in-view holders already have content and this is a no-op (stays lazy).
  function scheduleIconFallback(grid) {
    setTimeout(() => {
      const holders = grid.querySelectorAll('.ic-holder');
      if (!holders.length) return;
      let anyLoaded = false;
      holders.forEach((h) => { if (h.childElementCount > 0) anyLoaded = true; });
      if (!anyLoaded) holders.forEach((h) => { if (h.childElementCount === 0) loadIcon(h); });
    }, 700);
  }

  // a placeholder .ic-holder that resolves its icon lazily (grid) or immediately (mat-ic preview)
  function makeIconHolder(material, sizePx, txtCls, lazy) {
    const holder = el('div', 'ic-holder');
    holder.style.setProperty('--sz', sizePx + 'px');
    holder.dataset.name = stripNs(String(material || '').toLowerCase()).replace(/\s+/g, '').trim();
    holder.dataset.txt = txtCls || 'cell-txt';
    if (lazy && iconObserver) iconObserver.observe(holder);
    else loadIcon(holder);
    return holder;
  }

  function loadIcon(holder) {
    const name = holder.dataset.name;
    const txtCls = holder.dataset.txt;
    if (!name) { holder.append(el('span', txtCls, '?')); return; }
    if (iconResultCache.has(name)) { renderResolved(holder, iconResultCache.get(name), name, txtCls); return; }

    // fast-path (no fetch): most real items have a flat item/<name>.png texture
    const img = document.createElement('img');
    img.className = 'flat'; img.loading = 'lazy'; img.alt = '';
    img.onload = () => { iconResultCache.set(name, { kind: 'flat', tex: 'item/' + name }); };
    img.onerror = () => {
      img.remove();
      resolveIconModel(name).then((res) => {
        iconResultCache.set(name, res);
        if (holder.isConnected) { clear(holder); renderResolved(holder, res, name, txtCls); }
      });
    };
    img.src = ICON_BASE + 'item/' + name + '.png';
    holder.append(img);
  }

  function renderResolved(holder, res, name, txtCls) {
    clear(holder);
    if (res.kind === 'flat') {
      const im = document.createElement('img');
      im.className = 'flat'; im.loading = 'lazy'; im.alt = '';
      im.onerror = () => { im.remove(); if (!holder.firstChild) holder.append(el('span', txtCls, shortMat(name))); };
      im.src = texUrl(res.tex);
      holder.append(im);
    } else if (res.kind === 'cube') {
      holder.append(buildCube(res.top, res.side, res.front));
    } else {
      // blank: only truly-unresolvable entity items (chest/bed/head/banner/shield/conduit)
      holder.append(el('span', txtCls, shortMat(name)));
    }
  }

  // props material preview (small): same resolver, rendered immediately
  function setMatIcon(material) {
    const holder = $('mat-ic');
    clear(holder);
    if (material && String(material).trim()) holder.append(makeIconHolder(material, 28, 'mi-txt', false));
  }

  // ================================================================== VIEW MODES (raw / graph)
  // raw and graph are mutually exclusive; both replace the center+right area.
  function syncModes() {
    const layout = $('layout');
    $('raw-toggle').setAttribute('aria-pressed', state.raw ? 'true' : 'false');
    $('graph-toggle').setAttribute('aria-pressed', state.graph ? 'true' : 'false');
    layout.classList.toggle('raw-mode', state.raw);
    layout.classList.toggle('graph-mode', state.graph);
    $('raw-wrap').hidden = !state.raw;
    $('graph-wrap').hidden = !state.graph;
    if (state.raw) dumpRaw();
    if (state.graph) renderGraph();
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
      if (!commitRaw()) { toast('Исправь YAML, затем выключи режим', 'err'); return; }
      state.raw = false;
      renderAll();
    } else {
      if (!current()) { toast('Нет выбранного меню', 'err'); return; }
      state.graph = false;   // mutually exclusive
      state.raw = true;
      syncModes();
    }
  }

  function toggleGraph() {
    if (state.graph) {
      state.graph = false;
      renderAll();
    } else {
      if (state.raw) { if (!commitRaw()) { toast('Исправь YAML, затем переключись', 'err'); return; } state.raw = false; }
      state.graph = true;
      syncModes();
    }
  }

  function showRawErr(msg) { const e = $('raw-err'); e.textContent = 'YAML: ' + msg; e.hidden = false; }
  function hideRawErr() { $('raw-err').hidden = true; }

  // ================================================================== NAVIGATION GRAPH
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  // every open_menu target anywhere in a menu object (clicks, dialog buttons, conditional branches)
  function collectOpenMenuTargets(obj) {
    const out = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.type === 'open_menu' && n.menu) out.push(String(n.menu));
      for (const k in n) walk(n[k]);
    })(obj);
    return out;
  }
  // nodes = menus (+ ghost nodes for dangling targets); edges = open_menu links (deduped)
  function buildGraphData() {
    const menus = state.menus;
    const idOf = new Map();
    menus.forEach((m, i) => idOf.set(m.id, i));
    const nodes = menus.map((m, i) => ({ id: m.id, type: (m.obj && m.obj.type) || '?', real: true, menuIndex: i }));
    const ghost = new Map();
    const seen = new Set();
    const edges = [];
    menus.forEach((m, i) => {
      collectOpenMenuTargets(m.obj).forEach((t) => {
        let to;
        if (idOf.has(t)) to = idOf.get(t);
        else { if (!ghost.has(t)) { ghost.set(t, nodes.length); nodes.push({ id: t, type: null, real: false }); } to = ghost.get(t); }
        const key = i + '>' + to;
        if (!seen.has(key)) { seen.add(key); edges.push({ from: i, to }); }
      });
    });
    return { nodes, edges };
  }
  // point on a node's box border (center cx,cy; half hw,hh) toward (tx,ty)
  function boxTrim(cx, cy, tx, ty, hw, hh) {
    const dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }
  function selfLoopPath(cx, cy) {
    const y = cy - 24;
    return 'M ' + (cx - 14) + ' ' + y + ' C ' + (cx - 44) + ' ' + (y - 48) + ', ' + (cx + 44) + ' ' + (y - 48) + ', ' + (cx + 14) + ' ' + y;
  }
  function graphDefs() {
    const defs = svgEl('defs');
    const m = svgEl('marker', { id: 'gm-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' })); // arrow follows the line color
    defs.append(m);
    return defs;
  }
  function renderGraph() {
    const wrap = $('graph-wrap');
    const svg = $('graph-svg');
    const note = $('graph-empty');
    clear(svg);
    graphEdges = [];
    if (!state.menus.length) { note.hidden = false; svg.style.display = 'none'; return; }
    note.hidden = true; svg.style.display = 'block';

    const data = buildGraphData();
    graphNodes = data.nodes;
    const rect = wrap.getBoundingClientRect();
    const W = Math.max(320, Math.round(rect.width) || 800);
    const H = Math.max(280, Math.round(rect.height) || 500);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', W); svg.setAttribute('height', H);

    // circle layout; keep any position already set (so drags persist)
    const cx = W / 2, cy = H / 2, R = Math.max(90, Math.min(W, H) / 2 - 80);
    const N = graphNodes.length;
    graphNodes.forEach((node, i) => {
      if (!graphPos[node.id]) {
        if (N === 1) graphPos[node.id] = { x: cx, y: cy };
        else { const a = -Math.PI / 2 + (i / N) * 2 * Math.PI; graphPos[node.id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }; }
      }
    });

    svg.append(graphDefs());
    const selId = current() ? current().id : null;

    // edges first (under nodes)
    data.edges.forEach((e) => {
      const A = graphNodes[e.from], B = graphNodes[e.to];
      const pa = graphPos[A.id], pb = graphPos[B.id];
      const hot = selId && (A.id === selId || B.id === selId);
      let line;
      if (e.from === e.to) {
        line = svgEl('path', { d: selfLoopPath(pa.x, pa.y), class: 'gedge' + (hot ? ' hot' : ''), 'marker-end': 'url(#gm-arrow)' });
      } else {
        const s = boxTrim(pa.x, pa.y, pb.x, pb.y, 55, 22), t = boxTrim(pb.x, pb.y, pa.x, pa.y, 55, 22);
        line = svgEl('line', { x1: s.x, y1: s.y, x2: t.x, y2: t.y, class: 'gedge' + (hot ? ' hot' : ''), 'marker-end': 'url(#gm-arrow)' });
      }
      svg.append(line);
      graphEdges.push({ from: e.from, to: e.to, node: line });
    });

    // nodes on top
    graphNodes.forEach((node, i) => {
      const p = graphPos[node.id];
      const g = svgEl('g', {
        class: 'gnode' + (node.real ? '' : ' ghost') + (node.real && node.id === selId ? ' sel' : ''),
        transform: 'translate(' + p.x + ',' + p.y + ')', 'data-i': i
      });
      g.append(svgEl('rect', { class: 'nbox', x: -55, y: -22, width: 110, height: 44, rx: 9 }));
      g.append(svgEl('text', { class: 'nid', x: 0, y: node.real ? -2 : 4, 'text-anchor': 'middle' }, node.id));
      g.append(svgEl('text', { class: 'ntype', x: 0, y: node.real ? 14 : 16, 'text-anchor': 'middle' }, node.real ? node.type : 'нет меню'));
      g.addEventListener('mousedown', (ev) => onGraphNodeDown(ev, i));
      svg.append(g);
    });
  }
  function svgPoint(svg, clientX, clientY) {
    const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
    const m = svg.getScreenCTM();
    if (!m) return { x: clientX, y: clientY };
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }
  // update one node's group + the endpoints of every edge that touches it (during drag)
  function updateGraphNode(i) {
    const svg = $('graph-svg');
    const node = graphNodes[i];
    const p = graphPos[node.id];
    const g = svg.querySelector('.gnode[data-i="' + i + '"]');
    if (g) g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    graphEdges.forEach((e) => {
      if (e.from !== i && e.to !== i) return;
      const pa = graphPos[graphNodes[e.from].id], pb = graphPos[graphNodes[e.to].id];
      if (e.from === e.to) { e.node.setAttribute('d', selfLoopPath(pa.x, pa.y)); return; }
      const s = boxTrim(pa.x, pa.y, pb.x, pb.y, 55, 22), t = boxTrim(pb.x, pb.y, pa.x, pa.y, 55, 22);
      e.node.setAttribute('x1', s.x); e.node.setAttribute('y1', s.y);
      e.node.setAttribute('x2', t.x); e.node.setAttribute('y2', t.y);
    });
  }
  function onGraphNodeDown(ev, i) {
    ev.preventDefault();
    const node = graphNodes[i];
    const svg = $('graph-svg');
    let moved = false;
    const move = (e) => {
      moved = true;
      const pt = svgPoint(svg, e.clientX, e.clientY);
      graphPos[node.id] = { x: pt.x, y: pt.y };
      updateGraphNode(i);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (!moved && node.real) selectMenuFromGraph(node.menuIndex); // click (no drag) selects the menu
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  // clicking a node selects that menu but stays in the graph view (re-highlights)
  function selectMenuFromGraph(i) {
    state.sel = i;
    resetSelection();
    renderSidebar();
    $('cur-menu-id').textContent = state.menus[i] ? state.menus[i].id : '—';
    renderGraph();
  }

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
    resetSelection();
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
    resetSelection();
    renderAll();
    toast('Дубликат: «' + id + '»', 'ok');
  }

  function deleteMenu() {
    const m = current();
    if (!m) return;
    if (!window.confirm('Удалить меню «' + m.id + '»? Действие применится после сохранения.')) return;
    state.menus.splice(state.sel, 1);
    state.sel = state.menus.length ? Math.max(0, state.sel - 1) : -1;
    resetSelection();
    state.raw = false;
    renderAll();
    if (!state.menus.length) $('cur-menu-id').textContent = '—';
  }

  // ================================================================== SLOT actions (bulk)
  function clearSlot() {
    const m = current();
    if (!m || !m.obj.items) return;
    targetSlots().forEach((s) => delete m.obj.items[String(s)]);
    renderGrid();
    renderProps();
  }

  // ================================================================== CONTEXT MENU (right-click)
  function hideContextMenu() { $('ctx-menu').hidden = true; }

  function openContextMenu(x, y) {
    const menu = $('ctx-menu');
    clear(menu);
    buildContextItems().forEach((it) => {
      if (it.sep) { menu.append(el('div', 'ctx-sep')); return; }
      const row = el('div', 'ctx-item' + (it.enabled === false ? ' disabled' : ''), it.label);
      if (it.enabled !== false) {
        // mousedown (not click) so it fires before the document-level close handler
        row.addEventListener('mousedown', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          hideContextMenu();
          it.fn();
        });
      }
      menu.append(row);
    });
    menu.hidden = false;
    // clamp to viewport
    const rect = menu.getBoundingClientRect();
    let px = x, py = y;
    if (px + rect.width > window.innerWidth) px = Math.max(4, window.innerWidth - rect.width - 6);
    if (py + rect.height > window.innerHeight) py = Math.max(4, window.innerHeight - rect.height - 6);
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';
  }

  function buildContextItems() {
    const n = targetSlots().length;
    const activeHas = !!activeItem();
    return [
      { label: 'Редактировать', fn: () => { const f = $('f-material'); if (f) f.focus(); } },
      { label: 'Копировать', enabled: activeHas, fn: () => { state.clipboard = JSON.parse(JSON.stringify(activeItem())); toast('Скопировано в буфер', 'ok'); } },
      { label: n > 1 ? ('Вставить в выделенные (' + n + ')') : 'Вставить', enabled: !!state.clipboard, fn: () => { pasteInto(targetSlots(), state.clipboard); renderGrid(); renderProps(); } },
      { label: 'Дублировать в выделенные', enabled: activeHas && n > 1, fn: () => { dupIntoSelected(); renderGrid(); renderProps(); } },
      { label: n > 1 ? ('Очистить выделенные (' + n + ')') : 'Очистить', fn: () => { clearSlot(); } },
      { sep: true },
      { label: 'Выделить всё', fn: () => { selectAll(); } },
      { label: 'Снять выделение', fn: () => { clearSelection(); } }
    ];
  }

  function pasteInto(slots, elObj) {
    const m = current();
    if (!m || !elObj) return;
    if (!m.obj.items) m.obj.items = {};
    slots.forEach((s) => { m.obj.items[String(s)] = JSON.parse(JSON.stringify(elObj)); });
  }
  function dupIntoSelected() {
    const src = activeItem();
    if (!src) return;
    const m = current();
    if (!m.obj.items) m.obj.items = {};
    targetSlots().forEach((s) => { if (s !== state.active) m.obj.items[String(s)] = JSON.parse(JSON.stringify(src)); });
  }
  function selectAll() {
    const c = gridCount();
    const s = new Set();
    for (let i = 0; i < c; i++) s.add(i);
    state.selected = s;
    if (state.active == null && c > 0) state.active = 0;
    renderGrid();
    renderProps();
  }
  function clearSelection() {
    resetSelection();
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
  // number of grid cells for the current menu (0 for non-grid types)
  function gridCount() {
    const m = current();
    if (!m) return 0;
    const t = m.obj.type || 'chest';
    if (t !== 'chest' && t !== 'inventory') return 0;
    return t === 'inventory' ? 27 : rowsOf(m.obj) * 9;
  }

  // ================================================================== static wiring
  function wireStaticUi() {
    $('save-btn').onclick = saveBundle;
    $('raw-toggle').onclick = toggleRaw;
    $('graph-toggle').onclick = toggleGraph;
    $('raw-yaml').addEventListener('blur', commitRaw);

    $('new-menu-btn').onclick = openNewMenu;
    $('dup-menu-btn').onclick = duplicateMenu;
    $('del-menu-btn').onclick = deleteMenu;
    $('clear-slot-btn').onclick = clearSlot;

    // bulk clicks: any field edit inside #f-clicks propagates to all selected slots
    $('f-clicks').addEventListener('input', () => { if (targetSlots().length > 1) propagateClicks(); });
    $('f-clicks').addEventListener('change', () => { if (targetSlots().length > 1) propagateClicks(); });

    // drag-select finishes anywhere on the page
    document.addEventListener('mouseup', onDocMouseUp);

    // context menu: close when clicking outside it
    document.addEventListener('mousedown', (e) => {
      const menu = $('ctx-menu');
      if (!menu.hidden && !menu.contains(e.target)) hideContextMenu();
    });

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

    // close overlays on backdrop click
    document.querySelectorAll('.overlay').forEach((ov) => {
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.hidden = true; });
    });
    // Esc closes overlays and the context menu
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.overlay').forEach((o) => (o.hidden = true));
        hideContextMenu();
      }
    });
  }

  // go
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
