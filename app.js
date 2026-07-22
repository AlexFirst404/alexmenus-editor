/* AlexMenus web editor — vanilla JS SPA (js-yaml v4 is the only external dep).
 *
 * DATA FLOW
 *   load:  #<code>            (bare, clean link)  -> worker from localStorage (asked once per browser)
 *          #k=<code>&w=<url>  (legacy, back-compat) -> worker from w= (also remembered)
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
  // deepslate WebGL block renderer (optional, loaded lazily on first block icon). Renders BLOCK items
  // as exact 1.21.11 3D inventory images; flat item/generated items keep the cheaper texture path.
  // All three endpoints verified 200 + `Access-Control-Allow-Origin: *` (canvas-clean).
  const DEEPSLATE_URL = 'https://cdn.jsdelivr.net/npm/deepslate@0.26.0/+esm';
  const ATLAS_PNG_URL = 'https://cdn.jsdelivr.net/gh/misode/mcmeta@1.21.11-atlas/all/atlas.png';
  const ATLAS_DATA_URL = 'https://cdn.jsdelivr.net/gh/misode/mcmeta@1.21.11-atlas/all/data.min.json';
  const DS_RENDER_PX = 64; // resolution of the single reused offscreen WebGL2 canvas
  // face-texture priority lists for resolving a cube's top/side from a model's textures map
  const TOP_KEYS = ['up', 'top', 'end', 'all', 'side', 'north', 'texture', 'particle', 'wall', 'cross'];
  const SIDE_KEYS = ['side', 'north', 'west', 'south', 'east', 'all', 'texture', 'particle', 'wall', 'up', 'top'];
  const modelCache = new Map();   // model path -> Promise<json|null>  (dedupes CDN fetches)
  const itemDefCache = new Map(); // item name -> Promise<json|null>   (1.21.4 item-definitions)
  const BUNDLE_VERSION = 1;

  // Paste-service Worker base URL. The default is the shared public paste worker on a NEUTRAL subdomain
  // (no account handle), so the editor is zero-config. An explicit `?w=` in the link overrides it; forks
  // that blank DEFAULT_WORKER fall back to a saved value or a one-time prompt.
  const DEFAULT_WORKER = 'https://alexmenus-paste.alexmenus.workers.dev';
  const WORKER_STORE_KEY = 'am_worker';

  function storedWorker() {
    try { return (localStorage.getItem(WORKER_STORE_KEY) || '').trim().replace(/\/+$/, ''); }
    catch (e) { return ''; }
  }
  function rememberWorker(url) {
    const clean = (url || '').trim().replace(/\/+$/, '');
    try { if (clean) localStorage.setItem(WORKER_STORE_KEY, clean); } catch (e) { /* private mode */ }
    return clean;
  }
  // async: uses the themed modalPrompt (no browser prompt). Rarely reached now that DEFAULT_WORKER
  // is set, but kept for forks that blank the default.
  async function askWorker() {
    const msg = 'Адрес paste-воркера (из config.yml плагина, поле editor.worker-url), '
              + 'напр. https://alexmenus-paste.<акк>.workers.dev';
    const inp = await modalPrompt('Адрес paste-воркера', { label: msg, value: storedWorker() || 'https://', placeholder: 'https://…' });
    return inp == null ? '' : rememberWorker(inp);
  }
  // Resolve the Worker for this session: an explicit `?w=` wins (and is remembered); otherwise the baked
  // default is used (zero-config — and it takes precedence over any stale saved value, e.g. an old worker
  // URL a tester typed before the default existed). Forks that blank DEFAULT_WORKER fall back to storage/prompt.
  async function resolveWorker(fromParam) {
    const w = (fromParam || '').trim().replace(/\/+$/, '');
    if (w) return rememberWorker(w);
    if (DEFAULT_WORKER) return DEFAULT_WORKER;
    return storedWorker() || await askWorker();
  }

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

  // requirement types the STRUCTURED builder understands; composites (all/any/not) and anything
  // else are edited via the per-requirement «Расширенно (raw)» YAML box. (See REQUIREMENTS.)
  const REQ_TYPES = [
    ['', '— нет —'],
    ['permission', 'Право (permission)'],
    ['placeholder', 'Плейсхолдер (placeholder)'],
    ['money', 'Деньги (money)'],
    ['has_item', 'Предмет (has_item)'],
    ['exp', 'Опыт (exp)']
  ];
  const REQ_STRUCTURED = ['permission', 'placeholder', 'money', 'has_item', 'exp'];
  const PLACEHOLDER_OPS = ['==', '!=', 'contains', 'contains_ignorecase', 'equals_ignorecase', 'regex', '>', '<', '>=', '<='];

  // ------------------------------------------------------------------ state
  const state = {
    workerBase: '',        // Worker base URL (from hash `w=`, or saved in localStorage)
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
  async function init() {
    wireStaticUi();
    const hash = parseHash();
    if (!hash.k) {
      // No code -> friendly empty state explaining how to open the editor.
      show('empty-state');
      return;
    }
    state.code = hash.k;
    state.workerBase = await resolveWorker(hash.w);
    if (!state.workerBase) {   // no worker configured for this browser -> can't load; explain
      show('empty-state');
      return;
    }
    loadBundle();
  }

  // Parse location.hash. Supports two forms (the worker is resolved separately, not baked here):
  //   `#<code>`               (bare/clean link) -> code = whole fragment, worker from storage/prompt
  //   `#k=<code>&w=<url-enc>`  (legacy)          -> code from k=, explicit worker from w=
  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '').trim();
    if (!raw) return { k: '', w: '' };

    if (/(?:^|&)[kw]=/.test(raw)) {           // param form: contains a k= or w=
      const p = new URLSearchParams(raw);
      let w = p.get('w') || '';
      if (w) { try { w = decodeURIComponent(w); } catch (e) { /* already decoded */ } }
      return { k: (p.get('k') || '').trim(), w: w.trim().replace(/\/+$/, '') };
    }
    // bare form: the entire fragment is the paste code (worker comes from storage/prompt)
    return { k: raw, w: '' };
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

    // open-requirement (block: require + deny/success actions) — top-level menu key
    buildReqBlock($('req-open'),
      () => (m.obj['open-requirement'] != null ? m.obj['open-requirement'] : null),
      (block) => { if (block == null) delete m.obj['open-requirement']; else m.obj['open-requirement'] = block; });
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
      // plain click selects the cell; the item is materialised only once a material is chosen
      // (via the picker or the material field) — an empty slot never becomes a STONE placeholder.
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

    // material (+ live icon) — bulk. Typing a material CREATES the item(s) with exactly that
    // material (never a STONE default); the picker button opens the full material list (feature 4).
    const fMat = $('f-material');
    fMat.value = disp.material != null ? String(disp.material) : '';
    setMatIcon(disp.material);
    fMat.oninput = () => assignMaterialLive(fMat.value);
    fMat.onchange = () => { setMatIcon(fMat.value); renderGrid(); renderProps(); };

    // EMPTY-slot state: no item yet -> show the "pick a material" prompt and HIDE the rest of the
    // editor, so name/lore/flags/requirements can never materialise a STONE placeholder.
    $('slot-nomat-hint').hidden = !!real;
    $('slot-rest').hidden = !real;
    if (!real) return;

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
    renderSlotRequirements(disp);   // view-requirement + click-requirement builders (bulk-aware)
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
        if (!real) return;   // no item yet (empty slot) — pick a material first
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
  // the active slot's element, or null. Does NOT auto-create (click-editing only renders once an
  // item exists), so it can never introduce a STONE placeholder.
  function ensureActiveElement() {
    const m = current();
    if (!m || state.active == null || !m.obj.items) return null;
    return m.obj.items[String(state.active)] || null;
  }
  // material used when a bulk edit must CREATE an item in a selected-but-empty slot: the active
  // slot's own material (so name/lore/flags spread with the right item), or null when there is none.
  function creationMaterial() {
    const a = activeItem();
    return (a && a.material != null && String(a.material).trim() !== '') ? a.material : null;
  }
  // element objects for every target slot. Missing items are created with creationMaterial(); if
  // there is no chosen material, the empty slot is SKIPPED — we never invent a STONE placeholder.
  function targetItems() {
    const m = current();
    if (!m) return [];
    if (!m.obj.items) m.obj.items = {};
    const mat = creationMaterial();
    const out = [];
    targetSlots().forEach((slot) => {
      const k = String(slot);
      if (!m.obj.items[k]) {
        if (mat == null) return;
        m.obj.items[k] = { material: mat };
      }
      out.push(m.obj.items[k]);
    });
    return out;
  }
  // Live material edit from the text field: set material on the active slot + every selected slot,
  // creating items ONLY where a non-empty material is given (never a STONE default).
  function assignMaterialLive(val) {
    const m = current();
    if (!m) return;
    if (!m.obj.items) m.obj.items = {};
    const before = filledCount();
    const empty = String(val).trim() === '';
    targetSlots().forEach((s) => {
      const k = String(s);
      if (empty) delete m.obj.items[k];              // clearing the material removes the item (no phantom {material:''})
      else if (m.obj.items[k]) m.obj.items[k].material = val;
      else m.obj.items[k] = { material: val };
    });
    updateSelCounter();
    if (filledCount() !== before) renderGrid();
  }
  // Assign a concrete material (from the picker) to the given slots: create items where missing with
  // that material, otherwise just change the material. Never uses a STONE default.
  function assignMaterial(mat, slots) {
    const m = current();
    if (!m) return;
    if (!m.obj.items) m.obj.items = {};
    slots.forEach((s) => {
      const k = String(s);
      if (m.obj.items[k]) m.obj.items[k].material = mat;
      else m.obj.items[k] = { material: mat };
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

  // ================================================================== REQUIREMENTS
  // view/click (per item) + open (per menu). A *requirement* = { type, ...fields, negate? }; the
  // structured builder covers permission/placeholder/money/has_item/exp, and a per-requirement raw
  // YAML box edits anything (incl. all/any/not composites). `view-requirement` = a bare requirement;
  // `click-requirement`/`open-requirement` = a BLOCK { require, deny:[actions], success?:[actions] }.
  // These round-trip straight into the obj keys the plugin parses (jsyaml.dump handles the rest).

  const isStructuredReq = (t) => REQ_STRUCTURED.indexOf(t) !== -1;
  const numOr = (v, d) => { const n = Number(v); return (isFinite(n) && String(v).trim() !== '') ? n : d; };

  // Write (or delete) a requirement key on every TARGET slot that ALREADY holds an item — the active
  // slot plus any others in the selection (bulk), deep-cloned. Empty slots are skipped on BOTH the
  // set and clear paths: requirements constrain existing items and must never materialise a STONE
  // placeholder. (Plain-clicking a cell already creates its item, so the active slot is normally set.)
  function writeReqKey(key, value) {
    const m = current();
    if (!m || !m.obj.items) return;
    targetSlots().forEach((s) => {
      const it = m.obj.items[String(s)];
      if (!it) return;                                  // never create an item just to hold a requirement
      if (value == null) delete it[key];
      else it[key] = JSON.parse(JSON.stringify(value));
    });
  }

  // Renders a single-requirement builder into `host`. `initial` = existing requirement (or null).
  // `onChange(value)` fires on every user edit with the requirement object, or null when cleared.
  // Populating (the initial render) does NOT emit — round-trip only writes back on real edits.
  function buildRequirementBuilder(host, initial, onChange) {
    clear(host);
    host.classList.add('req-builder');
    const structured = !initial || isStructuredReq(initial.type);
    const local = { raw: !structured };   // composites/unknown types open straight in the raw box
    let refs = {};

    // controls row: type <select> + «Расширенно (raw)» toggle
    const ctrls = el('div', 'req-ctrls');
    const typeSel = el('select', 'in');
    REQ_TYPES.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; typeSel.append(o); });
    typeSel.value = (initial && isStructuredReq(initial.type)) ? initial.type : '';
    const rawBtn = el('button', 'btn small req-raw-toggle', 'Расширенно');
    rawBtn.type = 'button';
    ctrls.append(typeSel, rawBtn);

    const fieldsBox = el('div', 'req-fields');
    const negLab = el('label', 'check req-negate');
    const negCb = document.createElement('input'); negCb.type = 'checkbox';
    negCb.checked = !!(initial && initial.negate);
    negLab.append(negCb, el('span', null, 'Инвертировать (negate)'));

    const rawBox = el('div', 'req-raw');
    const rawTa = document.createElement('textarea');
    rawTa.className = 'in area'; rawTa.spellcheck = false; rawTa.rows = 4;
    rawTa.placeholder = 'type: any\nof:\n  - { type: permission, permission: a.b }\n  - { type: money, amount: 100 }';
    if (initial && !structured) rawTa.value = jsyaml.dump(initial, { lineWidth: -1, noRefs: true, indent: 2 }).trim();
    const rawErr = el('div', 'req-raw-err'); rawErr.hidden = true;
    rawBox.append(rawTa, rawErr);

    host.append(ctrls, fieldsBox, negLab, rawBox);

    // gather the structured value from the current inputs (null when no type is chosen)
    function collectStructured() {
      const type = typeSel.value;
      if (!type) return null;
      const req = { type };
      if (type === 'permission') req.permission = refs.permission.value;
      else if (type === 'placeholder') { req.placeholder = refs.placeholder.value; req.operator = refs.operator.value; req.value = refs.value.value; }
      else if (type === 'money') req.amount = numOr(refs.amount.value, 0);
      else if (type === 'has_item') { req.material = refs.material.value; req.amount = numOr(refs.amount.value, 1); }
      else if (type === 'exp') { req.amount = numOr(refs.amount.value, 0); req.level = refs.level.checked; }
      if (negCb.checked) req.negate = true;
      return req;
    }

    function emit() {
      if (local.raw) {
        const txt = rawTa.value.trim();
        if (txt === '') { rawErr.hidden = true; rawTa.style.borderColor = ''; onChange(null); return; }
        try {
          const parsed = jsyaml.load(txt);
          if (!parsed || typeof parsed !== 'object') throw new Error('ожидается объект');
          rawErr.hidden = true; rawTa.style.borderColor = '';
          onChange(parsed);
        } catch (e) {
          rawErr.textContent = 'YAML: ' + (e && e.message ? e.message : 'ошибка');
          rawErr.hidden = false; rawTa.style.borderColor = 'var(--danger)';
          // invalid raw -> leave the obj untouched until it parses again
        }
        return;
      }
      onChange(collectStructured());
    }

    // one field registered in `refs` and wired to emit; `kind` = text | number | select | check
    function addField(key, label, kind, opts) {
      opts = opts || {};
      if (kind === 'check') {
        const lab = el('label', 'check');
        const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!opts.value;
        inp.onchange = emit;
        lab.append(inp, el('span', null, label));
        refs[key] = inp; fieldsBox.append(lab); return;
      }
      let inp;
      if (kind === 'select') {
        inp = el('select', 'in');
        (opts.options || []).forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; inp.append(o); });
        inp.value = opts.value != null ? opts.value : '';
        inp.onchange = emit;
      } else {
        inp = document.createElement('input');
        inp.type = kind === 'number' ? 'number' : 'text'; inp.className = 'in';
        if (kind === 'number') inp.step = 'any';
        inp.value = opts.value != null ? String(opts.value) : '';
        if (opts.placeholder) inp.placeholder = opts.placeholder;
        inp.oninput = emit;
      }
      refs[key] = inp;
      fieldsBox.append(labelWrap(label, inp));
    }

    function renderFields() {
      clear(fieldsBox);
      refs = {};
      const type = typeSel.value;
      const src = (initial && initial.type === type) ? initial : {};  // seed from initial only on a match
      if (type === 'permission') {
        addField('permission', 'Право (node)', 'text', { value: src.permission, placeholder: 'напр. menus.shop' });
      } else if (type === 'placeholder') {
        addField('placeholder', 'Плейсхолдер', 'text', { value: src.placeholder, placeholder: '%player_name%' });
        addField('operator', 'Оператор', 'select', { value: src.operator || '==', options: PLACEHOLDER_OPS });
        addField('value', 'Значение', 'text', { value: src.value, placeholder: 'сравнить с…' });
      } else if (type === 'money') {
        addField('amount', 'Сумма', 'number', { value: src.amount != null ? src.amount : '' });
      } else if (type === 'has_item') {
        addField('material', 'Материал', 'text', { value: src.material, placeholder: 'DIAMOND' });
        addField('amount', 'Кол-во', 'number', { value: src.amount != null ? src.amount : 1 });
      } else if (type === 'exp') {
        addField('amount', 'Кол-во', 'number', { value: src.amount != null ? src.amount : '' });
        addField('level', 'В уровнях (level)', 'check', { value: src.level === true });
      }
    }

    function syncMode() {
      rawBtn.setAttribute('aria-pressed', local.raw ? 'true' : 'false');
      typeSel.disabled = local.raw;
      fieldsBox.hidden = local.raw;
      negLab.hidden = local.raw || !typeSel.value;
      rawBox.hidden = !local.raw;
    }

    // Toggling modes only swaps which editor is shown — it must SYNC the value across, never emit.
    // (The obj is already current from per-keystroke emits, so a toggle must not rewrite/delete it.)
    rawBtn.onclick = () => {
      if (!local.raw) {
        // structured -> raw: carry the CURRENT structured value into the box verbatim (overwrite)
        const cur = collectStructured();
        rawTa.value = cur ? jsyaml.dump(cur, { lineWidth: -1, noRefs: true, indent: 2 }).trim() : '';
        rawErr.hidden = true; rawTa.style.borderColor = '';
        local.raw = true;
        syncMode();
        return;
      }
      // raw -> structured: only switch when the YAML is a representable STRUCTURED requirement;
      // for composites (all/any/not/unknown) or invalid YAML, STAY in raw — never null the value.
      const txt = rawTa.value.trim();
      if (txt !== '') {
        let parsed;
        try { parsed = jsyaml.load(txt); }
        catch (e) { toast('Исправьте YAML, затем переключитесь в простой режим', 'err'); return; }
        if (!parsed || typeof parsed !== 'object' || !isStructuredReq(parsed.type)) {
          toast('Композит/сложное условие — редактируется только в raw', 'err');
          return;   // keep raw mode; the requirement is left exactly as-is
        }
        initial = parsed;                 // reseed the structured inputs from the (edited) raw value
      } else {
        initial = null;                   // empty box -> empty structured (obj already reflects this)
      }
      typeSel.value = (initial && isStructuredReq(initial.type)) ? initial.type : '';
      negCb.checked = !!(initial && initial.negate);
      renderFields();
      rawErr.hidden = true; rawTa.style.borderColor = '';
      local.raw = false;
      syncMode();
    };
    typeSel.onchange = () => { renderFields(); syncMode(); emit(); };
    negCb.onchange = emit;
    rawTa.oninput = emit;

    renderFields();
    syncMode();
  }

  // generic action-list editor (deny/success). `actions` is a live array mutated in place; `onChange`
  // fires after structural edits, and per-field typing bubbles to a delegated listener on the host.
  function renderActionList(host, actions, onChange) {
    clear(host);
    actions.forEach((a, idx) => host.append(buildGenericActionRow(host, actions, idx, onChange)));
    const add = el('button', 'btn small add-action', '＋ действие');
    add.type = 'button';
    add.onclick = () => { actions.push({ type: 'message', text: '' }); onChange(); renderActionList(host, actions, onChange); };
    host.append(add);
  }
  function buildGenericActionRow(host, actions, idx, onChange) {
    const a = actions[idx];
    const row = el('div', 'action-row');
    const top = el('div', 'action-top');
    const sel = el('select', 'in');
    ACTION_TYPES.forEach(([val, lab]) => { const o = document.createElement('option'); o.value = val; o.textContent = lab; sel.append(o); });
    sel.value = a.type || 'message';
    sel.onchange = () => { actions[idx] = defaultAction(sel.value); onChange(); renderActionList(host, actions, onChange); };
    const del = el('button', 'btn icon', '×'); del.type = 'button'; del.title = 'Удалить действие';
    del.onclick = () => { actions.splice(idx, 1); onChange(); renderActionList(host, actions, onChange); };
    top.append(sel, del);
    row.append(top);
    const fields = el('div', 'action-fields');
    buildActionFields(fields, a);   // reuses the clicks field editor; mutates `a` in place
    row.append(fields);
    return row;
  }

  // block editor: require (single-requirement builder) + deny + optional success action lists.
  // `getBlock()`/`setBlock(block|null)` abstract storage + bulk (item click-req vs menu open-req).
  function buildReqBlock(host, getBlock, setBlock) {
    clear(host);
    const b = getBlock() || {};
    // Derive the condition: an explicit `require:` wins; otherwise a hand-authored BARE block (no
    // require/deny/success wrapper — the whole map IS the condition, which the plugin also accepts)
    // is preserved so the first edit doesn't silently drop the gate. commit() re-normalises it.
    let cond = null;
    if (b && b.require !== undefined) {
      cond = b.require;
    } else if (b && typeof b === 'object') {
      const leftover = {};
      Object.keys(b).forEach((k) => { if (k !== 'require' && k !== 'deny' && k !== 'success') leftover[k] = b[k]; });
      if (Object.keys(leftover).length) cond = leftover;
    }
    const work = {
      require: (cond != null) ? JSON.parse(JSON.stringify(cond)) : null,
      deny: (b && Array.isArray(b.deny)) ? JSON.parse(JSON.stringify(b.deny)) : [],
      success: (b && Array.isArray(b.success)) ? JSON.parse(JSON.stringify(b.success)) : []
    };
    // re-serialise the working copies into a block (or delete when fully empty)
    function commit() {
      const block = {};
      if (work.require != null) block.require = work.require;
      if (work.deny.length) block.deny = work.deny;
      if (work.success.length) block.success = work.success;   // omitted unless the user set it
      setBlock(Object.keys(block).length ? block : null);
    }

    host.append(el('span', 'req-sub-lbl', 'Условие (require)'));
    const reqHost = el('div');
    host.append(reqHost);
    mountRequirementEditor(reqHost, work.require, (val) => { work.require = val; commit(); });

    host.append(el('span', 'req-sub-lbl', 'При отказе (deny)'));
    const denyHost = el('div', 'req-actions');
    denyHost.addEventListener('input', commit);   // field typing -> re-serialise
    denyHost.addEventListener('change', commit);
    host.append(denyHost);
    renderActionList(denyHost, work.deny, commit);

    // success is tucked into a <details> so it stays out of the way until wanted
    const succWrap = document.createElement('details');
    succWrap.className = 'req-success';
    const succSum = document.createElement('summary');
    succSum.textContent = 'При успехе (success)';
    if (work.success.length) succWrap.open = true;
    succWrap.append(succSum);
    const succHost = el('div', 'req-actions');
    succHost.addEventListener('input', commit);
    succHost.addEventListener('change', commit);
    succWrap.append(succHost);
    host.append(succWrap);
    renderActionList(succHost, work.success, commit);
  }

  // single (bare) requirement editor — used for view-requirement
  function buildReqSingle(host, getReq, setReq) {
    const cur = getReq();
    mountRequirementEditor(host, cur ? JSON.parse(JSON.stringify(cur)) : null, setReq);
  }

  // ================================================================== REQUIREMENT NODE-GRAPH
  // A visual "block-programming" editor for the SAME requirement tree the structured/raw builders
  // edit. It renders the requirement as SVG nodes + wires (reusing the «Граф» drag/render approach):
  // logic nodes (ALL/ANY/NOT, accent-coloured) wired to their children, leaf condition nodes showing
  // type + a short summary. The internal model (nodes keyed by generated ids) is serialised to/from
  // the EXACT data-model shape the plugin parses:
  //   leaf  -> { type, ...fields, negate? }
  //   all/any -> { type:'all'|'any', of:[ <child>, ... ] }   (AND / OR)
  //   not   -> { type:'not', of: <child> }                    (single child)
  // The whole requirement is one root node. Every graph edit re-serialises and writes back through the
  // SAME onChange path the structured builder uses, so Save / raw-YAML round-trip correctly.

  const RG_NODE_W = 140, RG_NODE_H = 48;   // node box size (shared by layout + render)

  // ---- model <-> requirement-object serialisation (the CRITICAL correctness path) ----

  // Build internal nodes from a requirement object; returns the new node id (parent linkage set).
  function reqToNodes(model, reqObj, parentId) {
    const id = model.newId();
    const t = reqObj && typeof reqObj === 'object' ? reqObj.type : null;
    if (t === 'all' || t === 'any') {
      const node = { id, kind: t, cond: null, children: [], parent: parentId };
      model.nodes[id] = node;
      const of = Array.isArray(reqObj.of) ? reqObj.of : [];
      of.forEach((c) => { if (c != null) node.children.push(reqToNodes(model, c, id)); });
    } else if (t === 'not') {
      const node = { id, kind: 'not', cond: null, children: [], parent: parentId };
      model.nodes[id] = node;
      const ch = reqObj.of;   // a single requirement, OR (list-form) the negation of an implicit `all`
      if (Array.isArray(ch)) {
        const items = ch.filter((c) => c != null);
        if (items.length === 1) {
          node.children.push(reqToNodes(model, items[0], id));
        } else if (items.length > 1) {
          // list-form NOT = !(A and B …) → NOT over an implicit ALL, so no child is dropped
          const allId = model.newId();
          model.nodes[allId] = { id: allId, kind: 'all', cond: null, children: [], parent: id };
          items.forEach((c) => model.nodes[allId].children.push(reqToNodes(model, c, allId)));
          node.children.push(allId);
        }
      } else if (ch != null && typeof ch === 'object') {
        node.children.push(reqToNodes(model, ch, id));
      }
    } else {
      // leaf condition (permission/placeholder/money/has_item/exp, or any unrecognised leaf)
      const cond = (reqObj && typeof reqObj === 'object') ? JSON.parse(JSON.stringify(reqObj)) : { type: 'permission', permission: '' };
      model.nodes[id] = { id, kind: 'leaf', cond, children: [], parent: parentId };
    }
    return id;
  }

  // Walk the model from the root and produce the requirement object (or null when empty). Produces a
  // FRESH object each call (never aliases model.cond), so writing it back can't be mutated underfoot.
  function serializeGraph(model) {
    function walk(id) {
      const n = model.nodes[id];
      if (!n) return null;
      if (n.kind === 'all' || n.kind === 'any') {
        const of = n.children.map(walk).filter((x) => x != null);
        return of.length ? { type: n.kind, of } : null;   // empty group => null (NOT a fails-open {of:[]})
      }
      if (n.kind === 'not') {
        const of = n.children.map(walk).filter((x) => x != null);
        if (!of.length) return null;                        // childless NOT => null (NOT a fails-closed {of:null})
        return { type: 'not', of: of.length === 1 ? of[0] : { type: 'all', of } };
      }
      return JSON.parse(JSON.stringify(n.cond));   // leaf
    }
    if (!model.rootId || !model.nodes[model.rootId]) return null;
    return walk(model.rootId);
  }

  // fresh model (optionally seeded from an existing requirement object)
  function makeReqGraphModel(initial) {
    let counter = 0;
    const model = { nodes: {}, rootId: null, pos: {}, selected: null, newId: () => 'rg' + (++counter) };
    if (initial && typeof initial === 'object') model.rootId = reqToNodes(model, initial, null);
    return model;
  }

  // ---- model mutations (all keep parent/children consistent + predictable) ----
  function rgRemoveSubtree(model, id) {
    const n = model.nodes[id];
    if (!n) return;
    n.children.slice().forEach((c) => rgRemoveSubtree(model, c));
    delete model.nodes[id];
    delete model.pos[id];
  }
  // is `ancestorId` an ancestor of (or equal to) `id`?  (walk up the parent chain)
  function rgIsAncestor(model, ancestorId, id) {
    let c = id;
    while (c != null) { if (c === ancestorId) return true; const n = model.nodes[c]; c = n ? n.parent : null; }
    return false;
  }
  // replace node `id` (and its subtree) with the deserialised `reqObj`, keeping its slot under its parent
  function rgReplaceSubtree(model, id, reqObj) {
    const n = model.nodes[id];
    const parentId = n ? n.parent : null;
    const parent = parentId != null ? model.nodes[parentId] : null;
    const idx = parent ? parent.children.indexOf(id) : -1;
    rgRemoveSubtree(model, id);
    const nid = reqToNodes(model, reqObj, parentId);
    if (parent) { if (idx >= 0) parent.children[idx] = nid; else parent.children.push(nid); }
    else model.rootId = nid;
    return nid;
  }
  // drag-drop reparent: move `id` under logic node `newParentId` (guards cycles + NOT-arity + leaf targets)
  function rgReparent(model, id, newParentId) {
    if (id === newParentId) return false;
    const n = model.nodes[id], np = model.nodes[newParentId];
    if (!n || !np || np.kind === 'leaf') return false;
    if (rgIsAncestor(model, id, newParentId)) return false;                 // target is inside the dragged subtree
    if (np.kind === 'not' && np.children.length >= 1 && np.children[0] !== id) return false; // NOT is single-child
    if (n.parent != null) { const op = model.nodes[n.parent]; if (op) { const i = op.children.indexOf(id); if (i >= 0) op.children.splice(i, 1); } }
    n.parent = newParentId;
    if (np.children.indexOf(id) < 0) np.children.push(id);
    return true;
  }

  // ---- layout: tidy top-down tree (root at top). Manual drags override per-node in model.pos. ----
  function rgLayout(model) {
    const LEVEL_H = 96, GAP_X = 26, TOP = 30, LEFT = 90;
    let leaf = 0;
    function assign(id, depth) {
      const n = model.nodes[id];
      if (!n) return;
      n._cy = TOP + depth * LEVEL_H + RG_NODE_H / 2;
      if (!n.children.length) { n._cx = LEFT + leaf * (RG_NODE_W + GAP_X); leaf++; }
      else {
        n.children.forEach((c) => assign(c, depth + 1));
        const f = model.nodes[n.children[0]]._cx, l = model.nodes[n.children[n.children.length - 1]]._cx;
        n._cx = (f + l) / 2;
      }
    }
    if (model.rootId && model.nodes[model.rootId]) assign(model.rootId, 0);
  }

  // ---- leaf display helpers ----
  function rgClip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function rgLeafType(cond) { return (cond && cond.negate ? '¬ ' : '') + (cond && cond.type ? cond.type : '?'); }
  function rgLeafSummary(cond) {
    if (!cond || typeof cond !== 'object') return '?';
    const neg = cond.negate ? '¬ ' : '';
    switch (cond.type) {
      case 'permission': return neg + 'perm: ' + (cond.permission || '—');
      case 'placeholder': return neg + (cond.placeholder || '?') + ' ' + (cond.operator || '==') + ' ' + (cond.value != null ? cond.value : '');
      case 'money': return neg + 'money ≥ ' + (cond.amount != null ? cond.amount : 0);
      case 'has_item': return neg + ((cond.amount > 1 ? cond.amount + '× ' : '')) + (cond.material || '?');
      case 'exp': return neg + 'exp ' + (cond.amount != null ? cond.amount : 0) + (cond.level ? ' lvl' : '');
      default: return neg + (cond.type || '?');
    }
  }
  function rgWirePath(px, py, cx, cy) { const my = (py + cy) / 2; return 'M ' + px + ' ' + py + ' C ' + px + ' ' + my + ', ' + cx + ' ' + my + ', ' + cx + ' ' + cy; }

  // Modal that hosts the existing single-condition builder; resolves the edited condition object,
  // `null` (cleared), or `undefined` (cancel). Reused for both "add condition" and "edit leaf".
  function openReqLeafModal(initialCond, title) {
    return new Promise((resolve) => {
      const seed = initialCond ? JSON.parse(JSON.stringify(initialCond)) : null;
      let latest = seed ? JSON.parse(JSON.stringify(seed)) : null;

      const overlay = el('div', 'overlay');
      const modal = el('div', 'modal');
      modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
      modal.append(el('h2', null, title || 'Условие'));
      const bhost = el('div');
      modal.append(bhost);
      buildRequirementBuilder(bhost, seed, (val) => { latest = val; });

      const actions = el('div', 'modal-actions');
      const cancel = el('button', 'btn', 'Отмена'); cancel.type = 'button';
      const ok = el('button', 'btn primary', 'Сохранить'); ok.type = 'button';
      actions.append(cancel, ok);
      modal.append(actions);
      overlay.append(modal);

      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(v); };
      cancel.onclick = () => finish(undefined);
      ok.onclick = () => finish(latest);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(undefined); });
      // capture-phase Esc (stopPropagation) so the global overlay-closer never double-fires
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(undefined); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); ok.click(); }
      };
      document.addEventListener('keydown', onKey, true);
      document.body.append(overlay);
    });
  }

  // The node-graph editor itself. `initial` = current requirement (or null); `onChange(value|null)`
  // fires with the re-serialised requirement on every structural edit.
  function buildRequirementGraph(host, initial, onChange) {
    clear(host);
    host.classList.add('rg-host');
    const model = makeReqGraphModel(initial);

    const toolbar = el('div', 'rg-toolbar');
    const canvas = el('div', 'rg-canvas');
    const svg = svgEl('svg', { class: 'rg-svg' });
    canvas.append(svg);
    const inspector = el('div', 'rg-inspector');
    host.append(toolbar, canvas, inspector);

    const commit = () => onChange(serializeGraph(model));
    const posOf = (id) => { const mp = model.pos[id]; if (mp) return mp; const n = model.nodes[id]; return { x: n._cx, y: n._cy }; };
    const rgBtn = (label, cls, fn) => { const b = el('button', 'btn small' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.onclick = fn; return b; };

    function rerender() { rgLayout(model); drawGraph(); renderToolbar(); renderInspector(); }

    // clicking blank canvas deselects
    svg.addEventListener('mousedown', (e) => { if (e.target === svg || (e.target.classList && e.target.classList.contains('rg-empty-t'))) { model.selected = null; drawGraph(); renderInspector(); } });

    function drawGraph() {
      clear(svg);
      const ids = Object.keys(model.nodes);
      if (!ids.length) {
        svg.setAttribute('viewBox', '0 0 320 120'); svg.setAttribute('width', 320); svg.setAttribute('height', 120);
        svg.append(svgEl('text', { class: 'rg-empty-t', x: 160, y: 62, 'text-anchor': 'middle' }, 'Пусто — добавьте условие или группу'));
        return;
      }
      let maxX = 0, maxY = 0;
      ids.forEach((id) => { const p = posOf(id); maxX = Math.max(maxX, p.x + RG_NODE_W / 2); maxY = Math.max(maxY, p.y + RG_NODE_H / 2); });
      const W = Math.max(320, Math.round(maxX + 30)), H = Math.max(120, Math.round(maxY + 30));
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', W); svg.setAttribute('height', H);
      // wires first (under nodes)
      ids.forEach((id) => {
        const n = model.nodes[id], p = posOf(id);
        n.children.forEach((c) => { const cp = posOf(c); svg.append(svgEl('path', { class: 'rgedge', d: rgWirePath(p.x, p.y + RG_NODE_H / 2, cp.x, cp.y - RG_NODE_H / 2) })); });
      });
      ids.forEach((id) => svg.append(buildRgNode(id)));
    }

    function buildRgNode(id) {
      const n = model.nodes[id], p = posOf(id);
      const cls = 'rgnode ' + (n.kind === 'leaf' ? 'leaf' : 'logic') + (model.selected === id ? ' sel' : '');
      const g = svgEl('g', { class: cls, transform: 'translate(' + p.x + ',' + p.y + ')', 'data-id': id });
      g.append(svgEl('rect', { class: 'rgbox', x: -RG_NODE_W / 2, y: -RG_NODE_H / 2, width: RG_NODE_W, height: RG_NODE_H, rx: 9 }));
      if (n.kind === 'leaf') {
        g.append(svgEl('text', { class: 'rgtitle', x: 0, y: -3, 'text-anchor': 'middle' }, rgLeafType(n.cond)));
        g.append(svgEl('text', { class: 'rgsub', x: 0, y: 13, 'text-anchor': 'middle' }, rgClip(rgLeafSummary(n.cond), 20)));
      } else {
        g.append(svgEl('text', { class: 'rgtitle', x: 0, y: -3, 'text-anchor': 'middle' }, n.kind.toUpperCase()));
        g.append(svgEl('text', { class: 'rgsub', x: 0, y: 13, 'text-anchor': 'middle' }, n.kind === 'all' ? 'AND — все' : n.kind === 'any' ? 'OR — любое' : 'NOT — инверсия'));
      }
      g.addEventListener('mousedown', (ev) => onNodeDown(ev, id));
      return g;
    }

    // which node's box is under a model-space point (for drag-drop reparenting)?
    function nodeAt(x, y, exceptId) {
      let hit = null;
      Object.keys(model.nodes).forEach((id) => { if (id === exceptId) return; const p = posOf(id); if (Math.abs(x - p.x) <= RG_NODE_W / 2 && Math.abs(y - p.y) <= RG_NODE_H / 2) hit = id; });
      return hit;
    }

    // drag = reposition; a no-move click selects; dropping onto a logic node reparents (best-effort).
    function onNodeDown(ev, id) {
      ev.preventDefault(); ev.stopPropagation();
      const start = { x: ev.clientX, y: ev.clientY };
      let moved = false;
      const move = (e) => {
        if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
        moved = true;
        const pt = svgPoint(svg, e.clientX, e.clientY);
        model.pos[id] = { x: pt.x, y: pt.y };
        drawGraph();
      };
      const up = (e) => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!moved) { model.selected = id; drawGraph(); renderInspector(); return; }
        const pt = svgPoint(svg, e.clientX, e.clientY);
        const target = nodeAt(pt.x, pt.y, id);
        if (target && rgReparent(model, id, target)) { delete model.pos[id]; model.selected = id; commit(); }
        rerender();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }

    // ---- operations (each mutates the model, re-serialises, re-renders) ----
    async function addCondChild(parentId) {
      const cond = await openReqLeafModal({ type: 'permission', permission: '' }, 'Новое условие');
      if (cond === undefined || cond == null) return;   // cancel / empty
      const nid = reqToNodes(model, cond, parentId != null ? parentId : null);
      if (parentId != null) model.nodes[parentId].children.push(nid); else model.rootId = nid;
      model.selected = nid; commit(); rerender();
    }
    function addLogicChild(parentId, kind) {
      const id = model.newId();
      model.nodes[id] = { id, kind, cond: null, children: [], parent: parentId != null ? parentId : null };
      if (parentId != null) model.nodes[parentId].children.push(id); else model.rootId = id;
      model.selected = id; commit(); rerender();
    }
    function changeKind(id, kind) {
      const n = model.nodes[id];
      if (!n || n.kind === 'leaf' || n.kind === kind) return;
      if (kind === 'not' && n.children.length > 1) { n.children.slice(1).forEach((c) => rgRemoveSubtree(model, c)); n.children = n.children.slice(0, 1); }
      n.kind = kind; commit(); rerender();
    }
    function wrapNode(id, kind) {
      const n = model.nodes[id];
      if (!n) return;
      const wid = model.newId(), parentId = n.parent;
      model.nodes[wid] = { id: wid, kind, cond: null, children: [id], parent: parentId };
      if (parentId != null) { const p = model.nodes[parentId]; const i = p.children.indexOf(id); if (i >= 0) p.children[i] = wid; else p.children.push(wid); }
      else model.rootId = wid;
      n.parent = wid; model.selected = wid; commit(); rerender();
    }
    function deleteNode(id) {
      const n = model.nodes[id];
      if (!n) return;
      const parentId = n.parent;
      rgRemoveSubtree(model, id);
      if (model.rootId === id) model.rootId = null;
      if (parentId != null) { const p = model.nodes[parentId]; if (p) { const i = p.children.indexOf(id); if (i >= 0) p.children.splice(i, 1); } }
      model.selected = parentId != null ? parentId : null;
      commit(); rerender();
    }
    async function editLeaf(id) {
      const n = model.nodes[id];
      if (!n || n.kind !== 'leaf') return;
      const res = await openReqLeafModal(n.cond, 'Условие');
      if (res === undefined) return;                       // cancel
      if (res == null) { deleteNode(id); return; }         // cleared -> remove
      if (res.type === 'all' || res.type === 'any' || res.type === 'not') { model.selected = rgReplaceSubtree(model, id, res); commit(); rerender(); return; }
      n.cond = JSON.parse(JSON.stringify(res)); commit(); rerender();
    }

    function renderToolbar() {
      clear(toolbar);
      if (!model.rootId) {
        toolbar.append(el('span', 'rg-tb-lbl', 'Пусто. Начните с:'));
        toolbar.append(rgBtn('＋ Условие', '', () => addCondChild(null)));
        toolbar.append(rgBtn('＋ ALL', '', () => addLogicChild(null, 'all')));
        toolbar.append(rgBtn('＋ ANY', '', () => addLogicChild(null, 'any')));
        toolbar.append(rgBtn('＋ NOT', '', () => addLogicChild(null, 'not')));
      } else {
        toolbar.append(el('span', 'rg-tb-lbl', 'Клик — выбрать · тяни узел на группу — вложить'));
        toolbar.append(rgBtn('Сбросить', 'danger-ghost', async () => {
          if (await modalConfirm('Сбросить условие', 'Удалить все узлы графа условия?')) {
            model.nodes = {}; model.pos = {}; model.rootId = null; model.selected = null; commit(); rerender();
          }
        }));
      }
    }

    function renderInspector() {
      clear(inspector);
      const id = model.selected;
      if (id == null || !model.nodes[id]) { inspector.append(el('div', 'rg-ins-hint', 'Выберите узел на графе, чтобы редактировать его.')); return; }
      const n = model.nodes[id];

      const head = el('div', 'rg-ins-head');
      if (n.kind === 'leaf') { head.append(el('span', 'rg-ins-kind leaf', 'условие')); head.append(el('span', 'rg-ins-sum', rgLeafSummary(n.cond))); }
      else { head.append(el('span', 'rg-ins-kind logic', n.kind.toUpperCase())); head.append(el('span', 'rg-ins-sum', n.kind === 'all' ? 'все условия (AND)' : n.kind === 'any' ? 'любое условие (OR)' : 'инверсия (NOT)')); }
      inspector.append(head);

      const row1 = el('div', 'rg-ins-row');
      if (n.kind === 'leaf') {
        row1.append(rgBtn('✎ Редактировать', '', () => editLeaf(id)));
      } else {
        row1.append(el('span', 'rg-ins-lbl', 'Тип:'));
        ['all', 'any', 'not'].forEach((k) => row1.append(rgBtn(k.toUpperCase(), n.kind === k ? 'primary' : '', () => changeKind(id, k))));
      }
      inspector.append(row1);

      if (n.kind !== 'leaf') {
        const addRow = el('div', 'rg-ins-row');
        if (n.kind === 'not' && n.children.length >= 1) {
          addRow.append(el('span', 'rg-ins-hint', 'NOT содержит одно условие (удалите его, чтобы заменить)'));
        } else {
          addRow.append(el('span', 'rg-ins-lbl', 'Добавить:'));
          addRow.append(rgBtn('＋ Условие', '', () => addCondChild(id)));
          addRow.append(rgBtn('＋ ALL', '', () => addLogicChild(id, 'all')));
          addRow.append(rgBtn('＋ ANY', '', () => addLogicChild(id, 'any')));
          addRow.append(rgBtn('＋ NOT', '', () => addLogicChild(id, 'not')));
        }
        inspector.append(addRow);
      }

      const wrapRow = el('div', 'rg-ins-row');
      wrapRow.append(el('span', 'rg-ins-lbl', 'Обернуть в:'));
      wrapRow.append(rgBtn('ALL', '', () => wrapNode(id, 'all')));
      wrapRow.append(rgBtn('ANY', '', () => wrapNode(id, 'any')));
      wrapRow.append(rgBtn('NOT', '', () => wrapNode(id, 'not')));
      inspector.append(wrapRow);

      const delRow = el('div', 'rg-ins-row');
      delRow.append(rgBtn('🗑 Удалить узел', 'danger-ghost', () => deleteNode(id)));
      inspector.append(delRow);
    }

    rerender();
  }

  // Toggle wrapper mounted at every requirement host (view / click / open): a compact bar with a
  // «🔗 Граф» button switches the SAME requirement object between the structured/raw builder and the
  // node-graph editor. `currentValue` is kept live across edits so a mode switch never loses the value.
  function mountRequirementEditor(host, initial, onChange) {
    clear(host);
    host.classList.add('req-editor');
    const local = { graph: false };
    let currentValue = initial ? JSON.parse(JSON.stringify(initial)) : null;

    const bar = el('div', 'req-mode-bar');
    bar.append(el('span', 'req-mode-lbl', 'Редактор условия'));
    const gbtn = el('button', 'btn small req-graph-toggle', '🔗 Граф');
    gbtn.type = 'button';
    bar.append(gbtn);
    const body = el('div', 'req-editor-body');
    host.append(bar, body);

    function change(val) { currentValue = val ? JSON.parse(JSON.stringify(val)) : null; onChange(val); }
    function mount() {
      gbtn.setAttribute('aria-pressed', local.graph ? 'true' : 'false');
      clear(body);
      if (local.graph) buildRequirementGraph(body, currentValue, change);
      else buildRequirementBuilder(body, currentValue, change);
    }
    gbtn.onclick = () => { local.graph = !local.graph; mount(); };
    mount();
  }

  // wire the per-slot view/click requirement builders from the active item (bulk-aware writes)
  function renderSlotRequirements(disp) {
    buildReqSingle($('req-view'),
      () => (disp && disp['view-requirement']) || null,
      (req) => writeReqKey('view-requirement', req));
    buildReqBlock($('req-click'),
      () => (disp && disp['click-requirement']) || null,
      (block) => writeReqKey('click-requirement', block));
  }

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

  // ================================================================== deepslate block renderer
  // BLOCKS (resolver kind 'cube') are upgraded to a real 1.21.11 3D inventory render via deepslate's
  // WebGL ItemRenderer, so stairs/slabs/fences/logs/etc. show their true shape, not a flat CSS cube.
  // Everything here is OPTIONAL and lazy: the module loads on first use, one WebGL2 context + one
  // ItemRenderer are reused for every block, results are cached per material as a PNG data URL, and
  // ANY failure (module load, missing model, empty render) silently falls back to the CSS cube. The
  // atlas is 2048x1888 (non-power-of-two) and deepslate calls generateMipmap, so a WebGL2 context is
  // required (NPOT mipmaps are only valid under WebGL2). misode's data.min.json stores pixel UVs
  // [x,y,w,h]; deepslate wants normalised [u0,v0,u1,v1], so we supply a custom TextureAtlasProvider.

  let deepslateInit = null;              // Promise<ctx|null>, resolved once per session
  const dsBlockJson = new Map();         // model path  -> raw json | null (sync-readable by provider)
  const dsItemDefJson = new Map();       // item name   -> raw json | null
  const dsBlockModelInst = new Map();    // model path  -> flattened deepslate BlockModel | null
  const dsItemModelInst = new Map();     // item name   -> deepslate ItemModel | null
  const blockRenderCache = new Map();    // material    -> PNG data URL | null (null = tried & failed)
  const blockRenderPending = new Map();  // material    -> Promise<url|null> (dedupes concurrent renders)

  function loadImageCors(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image load failed: ' + url));
      im.src = url;
    });
  }

  // collect every block-model path referenced anywhere in a 1.21.4 item-model tree (type:model nodes),
  // recursing through the select/condition/range_dispatch/composite dispatch containers.
  function collectItemModelPaths(node, out) {
    if (!node || typeof node !== 'object') return;
    if (stripNs(node.type || '') === 'model' && typeof node.model === 'string') { out.push(stripNs(node.model)); return; }
    const kids = [];
    if (Array.isArray(node.cases)) node.cases.forEach((c) => kids.push(c && c.model));
    if (node.fallback) kids.push(node.fallback);
    if (node.on_true) kids.push(node.on_true);
    if (node.on_false) kids.push(node.on_false);
    if (Array.isArray(node.entries)) node.entries.forEach((e) => kids.push(e && e.model));
    if (Array.isArray(node.models)) node.models.forEach((m) => kids.push(m));
    kids.forEach((k) => collectItemModelPaths(k, out));
  }

  // fetch a block model + its whole parent chain into dsBlockJson (so the sync provider can read them)
  async function ensureBlockChain(path, depth) {
    depth = depth || 0;
    if (depth > 16) return true;
    if (dsBlockJson.has(path)) return dsBlockJson.get(path) != null;
    const json = await fetchModelJson(path); // reuses the shared modelCache (mcasset.cloud, CORS *)
    dsBlockJson.set(path, json || null);
    if (!json) return false;
    const parent = json.parent ? stripNs(json.parent) : '';
    if (parent && !parent.startsWith('builtin/')) await ensureBlockChain(parent, depth + 1);
    return true;
  }

  // resolve + fetch everything the renderer needs for one block material (item def + model chains)
  async function prefetchBlockItem(name) {
    if (!dsItemDefJson.has(name)) {
      const def = await fetchItemDef(name); // reuses itemDefCache
      dsItemDefJson.set(name, def || null);
    }
    const def = dsItemDefJson.get(name);
    if (!def || !def.model) return false;
    const paths = [];
    collectItemModelPaths(def.model, paths);
    if (!paths.length) return false;
    let anyOk = false;
    for (const p of paths) { if (await ensureBlockChain(p)) anyOk = true; }
    return anyOk;
  }

  // load deepslate + the atlas once; wire the four synchronous resource providers ItemRenderer needs.
  function initDeepslate() {
    if (deepslateInit) return deepslateInit;
    deepslateInit = (async () => {
      const ds = await import(DEEPSLATE_URL);
      const { Identifier, ItemStack, ItemRenderer, ItemModel, BlockModel, NbtString } = ds;
      if (!Identifier || !ItemStack || !ItemRenderer || !ItemModel || !BlockModel || !NbtString) {
        throw new Error('deepslate exports missing');
      }
      const [atlasImg, atlasData] = await Promise.all([
        loadImageCors(ATLAS_PNG_URL),
        fetch(ATLAS_DATA_URL).then((r) => { if (!r.ok) throw new Error('atlas data ' + r.status); return r.json(); }),
      ]);
      const AW = atlasImg.naturalWidth || atlasImg.width;
      const AH = atlasImg.naturalHeight || atlasImg.height;
      // atlas PNG -> ImageData (throws SecurityError if the image were CORS-tainted -> disables path)
      const ac = document.createElement('canvas'); ac.width = AW; ac.height = AH;
      const actx = ac.getContext('2d');
      actx.drawImage(atlasImg, 0, 0);
      const atlasImageData = actx.getImageData(0, 0, AW, AH);

      const glCanvas = document.createElement('canvas');
      glCanvas.width = DS_RENDER_PX; glCanvas.height = DS_RENDER_PX;
      const gl = glCanvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error('webgl2 unavailable');

      // --- resource providers (all SYNCHRONOUS; backed by the prefetched sync caches above) ---
      const atlasProvider = {
        getTextureAtlas: () => atlasImageData,
        getTextureUV: (id) => {
          const px = atlasData[id.path] || atlasData[String(id).replace(/^minecraft:/, '')];
          if (!px) return [0, 0, 16 / AW, 16 / AH];
          const x = px[0], y = px[1], w = px[2];
          let h = px[3];
          if (h > w && h % w === 0) h = w; // vertical animation strip -> render first frame only
          return [x / AW, y / AH, (x + w) / AW, (y + h) / AH];
        },
        getPixelSize: () => 1 / AW, // half-texel inset for anti-bleed; atlas is near-square so ~exact
      };
      const blockModelProvider = {
        getBlockModel: (id) => {
          const path = id.path;
          if (dsBlockModelInst.has(path)) return dsBlockModelInst.get(path);
          const json = dsBlockJson.get(path);
          if (!json) { dsBlockModelInst.set(path, null); return null; }
          let bm = null;
          try { bm = BlockModel.fromJson(json); bm.flatten(blockModelProvider); } catch (e) { bm = null; }
          dsBlockModelInst.set(path, bm);
          return bm;
        },
      };
      const itemModelProvider = {
        getItemModel: (id) => {
          const key = id.path;
          if (dsItemModelInst.has(key)) return dsItemModelInst.get(key);
          const def = dsItemDefJson.get(key);
          const node = def && def.model;
          let im = null;
          if (node) { try { im = ItemModel.fromJson(node); } catch (e) { im = null; } }
          dsItemModelInst.set(key, im);
          return im;
        },
      };
      // default item_model component = the item's own id (matches vanilla), so a bare ItemStack renders
      const componentsProvider = {
        getItemComponents: (id) => new Map([['minecraft:item_model', new NbtString(String(id))]]),
      };
      const resources = Object.assign({}, atlasProvider, blockModelProvider, itemModelProvider, componentsProvider);

      let itemRenderer = null;                 // one renderer, reused (atlas texture uploaded once)
      const guiCtx = { display_context: 'gui' };
      const pixels = new Uint8Array(DS_RENDER_PX * DS_RENDER_PX * 4);

      // draw an already-prefetched block to a data URL, or null if essentially nothing rendered
      function drawToDataUrl(name) {
        const item = new ItemStack(Identifier.create(name), 1);
        gl.viewport(0, 0, DS_RENDER_PX, DS_RENDER_PX);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (!itemRenderer) itemRenderer = new ItemRenderer(gl, item, resources, guiCtx);
        else itemRenderer.setItem(item, guiCtx);
        itemRenderer.drawItem();
        // validity guard: missing/empty meshes draw nothing -> treat as failure so we fall back
        gl.readPixels(0, 0, DS_RENDER_PX, DS_RENDER_PX, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let covered = 0;
        for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] > 12 && ++covered >= 12) break; }
        if (covered < 12) return null;
        return glCanvas.toDataURL('image/png');
      }

      return { drawToDataUrl };
    })().catch((e) => {
      console.warn('[AlexMenus] deepslate block renderer unavailable, using CSS cube fallback:', e && e.message);
      return null;
    });
    return deepslateInit;
  }

  // public entry: resolve a block material to a cached PNG data URL (null if it can't be rendered)
  function getBlockRender(name) {
    if (blockRenderCache.has(name)) return Promise.resolve(blockRenderCache.get(name));
    if (blockRenderPending.has(name)) return blockRenderPending.get(name);
    const p = (async () => {
      let url = null;
      try {
        const ctx = await initDeepslate();
        if (ctx && await prefetchBlockItem(name)) url = ctx.drawToDataUrl(name);
      } catch (e) { url = null; }
      blockRenderCache.set(name, url);
      blockRenderPending.delete(name);
      return url;
    })();
    blockRenderPending.set(name, p);
    return p;
  }

  function blockImg(url) {
    const im = document.createElement('img');
    im.className = 'block3d'; im.loading = 'eager'; im.alt = '';
    im.src = url;
    return im;
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

  // a placeholder .ic-holder that resolves its icon lazily (grid/picker) or immediately (mat-ic).
  // `observer` overrides the shared grid observer (the material picker passes its own, rooted on its
  // scroll container); omitted -> the grid's iconObserver, preserving all existing call sites.
  function makeIconHolder(material, sizePx, txtCls, lazy, observer) {
    const holder = el('div', 'ic-holder');
    holder.style.setProperty('--sz', sizePx + 'px');
    holder.dataset.name = stripNs(String(material || '').toLowerCase()).replace(/\s+/g, '').trim();
    holder.dataset.txt = txtCls || 'cell-txt';
    const obs = observer || iconObserver;
    if (lazy && obs) obs.observe(holder);
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
    // eager, not lazy: the holder is only loaded once its IntersectionObserver says it's visible, so the
    // native lazy attribute is redundant AND can wedge the probe (never firing onload/onerror, so the
    // resolver never advances to the block/cube path) in some layout/compositing situations.
    img.className = 'flat'; img.loading = 'eager'; img.alt = '';
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
      im.className = 'flat'; im.loading = 'eager'; im.alt = '';
      im.onerror = () => { im.remove(); if (!holder.firstChild) holder.append(el('span', txtCls, shortMat(name))); };
      im.src = texUrl(res.tex);
      holder.append(im);
    } else if (res.kind === 'cube') {
      // BLOCK: prefer an exact deepslate 3D inventory render; the CSS cube shows instantly and stays
      // as the permanent fallback if deepslate is unavailable or can't render this particular block.
      const cached = blockRenderCache.get(name);
      if (typeof cached === 'string') {
        holder.append(blockImg(cached));
      } else {
        holder.append(buildCube(res.top, res.side, res.front));
        if (cached !== null) { // undefined = not tried yet; null = tried & failed (keep the cube)
          getBlockRender(name).then((url) => {
            if (url && holder.isConnected && holder.dataset.name === name) {
              clear(holder); holder.append(blockImg(url));
            }
          });
        }
      }
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
    const seen = new WeakSet(); // guard against cyclic YAML anchors (js-yaml aliases share references)
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (seen.has(n)) return;
      seen.add(n);
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
    const start = { x: ev.clientX, y: ev.clientY };
    let moved = false;
    const move = (e) => {
      // 4px dead-zone: a deliberate click often emits 1-2px of jitter — don't misread it as a drag.
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
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

  async function deleteMenu() {
    const m = current();
    if (!m) return;
    if (!(await modalConfirm('Удалить меню', 'Удалить меню «' + m.id + '»? Действие применится после сохранения.'))) return;
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

  // ================================================================== MATERIAL PICKER
  // Full 1.21.11 item/block list from PrismarineJS minecraft-data. Cached in-memory + localStorage.
  // On fetch failure the picker degrades to a note ("введите вручную") and the manual material text
  // field stays usable. Selecting a cell assigns an UPPERCASE Bukkit material (minecraft-data `name`
  // is lowercase snake_case) to the active slot + every selected slot (bulk), creating items as needed.
  const MATERIALS_URL = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/1.21.11/items.json';
  const MATERIALS_STORE_KEY = 'am_materials_1_21_11';
  const PICKER_CAP = 320;          // cap rendered cells; the search box narrows the full list
  let materialsCache = null;       // [{ name, displayName }] once loaded
  let materialsPromise = null;     // in-flight fetch (dedupe)
  let pickerObserver = null;       // lazy-icon observer rooted on the picker's scroll container
  let mpSearchTimer = null;        // debounce for the search box

  function loadMaterials() {
    if (materialsCache) return Promise.resolve(materialsCache);
    try {
      const raw = localStorage.getItem(MATERIALS_STORE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) { materialsCache = arr; return Promise.resolve(arr); }
      }
    } catch (e) { /* private mode / corrupt cache -> refetch */ }
    if (materialsPromise) return materialsPromise;
    materialsPromise = fetch(MATERIALS_URL)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((arr) => {
        const list = (Array.isArray(arr) ? arr : [])
          .map((it) => ({ name: String(it.name || ''), displayName: String(it.displayName || it.name || '') }))
          .filter((it) => it.name);
        materialsCache = list;
        try { localStorage.setItem(MATERIALS_STORE_KEY, JSON.stringify(list)); } catch (e) { /* quota */ }
        return list;
      })
      .catch((e) => { materialsPromise = null; throw e; });
    return materialsPromise;
  }

  function openMaterialPicker() {
    const m = current();
    if (!m || state.active == null) { toast('Сначала выберите слот', 'err'); return; }
    if (pickerObserver) { pickerObserver.disconnect(); pickerObserver = null; }
    const search = $('mp-search');
    search.value = '';
    clear($('mp-grid'));
    $('mp-note').hidden = true;
    $('mp-loading').hidden = !!materialsCache;
    $('material-modal').hidden = false;
    search.focus();
    loadMaterials().then(() => {
      $('mp-loading').hidden = true;
      renderPickerGrid('');
    }).catch((e) => {
      $('mp-loading').hidden = true;
      // Do NOT cache an empty list — that would make loadMaterials() short-circuit forever with no retry.
      // renderPickerGrid('') shows the "недоступны" note when the list is empty; cache stays null so a reopen re-fetches.
      renderPickerGrid('');
      toast('Список материалов недоступен (' + (e && e.message ? e.message : 'сеть') + '). Введите материал вручную.', 'err');
    });
  }

  function closeMaterialPicker() {
    $('material-modal').hidden = true;
    if (pickerObserver) { pickerObserver.disconnect(); pickerObserver = null; }
  }

  function renderPickerGrid(query) {
    const grid = $('mp-grid');
    const scrollEl = $('mp-scroll');
    clear(grid);
    if (pickerObserver) pickerObserver.disconnect();
    pickerObserver = ('IntersectionObserver' in window)
      ? new IntersectionObserver((entries) => {
          entries.forEach((e) => { if (e.isIntersecting) { pickerObserver.unobserve(e.target); loadIcon(e.target); } });
        }, { root: scrollEl, rootMargin: '250px' })
      : null;

    const q = (query || '').trim().toLowerCase();
    const list = materialsCache || [];
    const filtered = q
      ? list.filter((it) => it.name.toLowerCase().indexOf(q) !== -1 || it.displayName.toLowerCase().indexOf(q) !== -1)
      : list;
    const shown = filtered.slice(0, PICKER_CAP);
    shown.forEach((it) => grid.append(buildPickerCell(it)));

    const note = $('mp-note');
    if (!list.length) note.textContent = 'Данные о материалах недоступны — введите материал вручную в поле «Материал».';
    else if (filtered.length > shown.length) note.textContent = 'Найдено ' + filtered.length + ', показаны первые ' + PICKER_CAP + ' — уточните поиск.';
    else note.textContent = filtered.length + (filtered.length === 1 ? ' совпадение' : ' совпадений');
    note.hidden = false;

    if (pickerObserver) scheduleIconFallback(scrollEl);
    else grid.querySelectorAll('.ic-holder').forEach(loadIcon);
  }

  function buildPickerCell(it) {
    const bukkit = it.name.toUpperCase();   // diamond_sword -> DIAMOND_SWORD
    const cell = el('button', 'mp-cell');
    cell.type = 'button';
    cell.title = bukkit;
    cell.append(makeIconHolder(it.name, 34, 'mi-txt', true, pickerObserver));
    cell.append(el('span', 'mp-name', it.displayName));
    cell.onclick = () => choosePickerMaterial(bukkit);
    return cell;
  }

  function choosePickerMaterial(mat) {
    assignMaterial(mat, targetSlots());   // active slot + selection (bulk), creating items as needed
    closeMaterialPicker();
    renderGrid();
    renderProps();
    toast('Материал: ' + mat, 'ok');
  }

  // ================================================================== TOASTS
  function toast(msg, kind) {
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    $('toasts').append(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 3200);
  }

  // ================================================================== MODALS (prompt/confirm/alert)
  // Themed in-page replacements for window.prompt/confirm/alert. Each returns a Promise. The overlay
  // reuses the .overlay/.modal styling; Esc/backdrop = cancel, Enter = confirm, input is focused.
  // These modals are created dynamically (after wireStaticUi), so they own their Esc/backdrop wiring:
  // the keydown listener is registered in the CAPTURE phase and stopPropagation()s, so the global
  // Esc-closes-all-overlays handler never fires for them (no dangling unresolved promise).
  function openModal(opts) {
    return new Promise((resolve) => {
      const kind = opts.kind;                       // 'prompt' | 'confirm' | 'alert'
      const cancelVal = kind === 'confirm' ? false : (kind === 'alert' ? undefined : null);

      const overlay = el('div', 'overlay');
      const modal = el('div', 'modal');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.append(el('h2', null, opts.title || ''));

      let input = null;
      if (kind === 'prompt') {
        const field = el('label', 'field');
        if (opts.label) field.append(el('span', 'modal-label', opts.label));
        input = document.createElement('input');
        input.type = 'text'; input.className = 'in'; input.autocomplete = 'off';
        if (opts.value != null) input.value = String(opts.value);
        if (opts.placeholder) input.placeholder = opts.placeholder;
        field.append(input);
        modal.append(field);
      } else if (opts.message) {
        modal.append(el('p', 'muted', opts.message));
      }

      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(val);
      };

      const actions = el('div', 'modal-actions');
      if (kind !== 'alert') {
        const cancel = el('button', 'btn', opts.cancelText || 'Отмена');
        cancel.type = 'button';
        cancel.onclick = () => finish(cancelVal);
        actions.append(cancel);
      }
      const ok = el('button', 'btn primary', opts.okText || 'OK');
      ok.type = 'button';
      ok.onclick = () => finish(kind === 'prompt' ? (input ? input.value : '') : (kind === 'confirm' ? true : undefined));
      actions.append(ok);
      modal.append(actions);
      overlay.append(modal);

      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(cancelVal); });
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(cancelVal); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ok.click(); }
      };
      document.addEventListener('keydown', onKey, true);

      document.body.append(overlay);
      if (input) { input.focus(); input.select(); } else ok.focus();
    });
  }
  // -> entered string, or null on cancel/backdrop/Esc
  function modalPrompt(title, o) {
    o = o || {};
    return openModal({ kind: 'prompt', title, label: o.label, value: o.value, placeholder: o.placeholder });
  }
  // -> boolean
  function modalConfirm(title, message) { return openModal({ kind: 'confirm', title, message }); }
  // -> void
  function modalAlert(title, message) { return openModal({ kind: 'alert', title, message }); }

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

    // material picker (both entry points: the button beside the material field + the empty-slot button)
    $('f-material-pick').onclick = openMaterialPicker;
    $('f-material-pick-big').onclick = openMaterialPicker;
    $('mp-close').onclick = closeMaterialPicker;
    $('mp-search').addEventListener('input', () => {
      clearTimeout(mpSearchTimer);
      mpSearchTimer = setTimeout(() => renderPickerGrid($('mp-search').value), 110);
    });

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
      ov.addEventListener('mousedown', (e) => {
        if (e.target === ov) {
          ov.hidden = true;
          if (ov.id === 'material-modal' && pickerObserver) { pickerObserver.disconnect(); pickerObserver = null; }
        }
      });
    });
    // Esc closes overlays and the context menu
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.overlay').forEach((o) => (o.hidden = true));
        if (pickerObserver) { pickerObserver.disconnect(); pickerObserver = null; }  // don't leak the picker's observer
        hideContextMenu();
      }
    });
  }

  // go
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
