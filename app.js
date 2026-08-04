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

  // ---- textures (custom resource pack) ------------------------------------------------------
  // The plugin puts its texture catalog into the SAME bundle as the menus, and new PNGs ride back
  // in the same body as base64. That means one shared 2 MB budget for everything — see the meter.
  //
  //   MAX_ITEM_PX / MAX_GUI_PX — the browser resamples every upload down to these BEFORE it enters
  //   the bundle. Not a UI nicety: PackGenerator packs icons as flat 2D item textures and GuiFont
  //   clamps every background glyph to 256 px per side and resamples it there, so a 1024x1024 source
  //   would be thrown away by the server anyway — after costing 2.4 MB of the 2 MB budget.
  const MAX_ITEM_PX = 64;
  const MAX_GUI_PX = 256;
  // Per-file cap on the plugin side (TextureStore.MAX_PNG_BYTES). The bundle carries the real value
  // in `pngLimit`; this is only the fallback for an older plugin build.
  const PNG_LIMIT_DEFAULT = 1024 * 1024;
  // Worker's MAX_BYTES. Shown as the denominator so the number matches what the admin will hit.
  const BUNDLE_LIMIT = 2 * 1024 * 1024;
  // Where the editor actually refuses to send. Lower than BUNDLE_LIMIT on purpose: the live «Применить»
  // channel stores the body in a SQLite-backed Durable Object whose "key + value" cap is 2 MB, so a
  // body AT the limit dies inside the worker's try/catch and comes back as a confusing 500 instead of
  // a 413. Stopping ~150 KB early keeps the failure honest.
  const BUNDLE_SAFE = 1900 * 1024;
  const SIZE_WARN_AT = 0.7;         // meter turns accent-coloured past 70%
  // Chest window geometry in GAME pixels — the coordinate system `background:` is written in.
  // Mirrors MenuBackground: 176 wide, rows*18+31 tall, first slot at (7,17), title baseline 13
  // (so `ascent: 13` puts the top of the picture exactly on the top edge of the window).
  const WIN_W = 176, SLOT_PITCH = 18, SLOT_X0 = 7, SLOT_Y0 = 17, TITLE_BASELINE = 13;

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

  // open-animation pace scale, in percent.
  //   1..100  -> one reveal step every N ticks; 100 = one step per tick (the engine's hard floor,
  //              OpenAnimation.ticksFromSpeed() maps 1..100 onto 20..1 ticks).
  //   101..200-> more than one step per tick — the interval is already 1, so the extra speed has to
  //              come from revealing a BATCH per tick (see oaBatchOf). Engine builds that predate the
  //              batch support clamp such a value back to 100, which only costs speed, never breaks.
  const OA_SPEED_MAX = 200;
  // Steps revealed per tick for a given speed: 1 up to 100%, then +1 per started 25 points —
  // 101..125 -> 2, 126..150 -> 3, 151..175 -> 4, 176..200 -> 5. `ceil` (not `round`) on purpose:
  // every value above 100 must be strictly faster than 100, otherwise 101..112 would silently
  // behave exactly like 100. This is the contract the Java side has to mirror.
  function oaBatchOf(speed) {
    const s = Math.max(1, Math.min(OA_SPEED_MAX, parseInt(speed, 10) || 0));
    return s <= 100 ? 1 : 1 + Math.ceil((s - 100) / 25);
  }

  // common item-flags exposed as checkboxes (hide-all handled separately)
  const HIDE_FLAGS = [
    'HIDE_ATTRIBUTES', 'HIDE_ENCHANTS', 'HIDE_UNBREAKABLE', 'HIDE_ADDITIONAL_TOOLTIP',
    'HIDE_DYE', 'HIDE_ARMOR_TRIM', 'HIDE_DESTROYS', 'HIDE_PLACED_ON'
  ];

  // action type -> Russian label (order = <select> order). Mirrors ActionHandler.dispatch():
  // messaging, economy/exp, items, slot manipulation (input slots), flow control.
  const ACTION_TYPES = [
    ['run_command', 'Команда'], ['message', 'Сообщение'], ['broadcast', 'Объявление всем (broadcast)'],
    ['actionbar', 'Actionbar'],
    ['title', 'Заголовок (title)'], ['open_menu', 'Открыть меню'], ['connect', 'Сервер (connect)'],
    ['sound', 'Звук'], ['give_item', 'Выдать предмет'], ['take_item', 'Списать предмет (take_item)'],
    ['give_money', 'Выдать деньги'], ['take_money', 'Забрать деньги'],
    ['give_exp', 'Выдать опыт'], ['take_exp', 'Забрать опыт'],
    ['give_permission', 'Выдать право'], ['take_permission', 'Забрать право'],
    ['set_slot', 'Задать слот (set_slot)'], ['modify_slot', 'Изменить слот (modify_slot)'],
    ['clear_slot', 'Очистить слот (clear_slot)'], ['give_slot', 'Отдать слот игроку (give_slot)'],
    ['outcome', 'Случайный исход (outcome)'],
    ['refresh', 'Обновить'], ['close', 'Закрыть'], ['back', 'Назад'], ['conditional', 'Условие (JSON)']
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
    applyToken: '',        // live-apply session token (from hash `a=`); empty -> only the code flow works
    menus: [],             // [{ id, obj }]  — obj = parsed menu object
    sel: -1,               // index of the selected menu
    selected: new Set(),   // set of selected slot indices (ints)
    active: null,          // the slot shown in the right panel (int) or null
    clipboard: null,       // internal copy buffer (a cloned element object)
    raw: false,            // raw-YAML mode active?
    graph: false,          // navigation-graph view active?
    reqEdit: false,        // full-screen requirement editor active?
    reqEditCtx: null,      // { title, subtitle, value, onChange } for the full-screen requirement editor
    // texture catalog from the bundle + everything queued for upload. `enabled` mirrors the server's
    // textures.enabled: false there means `texture:`/`background:` are IGNORED by the plugin, and the
    // editor must say so instead of letting the admin decorate a menu into the void.
    tex: {
      enabled: false,
      known: false,        // did the bundle carry the flag at all? (an older plugin build did not)
      pngLimit: PNG_LIMIT_DEFAULT,
      item: [],            // [{ name, kind, w, h, bytes, b64, pending }]
      gui: []
    }
  };

  // transient drag-select bookkeeping
  const drag = { pending: false, moved: false, startSlot: null };

  // menu id -> the last custom reveal order the admin built with the open-animation click-grid.
  // `order:` is only written to YAML for `type: custom`, so switching the type to anything else
  // erases it from the model. Without this draft the order would survive only until the next
  // re-render (raw toggle, menu switch, rows change) — i.e. a couple of curious clicks on the type
  // <select> would silently destroy a hand-placed 54-slot sequence.
  const oaOrderDrafts = new Map();

  // graph-view bookkeeping (node positions persist across renders so drags stick)
  const graphPos = {};         // menu/ghost id -> { x, y } center
  let graphNodes = [];         // current node list
  let graphEdges = [];         // [{ from, to, node(SVG el) }]
  let graphView = null;        // current viewBox {x,y,w,h} (mouse-wheel zoom + drag pan)
  let graphPan = null;         // active background-pan gesture

  // ------------------------------------------------------------------ tiny DOM helpers
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  // ru plural: plural(1,'шаг','шага','шагов') -> 'шаг', 2 -> 'шага', 5 -> 'шагов'
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  }

  // ---- bridges into the LAYOUT CHROME module (bottom of this file) --------------------------
  // The chrome module owns the number steppers and the accordions. Both bridges are no-ops until it
  // has booted (it registers window.AlexMenusChrome while parsing, so in practice it is always there),
  // which keeps the render functions independent of load order.

  // Decorate freshly built <input type="number"> under `root` with the themed up/down arrows and
  // refresh their at-limit greying. Idempotent — safe (and expected) after every re-render. A
  // MutationObserver in the chrome module is the safety net for nodes built outside these calls;
  // calling it directly just makes the arrows appear in the same frame instead of the next one.
  function numChrome(root) {
    const c = window.AlexMenusChrome;
    if (c && typeof c.enhanceNumbers === 'function') c.enhanceNumbers(root || document);
  }
  // Put a short summary next to an accordion title (visible while the section is COLLAPSED), so a
  // closed «Действия по кликам» still says how many actions hide in there. Creates the <span> when
  // the markup has none. Passing an empty string clears it.
  function setAccSub(key, text) {
    const acc = document.querySelector('.acc[data-acc="' + key + '"]');
    if (!acc) return;
    const head = acc.querySelector('.acc-head');
    if (!head) return;
    let sub = head.querySelector('.acc-sub');
    if (!sub) { sub = el('span', 'acc-sub'); head.append(sub); }
    sub.textContent = text || '';
  }

  const current = () => (state.sel >= 0 ? state.menus[state.sel] : null);
  // Clearing the selection also leaves the full-screen requirement editor: its onChange closures are
  // bound to the previous menu/slot context, so switching menu (which resetSelection()s) must exit it.
  function resetSelection() {
    stopAnimPreview();   // the preview is anchored to a slot of the menu we are leaving
    state.selected = new Set(); state.active = null; state.reqEdit = false; state.reqEditCtx = null;
  }

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
    state.applyToken = hash.a || '';
    const applyBtn = $('apply-btn');
    if (applyBtn && !state.applyToken) {     // old/bare link: only the "get a code" flow is available
      applyBtn.disabled = true;
      applyBtn.title = 'Ссылка без live-сессии — открой редактор командой /am editor';
    }
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
    if (!raw) return { k: '', w: '', a: '' };

    if (/(?:^|&)[kwa]=/.test(raw)) {          // param form: contains a k=, w= or a=
      const p = new URLSearchParams(raw);
      let w = p.get('w') || '';
      if (w) { try { w = decodeURIComponent(w); } catch (e) { /* already decoded */ } }
      return { k: (p.get('k') || '').trim(), w: w.trim().replace(/\/+$/, ''), a: (p.get('a') || '').trim() };
    }
    // bare form: the entire fragment is the paste code (worker comes from storage/prompt)
    return { k: raw, w: '', a: '' };
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
      readTextureCatalog(bundle);

      if (!state.menus.length) return failLoad('В бандле нет меню. Создай меню кнопкой «＋».', true);

      state.sel = 0;
      resetSelection();
      show('editor');
      renderAll();
      if (state.tex.known && !state.tex.enabled) {
        toast('Текстуры на сервере выключены (textures.enabled: false) — texture: и background: будут проигнорированы', 'err');
      }
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

    const body = buildBundleBody();
    if (!guardBundleSize(body)) return;

    const btn = $('save-btn');
    btn.disabled = true;
    try {
      const res = await fetch(state.workerBase + '/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body.json
      });
      if (!res.ok) throw new Error('POST /post -> ' + res.status);
      const out = await res.json();
      if (!out || !out.key) throw new Error('в ответе нет key');
      // The paste now carries the pictures; the NEXT save must not pay for them a second time.
      markUploadsSent(body.uploads);
      openSaveModal(out.key);
    } catch (e) {
      toast('Не удалось сохранить: ' + (e && e.message ? e.message : 'сеть'), 'err');
    } finally {
      btn.disabled = false;
      updateSizeMeter();
    }
  }

  // ================================================================== APPLY  (POST <w>/apply/<token>)
  // Pushes the edited bundle straight back to the server that opened this editor: /am editor mints a
  // one-shot session token, puts it in the link, and polls for it. saveBundle() stays as the fallback.
  async function applyLive() {
    if (!commitRaw()) return;                 // flush raw editor; abort if its YAML is invalid
    if (!state.menus.length) { toast('Нет меню для применения', 'err'); return; }
    if (!state.applyToken) {
      toast('Эта ссылка без live-сессии — используй «Сохранить и получить код»', 'err');
      return;
    }
    const body = buildBundleBody();
    if (!guardBundleSize(body)) return;

    const btn = $('apply-btn');
    btn.disabled = true;
    try {
      const res = await fetch(state.workerBase + '/apply/' + encodeURIComponent(state.applyToken), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body.json
      });
      if (!res.ok) throw new Error('POST /apply -> ' + res.status);
      markUploadsSent(body.uploads);
      toast('Отправлено — сервер подхватит изменения (обычно за секунды, изредка до минуты)'
            + (body.uploads.length ? ' · картинок: ' + body.uploads.length : ''));
    } catch (e) {
      toast('Не удалось применить: ' + (e && e.message ? e.message : 'сеть')
            + '. Используй «Сохранить и получить код».', 'err');
    } finally {
      btn.disabled = false;
      updateSizeMeter();
    }
  }

  // ---------- one place that turns the editor state into the wire body ----------
  // Both channels send exactly the same JSON, so they must build it in exactly one place: a divergence
  // here means «Применить» ships the textures and «Сохранить» silently does not.
  function buildBundleBody() {
    const menus = state.menus.map((m) => ({
      id: m.id,
      yaml: jsyaml.dump(m.obj, { lineWidth: -1, noRefs: true, indent: 2 })
    }));
    const uploads = pendingUploads();
    const bundle = { v: BUNDLE_VERSION, menus };
    if (uploads.length) {
      bundle.assets = uploads.map((e) => ({ name: e.name, kind: e.kind, png: e.b64 }));
    }
    const json = JSON.stringify(bundle);
    return { json, uploads, size: measureJson(json) };
  }

  // Refuse to POST a body the worker will reject anyway, and say exactly what to do about it.
  function guardBundleSize(body) {
    if (body.size <= BUNDLE_SAFE) return true;
    const uploads = body.uploads.length;
    toast('Бандл ' + fmtBytes(body.size) + ' — больше предела ' + fmtBytes(BUNDLE_LIMIT)
          + (uploads
              ? '. Открой «Выбрать…» у текстуры и убери часть новых картинок крестиком (их '
                + uploads + '), либо примени их в два захода.'
              : '. Меню слишком тяжёлые для paste-сервиса — раздели их.'), 'err');
    updateSizeMeter();
    return false;
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
    updateSizeMeter();
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
        // the open-animation `order:` click-grid is sized from rows and may now hold slots that no
        // longer exist — rebuilding menu-settings re-sanitises it against the new grid
        renderMenuSettings();
      };
    } else {
      rowsField.hidden = true;
    }
    // `inp.value` was set programmatically above (no `input` event), so ask the chrome module to
    // re-evaluate which of the ▲/▼ arrows must be greyed out at the 1/6 limits.
    numChrome($('center-toolbar'));
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

    // update-interval (live refresh, ticks) — 0 / absent = off, so omit the key at 0
    const upd = $('ms-update-interval');
    upd.value = (m.obj['update-interval'] != null) ? String(m.obj['update-interval']) : '';
    upd.oninput = () => {
      const v = parseInt(upd.value, 10);
      if (isNaN(v) || v <= 0) delete m.obj['update-interval']; else m.obj['update-interval'] = v;
    };

    // args (named command arguments) — comma/space list <-> string array; empty omits the key
    const args = $('ms-args');
    args.value = Array.isArray(m.obj.args) ? m.obj.args.join(', ') : (m.obj.args != null ? String(m.obj.args) : '');
    args.oninput = () => {
      const list = args.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      if (list.length) m.obj.args = list; else delete m.obj.args;
    };

    // open-item {material, name, cmd, slot, give-on-join} — the whole key is omitted when material is empty
    const oi = (m.obj['open-item'] && typeof m.obj['open-item'] === 'object') ? m.obj['open-item'] : {};
    const oiMat = $('ms-oi-material'), oiName = $('ms-oi-name'), oiCmd = $('ms-oi-cmd'),
          oiSlot = $('ms-oi-slot'), oiJoin = $('ms-oi-join');
    oiMat.value = oi.material != null ? String(oi.material) : '';
    oiName.value = oi.name != null ? String(oi.name) : '';
    oiCmd.value = oi.cmd != null ? String(oi.cmd) : '';
    oiSlot.value = oi.slot != null ? String(oi.slot) : '';
    oiJoin.checked = oi['give-on-join'] === true;
    setMatIconEl($('ms-oi-ic'), oi.material);
    const syncOpenItem = () => {
      const mat = oiMat.value.trim();
      if (!mat) { delete m.obj['open-item']; return; }
      const spec = { material: mat };
      const nm = oiName.value.trim(); if (nm) spec.name = nm;
      const cd = oiCmd.value.trim(); if (cd) spec.cmd = cd;
      const sl = parseInt(oiSlot.value, 10); if (!isNaN(sl)) spec.slot = sl;
      if (oiJoin.checked) spec['give-on-join'] = true;
      m.obj['open-item'] = spec;
    };
    oiMat.oninput = () => { syncOpenItem(); setMatIconEl($('ms-oi-ic'), oiMat.value.trim()); };
    oiName.oninput = syncOpenItem;
    oiCmd.oninput = syncOpenItem;
    oiSlot.oninput = syncOpenItem;
    oiJoin.onchange = syncOpenItem;
    $('ms-oi-pick').onclick = () => openMaterialPickerFor((mat) => {
      oiMat.value = mat; syncOpenItem(); setMatIconEl($('ms-oi-ic'), mat);
    });

    // open-animation {type, interval|speed, sound, order} — omitted when type is none/empty
    const oa = (m.obj['open-animation'] && typeof m.obj['open-animation'] === 'object') ? m.obj['open-animation'] : {};
    const oaType = $('ms-oa-type'), oaSpeed = $('ms-oa-speed'), oaSpeedVal = $('ms-oa-speed-val'),
          oaSound = $('ms-oa-sound'), oaNote = $('ms-oa-speed-note');
    oaSpeed.max = String(OA_SPEED_MAX);   // safety net if index.html is older than this script
    oaType.value = normalizeOaType(oa.type);
    // `order:` is only meaningful for type: custom, but a non-empty list on ANY type is what the
    // plugin reads as "the admin meant custom" (parseOpenAnimation upgrades the type). Mirror that
    // here so a hand-written `order:` without `type:` opens the click-grid instead of looking lost.
    if (Array.isArray(oa.order) && oa.order.length && (oa.type == null || oaType.value === 'custom')) oaType.value = 'custom';
    // the model wins; the draft only fills in when the model has no order to show (see oaOrderDrafts)
    const storedOrder = sanitizeOaOrder(oa.order, slotCount(m.obj));
    const oaOrder = storedOrder.length ? storedOrder : sanitizeOaOrder(oaOrderDrafts.get(m.id), slotCount(m.obj));
    oaSpeed.value = String(oaSpeedOf(oa));
    oaSound.value = oa.sound != null ? String(oa.sound) : '';
    // A legacy `interval` outside the representable 1..20 tick range has no exact speed value; keep it
    // verbatim until the admin actually moves the slider, instead of silently speeding the menu up.
    const legacyIv = (oa && oa.speed == null && oa.interval != null) ? parseInt(oa.interval, 10) : NaN;
    const legacyUnrepresentable = !isNaN(legacyIv) && (legacyIv < 1 || legacyIv > 20);
    const legacySliderValue = oaSpeedOf(oa);
    // 1..100 = one reveal step every N ticks (100 = every tick). Above 100 the pace can no longer be
    // expressed as a tick interval — it means "more than one step per tick" (a BATCH). The engine
    // implements exactly the oaBatchOf() split (OpenAnimation.batchFromSpeed); plugin builds older than
    // that clamp 101..200 back to 100, which only costs speed and never breaks. Say so either way.
    const paintSpeed = () => {
      const sp = parseInt(oaSpeed.value, 10);
      oaSpeedVal.textContent = (isNaN(sp) ? '—' : sp) + '%';
      if (!oaNote) return;
      const fast = !isNaN(sp) && sp > 100;
      oaNote.hidden = !fast;
      const batch = oaBatchOf(sp);
      oaNote.textContent = fast
        ? 'Выше 100% меню раскрывается пачками: ' + batch + ' ' + plural(batch, 'шаг', 'шага', 'шагов')
          + ' за тик. Нужен плагин с поддержкой пачек — более старые сборки зажмут значение до 100%.'
        : '';
      const custom = oaType.value === 'custom';
      setAccSub('ms-anim', (oaType.value === 'none' || !oaType.value)
        ? 'выключена'
        : oaType.value + ' · ' + (isNaN(sp) ? '—' : sp) + '%'
          + (custom ? ' · ' + oaOrder.length + ' ' + plural(oaOrder.length, 'слот', 'слота', 'слотов') : ''));
    };
    const syncOpenAnim = () => {
      paintSpeed();
      // Remember the order even while the type is not custom, so a "what does spiral look like?"
      // detour does not throw the hand-built sequence away. «Очистить» empties it here too, so an
      // intentionally cleared order stays cleared instead of resurrecting on the next render.
      if (oaOrder.length) oaOrderDrafts.set(m.id, oaOrder.slice()); else oaOrderDrafts.delete(m.id);
      const t = oaType.value;
      if (!t || t === 'none') { delete m.obj['open-animation']; renderOaOrder(); return; }
      const spec = { type: t };
      const sp = parseInt(oaSpeed.value, 10);
      if (legacyUnrepresentable && sp === legacySliderValue) spec.interval = legacyIv;
      else if (!isNaN(sp)) spec.speed = Math.max(1, Math.min(OA_SPEED_MAX, sp));   // 1..200
      const snd = oaSound.value.trim(); if (snd) spec.sound = snd;
      // `order:` travels ONLY with type: custom — on any other pattern the plugin warns and ignores
      // it, so writing it would be config noise that shouts on every reload. The draft above is what
      // makes dropping it non-destructive.
      if (t === 'custom' && oaOrder.length) spec.order = oaOrder.slice();
      m.obj['open-animation'] = spec;
      renderOaOrder();
    };

    // ---- custom `order:` click-grid -------------------------------------------------------
    // Clicking a cell appends it to the reveal queue; clicking it again removes it and renumbers
    // everything after. Cells that hold an item show their icon, so the admin picks by sight.
    const ordWrap = $('ms-oa-order-wrap'), ordGrid = $('ms-oa-order-grid'), ordSum = $('ms-oa-order-sum');
    function renderOaOrder() {
      if (!ordWrap || !ordGrid) return;
      const custom = oaType.value === 'custom';
      ordWrap.hidden = !custom;
      if (!custom) { clear(ordGrid); return; }
      const count = slotCount(m.obj);
      const items = m.obj.items || {};
      clear(ordGrid);
      // a non-chest/inventory menu has no grid to click at all (it is raw-YAML-only) — say so instead
      // of drawing an empty 0-column box the admin would read as a rendering bug
      if (!count) {
        ordGrid.style.gridTemplateColumns = '';
        ordGrid.append(el('span', 'faint', 'У этого типа меню нет сетки слотов — задайте order в «Сыром YAML».'));
        if (ordSum) ordSum.textContent = '';
        return;
      }
      ordGrid.style.gridTemplateColumns = 'repeat(' + Math.min(9, count) + ', var(--oa-cell))';
      for (let s = 0; s < count; s++) {
        const idx = oaOrder.indexOf(s);
        const c = el('button', 'oa-cell' + (idx >= 0 ? ' on' : ''));
        c.type = 'button';
        c.title = 'Слот ' + s + (idx >= 0 ? ' — шаг ' + (idx + 1) : ' — не в списке');
        const it = items[String(s)];
        if (it) c.append(makeItemIconHolder(it, 22, 'oa-cell-txt', false));
        c.append(el('span', 'oa-cell-num', idx >= 0 ? String(idx + 1) : String(s)));
        c.onclick = () => {
          const at = oaOrder.indexOf(s);
          if (at >= 0) oaOrder.splice(at, 1); else oaOrder.push(s);
          syncOpenAnim();
        };
        ordGrid.append(c);
      }
      if (ordSum) {
        const rest = count - oaOrder.length;
        ordSum.textContent = oaOrder.length
          ? oaOrder.length + ' из ' + count + (rest ? ' · остальные ' + rest + ' — последним кадром' : ' · весь порядок задан')
          : 'пусто — плагин предупредит и откатится на sweep';
      }
    }
    const ordClear = $('ms-oa-order-clear'), ordRev = $('ms-oa-order-rev');
    if (ordClear) ordClear.onclick = () => { oaOrder.length = 0; syncOpenAnim(); };
    if (ordRev) ordRev.onclick = () => { oaOrder.reverse(); syncOpenAnim(); };

    paintSpeed();
    renderOaOrder();
    // The type <select> is the only control that can bring `order:` in or out of the spec, so it
    // must re-serialise even when nothing else changed (e.g. rows -> custom with a saved order).
    oaType.onchange = syncOpenAnim;
    oaSpeed.oninput = syncOpenAnim;
    oaSound.oninput = syncOpenAnim;

    // open-requirement (block: require + deny/success actions) — top-level menu key
    buildReqBlock($('req-open'),
      () => (m.obj['open-requirement'] != null ? m.obj['open-requirement'] : null),
      (block) => { if (block == null) delete m.obj['open-requirement']; else m.obj['open-requirement'] = block; },
      { title: 'Условие открытия меню (open-requirement)', scope: 'menu' });

    // background: custom GUI texture (+ the schematic over the slot grid)
    renderMenuBackground();

    // collapsed-state summaries + steppers for everything this pass (re)built
    setAccSub('ms-openitem', oiMat.value.trim() ? oiMat.value.trim().toUpperCase() : 'не задан');
    setAccSub('ms-openreq', m.obj['open-requirement'] != null ? 'задано' : 'нет');
    numChrome(box);
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
      renderBgSchema();   // no grid -> the schema has nothing to anchor to; this hides it
      return;
    }
    grid.style.display = 'grid';
    hint.textContent = 'ЛКМ — выбрать · Ctrl — добавить · Shift — диапазон · тянуть — рамкой · ПКМ — меню';

    const count = slotCount(m.obj);
    const items = m.obj.items || {};
    resetIconObserver(); // new lazy-icon observer for this grid generation
    for (let s = 0; s < count; s++) grid.append(buildCell(items[String(s)], s));
    scheduleIconFallback(grid);
    updateSelCounter();
    // The cells were just rebuilt, so the schema's anchor (cell 0) moved — redraw it against the
    // fresh geometry rather than leaving it hanging over the old layout.
    renderBgSchema();
  }

  function buildCell(item, slot) {
    const cell = el('div', 'cell');
    cell.dataset.slot = String(slot);
    cell.append(el('span', 'cell-num', String(slot)));
    if (item) {
      cell.classList.add('filled');
      cell.append(makeItemIconHolder(item, 58, 'cell-txt', true));
    }
    if (isInputItem(item)) markInputCell(cell);
    if (isAnimatedItem(item)) markAnimatedCell(cell, item);
    // a regrid mid-preview (any edit that changes the filled set) rebuilds this cell from scratch —
    // re-apply the "playing" tint so the ticker's next paint lands on a correctly styled cell
    if (animPreview.slot === slot) cell.classList.add('anim-playing');
    if (state.selected.has(slot)) cell.classList.add('selected');
    if (state.active === slot) cell.classList.add('active');
    cell.addEventListener('mousedown', (e) => onCellMouseDown(e, slot));
    cell.addEventListener('mouseenter', (e) => onCellMouseEnter(e, slot));
    cell.addEventListener('contextmenu', (e) => onCellContext(e, slot));
    return cell;
  }

  // an element is an INPUT slot as soon as it carries an `input:` map (the plugin's own marker)
  function isInputItem(it) { return !!(it && typeof it === 'object' && it.input && typeof it.input === 'object'); }
  // visual marker for an input slot: dashed border + a small ⇩ badge. Look lives in style.css
  // (.cell.input-slot / .cell-input-badge) so it follows the theme and the spacing scale.
  function markInputCell(cell) {
    cell.classList.add('input-slot');
    cell.title = 'Input-слот: игрок кладёт сюда свои вещи';
    cell.append(el('span', 'cell-input-badge', '⇩'));
  }
  // an element is ANIMATED once it carries an `animation:` map with at least one frame
  function isAnimatedItem(it) {
    return !!(it && typeof it === 'object' && it.animation && typeof it.animation === 'object'
              && Array.isArray(it.animation.frames) && it.animation.frames.length > 0);
  }
  // Visual marker for an animated slot, built to markInputCell's rules: a corner badge plus an
  // ::after underline, and nothing that touches .cell's own box-shadow (that belongs to the
  // .selected / .active rings). The badge takes the opposite corner from the input one.
  function markAnimatedCell(cell, item) {
    cell.classList.add('anim-slot');
    const n = item.animation.frames.length;
    cell.title = 'Анимированный предмет: ' + n + ' ' + plural(n, 'кадр', 'кадра', 'кадров');
    cell.append(el('span', 'cell-anim-badge', '▶'));
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
    // The frame preview belongs to ONE slot's cell and its ▶/■ button lives in this panel, so it can
    // never outlive the slot that started it — switching slots (or clearing the selection) stops it.
    if (animPreview.slot != null && animPreview.slot !== state.active) stopAnimPreview();
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
    setItemIcon(disp);
    fMat.oninput = () => { assignMaterialLive(fMat.value); renderHeadFields(activeItemObj() || { material: fMat.value }); };
    fMat.onchange = () => { renderGrid(); renderProps(); };

    // EMPTY-slot state: no item yet -> show the "pick a material" prompt and HIDE the rest of the
    // editor, so name/lore/flags/requirements can never materialise a STONE placeholder.
    $('slot-nomat-hint').hidden = !!real;
    $('slot-rest').hidden = !real;
    if (!real) return;

    // cmd (custom-model-data) — bulk. Also repaints the texture note: an explicit cmd WINS over
    // `texture:` on the plugin side, so typing one here silently switches the texture off.
    const fCmd = $('f-cmd');
    fCmd.value = disp.cmd != null ? String(disp.cmd) : '';
    fCmd.oninput = () => { applyBulk((it) => setOrDel(it, 'cmd', fCmd.value), false); paintTextureNote(disp); };

    // texture (pack icon) — bulk
    renderTextureField(disp);

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

    renderSlotMode(disp);           // обычный предмет / input-слот (+ the input editor)
    renderItemAnimation();          // animation: interval/loop/frames (+ the in-grid preview)
    renderHeadFields(disp);
    renderFlags(disp);
    renderClicks(disp);
    renderSlotRequirements(disp);   // view-requirement + click-requirement builders (bulk-aware)
    setAccSub('look', lookSummary(disp));
    // Everything above rebuilt its inputs from scratch — hand the fresh <input type=number> nodes to
    // the stepper decorator. It is idempotent, and the accordions are static markup that renderProps
    // never recreates, so their listeners (one delegated click on document) are NOT re-bound here.
    numChrome(body);
  }

  // drop the colour syntax the plugin understands, so a collapsed summary reads as plain text
  function stripColors(s) {
    return String(s)
      .replace(/<[^>]*>/g, '')                 // <gradient:#f00:#00f>, <red>, …
      .replace(/&#[0-9a-fA-F]{6}/g, '')        // &#RRGGBB
      .replace(/#[0-9a-fA-F]{6}/g, '')         // bare #RRGGBB
      .replace(/[&§][0-9a-fk-orA-FK-OR]/g, '')
      .trim();
  }
  // one-line «what does this item look like» summary for the collapsed «Внешний вид» accordion
  function lookSummary(disp) {
    const bits = [];
    const nm = stripColors(disp.name != null ? disp.name : '');
    if (nm) bits.push(nm.length > 26 ? nm.slice(0, 25) + '…' : nm);
    const loreLines = Array.isArray(disp.lore) ? disp.lore.length : (disp.lore ? 1 : 0);
    if (loreLines) bits.push(loreLines + ' стр. лора');
    if (disp.cmd != null && String(disp.cmd).trim() !== '') bits.push('cmd ' + disp.cmd);
    return bits.length ? bits.join(' · ') : 'имя · лор · модель';
  }

  // ================================================================== INPUT SLOTS (element key `input:`)
  // An input slot is a slot the PLAYER puts their own items into, so every write below targets the
  // ACTIVE slot only — never the bulk selection. Two reasons: (1) mass-applying an item-consuming
  // config from a stray multi-select is how people lose gear, and (2) none of this markup lives inside
  // #f-clicks, so the propagateClicks() keystroke path (which deep-clones the whole clicks object onto
  // every selected slot) can never pick these keys up.
  function renderSlotMode(disp) {
    const it = activeItemObj();
    const isInput = isInputItem(it);
    const bItem = $('f-mode-item'), bInput = $('f-mode-input');
    if (!bItem || !bInput) return;
    bItem.classList.toggle('primary', !isInput);
    bInput.classList.toggle('primary', isInput);
    bItem.setAttribute('aria-pressed', isInput ? 'false' : 'true');
    bInput.setAttribute('aria-pressed', isInput ? 'true' : 'false');
    bItem.onclick = () => setSlotMode(false);
    bInput.onclick = () => setSlotMode(true);

    const hint = $('f-mode-hint');
    if (hint) {
      hint.textContent = isInput
        ? 'Игрок кладёт сюда свои вещи. Настройки input применяются ТОЛЬКО к активному слоту, даже при мультивыделении.'
        : 'Обычный предмет: клики выполняют действия из списка ниже.';
    }
    const note = $('req-view-input-note');
    if (note) note.hidden = !isInput;

    setAccSub('mode', isInput ? 'слот для предметов игрока' : 'обычный предмет');

    const wrap = $('f-input-wrap');
    if (!wrap) return;
    wrap.hidden = !isInput;   // [hidden] here also folds the whole «input» accordion away (data-autohide)
    if (isInput) renderInputEditor(wrap, it);
    else clear(wrap);
  }

  // toggle the active slot between a plain item and an input slot (presence of `input:` IS the mode)
  function setSlotMode(toInput) {
    const it = activeItemObj();
    if (!it) return;
    if (toInput) { if (!isInputItem(it)) it.input = {}; }
    else delete it.input;
    renderGrid();     // the cell marker changes
    renderProps();
  }

  function renderInputEditor(host, it) {
    clear(host);
    const m = current();
    if (!isInputItem(it)) it.input = {};
    const inp = it.input;

    // parser rules the plugin enforces — surfaced here so nothing dies silently in the server log
    const warn = el('div', 'input-warn');   // look: .input-warn in style.css
    const lines =['Действия on-insert / on-extract / on-reject срабатывают на вложение, изъятие и отказ фильтра.'];
    if (m && (m.obj.type || 'chest') === 'inventory') {
      lines.push('⚠ Тип меню «inventory» не поддерживает input-слоты — плагин выбросит этот элемент.');
    }
    const iv = m ? parseInt(m.obj['update-interval'], 10) : NaN;
    if (!isNaN(iv) && iv > 0) lines.push('⚠ update-interval меню будет принудительно обнулён (живое обновление затирало бы вещи игрока).');
    if (it['view-requirement'] != null) lines.push('⚠ view-requirement на input-слоте игнорируется — скрытый слот терял бы вещи.');
    lines.forEach((s) => warn.append(el('span', null, s)));
    host.append(warn);

    // ---- accept: OR-list of filters (empty/absent = accept anything) ----
    host.append(el('span', 'req-sub-lbl', 'Фильтры приёма (accept) — OR-список, пусто = принимать что угодно'));
    const accHost = el('div', 'input-accept');
    host.append(accHost);
    renderAcceptList(accHost, inp);

    // ---- max-amount / lock-extract ----
    host.append(pctField('Максимум предметов (max-amount)', inp['max-amount'],
      (v) => setOrDel(inp, 'max-amount', v), { min: 1, max: 64, step: 1, placeholder: '1' }));
    host.append(checkField('Забрать нельзя (lock-extract)', inp['lock-extract'] === true,
      (on) => { if (on) inp['lock-extract'] = true; else delete inp['lock-extract']; }));

    // ---- placeholder {material, name}: what the slot shows while it is empty ----
    host.append(el('span', 'req-sub-lbl', 'Заглушка пустого слота (placeholder)'));
    const ph = (inp.placeholder && typeof inp.placeholder === 'object') ? inp.placeholder : {};
    const phIc = el('span', 'mat-ic');
    const phMat = document.createElement('input');
    phMat.type = 'text'; phMat.className = 'in';
    phMat.placeholder = 'GRAY_STAINED_GLASS_PANE (пусто — без заглушки)';
    phMat.value = ph.material != null ? String(ph.material) : '';
    const phName = document.createElement('input');
    phName.type = 'text'; phName.className = 'in';
    phName.placeholder = '&7Положи инструмент';
    phName.value = ph.name != null ? String(ph.name) : '';
    const syncPh = () => {
      const mat = phMat.value.trim();
      if (!mat) { delete inp.placeholder; return; }     // no material -> no placeholder at all
      const spec = { material: mat };
      const nm = phName.value.trim(); if (nm) spec.name = nm;
      inp.placeholder = spec;
    };
    phMat.oninput = () => { syncPh(); setMatIconEl(phIc, phMat.value.trim()); };
    phName.oninput = syncPh;
    const phPick = el('button', 'btn small', 'Выбрать…');
    phPick.type = 'button';
    phPick.onclick = () => openMaterialPickerFor((mat) => { phMat.value = mat; syncPh(); setMatIconEl(phIc, mat); });
    const phRow = el('div', 'mat-row');
    phRow.append(phIc, phMat, phPick);
    setMatIconEl(phIc, ph.material);
    host.append(labelWrap('Материал заглушки', phRow));
    host.append(labelWrap('Имя заглушки (цвета &c, &#RRGGBB, #RRGGBB)', phName));

    // ---- on-insert / on-extract / on-reject action lists ----
    [['on-insert', 'При вложении (on-insert)'],
     ['on-extract', 'При изъятии (on-extract)'],
     ['on-reject', 'Отказ фильтра (on-reject)']].forEach(([key, label]) => {
      host.append(el('span', 'req-sub-lbl', label));
      // work on a live array but only WRITE the key while it is non-empty (no `on-insert: []` cruft)
      const arr = Array.isArray(inp[key]) ? inp[key] : [];
      const commit = () => { if (arr.length) inp[key] = arr; else delete inp[key]; };
      const box = el('div', 'req-actions');
      box.addEventListener('input', commit);
      box.addEventListener('change', commit);
      host.append(box);
      renderActionList(box, arr, commit);
    });
  }

  // accept-filter list: each entry is an OR-alternative; an item passes when ANY filter matches
  function renderAcceptList(host, inp) {
    clear(host);
    const list = Array.isArray(inp.accept) ? inp.accept : [];
    list.forEach((f, i) => host.append(buildAcceptRow(host, inp, list, i)));
    const add = el('button', 'btn small add-action', '＋ фильтр');
    add.type = 'button';
    add.onclick = () => {
      const arr = Array.isArray(inp.accept) ? inp.accept : (inp.accept = []);
      arr.push({});
      renderAcceptList(host, inp);
    };
    host.append(add);
  }

  function buildAcceptRow(host, inp, list, idx) {
    if (!list[idx] || typeof list[idx] !== 'object') list[idx] = {};
    const f = list[idx];
    const row = el('div', 'action-row');

    const top = el('div', 'action-top');
    top.append(el('span', 'ck-name', 'Фильтр ' + (idx + 1)));
    const del = el('button', 'btn icon', '×');
    del.type = 'button'; del.title = 'Удалить фильтр';
    del.onclick = () => {
      list.splice(idx, 1);
      if (!list.length) delete inp.accept;              // last one removed -> the key goes away
      renderAcceptList(host, inp);
    };
    top.append(del);
    row.append(top);

    const fields = el('div', 'action-fields');
    // material: a single value stays a bare string, several become a list (both are accepted)
    const matInp = document.createElement('input');
    matInp.type = 'text'; matInp.className = 'in';
    matInp.placeholder = 'DIAMOND_SWORD, NETHERITE_SWORD (пусто — любой)';
    matInp.value = listToText(f.material);
    matInp.oninput = () => setListOrDel(f, 'material', matInp.value);
    const matPick = el('button', 'btn small', 'Выбрать…');
    matPick.type = 'button';
    matPick.onclick = () => openMaterialPickerFor((mat) => {   // append, don't replace: it is an OR-list
      const cur = matInp.value.trim().replace(/,\s*$/, '');
      matInp.value = cur ? cur + ', ' + mat : mat;
      setListOrDel(f, 'material', matInp.value);
    });
    const matRow = el('div', 'mat-row');
    matRow.append(matInp, matPick);
    fields.append(labelWrap('Материалы (material)', matRow));

    fields.append(textField('Имя точно (name-equals)', f['name-equals'], (v) => setOrDel(f, 'name-equals', v)));
    fields.append(textField('Имя содержит (name-contains)', f['name-contains'], (v) => setOrDel(f, 'name-contains', v)));
    fields.append(linesField('Лор содержит (lore-contains, по строке)', f['lore-contains'],
      (v) => setOrDel(f, 'lore-contains', v ? v.map((s) => s.trim()).filter(Boolean) : null), 'Уровень'));

    const line = el('div', 'inline');
    line.append(textField('custom-model-data (cmd)', f.cmd, (v) => setOrDel(f, 'cmd', v)));
    line.append(pctField('Мин. кол-во (min-amount)', f['min-amount'],
      (v) => setOrDel(f, 'min-amount', v), { min: 1, max: 64, step: 1, placeholder: '1' }));
    fields.append(line);

    fields.append(textField('PDC-тег (tag: namespace:key)', f.tag, (v) => setOrDel(f, 'tag', v)));
    fields.append(textField('Чары, мин. уровни (enchants): DAMAGE_ALL: 4, DURABILITY: 2',
      enchToText(f.enchants), (v) => setOrDel(f, 'enchants', parseEnch(v))));

    row.append(fields);
    return row;
  }

  // «Скрыть всё (hide-all)» is deliberately the FIRST control of the section (see index.html): it is the
  // switch people actually reach for, and it overrides the eight individual flags below it. The two are
  // independent YAML keys — hide-all does NOT rewrite `flags:` — so ticking it only DIMS the list (the
  // per-flag values stay editable and are preserved for when hide-all goes back off).
  function renderFlags(disp) {
    const wrap = $('f-flags');
    const hideAll = $('f-hideall');
    clear(wrap);
    const flags = Array.isArray(disp.flags) ? disp.flags : [];
    const boxes = [];

    const syncFlagsUi = () => {
      const all = !!(hideAll && hideAll.checked);
      const on = boxes.filter((c) => c.checked).length;
      wrap.classList.toggle('is-dimmed', all);
      wrap.title = all ? 'Скрыто всё — отдельные флаги сейчас ни на что не влияют' : '';
      setAccSub('flags', all
        ? (on ? 'скрыто всё (+' + on + ' в запасе)' : 'скрыто всё')
        : (on ? on + ' из ' + HIDE_FLAGS.length : 'нет'));
    };

    HIDE_FLAGS.forEach((flag) => {
      const lab = el('label', 'check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = flags.indexOf(flag) !== -1;
      cb.onchange = () => {
        applyBulk((it) => {
          let arr = Array.isArray(it.flags) ? it.flags.slice() : [];
          if (cb.checked) { if (arr.indexOf(flag) === -1) arr.push(flag); }
          else { arr = arr.filter((f) => f !== flag); }
          if (arr.length) it.flags = arr; else delete it.flags;
        }, false);
        syncFlagsUi();
      };
      lab.append(cb, el('span', null, flag.replace('HIDE_', '')));
      boxes.push(cb);
      wrap.append(lab);
    });

    if (!hideAll) return;
    hideAll.checked = disp['hide-all'] === true;
    hideAll.onchange = () => {
      applyBulk((it) => {
        if (hideAll.checked) it['hide-all'] = true; else delete it['hide-all'];
      }, false);
      syncFlagsUi();
    };
    syncFlagsUi();
  }

  // ---------- clicks editor (per click-kind: list of action rows) ----------
  // Reads from the active slot; structural changes mutate the active element and, when
  // more than one slot is selected, propagate the whole clicks object to all targets.
  function renderClicks(disp) {
    const wrap = $('f-clicks');
    clear(wrap);
    const clicks = (disp && disp.clicks && typeof disp.clicks === 'object') ? disp.clicks : {};
    let total = 0, kinds = 0;

    CLICK_KINDS.forEach(([kind, label]) => {
      const actions = Array.isArray(clicks[kind]) ? clicks[kind] : null;
      if (actions) { kinds++; total += actions.length; }
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

    setAccSub('clicks', total ? (total + ' действ. в ' + kinds + ' вид. кликов') : 'нет действий');
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
    sel.onchange = () => {
      // `chance` is type-agnostic — carry it across the reset so switching type doesn't silently
      // turn a 12.5%-chance action into an always-fires one.
      const keep = actions[idx].chance;
      actions[idx] = defaultAction(sel.value);
      if (keep != null) actions[idx].chance = keep;
      propagateClicksIfBulk();
      renderProps();
    };

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
    // field inputs mutate `a`; #f-clicks delegated listener propagates. Structural edits inside
    // nested lists (outcome branches) go through the same bulk-propagate path.
    buildActionFields(fields, a, propagateClicksIfBulk);
    row.append(fields);
    return row;
  }

  // slot number a freshly added slot-action should point at (the slot being edited, when there is one)
  function defaultSlotNum() { return state.active != null ? state.active : 0; }

  function defaultAction(type) {
    switch (type) {
      case 'run_command': return { type, command: '', as: 'player' };
      case 'message': return { type, text: '' };
      case 'broadcast': return { type, text: '' };
      case 'actionbar': return { type, text: '' };
      case 'title': return { type, title: '', subtitle: '', 'fade-in': 10, stay: 40, 'fade-out': 10 };
      case 'open_menu': return { type, menu: '' };
      case 'connect': return { type, server: '' };
      case 'sound': return { type, sound: '' };
      case 'give_item': return { type, material: 'STONE', amount: 1 };
      case 'take_item': return { type, material: 'STONE', amount: 1 };
      case 'give_money': return { type, amount: 100 };
      case 'take_money': return { type, amount: 100 };
      case 'give_exp': return { type, amount: 1 };
      case 'take_exp': return { type, amount: 1 };
      case 'give_permission': return { type, permission: '' };
      case 'take_permission': return { type, permission: '' };
      case 'set_slot': return { type, slot: defaultSlotNum(), material: 'STONE', amount: 1 };
      case 'modify_slot': return { type, slot: defaultSlotNum() };
      case 'clear_slot': return { type, slot: defaultSlotNum() };
      case 'give_slot': return { type, slot: defaultSlotNum() };
      case 'outcome': return { type, outcomes: [] };
      case 'conditional': return { type, requirement: '', then: [], else: [] };
      default: return { type }; // refresh, close, back
    }
  }

  // Build the per-type field inputs for one action; each input mutates `a` directly.
  // `onStruct` (optional) is called after STRUCTURAL edits inside nested lists (outcome branches),
  // where a plain `input` event isn't enough for the caller to notice.
  function buildActionFields(box, a, onStruct) {
    const struct = (typeof onStruct === 'function') ? onStruct : function () { /* noop */ };
    const t = a.type;

    // `chance` is valid on EVERY action type, so it is built BEFORE the per-type branches.
    // Empty box = no key at all (the plugin treats a missing chance as "always"); 0 = never.
    box.append(pctField('Шанс, % (пусто — всегда)', a.chance, (v) => setOrDel(a, 'chance', v),
      { min: 0, max: 100, step: 0.1, placeholder: '100' }));

    if (t === 'run_command') {
      box.append(textField('Команда (без /)', a.command, (v) => { a.command = v; }));
      // `op` = от имени игрока, но с правами оператора. Вариант обязан быть в списке: без него
      // <select> не показывал бы уже сохранённое `as: op`, и админ не увидел бы, где раздаётся оп.
      box.append(selectField('От имени', a.as || 'player',
        [['player', 'игрок'], ['console', 'консоль'], ['op', 'игрок с правами оператора']],
        (v) => { a.as = v; }));
    } else if (t === 'message' || t === 'broadcast') {
      box.append(textField('Текст (цвета &c, &#RRGGBB, #RRGGBB)', a.text, (v) => { a.text = v; }));
    } else if (t === 'actionbar') {
      box.append(textField('Текст (цвета &c, &#RRGGBB, #RRGGBB)', a.text, (v) => { a.text = v; }));
    } else if (t === 'title') {
      box.append(textField('Заголовок (title)', a.title, (v) => { a.title = v; }));
      box.append(textField('Подзаголовок (subtitle)', a.subtitle, (v) => { a.subtitle = v; }));
      const line = el('div', 'inline');
      line.append(numField('Появл. (fade-in)', a['fade-in'], (v) => { a['fade-in'] = v; }));
      line.append(numField('Показ (stay)', a.stay, (v) => { a.stay = v; }));
      line.append(numField('Исчез. (fade-out)', a['fade-out'], (v) => { a['fade-out'] = v; }));
      box.append(line);
    } else if (t === 'open_menu') {
      box.append(textField('ID меню', a.menu, (v) => { a.menu = v; }));
    } else if (t === 'connect') {
      box.append(textField('Сервер (Bungee/Velocity)', a.server, (v) => { a.server = v; }));
    } else if (t === 'sound') {
      box.append(textField('Звук', a.sound, (v) => { a.sound = v; }));
    } else if (t === 'give_permission' || t === 'take_permission') {
      box.append(textField('Право (permission)', a.permission, (v) => { a.permission = v; }));
    } else if (t === 'give_item' || t === 'take_item') {
      box.append(materialField('Материал', a.material, (v) => { a.material = v; }, 'DIAMOND'));
      box.append(numField('Кол-во', a.amount, (v) => { a.amount = v; }));
      if (t === 'give_item') {
        box.append(textField('Имя (необяз.)', a.name, (v) => { setOrDel(a, 'name', v); }));
        box.append(textField('cmd (необяз.)', a.cmd, (v) => { setOrDel(a, 'cmd', v); }));
      }
    } else if (t === 'give_money' || t === 'take_money') {
      box.append(pctField('Сумма (Vault)', a.amount, (v) => setOrDel(a, 'amount', v),
        { min: 0, max: 1e9, step: 0.01, placeholder: '100' }));
    } else if (t === 'give_exp' || t === 'take_exp') {
      box.append(pctField('Кол-во', a.amount, (v) => setOrDel(a, 'amount', v),
        { min: 0, max: 1e9, step: 1, placeholder: '1' }));
      box.append(checkField('В уровнях (level)', a.level === true,
        (on) => { if (on) a.level = true; else delete a.level; }));
    } else if (t === 'clear_slot' || t === 'give_slot') {
      box.append(slotNumField(a));
    } else if (t === 'set_slot') {
      // set_slot REPLACES the slot contents wholesale (NBT of whatever was there is dropped)
      box.append(slotNumField(a));
      box.append(materialField('Материал', a.material, (v) => { a.material = v; }, 'DIAMOND_SWORD'));
      box.append(numField('Кол-во', a.amount, (v) => { a.amount = v; }));
      box.append(textField('Имя (необяз., цвета &c / #RRGGBB)', a.name, (v) => setOrDel(a, 'name', v)));
      box.append(linesField('Лор (по строке на ряд)', a.lore, (v) => setOrDel(a, 'lore', v), '&7Строка лора'));
      box.append(textField('cmd (необяз.)', a.cmd, (v) => setOrDel(a, 'cmd', v)));
    } else if (t === 'modify_slot') {
      // modify_slot EDITS the existing stack in place (keeps NBT) — the forge/upgrade workhorse
      box.append(slotNumField(a));
      box.append(materialField('Сменить материал (set-material)', a['set-material'],
        (v) => setOrDel(a, 'set-material', v), 'не менять'));
      box.append(textField('Сменить имя (set-name)', a['set-name'], (v) => setOrDel(a, 'set-name', v)));
      box.append(linesField('Заменить лор (set-lore)', a['set-lore'], (v) => setOrDel(a, 'set-lore', v), '&7Новый лор'));
      box.append(linesField('Дописать лор (add-lore)', a['add-lore'], (v) => setOrDel(a, 'add-lore', v), '&aУлучшено'));
      box.append(textField('Выдать чары (add-enchant), напр. DAMAGE_ALL: 4, DURABILITY: 2',
        enchToText(a['add-enchant']), (v) => setOrDel(a, 'add-enchant', parseEnch(v))));
      box.append(textField('Снять чары (remove-enchant), через запятую',
        listToText(a['remove-enchant']), (v) => setListOrDel(a, 'remove-enchant', v, true)));
      const amtLine = el('div', 'inline');
      amtLine.append(pctField('Задать кол-во (set-amount)', a['set-amount'],
        (v) => setOrDel(a, 'set-amount', v), { min: 1, max: 64, step: 1, placeholder: '—' }));
      amtLine.append(pctField('Изменить кол-во (add-amount)', a['add-amount'],
        (v) => setOrDel(a, 'add-amount', v), { min: -64, max: 64, step: 1, placeholder: '±0' }));
      box.append(amtLine);
      const miscLine = el('div', 'inline');
      miscLine.append(textField('Задать cmd (set-cmd)', a['set-cmd'], (v) => setOrDel(a, 'set-cmd', v)));
      miscLine.append(pctField('Прочность (damage)', a.damage, (v) => setOrDel(a, 'damage', v),
        { min: -32768, max: 32768, step: 1, placeholder: '±0' }));
      box.append(miscLine);
    } else if (t === 'outcome') {
      buildOutcomeEditor(box, a, struct);
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

  // ---------- outcome: weighted branches, exactly ONE of them runs ----------
  // Weights are NOT percentages — they are normalised against their sum, so the row header shows the
  // resolved probability. Each branch owns a nested action list (rendered by the same renderActionList),
  // which is why chance/delay keep working inside a branch: the plugin re-enters run(...) per action.
  function buildOutcomeEditor(box, a, onStruct) {
    if (!Array.isArray(a.outcomes)) a.outcomes = [];
    const host = el('div', 'outcome-list');
    // fieldWrap, NOT labelWrap: a <label> forwards stray clicks to its first labelable descendant,
    // which here would be a branch's «×» delete button — clicking the caption would drop a branch.
    box.append(fieldWrap('Ветки (outcomes) — сработает ровно одна, веса нормируются', host));
    renderOutcomeList(host, a.outcomes, onStruct);
  }

  function renderOutcomeList(host, outcomes, onStruct) {
    clear(host);
    const heads = [];   // per-branch header spans, refreshed live so weights show real percentages
    const refreshPcts = () => {
      let total = 0;
      outcomes.forEach((o) => { const w = Number(o && o.weight != null ? o.weight : 1); if (isFinite(w) && w > 0) total += w; });
      heads.forEach((h, i) => {
        const o = outcomes[i] || {};
        const w = Number(o.weight != null ? o.weight : 1);
        const pct = (total > 0 && isFinite(w) && w > 0) ? Math.round((w / total) * 1000) / 10 : 0;
        h.textContent = 'Ветка ' + (i + 1) + ' · ' + pct + '%';
      });
    };

    outcomes.forEach((raw, idx) => {
      if (!raw || typeof raw !== 'object') outcomes[idx] = {};
      const o = outcomes[idx];
      if (!Array.isArray(o.actions)) o.actions = [];

      const row = el('div', 'action-row');
      const top = el('div', 'action-top');
      const head = el('span', 'ck-name', 'Ветка ' + (idx + 1));
      heads.push(head);
      const del = el('button', 'btn icon', '×');
      del.type = 'button'; del.title = 'Удалить ветку';
      del.onclick = () => { outcomes.splice(idx, 1); onStruct(); renderOutcomeList(host, outcomes, onStruct); };
      top.append(head, del);
      row.append(top);

      const fields = el('div', 'action-fields');
      fields.append(pctField('Вес (weight, пусто — 1)', o.weight,
        (v) => { setOrDel(o, 'weight', v); refreshPcts(); }, { min: 0, max: 1e6, step: 1, placeholder: '1' }));
      fields.append(el('span', 'req-sub-lbl', 'Действия ветки'));
      const acts = el('div', 'req-actions');
      fields.append(acts);
      row.append(fields);
      host.append(row);
      renderActionList(acts, o.actions, onStruct);
    });

    const add = el('button', 'btn small add-action', '＋ ветка');
    add.type = 'button';
    add.onclick = () => { outcomes.push({ weight: 1, actions: [] }); onStruct(); renderOutcomeList(host, outcomes, onStruct); };
    host.append(add);
    refreshPcts();
  }

  // ---------- small field factories ----------
  function labelWrap(label, inputNode) {
    const f = el('label', 'field');
    f.append(el('span', 'lbl', label), inputNode);
    return f;
  }
  // same look, plain <div>: for captions over a GROUP of controls, where a <label> would forward
  // clicks on the caption to the first control inside (a delete button, say)
  function fieldWrap(label, node) {
    const f = el('div', 'field');
    f.append(el('span', 'lbl', label), node);
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
  // OPTIONAL number field (min/max/step configurable; defaults 0..100 step .1 — the `chance` shape).
  // numField() is unusable for these: its hard min=1 and "empty -> 1" make both `chance: 0` and
  // "no key at all" impossible to express. Here an EMPTY box calls onset(null) so the caller can
  // setOrDel() the key away instead of bloating the YAML with defaults.
  function pctField(label, val, onset, opts) {
    opts = opts || {};
    const min = opts.min != null ? opts.min : 0;
    const max = opts.max != null ? opts.max : 100;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'in';
    inp.min = String(min); inp.max = String(max);
    inp.step = String(opts.step != null ? opts.step : 0.1);
    if (opts.placeholder != null) inp.placeholder = String(opts.placeholder);
    inp.value = (val != null && String(val).trim() !== '') ? String(val) : '';
    const read = () => {
      const raw = inp.value.trim();
      if (raw === '') return null;                       // empty is a real state: "key absent"
      const n = Number(raw);
      if (!isFinite(n)) return null;
      return Math.max(min, Math.min(max, n));
    };
    inp.oninput = () => onset(read());
    // normalise the visible text to the clamped value once the user leaves the box
    inp.onchange = () => { const n = read(); if (n != null && String(n) !== inp.value.trim()) inp.value = String(n); onset(n); };
    return labelWrap(label, inp);
  }
  function checkField(label, checked, onset) {
    const lab = el('label', 'check');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!checked;
    cb.onchange = () => onset(cb.checked);
    lab.append(cb, el('span', null, label));
    return lab;
  }
  // text input + «Выбрать…» button wired to the shared material picker
  function materialField(label, val, onset, placeholder) {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'in';
    inp.value = val != null ? String(val) : '';
    if (placeholder) inp.placeholder = String(placeholder);
    inp.oninput = () => onset(inp.value);
    const pick = el('button', 'btn small', 'Выбрать…');
    pick.type = 'button';
    pick.onclick = () => openMaterialPickerFor((mat) => { inp.value = mat; onset(mat); });
    const row = el('div', 'mat-row');
    row.append(inp, pick);
    return labelWrap(label, row);
  }
  // multi-line text <-> string[]; empty text -> onset(null) so the caller drops the key
  function linesField(label, val, onset, placeholder) {
    const ta = document.createElement('textarea');
    ta.className = 'in area'; ta.rows = 2; ta.spellcheck = false;
    if (placeholder) ta.placeholder = String(placeholder);
    ta.value = Array.isArray(val) ? val.join('\n') : (val != null ? String(val) : '');
    ta.oninput = () => onset(ta.value.trim() === '' ? null : ta.value.split('\n'));
    return labelWrap(label, ta);
  }
  // `slot:` field shared by set_slot / modify_slot / clear_slot / give_slot
  function slotNumField(a) {
    return pctField('Слот (номер в меню)', a.slot, (v) => setOrDel(a, 'slot', v),
      { min: 0, max: 53, step: 1, placeholder: String(defaultSlotNum()) });
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
  // "A, B" <-> "A" | ["A","B"] — the plugin accepts a bare string or a list, so a single entry stays scalar
  function listToText(v) {
    if (Array.isArray(v)) return v.join(', ');
    return v != null ? String(v) : '';
  }
  function setListOrDel(obj, key, text, forceArray) {
    const arr = String(text == null ? '' : text).split(',').map((s) => s.trim()).filter(Boolean);
    if (!arr.length) delete obj[key];
    else if (arr.length === 1 && !forceArray) obj[key] = arr[0];
    else obj[key] = arr;
  }
  // { DAMAGE_ALL: 4 } <-> "DAMAGE_ALL: 4, DURABILITY: 2"
  function enchToText(v) {
    if (!v || typeof v !== 'object') return '';
    return Object.keys(v).map((k) => k + ': ' + v[k]).join(', ');
  }
  function parseEnch(text) {
    const out = {};
    String(text == null ? '' : text).split(',').forEach((part) => {
      const p = part.trim();
      if (!p) return;
      const i = p.indexOf(':');
      const name = (i >= 0 ? p.slice(0, i) : p).trim();
      const lvl = i >= 0 ? parseInt(p.slice(i + 1), 10) : 1;
      if (name) out[name] = isNaN(lvl) ? 1 : lvl;
    });
    return Object.keys(out).length ? out : null;
  }
  // set obj[key]=val, or delete the key when the value is empty (keeps YAML tidy)
  function setOrDel(obj, key, val) {
    if (val == null || String(val).trim() === '') delete obj[key];
    else obj[key] = val;
  }
  // map a stored open-animation type (incl. plugin aliases) onto a <select> option value.
  // Alias table mirrors OpenAnimation.Type.fromConfig() 1:1 — note that `center` deliberately stays
  // on ELLIPSE (it predates center-out; remapping it would silently reshape old configs).
  function normalizeOaType(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (s === 'sweep' || s === 'slots' || s === 'slot') return 'sweep';
    if (s === 'rows' || s === 'row') return 'rows';
    if (s === 'columns' || s === 'column' || s === 'cols' || s === 'col') return 'columns';
    if (s === 'random' || s === 'shuffle') return 'random';
    if (s === 'corners' || s === 'corner') return 'corners';
    if (s === 'edges' || s === 'converge' || s === 'top_bottom' || s === 'top-bottom') return 'edges';
    if (s === 'ellipse' || s === 'oval' || s === 'ripple' || s === 'center') return 'ellipse';
    if (s === 'spiral') return 'spiral';
    if (s === 'center-out' || s === 'center_out' || s === 'centerout' || s === 'outward' || s === 'explode') return 'center-out';
    if (s === 'diagonal' || s === 'diag') return 'diagonal';
    if (s === 'snake' || s === 'zigzag' || s === 'boustrophedon') return 'snake';
    if (s === 'custom' || s === 'order' || s === 'manual') return 'custom';
    return 'none';
  }
  // Sanitise a stored `order:` list the way MenuStore.parseOrder does — drop non-numbers, slots
  // outside the grid and repeats — so the click-grid can never show a state the plugin would reject.
  function sanitizeOaOrder(raw, count) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set(), out = [];
    raw.forEach((v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0 || n >= count || seen.has(n)) return;
      seen.add(n);
      out.push(n);
    });
    return out;
  }
  // stored open-animation pace -> a 1..OA_SPEED_MAX slider value (legacy `interval` ticks are converted)
  function oaSpeedOf(oa) {
    if (oa && oa.speed != null) {
      const s = parseInt(oa.speed, 10);
      if (!isNaN(s)) return Math.max(1, Math.min(OA_SPEED_MAX, s));   // >100 (batched) survives a round-trip
    }
    if (oa && oa.interval != null) {
      const iv = parseInt(oa.interval, 10);
      // a legacy tick interval can only ever describe 1..100 — never invent a batched speed from it
      if (!isNaN(iv)) return Math.max(1, Math.min(100, 100 - (iv - 1) * 5));
    }
    return 95;   // ≈2 ticks/step — matches the pre-speed default instead of the much slower slider midpoint
  }

  // ================================================================== ITEM ANIMATION (element key `animation:`)
  // `animation: { interval, loop, frames: [ …overrides… ] }`. A frame carries ONLY the keys it
  // overrides — everything else is inherited from the base item, and `- {}` is literally "the base
  // item". That inheritance is why every field below goes through setOrDel: an empty box must leave
  // the key OUT of the frame (inherit), not write an empty string that would blank the base value.
  //
  // Like the input editor, all writes target the ACTIVE slot only. Bulk-applying a frame list to a
  // mixed selection is meaningless — frames inherit from the base item, so the same frames on two
  // different items produce two different animations, which is never what a marquee-select meant.
  const ANIM_LOOPS = [['loop', 'Зациклить'], ['once', 'Один раз'], ['pingpong', 'Туда-обратно']];
  const ANIM_DEFAULT_INTERVAL = 10;   // ItemAnimation's own default when `interval:` is absent

  // The plugin's loop aliases, mirrored 1:1 from ItemAnimation.Loop.fromConfig. Kept as data so the two
  // lists can be eyeballed side by side: a missing alias here silently rewrites the admin's mode on the
  // next apply (the editor shows «Зациклить», they click it, and `loop: pingpong` becomes `loop: true`).
  // 'false' is in the once-list on purpose — quoted in YAML it arrives as the STRING "false".
  const ANIM_LOOP_ALIASES = {
    once: ['false', 'no', 'once', 'stop', 'hold'],
    pingpong: ['pingpong', 'ping-pong', 'ping_pong', 'bounce', 'yoyo', 'alternate'],
  };

  // normalise the plugin's loop aliases (incl. the YAML booleans) onto our three option values
  function animLoopOf(raw) {
    if (raw === true) return 'loop';
    if (raw === false) return 'once';
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (ANIM_LOOP_ALIASES.once.includes(s)) return 'once';
    if (ANIM_LOOP_ALIASES.pingpong.includes(s)) return 'pingpong';
    return 'loop';   // true / LOOP / anything unknown — same fallback the engine uses
  }
  // the value we WRITE back for each option (`loop: true` is the engine default but is written
  // anyway: the key is the one thing an admin re-reading the YAML looks for, and it costs one line)
  function animLoopValue(id) { return id === 'once' ? false : (id === 'pingpong' ? 'pingpong' : true); }

  // frame keys the plugin merges over the base item (ItemSpec.merge). The editor only exposes four
  // of them, but the list drives the PREVIEW merge, so a hand-written `flags:` frame still previews.
  const FRAME_KEYS = ['material', 'cmd', 'name', 'lore', 'flags', 'hide-all', 'head-owner', 'head-uuid', 'head-texture'];
  // base item + one frame's overrides -> the item this frame actually shows. Key PRESENCE decides
  // (not truthiness), which is what makes `lore: []` a real "clear the lore" instead of "inherit".
  function mergeFrame(base, frame) {
    const out = {};
    Object.keys(base || {}).forEach((k) => { if (k !== 'animation') out[k] = base[k]; });
    if (frame && typeof frame === 'object') {
      FRAME_KEYS.forEach((k) => { if (Object.prototype.hasOwnProperty.call(frame, k)) out[k] = frame[k]; });
    }
    return out;
  }

  // ---- preview: cycle the frames straight in the grid cell -------------------------------------
  // One preview at a time, keyed by slot. The ticker re-reads the element from the model on every
  // frame, so edits made while it runs show up immediately and a deleted animation stops it by
  // itself — no listener to unsubscribe and no stale copy of the frame list to go out of date.
  const animPreview = { slot: null, timer: null, i: 0, dir: 1, held: false };

  function animPreviewCell(slot) {
    const grid = $('slot-grid');
    return grid ? grid.querySelector('.cell[data-slot="' + slot + '"]') : null;
  }
  // paint `item` into a cell's icon holder, replacing whatever is there (icon holders are cheap and
  // self-contained: .cell-num / the badges are siblings, so they survive untouched)
  function paintCellItem(slot, item) {
    const cell = animPreviewCell(slot);
    if (!cell) return false;
    const holder = makeItemIconHolder(item, 58, 'cell-txt', false);
    const old = cell.querySelector('.ic-holder');
    if (old) cell.replaceChild(holder, old); else cell.append(holder);
    return true;
  }
  function stopAnimPreview() {
    if (animPreview.timer) clearInterval(animPreview.timer);
    const was = animPreview.slot;
    animPreview.timer = null; animPreview.slot = null; animPreview.i = 0; animPreview.dir = 1;
    animPreview.held = false;
    if (was != null) {
      const m = current();
      const it = (m && m.obj.items) ? m.obj.items[String(was)] : null;
      if (it) paintCellItem(was, it);        // restore the base item under the cursor
      const cell = animPreviewCell(was);
      if (cell) cell.classList.remove('anim-playing');
    }
    const btn = $('f-anim-play');
    if (btn) { btn.textContent = '▶ Проиграть'; btn.classList.remove('primary'); }
  }
  // `loop: false` reaches its last frame and HOLDS it — the cell keeps showing that frame (which is
  // exactly what the player would see in game), but the preview is no longer running, so the button
  // has to offer a replay instead of a stop and the pulsing "playing" tint has to go.
  function finishAnimPreview() {
    if (animPreview.timer) clearInterval(animPreview.timer);
    animPreview.timer = null;
    animPreview.held = true;
    const cell = animPreviewCell(animPreview.slot);
    if (cell) cell.classList.remove('anim-playing');
    const btn = $('f-anim-play');
    if (btn) { btn.textContent = '▶ Заново'; btn.classList.remove('primary'); }
  }
  function toggleAnimPreview(slot) {
    // a HELD preview is finished, not running: clicking «Заново» must replay it, not stop it
    if (animPreview.slot === slot && !animPreview.held) { stopAnimPreview(); return; }
    stopAnimPreview();
    const m = current();
    const it = (m && m.obj.items) ? m.obj.items[String(slot)] : null;
    if (!isAnimatedItem(it)) { toast('Сначала добавьте кадры', 'err'); return; }
    animPreview.slot = slot; animPreview.i = 0; animPreview.dir = 1; animPreview.held = false;
    const cell = animPreviewCell(slot);
    if (cell) cell.classList.add('anim-playing');
    const btn = $('f-anim-play');
    if (btn) { btn.textContent = '■ Стоп'; btn.classList.add('primary'); }
    // 1 tick = 50 ms. The floor is one tick, same as the engine's clamp, so the preview can never
    // spin faster than the server would — an admin timing an animation here sees the real pace.
    const iv = Math.max(1, parseInt(it.animation.interval, 10) || ANIM_DEFAULT_INTERVAL);
    const step = () => {
      const cur = current();
      const live = (cur && cur.obj.items) ? cur.obj.items[String(slot)] : null;
      if (!isAnimatedItem(live)) { stopAnimPreview(); return; }      // animation deleted mid-play
      const frames = live.animation.frames;
      const n = frames.length;
      if (animPreview.i >= n) animPreview.i = n - 1;                  // frames removed mid-play
      if (!paintCellItem(slot, mergeFrame(live, frames[animPreview.i]))) { stopAnimPreview(); return; }
      const mode = animLoopOf(live.animation.loop);
      if (n < 2) { finishAnimPreview(); return; }   // one frame: nothing to cycle, so hold it
      if (mode === 'once') {
        if (animPreview.i >= n - 1) { finishAnimPreview(); return; }
        animPreview.i++;
      } else if (mode === 'pingpong') {
        // period 2n-2: the endpoints are visited ONCE per pass, matching ItemAnimation's frameAt()
        if (animPreview.i + animPreview.dir >= n || animPreview.i + animPreview.dir < 0) animPreview.dir *= -1;
        animPreview.i += animPreview.dir;
      } else {
        animPreview.i = (animPreview.i + 1) % n;
      }
    };
    step();                                   // show frame 0 immediately, don't wait a full interval
    if (animPreview.timer == null && animPreview.slot === slot) animPreview.timer = setInterval(step, iv * 50);
  }

  // ---- the editor ------------------------------------------------------------------------------
  function renderItemAnimation() {
    const host = $('f-anim-wrap');
    if (!host) return;
    clear(host);
    const m = current();
    const it = activeItemObj();
    if (!m || !it) { setAccSub('anim', 'нет'); return; }

    // Parser rules that make `animation:` illegal on this element. The plugin throws the animation
    // away with a warning in both cases, so refuse to author one instead of writing dead YAML.
    const blocked = isInputItem(it)
      ? 'На input-слоте анимация запрещена: покадровый перерендер спорит с вещами игрока, плагин её отбросит.'
      : ((m.obj.type || 'chest') === 'inventory'
        ? 'Тип меню «inventory» не поддерживает анимацию предметов — плагин её отбросит.'
        : null);
    if (blocked) {
      stopAnimPreviewFor(state.active);
      const warn = el('div', 'input-warn');
      warn.append(el('span', null, '⚠ ' + blocked));
      host.append(warn);
      if (it.animation != null) {          // an imported/hand-written key that can never run: offer to drop it
        const drop = el('button', 'btn small danger-ghost', 'Удалить animation');
        drop.type = 'button';
        drop.onclick = () => { delete it.animation; renderGrid(); renderProps(); };
        host.append(drop);
      }
      setAccSub('anim', 'недоступна');
      return;
    }

    const anim = (it.animation && typeof it.animation === 'object') ? it.animation : null;
    const frames = (anim && Array.isArray(anim.frames)) ? anim.frames : [];
    // The whole key exists only while there is at least one frame; commit() is the single writer.
    const commit = (regrid) => {
      if (!frames.length) delete it.animation;
      else {
        const spec = it.animation && typeof it.animation === 'object' ? it.animation : {};
        spec.frames = frames;
        it.animation = spec;
      }
      if (regrid) renderGrid();
    };

    if (!frames.length) {
      const hint = el('p', 'faint',
        'Кадры наследуют базовый предмет: в кадре задаются только те поля, что меняются. '
        + 'Пустой кадр = базовый предмет. Ключ animation: появится в YAML только когда есть кадры.');
      host.append(hint);
      const add = el('button', 'btn small add-action', '＋ кадр');
      add.type = 'button';
      add.onclick = () => {
        it.animation = { interval: ANIM_DEFAULT_INTERVAL, loop: true, frames: [{}, {}] };
        renderGrid(); renderProps();
      };
      host.append(add);
      setAccSub('anim', 'нет');
      return;
    }

    // ---- interval + loop ----
    // An EMPTY box DROPS the key instead of pinning it to 10: absent and 10 mean exactly the same
    // thing to the engine, and the placeholder already spells the default out.
    const ivField = pctField('Интервал (тиков на кадр)', anim.interval,
      (v) => {
        if (v == null) delete it.animation.interval;
        else it.animation.interval = Math.max(1, Math.round(v));
        restartPreviewIfPlaying();
      },
      { min: 1, max: 200, step: 1, placeholder: String(ANIM_DEFAULT_INTERVAL) });
    host.append(ivField);

    const loopId = animLoopOf(anim.loop);
    const loopRow = el('div', 'mat-row anim-loop');
    ANIM_LOOPS.forEach(([id, label]) => {
      const b = el('button', 'btn small' + (id === loopId ? ' primary' : ''), label);
      b.type = 'button';
      b.setAttribute('aria-pressed', id === loopId ? 'true' : 'false');
      b.onclick = () => { it.animation.loop = animLoopValue(id); renderItemAnimation(); restartPreviewIfPlaying(); };
      loopRow.append(b);
    });
    host.append(fieldWrap('Повтор (loop)', loopRow));

    // ---- preview ----
    const bar = el('div', 'mat-row anim-bar');
    // three states, matching stop/finish above: running here, finished-and-held here, or not ours
    const mine = animPreview.slot === state.active;
    const running = mine && !animPreview.held;
    const play = el('button', 'btn small' + (running ? ' primary' : ''),
      running ? '■ Стоп' : (mine ? '▶ Заново' : '▶ Проиграть'));
    play.type = 'button'; play.id = 'f-anim-play';
    play.title = 'Прокрутить кадры прямо в ячейке сетки';
    const slotAtBind = state.active;
    play.onclick = () => toggleAnimPreview(slotAtBind);
    bar.append(play, el('span', 'faint', 'кадры крутятся в ячейке слота ' + state.active));
    host.append(bar);

    if (frames.length < 2) {
      const warn = el('div', 'input-warn');
      warn.append(el('span', null, '⚠ Плагину нужно минимум 2 кадра — с одним кадром animation: будет отброшена при загрузке.'));
      host.append(warn);
    }

    // ---- frames ----
    host.append(el('span', 'req-sub-lbl', 'Кадры (frames) — пустое поле = наследовать у базового предмета'));
    const list = el('div', 'anim-frames');
    host.append(list);
    frames.forEach((f, i) => list.append(buildFrameRow(it, frames, i, commit)));

    const add = el('button', 'btn small add-action', '＋ кадр');
    add.type = 'button';
    add.onclick = () => { frames.push({}); commit(true); renderItemAnimation(); };
    host.append(add);

    setAccSub('anim', frames.length + ' ' + plural(frames.length, 'кадр', 'кадра', 'кадров')
      + ' · ' + (anim.interval != null ? anim.interval : ANIM_DEFAULT_INTERVAL) + ' тик.'
      + ' · ' + (ANIM_LOOPS.find(([id]) => id === loopId) || [, ''])[1].toLowerCase());
    numChrome(host);
  }

  // stop the preview when it is running on `slot` (used when a slot stops being animatable)
  function stopAnimPreviewFor(slot) { if (animPreview.slot != null && animPreview.slot === slot) stopAnimPreview(); }
  // interval/loop changed under a running preview -> restart it so the new pacing takes effect
  function restartPreviewIfPlaying() {
    const s = animPreview.slot;
    if (s == null) return;
    stopAnimPreview();
    toggleAnimPreview(s);
  }

  function buildFrameRow(it, frames, idx, commit) {
    if (!frames[idx] || typeof frames[idx] !== 'object') frames[idx] = {};
    const f = frames[idx];
    const row = el('div', 'action-row anim-frame');

    const top = el('div', 'action-top');
    const ic = el('span', 'mat-ic');
    setMatIconEl(ic, f.material != null && String(f.material).trim() ? f.material : it.material);
    top.append(ic, el('span', 'ck-name', 'Кадр ' + (idx + 1)
      + (Object.keys(f).length ? '' : ' — базовый предмет')));

    const up = el('button', 'btn icon', '↑'); up.type = 'button'; up.title = 'Выше';
    up.disabled = idx === 0;
    up.onclick = () => { frames.splice(idx - 1, 0, frames.splice(idx, 1)[0]); commit(true); renderItemAnimation(); };
    const down = el('button', 'btn icon', '↓'); down.type = 'button'; down.title = 'Ниже';
    down.disabled = idx === frames.length - 1;
    down.onclick = () => { frames.splice(idx + 1, 0, frames.splice(idx, 1)[0]); commit(true); renderItemAnimation(); };
    const del = el('button', 'btn icon', '×'); del.type = 'button'; del.title = 'Удалить кадр';
    del.onclick = () => {
      frames.splice(idx, 1);
      if (!frames.length) stopAnimPreviewFor(state.active);
      commit(true);
      renderItemAnimation();
    };
    top.append(up, down, del);
    row.append(top);

    const fields = el('div', 'action-fields');

    // material — empty inherits the base material (the icon above follows suit)
    const mat = document.createElement('input');
    mat.type = 'text'; mat.className = 'in';
    mat.placeholder = 'как у базового (' + String(it.material || '—') + ')';
    mat.value = f.material != null ? String(f.material) : '';
    // commit(false): a frame's material never changes what the GRID shows (the cell paints the base
    // item, and the ▶ badge counts frames), so there is nothing to regrid on every keystroke here.
    const syncMat = () => {
      setOrDel(f, 'material', mat.value.trim());
      setMatIconEl(ic, mat.value.trim() || it.material);
      commit(false);
    };
    mat.oninput = syncMat;
    const pick = el('button', 'btn small', 'Выбрать…');
    pick.type = 'button';
    pick.onclick = () => openMaterialPickerFor((mm) => { mat.value = mm; syncMat(); });
    const matRow = el('div', 'mat-row');
    matRow.append(mat, pick);
    fields.append(labelWrap('Материал (material)', matRow));

    // name / lore are TRI-state: absent = inherit, "" / [] = explicitly blank, value = override.
    // The «убрать» toggle is the only way to express the middle state — an empty text box has to
    // keep meaning "inherit", or a frame could never leave the base name alone.
    fields.append(overrideTextField('Имя (name)', f, 'name', '', it.name, 'убрать имя', commit));
    fields.append(overrideLoreField(f, it, commit));
    fields.append(textField('custom-model-data (cmd)', f.cmd, (v) => { setOrDel(f, 'cmd', v); commit(false); }));
    // `texture:` works per FRAME too (MenuStore resolves icons for frames through the same path), which
    // is how an animated icon changes picture without changing material. Same rule as on the item:
    // an explicit cmd on this frame wins and the texture is dropped.
    if (state.tex.enabled) fields.append(frameTextureField(f, commit));

    row.append(fields);
    return row;
  }

  // compact texture row for one animation frame: text + picker, empty = inherit the base item's icon
  function frameTextureField(f, commit) {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'in';
    inp.placeholder = 'как у базового';
    inp.value = f.texture != null ? String(f.texture) : '';
    const ic = el('span', 'tex-ic');
    setTexIcon(ic, texFind('item', inp.value));
    const sync = () => {
      setOrDel(f, 'texture', inp.value.trim());
      setTexIcon(ic, texFind('item', inp.value));
      commit(false);
    };
    inp.oninput = sync;
    const pick = el('button', 'btn small', 'Выбрать…');
    pick.type = 'button';
    pick.onclick = () => openTexturePicker({
      kind: 'item', current: inp.value,
      onPick: (name) => { inp.value = name; sync(); }
    });
    const row = el('div', 'mat-row');
    row.append(ic, inp, pick);
    return labelWrap('Текстура из пака (texture)', row);
  }

  // text field + an «убрать» checkbox: unchecked & empty -> key absent (inherit); unchecked & typed
  // -> key = text; checked -> key = `blank` (an empty string, i.e. "no custom name on this frame").
  function overrideTextField(label, f, key, blank, inheritedFrom, clearLabel, commit) {
    const wrap = el('div', 'field anim-ov');
    const head = el('div', 'anim-ov-head');
    head.append(el('span', 'lbl', label));
    const cleared = f[key] === blank;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = cleared;
    const cbLab = el('label', 'check tiny');
    cbLab.append(cb, el('span', null, clearLabel));
    head.append(cbLab);
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'in';
    inp.placeholder = inheritedFrom != null && String(inheritedFrom) !== ''
      ? 'как у базового (' + String(inheritedFrom) + ')' : 'как у базового';
    inp.value = (f[key] != null && f[key] !== blank) ? String(f[key]) : '';
    inp.disabled = cleared;
    inp.oninput = () => { setOrDel(f, key, inp.value); commit(false); };
    cb.onchange = () => {
      if (cb.checked) { f[key] = blank; inp.value = ''; inp.disabled = true; }
      else { delete f[key]; inp.disabled = false; }
      commit(false);
    };
    wrap.append(head, inp);
    return wrap;
  }
  // same tri-state for lore, where the "explicitly blank" value is an EMPTY LIST. `lore: []` is the
  // documented way to strip inherited lore in a frame, and it is only distinguishable from "absent"
  // because the plugin reads frames off the raw map — so the editor has to keep the two apart too.
  function overrideLoreField(f, it, commit) {
    const wrap = el('div', 'field anim-ov');
    const head = el('div', 'anim-ov-head');
    head.append(el('span', 'lbl', 'Лор (lore, по строке на ряд)'));
    const cleared = Array.isArray(f.lore) && f.lore.length === 0;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = cleared;
    const cbLab = el('label', 'check tiny');
    cbLab.append(cb, el('span', null, 'убрать лор'));
    head.append(cbLab);
    const ta = document.createElement('textarea');
    ta.className = 'in area'; ta.rows = 2; ta.spellcheck = false;
    const baseLore = Array.isArray(it.lore) ? it.lore.join(' / ') : (it.lore != null ? String(it.lore) : '');
    ta.placeholder = baseLore ? 'как у базового (' + baseLore.slice(0, 40) + ')' : 'как у базового';
    ta.value = (Array.isArray(f.lore) && f.lore.length) ? f.lore.join('\n') : '';
    ta.disabled = cleared;
    ta.oninput = () => {
      if (ta.value.trim() === '') delete f.lore; else f.lore = ta.value.split('\n');
      commit(false);
    };
    cb.onchange = () => {
      if (cb.checked) { f.lore = []; ta.value = ''; ta.disabled = true; }
      else { delete f.lore; ta.disabled = false; }
      commit(false);
    };
    wrap.append(head, ta);
    return wrap;
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
  // Single birth point for a slot element. Every "create the item here" path goes through this, so a
  // new element is ALWAYS a plain item (no `input:` key) — input mode is opted into per slot, never
  // inherited by a slot that a bulk edit happened to materialise.
  function newItem(mat) { return { material: mat }; }
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
        m.obj.items[k] = newItem(mat);
      }
      out.push(m.obj.items[k]);
    });
    return out;
  }
  // when an item's material is no longer a head, drop stale head-* keys (else they linger as YAML cruft
  // and silently re-skin the item if its material is later switched back to a head)
  function stripHeadIfNotHead(it) {
    if (it && !headDescOf(it)) { delete it['head-owner']; delete it['head-uuid']; delete it['head-texture']; }
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
      else if (m.obj.items[k]) { m.obj.items[k].material = val; stripHeadIfNotHead(m.obj.items[k]); }
      else m.obj.items[k] = newItem(val);
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
      if (m.obj.items[k]) { m.obj.items[k].material = mat; stripHeadIfNotHead(m.obj.items[k]); }
      else m.obj.items[k] = newItem(mat);
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
    sel.onchange = () => {
      // keep the type-agnostic `chance` across the reset (see buildActionRow)
      const keep = actions[idx].chance;
      actions[idx] = defaultAction(sel.value);
      if (keep != null) actions[idx].chance = keep;
      onChange();
      renderActionList(host, actions, onChange);
    };
    const del = el('button', 'btn icon', '×'); del.type = 'button'; del.title = 'Удалить действие';
    del.onclick = () => { actions.splice(idx, 1); onChange(); renderActionList(host, actions, onChange); };
    top.append(sel, del);
    row.append(top);
    const fields = el('div', 'action-fields');
    buildActionFields(fields, a, onChange);   // reuses the clicks field editor; mutates `a` in place
    row.append(fields);
    return row;
  }

  // block editor: require (single-requirement builder) + deny + optional success action lists.
  // `getBlock()`/`setBlock(block|null)` abstract storage + bulk (item click-req vs menu open-req).
  function buildReqBlock(host, getBlock, setBlock, opts) {
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
    mountRequirementEditor(reqHost, work.require, (val) => { work.require = val; commit(); }, opts);

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
  function buildReqSingle(host, getReq, setReq, opts) {
    const cur = getReq();
    mountRequirementEditor(host, cur ? JSON.parse(JSON.stringify(cur)) : null, setReq, opts);
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
  function rgLayout(model, dims) {
    const NW = (dims && dims.NW) || RG_NODE_W, NH = (dims && dims.NH) || RG_NODE_H;
    const LEVEL_H = (dims && dims.LEVEL_H) || 96, GAP_X = (dims && dims.GAP_X) || 26;
    const TOP = (dims && dims.TOP) || 30, LEFT = (dims && dims.LEFT) || 90;
    let leaf = 0;
    function assign(id, depth) {
      const n = model.nodes[id];
      if (!n) return;
      n._cy = TOP + depth * LEVEL_H + NH / 2;
      if (!n.children.length) { n._cx = LEFT + leaf * (NW + GAP_X); leaf++; }
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
  function buildRequirementGraph(host, initial, onChange, opts) {
    clear(host);
    host.classList.add('rg-host');
    opts = opts || {};
    // full-screen requirement editor passes { big:true } -> larger nodes + roomier layout that use the space
    const big = !!opts.big;
    const NW = big ? 188 : RG_NODE_W, NH = big ? 60 : RG_NODE_H;
    const dims = big ? { NW: NW, NH: NH, LEVEL_H: 120, GAP_X: 40, TOP: 34, LEFT: 110 } : null;
    const tY = big ? -5 : -3, sY = big ? 16 : 13, subClip = big ? 30 : 20;
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

    function rerender() { rgLayout(model, dims); drawGraph(); renderToolbar(); renderInspector(); }

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
      ids.forEach((id) => { const p = posOf(id); maxX = Math.max(maxX, p.x + NW / 2); maxY = Math.max(maxY, p.y + NH / 2); });
      const W = Math.max(320, Math.round(maxX + 30)), H = Math.max(120, Math.round(maxY + 30));
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', W); svg.setAttribute('height', H);
      // wires first (under nodes)
      ids.forEach((id) => {
        const n = model.nodes[id], p = posOf(id);
        n.children.forEach((c) => { const cp = posOf(c); svg.append(svgEl('path', { class: 'rgedge', d: rgWirePath(p.x, p.y + NH / 2, cp.x, cp.y - NH / 2) })); });
      });
      ids.forEach((id) => svg.append(buildRgNode(id)));
    }

    function buildRgNode(id) {
      const n = model.nodes[id], p = posOf(id);
      const cls = 'rgnode ' + (n.kind === 'leaf' ? 'leaf' : 'logic') + (model.selected === id ? ' sel' : '');
      const g = svgEl('g', { class: cls, transform: 'translate(' + p.x + ',' + p.y + ')', 'data-id': id });
      g.append(svgEl('rect', { class: 'rgbox', x: -NW / 2, y: -NH / 2, width: NW, height: NH, rx: 9 }));
      if (n.kind === 'leaf') {
        g.append(svgEl('text', { class: 'rgtitle', x: 0, y: tY, 'text-anchor': 'middle' }, rgLeafType(n.cond)));
        g.append(svgEl('text', { class: 'rgsub', x: 0, y: sY, 'text-anchor': 'middle' }, rgClip(rgLeafSummary(n.cond), subClip)));
      } else {
        g.append(svgEl('text', { class: 'rgtitle', x: 0, y: tY, 'text-anchor': 'middle' }, n.kind.toUpperCase()));
        g.append(svgEl('text', { class: 'rgsub', x: 0, y: sY, 'text-anchor': 'middle' }, n.kind === 'all' ? 'AND — все' : n.kind === 'any' ? 'OR — любое' : 'NOT — инверсия'));
      }
      g.addEventListener('mousedown', (ev) => onNodeDown(ev, id));
      return g;
    }

    // which node's box is under a model-space point (for drag-drop reparenting)?
    function nodeAt(x, y, exceptId) {
      let hit = null;
      Object.keys(model.nodes).forEach((id) => { if (id === exceptId) return; const p = posOf(id); if (Math.abs(x - p.x) <= NW / 2 && Math.abs(y - p.y) <= NH / 2) hit = id; });
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
  function mountRequirementEditor(host, initial, onChange, opts) {
    clear(host);
    host.classList.add('req-editor');
    opts = opts || {};
    const local = { graph: false };
    let currentValue = initial ? JSON.parse(JSON.stringify(initial)) : null;

    const bar = el('div', 'req-mode-bar');
    bar.append(el('span', 'req-mode-lbl', 'Редактор условия'));
    const btns = el('div', 'req-mode-btns');
    const gbtn = el('button', 'btn small req-graph-toggle', '🔗 Граф');
    gbtn.type = 'button';
    // opens THIS requirement (the live currentValue) in the full-screen editor, writing back through the
    // SAME onChange path (change -> onChange), so round-trip/serialization is identical to the inline editor.
    const fbtn = el('button', 'btn small req-full-toggle', '⛶ На весь экран');
    fbtn.type = 'button'; fbtn.title = 'Открыть это условие в большом редакторе';
    btns.append(gbtn, fbtn);
    bar.append(btns);
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
    fbtn.onclick = () => openReqFullView(opts, currentValue, change);
    mount();
  }

  // wire the per-slot view/click requirement builders from the active item (bulk-aware writes)
  function renderSlotRequirements(disp) {
    buildReqSingle($('req-view'),
      () => (disp && disp['view-requirement']) || null,
      (req) => writeReqKey('view-requirement', req),
      { title: 'Условие показа (view-requirement)', scope: 'slot' });
    buildReqBlock($('req-click'),
      () => (disp && disp['click-requirement']) || null,
      (block) => writeReqKey('click-requirement', block),
      { title: 'Условие клика (click-requirement)', scope: 'slot' });

    const set = [];
    if (disp && disp['view-requirement'] != null) set.push('показ');
    if (disp && disp['click-requirement'] != null) set.push('клик');
    setAccSub('req', set.length ? set.join(' · ') : 'не заданы');
  }

  // ================================================================== FULL-SCREEN REQUIREMENT EDITOR
  // A roomy, dedicated view for ONE requirement (view / click / open), opened by «⛶ На весь экран» from
  // any requirement panel. It takes over the center+right area exactly like the «Граф» / «Сырой YAML»
  // view modes (state.reqEdit + #reqedit-wrap + the `reqedit-mode` layout class, driven by syncModes()).
  // It edits the SAME requirement object through the SAME onChange path the inline editor uses — for
  // view: writeReqKey('view-requirement', …); for click/open: the block's commit — so serialization is
  // unchanged. Three tabs (node-graph at full canvas size / structured / raw) all share one live value.

  // context subtitle: which menu (+ slot, for view/click) this requirement belongs to
  function reqFullSubtitle(scope) {
    const m = current();
    const menu = m ? m.id : '—';
    if (scope === 'menu' || state.active == null) return 'Меню: ' + menu;
    let s = 'Меню: ' + menu + ' · слот ' + state.active;
    const n = targetSlots().length;
    if (n > 1) s += ' (+ ещё ' + (n - 1) + ')';
    return s;
  }

  // enter the full-screen editor for `value`, writing edits back through `onChange` (the inline editor's
  // own change wrapper — identical write path). Mutually exclusive with raw / graph view modes.
  function openReqFullView(opts, value, onChange) {
    opts = opts || {};
    if (!current()) { toast('Нет выбранного меню', 'err'); return; }
    state.reqEditCtx = {
      title: opts.title || 'Условие',
      subtitle: reqFullSubtitle(opts.scope),
      value: value ? JSON.parse(JSON.stringify(value)) : null,
      onChange: onChange
    };
    state.raw = false; state.graph = false; state.reqEdit = true;
    syncModes();
  }

  function closeReqFullView() {
    state.reqEdit = false; state.reqEditCtx = null;
    renderAll();   // rebuilds the inline requirement editors from the (now-updated) menu object
  }

  // full-height raw-YAML editor for a single requirement (the «Сырой YAML» tab of the full view)
  function buildReqRawFull(host, initial, onChange) {
    clear(host);
    host.classList.add('reqedit-raw');
    const ta = document.createElement('textarea');
    ta.className = 'in area reqedit-raw-area'; ta.spellcheck = false;
    ta.value = (initial && typeof initial === 'object')
      ? jsyaml.dump(initial, { lineWidth: -1, noRefs: true, indent: 2 }).trim() : '';
    ta.placeholder = 'type: any\nof:\n  - { type: permission, permission: a.b }\n  - { type: money, amount: 100 }';
    const err = el('div', 'req-raw-err'); err.hidden = true;
    ta.oninput = () => {
      const txt = ta.value.trim();
      if (txt === '') { err.hidden = true; ta.style.borderColor = ''; onChange(null); return; }
      try {
        const parsed = jsyaml.load(txt);
        if (!parsed || typeof parsed !== 'object') throw new Error('ожидается объект');
        err.hidden = true; ta.style.borderColor = ''; onChange(parsed);
      } catch (e) {
        err.textContent = 'YAML: ' + (e && e.message ? e.message : 'ошибка');
        err.hidden = false; ta.style.borderColor = 'var(--danger)';
      }
    };
    host.append(ta, err);
  }

  // render the full-screen editor into #reqedit-wrap (called by syncModes when state.reqEdit is on)
  function renderReqEdit() {
    const wrap = $('reqedit-wrap');
    clear(wrap);
    const ctx = state.reqEditCtx;
    if (!ctx) { state.reqEdit = false; return; }

    const head = el('div', 'reqedit-head');
    const back = el('button', 'btn reqedit-back', '← Назад'); back.type = 'button';
    back.onclick = closeReqFullView;
    const titles = el('div', 'reqedit-titles');
    titles.append(el('div', 'reqedit-title', ctx.title));
    if (ctx.subtitle) titles.append(el('div', 'reqedit-sub', ctx.subtitle));
    head.append(back, titles);
    wrap.append(head);

    const tabs = el('div', 'reqedit-tabs');
    const body = el('div', 'reqedit-body');
    const local = { mode: 'graph' };   // open on the node-graph (the star feature), like the «Граф» view
    let currentValue = ctx.value ? JSON.parse(JSON.stringify(ctx.value)) : null;
    // one live value shared by all three tabs; every edit writes back through the inline editor's path
    function change(val) { currentValue = val ? JSON.parse(JSON.stringify(val)) : null; ctx.onChange(val); }

    const tabDefs = [['graph', '🔗 Граф'], ['simple', 'Простой'], ['raw', 'Сырой YAML']];
    const tabBtns = {};
    function mountBody() {
      // reset the body class each mount: the builders add their own class to the host (req-builder /
      // reqedit-raw / rg-host), which would otherwise accumulate across tab switches.
      const graph = local.mode === 'graph';
      body.className = 'reqedit-body' + (graph ? ' reqedit-body-graph' : '');
      clear(body);
      if (graph) buildRequirementGraph(body, currentValue, change, { big: true });
      else if (local.mode === 'simple') buildRequirementBuilder(body, currentValue, change);
      else buildReqRawFull(body, currentValue, change);
      Object.keys(tabBtns).forEach((k) => tabBtns[k].classList.toggle('active', k === local.mode));
      numChrome(body);   // «Сумма» / «Кол-во» number fields of the structured tab get the ▲/▼ arrows too
    }
    tabDefs.forEach(([k, label]) => {
      const b = el('button', 'btn small reqedit-tab', label); b.type = 'button';
      b.onclick = () => { if (local.mode === k) return; local.mode = k; mountBody(); };
      tabBtns[k] = b; tabs.append(b);
    });
    wrap.append(tabs, body);
    mountBody();
  }

  // ================================================================== ICONS (model-JSON aware)
  // In MC 1.21.11 models/item/<block>.json 404s for block-items, so a naive item/block texture
  // probe misses most blocks. Instead we resolve via the model JSON: redirect item -> block model,
  // walk the parent chain accumulating textures, and classify flat (layer0) / cube / cross / blank.
  // CDN CORS is `*`, so fetch() of the model JSON works. Results are cached per material.

  const stripNs = (s) => String(s == null ? '' : s).replace(/^minecraft:/, '');
  const texUrl = (p) => ICON_BASE + stripNs(p) + '.png';

  // Concurrency gate for model fetches: the picker resolves hundreds of blocks at once, and firing every
  // model request in parallel makes the CDN rate-limit (429) — which is what turned blocks into flat 2D
  // fallbacks. Cap in-flight requests so the CDN keeps answering.
  const MODEL_MAX = 8;
  let modelActive = 0;
  const modelWaiters = [];
  function modelAcquire() {
    if (modelActive < MODEL_MAX) { modelActive++; return Promise.resolve(); }
    return new Promise((res) => modelWaiters.push(res));
  }
  function modelRelease() {
    const next = modelWaiters.shift();
    if (next) next();               // hand the slot straight to the next waiter (count stays at max)
    else modelActive--;
  }

  function fetchModelJson(path) {
    if (modelCache.has(path)) return modelCache.get(path);
    const p = modelAcquire().then(() => fetch(MODEL_BASE + path + '.json')
      .then((r) => {
        if (r.ok) return r.json();
        if (r.status === 404) return null;             // genuinely missing -> cache the null
        throw new Error('HTTP ' + r.status);           // 429 / 5xx when the picker hammers the CDN
      })
      // Transient failure: DON'T pin null (that would freeze the block as a 2D fallback for the whole
      // session) — drop it from the cache so a later render can retry and get the real model.
      .catch(() => { modelCache.delete(path); return null; })
      .finally(() => modelRelease()));
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
    // 4) broadened texture probe before giving up to text. A block texture -> CUBE (blocks must stay 3D
    //    even when the model walk was rate-limited and returned nothing); an item texture -> flat.
    if (await probeTexture('block/' + name)) {
      return { kind: 'cube', top: 'block/' + name, side: 'block/' + name, front: null };
    }
    for (const p of ['item/' + name, 'item/' + name + '_00']) {
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
      // head holders fill eagerly (not via IO), so exclude them — else one head makes the probe think IO
      // fired and the blank lazy material icons never get force-loaded in a background tab.
      holders.forEach((h) => { if (!h.classList.contains('head-holder') && h.childElementCount > 0) anyLoaded = true; });
      if (!anyLoaded) holders.forEach((h) => { if (!h.classList.contains('head-holder') && h.childElementCount === 0) loadIcon(h); });
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

  // small material preview into a given holder (same resolver, rendered immediately)
  function setMatIconEl(holder, material) {
    if (!holder) return;
    clear(holder);
    if (material && String(material).trim()) holder.append(makeIconHolder(material, 28, 'mi-txt', false));
  }
  // props material preview (small): same resolver, rendered immediately
  function setMatIcon(material) { setMatIconEl($('mat-ic'), material); }

  // ============================ PLAYER HEADS (custom skins) ============================
  // A slot renders a vanilla-style isometric head cube built from the full skin sheet (see buildHeadCube)
  // when its material is a player head. Skin sources, in fallback order (headSkinUrls):
  //   head-texture  base64 textures value | skin URL | textures.minecraft.net hash
  //   head-uuid     player UUID  -> minotar.net/skin/<id>.png, then mc-heads.net/skin/<id>
  //   head-owner    player name  -> same two hosts (a %..%/{..} placeholder can't resolve -> Steve's skin)
  // DeluxeMenus-style `material:` prefixes (basehead-/texture-/head-) are recognised too so imported
  // configs render. head-* keys on a NON-head material are ignored (mirrors the plugin).
  function isHeadName(mat) {
    // Only a literal player_head is a real head item in the plugin — mob skulls & player_wall_head aren't
    // items, and 'skull'/'playerhead' don't resolve (all fall back to STONE). DeluxeMenus material
    // prefixes (basehead-/texture-/head-) are recognised separately in headDescOf.
    return stripNs(String(mat || '').toLowerCase()).replace(/\s+/g, '').trim() === 'player_head';
  }
  function trimOrNull(v) { const s = (v == null ? '' : String(v)).trim(); return s || null; }

  function headDescOf(item) {
    if (!item) return null;
    const mat = String(item.material || '');
    const low = mat.toLowerCase();
    let texture = trimOrNull(item['head-texture']);
    let owner = trimOrNull(item['head-owner']);
    let uuid = trimOrNull(item['head-uuid']);
    let isHead = isHeadName(mat);
    if (!texture && (low.startsWith('basehead-') || low.startsWith('texture-'))) { texture = mat.slice(mat.indexOf('-') + 1); isHead = true; }
    else if (!owner && low.startsWith('head-')) { owner = mat.slice(mat.indexOf('-') + 1); isHead = true; }
    if (!isHead) return null;
    return { texture, owner, uuid };
  }

  function skinUrlFromTexture(tex) {
    if (!tex) return null;
    const t = String(tex).trim();
    const toHttps = (u) => u.replace(/^http:\/\//i, 'https://');   // https skin URL: avoid mixed-content block
    if (/^https?:\/\//i.test(t)) return toHttps(t);
    if (/^[0-9a-fA-F]{20,}$/.test(t)) return 'https://textures.minecraft.net/texture/' + t.toLowerCase();
    try {
      const j = JSON.parse(atob(t));
      const u = j && j.textures && j.textures.SKIN && j.textures.SKIN.url;
      if (u) return toHttps(String(u));
    } catch (e) { /* not a base64 textures value */ }
    return null;
  }

  // FULL SKIN urls (not a flat face) in fallback order — the isometric cube below is built from the skin
  // sheet, so we always need the whole thing. A name carrying a placeholder (%..%, {..}) can't be resolved
  // at design time -> a neutral Steve skin.
  function headSkinUrls(desc) {
    const out = [];
    const tex = skinUrlFromTexture(desc.texture);
    if (tex) out.push(tex);
    let id = null;
    if (desc.uuid) id = String(desc.uuid).replace(/-/g, '');
    else if (desc.owner && !/[%{}]/.test(desc.owner)) id = desc.owner;
    if (id) {
      const q = encodeURIComponent(id);
      out.push('https://minotar.net/skin/' + q + '.png');
      out.push('https://mc-heads.net/skin/' + q);
    }
    out.push('https://minotar.net/skin/MHF_Steve.png');
    return out;
  }

  // Head tiles inside a Minecraft skin sheet — [x, y] of the 8x8 tile. The second ("hat") layer uses the
  // same layout shifted +32px in x. `right` faces the viewer in the isometric cube, so it carries the face.
  const HEAD_TILES = { top: [8, 0], right: [8, 8], left: [0, 8] };

  function headFace(cls, skinUrl, x, y) {
    const d = el('div', 'face ' + cls);
    d.style.backgroundImage = "url('" + skinUrl + "')";
    // 8 tiles across the sheet; `auto` height keeps legacy 64x32 skins correct too
    d.style.backgroundSize = 'calc(var(--s) * 8) auto';
    d.style.backgroundPosition = 'calc(var(--s) * ' + (-x / 8) + ') calc(var(--s) * ' + (-y / 8) + ')';
    d.style.backgroundRepeat = 'no-repeat';
    return d;
  }

  // Vanilla-style isometric head: the base cube plus the slightly larger "hat" (second skin layer) on top —
  // the same three-face CSS cube the block icons use, so heads sit in the grid like real inventory items.
  function buildHeadCube(skinUrl, withHat) {
    const wrap = el('div', 'head3d');
    const base = el('div', 'cube');
    const hat = withHat ? el('div', 'cube hat') : null;
    ['top', 'left', 'right'].forEach((cls) => {
      const t = HEAD_TILES[cls];
      base.append(headFace(cls, skinUrl, t[0], t[1]));
      if (hat) hat.append(headFace(cls, skinUrl, t[0] + 32, t[1]));
    });
    wrap.append(base);
    if (hat) wrap.append(hat);
    return wrap;
  }

  /**
   * Vanilla's legacy-skin rule: on a 64x32 sheet the hat region is only genuine when it contains
   * transparency — a fully opaque block there is filler that the client zeroes out. Drawing it anyway
   * would box the face in. Needs a CORS read; all three skin hosts send `Access-Control-Allow-Origin: *`,
   * and if the read is refused we assume filler (a missing rare legacy hat beats a box over the face).
   */
  function legacyHatIsReal(url, done) {
    const cors = new Image();
    cors.crossOrigin = 'anonymous';
    cors.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = cors.naturalWidth; cv.height = cors.naturalHeight;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(cors, 0, 0);
        const d = ctx.getImageData(32, 0, 32, 16).data;
        for (let a = 3; a < d.length; a += 4) {
          if (d[a] < 128) { done(true); return; }   // any transparency -> the author drew a real hat
        }
        done(false);
      } catch (e) { done(false); }
    };
    cors.onerror = () => done(false);
    cors.src = url;
  }

  // skin url -> false (failed) | { hat } (loaded + whether the second layer is real). Mirrors
  // iconResultCache so grid rebuilds are synchronous and flicker-free instead of re-probing every head.
  const headSkinCache = new Map();

  function makeHeadHolder(desc, sizePx, txtCls) {
    const holder = el('div', 'ic-holder head-holder');
    holder.style.setProperty('--sz', sizePx + 'px');
    const urls = headSkinUrls(desc).filter((u) => headSkinCache.get(u) !== false);   // skip known-bad urls
    const paint = (url, hat) => { clear(holder); holder.append(buildHeadCube(url, hat)); };

    const warm = urls.length ? headSkinCache.get(urls[0]) : null;
    if (warm) { paint(urls[0], warm.hat); return holder; }   // fully cached: build now, no probe, no blank

    let i = 0;
    (function tryNext() {
      if (i >= urls.length) {
        if (!holder.firstChild) holder.append(el('span', txtCls || 'cell-txt', 'head'));
        return;
      }
      const url = urls[i++];
      const hit = headSkinCache.get(url);
      if (hit) { paint(url, hit.hat); return; }
      const probe = new Image();   // resolve the skin first so a failed URL never paints a broken cube
      probe.onload = () => {
        if (probe.naturalHeight !== 32) { headSkinCache.set(url, { hat: true }); paint(url, true); return; }
        legacyHatIsReal(url, (hat) => { headSkinCache.set(url, { hat }); paint(url, hat); });
      };
      probe.onerror = () => { headSkinCache.set(url, false); tryNext(); };
      probe.src = url;
    })();
    return holder;
  }

  // head-aware icon: a head face when the item is a head, else the normal material resolver
  function makeItemIconHolder(item, sizePx, txtCls, lazy, observer) {
    const desc = headDescOf(item);
    if (desc) return makeHeadHolder(desc, sizePx, txtCls);
    return makeIconHolder(item.material, sizePx, txtCls, lazy, observer);
  }

  // head-aware small preview (props material row)
  function setItemIcon(item) {
    const holder = $('mat-ic');
    if (!holder) return;
    clear(holder);
    const desc = headDescOf(item);
    if (desc) holder.append(makeHeadHolder(desc, 28, 'mi-txt'));
    else if (item && item.material && String(item.material).trim()) holder.append(makeIconHolder(item.material, 28, 'mi-txt', false));
  }

  function activeItemObj() {
    const m = current();
    return (m && m.obj.items && m.obj.items[String(state.active)]) || null;
  }

  // migrate a DeluxeMenus-prefix material (basehead-/texture-/head-<v>) into native player_head + head-*
  // keys, so editing a head field doesn't drop the skin that was carried inside the material string.
  function normalizeHeadMaterial(it) {
    const mat = String(it.material || '');
    const low = mat.toLowerCase();
    if (low.startsWith('basehead-') || low.startsWith('texture-')) {
      if (!trimOrNull(it['head-texture'])) it['head-texture'] = mat.slice(mat.indexOf('-') + 1);
      it.material = 'player_head';
    } else if (low.startsWith('head-')) {
      if (!trimOrNull(it['head-owner'])) it['head-owner'] = mat.slice(mat.indexOf('-') + 1);
      it.material = 'player_head';
    }
  }

  // populate + wire the head fields; visible whenever the item is a head (incl. DeluxeMenus prefixes),
  // matching the face preview (headDescOf) rather than only a literal player_head material.
  function renderHeadFields(disp) {
    const wrap = $('f-head-fields');
    if (!wrap) return;
    const desc = headDescOf(disp);
    if (!desc) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const fo = $('f-head-owner'), fu = $('f-head-uuid'), ft = $('f-head-texture');
    fo.value = desc.owner || '';   // seed from the decomposed desc so a prefix-carried skin still shows
    fu.value = desc.uuid || '';
    ft.value = desc.texture || '';
    const wire = (input, key) => () => {
      // only touch actual head items (never a non-head slot in a mixed selection); migrate any prefix first
      applyBulk((it) => { if (headDescOf(it)) { normalizeHeadMaterial(it); setOrDel(it, key, input.value); } }, false);
      afterHeadEdit();
    };
    fo.oninput = wire(fo, 'head-owner');
    fu.oninput = wire(fu, 'head-uuid');
    ft.oninput = wire(ft, 'head-texture');
  }
  // keep the material field + previews in sync (normalizeHeadMaterial may have rewritten the material)
  function afterHeadEdit() {
    const it = activeItemObj();
    const fMat = $('f-material');
    if (it && fMat && it.material != null) fMat.value = String(it.material);
    setItemIcon(it || {});
    renderGrid();
  }

  // ================================================================== VIEW MODES (raw / graph)
  // raw and graph are mutually exclusive; both replace the center+right area.
  function syncModes() {
    const layout = $('layout');
    // raw / graph / full-screen-requirement all replace the center area, taking the grid (and with it
    // the cell the preview paints into) off screen — stop it rather than let it tick against nothing
    if (state.raw || state.graph || state.reqEdit) stopAnimPreview();
    $('raw-toggle').setAttribute('aria-pressed', state.raw ? 'true' : 'false');
    $('graph-toggle').setAttribute('aria-pressed', state.graph ? 'true' : 'false');
    layout.classList.toggle('raw-mode', state.raw);
    layout.classList.toggle('graph-mode', state.graph);
    layout.classList.toggle('reqedit-mode', state.reqEdit);
    $('raw-wrap').hidden = !state.raw;
    $('graph-wrap').hidden = !state.graph;
    $('reqedit-wrap').hidden = !state.reqEdit;
    if (state.raw) dumpRaw();
    if (state.graph) renderGraph();
    if (state.reqEdit) renderReqEdit();
    // LAST, and here rather than in renderAll(): the background schema is positioned from the live
    // cell geometry, and until the mode classes above are off the grid is still display:none — every
    // offset reads 0 and the schema silently gives up. renderAll() calls syncModes() at the end, so
    // this is the first moment the grid is measurable again.
    renderBgSchema();
  }

  function dumpRaw() {
    const m = current();
    $('raw-yaml').value = m ? jsyaml.dump(m.obj, { lineWidth: -1, noRefs: true, indent: 2 }) : '';
    updateRawView();
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
      state.graph = false; state.reqEdit = false; state.reqEditCtx = null;   // mutually exclusive
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
      state.reqEdit = false; state.reqEditCtx = null;
      state.graph = true;
      graphView = null;   // reset zoom/pan to fit on each fresh open
      syncModes();
    }
  }

  function showRawErr(msg) { const e = $('raw-err'); e.textContent = 'YAML: ' + msg; e.hidden = false; }
  function hideRawErr() { $('raw-err').hidden = true; }

  // ================================================================== THEME (light / dark)
  const THEME_KEY = 'am_theme';
  function applyStoredTheme() {
    let t = 'dark';
    try { t = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { /* private mode */ }
    setTheme(t === 'light' ? 'light' : 'dark');
  }
  function setTheme(t) {
    const root = document.documentElement;
    if (t === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    const btn = $('theme-btn');
    if (btn) { btn.textContent = t === 'light' ? '☀' : '◐'; btn.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false'); }
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode */ }
  }
  function toggleTheme() {
    setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  }

  // ================================================================== RAW YAML highlight + gutter
  function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function hlYamlValue(v) {
    const lead = v.match(/^\s*/)[0];
    const body = v.slice(lead.length);
    if (body === '') return escHtml(v);
    let cls = 'ys';
    if (/^(true|false|null|~|yes|no|on|off)$/i.test(body)) cls = 'yn';
    else if (/^-?\d+(\.\d+)?$/.test(body)) cls = 'yn';
    return escHtml(lead) + '<span class="' + cls + '">' + escHtml(body) + '</span>';
  }
  function highlightYaml(src) {
    return src.split('\n').map((raw) => {
      // trailing/full-line comment: # at line start or after whitespace (good-enough; ignores # in quotes)
      let code = raw, comment = '';
      const cm = raw.match(/(?:^|\s)#.*$/);
      if (cm) { const i = raw.length - cm[0].length; code = raw.slice(0, i); comment = raw.slice(i); }
      let html;
      const km = code.match(/^(\s*(?:-\s+)?)([^:#\s][^:]*?)(:)(\s.*|$)/);
      if (km) {
        html = escHtml(km[1]) + '<span class="yk">' + escHtml(km[2]) + '</span><span class="yp">:</span>' + hlYamlValue(km[4]);
      } else {
        const lm = code.match(/^(\s*)(-\s+)?(.*)$/);
        html = escHtml(lm[1]) + (lm[2] ? '<span class="yp">' + escHtml(lm[2]) + '</span>' : '') + hlYamlValue(lm[3]);
      }
      if (comment) html += '<span class="yc">' + escHtml(comment) + '</span>';
      return html;
    }).join('\n');
  }
  function updateRawView() {
    const ta = $('raw-yaml');
    if (!ta) return;
    const val = ta.value;
    const hl = $('raw-hl');
    if (hl) hl.innerHTML = highlightYaml(val) + '\n';   // trailing newline so the final line renders
    const gut = $('raw-gutter');
    if (gut) {
      const n = Math.max(1, val.split('\n').length);
      let s = '';
      for (let i = 1; i <= n; i++) s += i + '\n';
      gut.textContent = s;
    }
    syncRawScroll();
  }
  function syncRawScroll() {
    const ta = $('raw-yaml'), hl = $('raw-hl'), gut = $('raw-gutter');
    if (!ta) return;
    if (hl) { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; }
    if (gut) gut.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
  }

  // ================================================================== GRAPH zoom (wheel) + pan (drag)
  function applyGraphView() {
    if (!graphView) return;
    $('graph-svg').setAttribute('viewBox', graphView.x + ' ' + graphView.y + ' ' + graphView.w + ' ' + graphView.h);
  }
  function onGraphWheel(e) {
    if (!state.graph || !graphView) return;
    e.preventDefault();
    const rect = $('graph-svg').getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
    const px = graphView.x + fx * graphView.w, py = graphView.y + fy * graphView.h;
    const aspect = graphView.h / graphView.w;
    const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85;   // wheel up -> zoom in
    let nw = Math.max(140, Math.min(6000, graphView.w * factor));
    const nh = nw * aspect;
    graphView = { x: px - fx * nw, y: py - fy * nh, w: nw, h: nh };
    applyGraphView();
  }
  function onGraphDown(e) {
    if (!state.graph || !graphView || e.button !== 0) return;
    if (e.target.closest('.gnode')) return;   // nodes handle their own drag
    const rect = $('graph-svg').getBoundingClientRect();
    graphPan = { sx: e.clientX, sy: e.clientY, ox: graphView.x, oy: graphView.y,
                 uw: graphView.w / rect.width, uh: graphView.h / rect.height };
    e.preventDefault();
  }
  function onGraphMove(e) {
    if (!graphPan) return;
    graphView.x = graphPan.ox - (e.clientX - graphPan.sx) * graphPan.uw;
    graphView.y = graphPan.oy - (e.clientY - graphPan.sy) * graphPan.uh;
    applyGraphView();
  }
  function onGraphUp() { graphPan = null; }

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
    if (!graphView) graphView = { x: 0, y: 0, w: W, h: H };
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    applyGraphView();

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
    // legacy &-codes are the documented default notation now (&f = белый)
    const obj = type === 'inventory'
      ? { type: 'inventory', title: '&f' + id, items: {} }
      : { type: 'chest', title: '&f' + id, rows: 3, items: {} };

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

  // ================================================================== TEXTURES
  /* Custom resource-pack textures: the catalog the plugin ships in the bundle, the uploader that puts
   * new PNGs back into it, and the bundle-size meter that keeps the whole thing under the worker's cap.
   *
   * WHY THE CATALOG TRAVELS IN THE BUNDLE: the paste worker only knows "store a body / return a body".
   * A second channel for binaries would need worker changes, a second round-trip and its own TTL, and
   * the numbers say it is not needed yet — 50 icons at 32x32 plus 10 backgrounds at 256x256 is ~780 KB
   * of the 2 MB budget once the browser has normalised them.
   *
   * WHY THE BROWSER RESAMPLES: the server would do it anyway (icons are flat 2D item textures, glyph
   * backgrounds are clamped to 256 px per side and nearest-neighbour resampled), so shrinking here
   * loses nothing and is the difference between a 4 KB upload and a 2.4 MB one.
   *
   * NAME RULES ARE COPIED FROM THE PLUGIN ON PURPOSE (texSanitize == TextureStore.sanitize): the editor
   * writes `texture: coin` into YAML, and the file lands under whatever name the plugin's sanitiser
   * produced. If the two disagreed by a single character, the menu would reference a file that does
   * not exist — and the only symptom would be a plain PAPER in a slot.
   */

  // file name -> id. Same rules as TextureStore.sanitize: lower-case, only [a-z0-9_-], everything else
  // DELETED (not replaced) — that deletion is also what kills path traversal, since dots and slashes
  // cannot survive it.
  function texSanitize(name) {
    let base = String(name == null ? '' : name).trim();
    const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
    if (slash >= 0) base = base.slice(slash + 1);
    if (base.toLowerCase().endsWith('.png')) base = base.slice(0, -4);
    return base.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  }

  const texList = (kind) => (kind === 'gui' ? state.tex.gui : state.tex.item);
  function texFind(kind, name) {
    const id = texSanitize(name);
    if (!id) return null;
    return texList(kind).find((e) => e.name === id) || null;
  }
  // data URL for an <img>, or null when the plugin sent this entry without a preview (too big / the
  // catalog's preview budget ran out). Name-only entries are still fully usable — just not visible.
  function texDataUrl(entry) {
    return entry && entry.b64 ? 'data:image/png;base64,' + entry.b64 : null;
  }
  function pendingUploads() {
    return texList('item').concat(texList('gui')).filter((e) => e.pending);
  }
  // called after a successful POST: the pictures are on the wire, so they stop counting as "new"
  function markUploadsSent(uploads) {
    uploads.forEach((e) => { e.pending = false; });
    renderTexGrid();
  }

  // Read the catalog the plugin put next to the menus. Tolerates every older shape: a missing block
  // (pre-textures plugin), bare strings instead of objects, entries without previews.
  function readTextureCatalog(bundle) {
    const t = state.tex;
    const has = !!bundle && typeof bundle === 'object';
    t.known = has && bundle.texturesEnabled != null;
    t.enabled = has && bundle.texturesEnabled === true;
    const limit = has ? parseInt(bundle.pngLimit, 10) : NaN;
    t.pngLimit = (!isNaN(limit) && limit > 0) ? limit : PNG_LIMIT_DEFAULT;
    t.item = catalogFrom(has ? bundle.textures : null, 'item');
    t.gui = catalogFrom(has ? bundle.guiTextures : null, 'gui');
  }

  function catalogFrom(raw, kind) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    raw.forEach((e) => {
      const name = texSanitize(typeof e === 'string' ? e : (e && e.name));
      if (!name || out.some((x) => x.name === name)) return;
      const o = (e && typeof e === 'object') ? e : {};
      out.push({
        name,
        kind,
        w: parseInt(o.w, 10) || 0,
        h: parseInt(o.h, 10) || 0,
        bytes: parseInt(o.bytes, 10) || 0,
        b64: typeof o.png === 'string' && o.png ? o.png : null,
        pending: false
      });
    });
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // ---------- upload: canvas normalisation ----------
  // Down-scales to the pipeline's real ceiling and re-encodes as PNG. imageSmoothingEnabled=false is
  // not a style choice: the plugin resamples backgrounds nearest-neighbour, and a browser-smoothed
  // source would arrive blurred and then be resampled AGAIN.
  function normalizeImage(file, kind) {
    const max = kind === 'gui' ? MAX_GUI_PX : MAX_ITEM_PX;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { reject(new Error('не удалось прочитать размеры картинки')); return; }
        const k = Math.min(1, max / w, max / h);
        const tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
        const cv = document.createElement('canvas');
        cv.width = tw; cv.height = th;
        const ctx = cv.getContext('2d');
        if (!ctx) { reject(new Error('canvas недоступен')); return; }
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, tw, th);
        ctx.drawImage(img, 0, 0, tw, th);
        cv.toBlob((blob) => {
          if (!blob) { reject(new Error('не удалось перекодировать в PNG')); return; }
          blob.arrayBuffer()
            .then((buf) => resolve({ bytes: new Uint8Array(buf), w: tw, h: th, scaled: k < 1 }))
            .catch(reject);
        }, 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('не картинка или файл повреждён')); };
      img.src = url;
    });
  }

  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  function isPngBytes(b) {
    if (!b || b.length < PNG_MAGIC.length) return false;
    for (let i = 0; i < PNG_MAGIC.length; i++) if (b[i] !== PNG_MAGIC[i]) return false;
    return true;
  }
  // btoa() on a 256 KB string via apply() blows the argument limit, hence the chunking
  function bytesToB64(bytes) {
    let s = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(s);
  }

  // Take one dropped/chosen file all the way to a catalog entry. Keeps the ORIGINAL bytes when they
  // are already a small-enough PNG and weigh less than the re-encode: canvas always writes RGBA8, so
  // a palettised 256x256 background can be 4 KB as authored and 20 KB after a pointless round trip.
  async function ingestFile(file, kind) {
    const norm = await normalizeImage(file, kind);
    let bytes = norm.bytes;
    if (!norm.scaled) {
      try {
        const raw = new Uint8Array(await file.arrayBuffer());
        if (isPngBytes(raw) && raw.length && raw.length <= bytes.length) bytes = raw;
      } catch (e) { /* keep the canvas copy */ }
    }
    if (bytes.length > state.tex.pngLimit) {
      throw new Error('после сжатия всё ещё ' + fmtBytes(bytes.length)
                      + ' — предел плагина ' + fmtBytes(state.tex.pngLimit));
    }
    return { bytes, w: norm.w, h: norm.h, scaled: norm.scaled };
  }

  async function addTextureFiles(files, kind) {
    if (!files || !files.length) return;
    if (!state.tex.enabled) { toast('Текстуры на сервере выключены — загружать некуда', 'err'); return; }
    let added = 0;
    for (const file of files) {
      let name = texSanitize(file.name);
      if (!name) {
        name = texSanitize(await modalPrompt('Имя текстуры', {
          label: 'Из имени файла «' + file.name + '» не осталось ни одного допустимого символа. '
               + 'Задай имя латиницей (a-z, 0-9, _ и -).',
          placeholder: 'coin'
        }));
        if (!name) continue;
      }
      const existing = texFind(kind, name);
      if (existing) {
        const ok = await modalConfirm('Заменить текстуру?',
          'Текстура «' + name + '» уже есть' + (existing.pending ? ' (ещё не отправлена)' : ' на сервере')
          + '. Заменить её этим файлом?');
        if (!ok) continue;
      }
      let img;
      try {
        img = await ingestFile(file, kind);
      } catch (e) {
        toast('«' + file.name + '»: ' + (e && e.message ? e.message : 'не удалось обработать'), 'err');
        continue;
      }
      const entry = {
        name, kind, w: img.w, h: img.h, bytes: img.bytes.length,
        b64: bytesToB64(img.bytes), pending: true
      };
      const list = texList(kind);
      const at = list.findIndex((e) => e.name === name);
      if (at >= 0) list[at] = entry; else list.push(entry);
      list.sort((a, b) => a.name.localeCompare(b.name));
      added++;
      if (img.scaled) {
        toast('«' + name + '» ужата до ' + img.w + '×' + img.h
              + ' — пак всё равно не примет больше', 'ok');
      }
    }
    if (added) {
      renderTexGrid();
      updateSizeMeter();
      renderProps();
      renderMenuSettings();
      renderBgSchema();
      toast(added + ' ' + plural(added, 'картинка добавлена', 'картинки добавлены', 'картинок добавлено')
            + ' — уедут на сервер по «Применить»', 'ok');
    }
  }

  // ---------- picker modal ----------
  let tpCtx = null;          // { kind, current, allowClear, onPick }
  let tpSearchTimer = null;

  // The picker is ALWAYS opened for one pipeline. `allowClear` shows the «Без текстуры» button.
  function openTexturePicker(opts) {
    tpCtx = {
      kind: opts.kind === 'gui' ? 'gui' : 'item',
      current: texSanitize(opts.current),
      allowClear: opts.allowClear !== false,
      onPick: opts.onPick
    };
    const gui = tpCtx.kind === 'gui';
    $('tp-title').textContent = gui ? 'Фон окна — текстуры GUI' : 'Иконка предмета — текстуры пака';
    $('tp-drop-note').textContent = gui
      ? 'PNG из plugins/AlexMenus/textures/gui/ · большие ужимаются до ' + MAX_GUI_PX + '×' + MAX_GUI_PX
        + ' (потолок шрифтового атласа)'
      : 'PNG из plugins/AlexMenus/textures/items/ · большие ужимаются до ' + MAX_ITEM_PX + '×' + MAX_ITEM_PX;
    const off = $('tp-off');
    off.hidden = state.tex.enabled;
    off.textContent = 'На сервере textures.enabled: false — плагин не собирает пак и игнорирует ключи '
                    + 'texture: и background:. Загрузка отключена; включи текстуры в config.yml и выполни /am reload.';
    $('tp-browse').disabled = !state.tex.enabled;
    $('tp-none').hidden = !tpCtx.allowClear;
    $('tp-search').value = '';
    $('texture-modal').hidden = false;
    renderTexGrid();
    $('tp-search').focus();
  }

  function closeTexturePicker() {
    $('texture-modal').hidden = true;
    tpCtx = null;
  }

  function renderTexGrid() {
    if (!tpCtx) return;
    const grid = $('tp-grid');
    if (!grid) return;
    clear(grid);
    const q = ($('tp-search').value || '').trim().toLowerCase();
    const all = texList(tpCtx.kind);
    const shown = q ? all.filter((e) => e.name.indexOf(q) !== -1) : all;
    shown.forEach((e) => grid.append(buildTexCell(e)));

    const note = $('tp-note');
    if (!all.length) {
      note.textContent = state.tex.enabled
        ? 'В паке пока нет ни одной картинки — перетащи PNG сюда.'
        : 'Каталог пуст: текстуры выключены на сервере.';
    } else {
      const pend = all.filter((e) => e.pending).length;
      note.textContent = shown.length + ' из ' + all.length
        + (pend ? ' · новых (ещё не на сервере): ' + pend : '');
    }
  }

  function buildTexCell(entry) {
    const cell = el('button', 'tp-cell' + (tpCtx && entry.name === tpCtx.current ? ' active' : ''));
    cell.type = 'button';
    const thumb = el('div', 'tp-thumb');
    const url = texDataUrl(entry);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = entry.name;
      thumb.append(img);
    } else {
      // A catalog entry without a preview is normal: the plugin only embeds pictures up to a budget.
      thumb.append(el('span', 'tp-noimg', '🖼'));
    }
    cell.append(thumb);
    cell.append(el('span', 'tp-name', entry.name));
    const size = entry.w && entry.h ? entry.w + '×' + entry.h : '';
    cell.append(el('span', 'tp-size', size + (entry.bytes ? (size ? ' · ' : '') + fmtBytes(entry.bytes) : '')));
    if (entry.pending) {
      cell.append(el('span', 'tp-badge', 'новая'));
      // The size meter can block sending; without a way to take a queued picture back OUT, the only
      // escape from an overfull bundle would be reloading the page and losing every unsaved edit.
      const drop = el('button', 'tp-drop-btn', '×');
      drop.type = 'button';
      drop.title = 'Убрать из отправки (файл на сервере не тронут)';
      drop.onclick = (e) => { e.stopPropagation(); removePending(entry); };
      cell.append(drop);
    }
    cell.title = entry.name + (url ? '' : ' — превью не приехало (крупный файл), но текстура рабочая');
    cell.onclick = () => {
      const cb = tpCtx && tpCtx.onPick;
      closeTexturePicker();
      if (cb) cb(entry.name);
    };
    return cell;
  }

  // Take a queued upload back out of the bundle. Only ever called for `pending` entries — anything
  // already on the server would need a delete channel the plugin deliberately does not have.
  function removePending(entry) {
    const list = texList(entry.kind);
    const at = list.indexOf(entry);
    if (at < 0) return;
    list.splice(at, 1);
    const used = texUsage(entry.name, entry.kind);
    renderTexGrid();
    updateSizeMeter();
    renderProps();
    renderMenuSettings();
    toast('«' + entry.name + '» убрана из отправки'
          + (used ? ' — но на неё всё ещё ссылается меню (' + used + ')' : ''),
          used ? 'err' : 'ok');
  }

  // How many places still reference this texture name (so removing it can say so out loud).
  function texUsage(name, kind) {
    let n = 0;
    state.menus.forEach((m) => {
      const obj = m.obj || {};
      if (kind === 'gui') {
        const bg = bgOf(obj);
        if (!bg) return;
        if (texSanitize(bg.image) === name) n++;
        (Array.isArray(bg.overlays) ? bg.overlays : []).forEach((ov) => {
          if (texSanitize(ov.image) === name) n++;
        });
        return;
      }
      const items = (obj.items && typeof obj.items === 'object') ? obj.items : {};
      Object.keys(items).forEach((k) => {
        const it = items[k];
        if (!it || typeof it !== 'object') return;
        if (texSanitize(it.texture) === name) n++;
        const frames = it.animation && Array.isArray(it.animation.frames) ? it.animation.frames : [];
        frames.forEach((f) => { if (f && texSanitize(f.texture) === name) n++; });
      });
    });
    return n;
  }

  // ---------- bundle-size meter ----------
  // Both numbers matter: the worker compares body.length (UTF-16 code units) against its 2 MB cap,
  // while the Durable Object behind «Применить» stores real bytes. Cyrillic YAML makes those two
  // differ by up to 2x, so the meter shows whichever is closer to blowing up.
  function measureJson(json) {
    const chars = json.length;
    let bytes = chars;
    try { bytes = new TextEncoder().encode(json).length; } catch (e) { /* ancient browser */ }
    return Math.max(chars, bytes);
  }

  function fmtBytes(n) {
    if (!isFinite(n)) return '—';
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0).replace('.', ',') + ' КБ';
    const mb = n / (1024 * 1024);
    // «2 МБ», not «2,00 МБ» — the denominator of the meter must read like the limit it is
    return (Math.abs(mb - Math.round(mb)) < 0.005 ? String(Math.round(mb))
                                                  : mb.toFixed(2).replace('.', ',')) + ' МБ';
  }

  let sizeTimer = null;
  // Measuring means dumping every menu to YAML, so it is debounced off keystrokes. Both send paths
  // measure again synchronously before posting — the meter is a warning light, not the gate.
  function scheduleSizeMeter() {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(updateSizeMeter, 700);
  }

  function updateSizeMeter() {
    const meter = $('size-meter');
    if (!meter) return;
    if (!state.menus.length) { meter.hidden = true; return; }
    let size;
    try {
      size = measureJson(buildBundleBody().json);
    } catch (e) {
      meter.hidden = true;   // a menu object that won't serialise: raw mode will report it properly
      return;
    }
    meter.hidden = false;
    const frac = Math.min(1, size / BUNDLE_LIMIT);
    const over = size > BUNDLE_SAFE;
    $('size-fill').style.width = (frac * 100).toFixed(1) + '%';
    $('size-txt').textContent = fmtBytes(size) + ' / ' + fmtBytes(BUNDLE_LIMIT);
    meter.classList.toggle('warn', !over && frac >= SIZE_WARN_AT);
    meter.classList.toggle('over', over);
    const pend = pendingUploads();
    meter.title = 'Размер бандла: меню + ' + pend.length + ' '
      + plural(pend.length, 'новая картинка', 'новые картинки', 'новых картинок')
      + '. Предел paste-сервиса — ' + fmtBytes(BUNDLE_LIMIT)
      + (over ? '. Сейчас отправка заблокирована.' : '');
    // The apply button has its own reason to be disabled (a link minted without a live session) —
    // never re-enable it here, only add the size veto on top.
    $('save-btn').disabled = over;
    $('apply-btn').disabled = over || !state.applyToken;
  }

  // ---------- slot `texture:` field ----------
  function renderTextureField(disp) {
    const field = $('f-texture-field');
    if (!field) return;
    const inp = $('f-texture');
    const enabled = state.tex.enabled;
    const raw = disp.texture != null ? String(disp.texture) : '';
    inp.value = raw;
    inp.disabled = !enabled;
    $('f-texture-pick').disabled = !enabled;
    $('f-texture-clear').disabled = !enabled || !raw;
    setTexIcon($('f-texture-ic'), texFind('item', raw));

    inp.oninput = () => {
      applyBulk((it) => setOrDel(it, 'texture', inp.value.trim()), false);
      paintTextureNote(disp);
      setTexIcon($('f-texture-ic'), texFind('item', inp.value));
      $('f-texture-clear').disabled = !inp.value.trim();
    };
    $('f-texture-pick').onclick = () => openTexturePicker({
      kind: 'item',
      current: inp.value,
      onPick: (name) => { inp.value = name; inp.oninput(); }
    });
    $('f-texture-clear').onclick = () => { inp.value = ''; inp.oninput(); };
    paintTextureNote(disp);
  }

  // Everything that can make `texture:` silently do nothing, said out loud.
  function paintTextureNote(disp) {
    const note = $('f-texture-note');
    if (!note) return;
    const raw = ($('f-texture').value || '').trim();
    const cmd = ($('f-cmd').value || '').trim();
    note.className = 'faint';
    if (!state.tex.enabled) {
      note.className = 'faint err';
      note.textContent = state.tex.known
        ? 'Текстуры выключены на сервере (textures.enabled: false) — ключ texture: будет проигнорирован.'
        : 'Плагин не сообщил о поддержке текстур — обнови плагин или используй cmd:.';
      return;
    }
    if (!raw) { note.textContent = ''; return; }
    const id = texSanitize(raw);
    if (!id) {
      note.className = 'faint err';
      note.textContent = 'Недопустимое имя: разрешены только a-z, 0-9, _ и -. Плагин это имя отбросит.';
      return;
    }
    if (id !== raw) {
      note.className = 'faint warn';
      note.textContent = 'Плагин приведёт имя к «' + id + '» — файл должен называться textures/items/'
                       + id + '.png. Лучше вписать «' + id + '» прямо здесь.';
      return;
    }
    if (cmd) {
      note.className = 'faint warn';
      note.textContent = 'Заданы и cmd:, и texture: — выигрывает cmd:, текстура НЕ подключится '
                       + '(явный cmd мог быть написан под чужой пак). Очисти cmd, чтобы включить текстуру.';
      return;
    }
    if (!texFind('item', id)) {
      note.className = 'faint warn';
      note.textContent = 'В паке нет textures/items/' + id + '.png — загрузи файл через «Выбрать…».';
      return;
    }
    note.textContent = 'Плагин выдаст предмету custom-model-data «am_' + id + '» из собранного пака.';
  }

  function setTexIcon(host, entry) {
    if (!host) return;
    clear(host);
    const url = texDataUrl(entry);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      host.append(img);
    } else {
      host.append(el('span', 'tex-q', entry ? '🖼' : '—'));
    }
  }

  // ================================================================== BACKGROUND (menu `background:`)
  /* The editor writes the human form of the vertical axis: `y:` = offset from the TOP of the window,
   * which parseBackground turns into `ascent: 13 - y`. Both keys are accepted by the plugin and
   * `ascent:` wins when both are present, so writing `y:` and deleting any inherited `ascent:` is the
   * only way to keep the two from fighting.
   */
  const bgOf = (obj) => (obj && obj.background && typeof obj.background === 'object') ? obj.background : null;
  const chestHeight = (rows) => rows * SLOT_PITCH + 31;
  // `ascent:` -> "offset from the top". Kept as one named helper so the schema and the fields cannot
  // drift apart on the sign.
  const topFromAscent = (a) => TITLE_BASELINE - a;
  const ascentFromTop = (y) => TITLE_BASELINE - y;

  function readTop(spec) {
    if (spec && spec.ascent != null && String(spec.ascent).trim() !== '') {
      const a = parseInt(spec.ascent, 10);
      if (!isNaN(a)) return topFromAscent(a);
    }
    const y = parseInt(spec && spec.y, 10);
    return isNaN(y) ? 0 : y;
  }
  // Always writes `y:` and drops `ascent:`: keeping both means the editor's number is silently ignored.
  function writeTop(spec, y) {
    delete spec.ascent;
    if (y) spec.y = y; else delete spec.y;
  }

  // Effective on-screen size, mirroring GuiFont.resolve(): height 0 = natural, width 0 = from the
  // natural proportions at that height, both clamped to 1..256. Returns [0,0] when the natural size
  // is unknown (a catalog entry that arrived without a preview) and nothing was typed.
  function bgSize(entry, w, h) {
    const clamp = (v) => Math.max(1, Math.min(MAX_GUI_PX, v));
    const nw = entry && entry.w > 0 ? entry.w : 0;
    const nh = entry && entry.h > 0 ? entry.h : 0;
    let H = w > 0 || h > 0 || nh > 0 ? (h > 0 ? h : nh) : 0;
    if (!H) return [0, 0];
    H = clamp(H);
    let W = h > 0 || w > 0 || nw > 0 ? (w > 0 ? w : Math.round(nw * (H / nh))) : 0;
    if (!W) return [0, H];
    return [clamp(W), H];
  }

  function renderMenuBackground() {
    const host = $('ms-bg-block');
    const m = current();
    if (!host || !m) return;
    clear(host);
    const type = m.obj.type || 'chest';
    const bg = bgOf(m.obj);

    if (!state.tex.enabled) {
      host.append(noteEl('Текстуры на сервере выключены (textures.enabled: false) — блок background: '
        + 'будет проигнорирован при загрузке меню. Включи textures.enabled в config.yml и выполни /am reload.', 'err'));
    }
    if (type !== 'chest') {
      host.append(noteEl('Фон работает только на type: chest — картинка живёт в ЗАГОЛОВКЕ окна сундука, '
        + 'а у меню в инвентаре игрока заголовка нет.', 'warn'));
      setAccSub('ms-bg', 'только для chest');
      renderBgSchema();
      return;
    }

    // main image row (+ enable/disable of the whole block)
    const row = el('div', 'bg-row');
    const ic = el('span', 'tex-ic');
    setTexIcon(ic, bg ? texFind('gui', bg.image) : null);
    const img = document.createElement('input');
    img.type = 'text'; img.className = 'in';
    img.placeholder = 'shop_bg — файл textures/gui/shop_bg.png';
    img.value = bg && bg.image != null ? String(bg.image) : '';
    img.disabled = !state.tex.enabled;
    const commitImage = () => {
      const spec = ensureBg(m.obj);
      setOrDel(spec, 'image', img.value.trim());
      dropEmptyBg(m.obj);
      setTexIcon(ic, texFind('gui', img.value));
      off.disabled = !bgOf(m.obj);   // the whole block may have just appeared or vanished
      afterBgEdit();
    };
    img.oninput = commitImage;
    const pick = el('button', 'btn small', 'Выбрать…');
    pick.type = 'button';
    pick.disabled = !state.tex.enabled;
    pick.onclick = () => openTexturePicker({
      kind: 'gui', current: img.value,
      onPick: (name) => { img.value = name; commitImage(); renderMenuBackground(); }
    });
    const off = el('button', 'btn small danger-ghost', 'Убрать фон');
    off.type = 'button';
    off.disabled = !bg;
    off.onclick = () => { delete m.obj.background; afterBgEdit(); renderMenuBackground(); };
    row.append(ic, img, pick, off);
    host.append(fieldWrap('Картинка фона (background.image)', row));

    // Live geometry/availability warning. It has to repaint on every keystroke, not on the next full
    // render: an ascent the client will clamp looks exactly like "the picture ignores my Y", and
    // finding that out only after switching menus is finding it out in the game.
    const mainNote = noteEl('', 'warn');
    host.append(mainNote);
    const paintMain = () => paintGeomNote(mainNote, bgOf(m.obj), true);

    // position + size
    const rows = rowsOf(m.obj);
    const entry = bg ? texFind('gui', bg.image) : null;
    const nums = el('div', 'bg-nums');
    const edit = (fn) => { fn(); paintMain(); afterBgEdit(); };
    nums.append(bgNum('X (слева, px)', bg && bg.x, (v) => edit(() => writeNum(ensureBg(m.obj), 'x', v)),
      { min: -256, max: 512, ph: '0' }));
    nums.append(bgNum('Y (сверху, px)', bg ? readTop(bg) || null : null,
      (v) => edit(() => writeTop(ensureBg(m.obj), v || 0)), { min: -256, max: 512, ph: '0' }));
    nums.append(bgNum('Ширина', bg && bg.width, (v) => edit(() => writeNum(ensureBg(m.obj), 'width', v)),
      { min: 1, max: MAX_GUI_PX, ph: String(bgSize(entry, 0, 0)[0] || WIN_W) }));
    nums.append(bgNum('Высота', bg && bg.height, (v) => edit(() => writeNum(ensureBg(m.obj), 'height', v)),
      { min: 1, max: MAX_GUI_PX, ph: String(bgSize(entry, 0, 0)[1] || chestHeight(rows)) }));
    host.append(fieldWrap('Позиция и размер (в игровых пикселях)', nums));
    paintMain();
    img.addEventListener('input', paintMain);
    host.append(noteEl('Окно сундука на ' + rows + ' ' + plural(rows, 'ряд', 'ряда', 'рядов') + ' — '
      + WIN_W + '×' + chestHeight(rows) + ' px, первый слот в (7, 17). Пустые ширина/высота = '
      + 'натуральный размер PNG (сторона зажимается в 256 — это потолок шрифтового атласа клиента).'));

    // overlays
    const ovs = Array.isArray(bg && bg.overlays) ? bg.overlays : [];
    const ovHost = el('div', 'bg-ovs');
    ovs.forEach((_, i) => ovHost.append(buildOverlayRow(m.obj, i)));
    const addOv = el('button', 'btn small', '+ Оверлей');
    addOv.type = 'button';
    addOv.disabled = !state.tex.enabled;
    addOv.onclick = () => {
      const spec = ensureBg(m.obj);
      if (!Array.isArray(spec.overlays)) spec.overlays = [];
      spec.overlays.push({ image: '', x: 0, y: 0 });
      afterBgEdit();
      renderMenuBackground();
    };
    ovHost.append(addOv);
    host.append(fieldWrap('Оверлеи — рисуются ПОВЕРХ фона, по порядку', ovHost));
    host.append(noteEl('Схема поверх сетки слотов — ориентир, а не WYSIWYG: картинка рисуется '
      + 'bitmap-шрифтом в заголовке окна, и точная позиция подгоняется в игре (/am reload — и смотри).'));

    setAccSub('ms-bg', bgSummary(m.obj));
    numChrome(host);
    renderBgSchema();
  }

  function buildOverlayRow(obj, idx) {
    const spec = ensureBg(obj);
    const ov = spec.overlays[idx];
    const row = el('div', 'bg-ov');
    const head = el('div', 'bg-ov-head');
    const ic = el('span', 'tex-ic');
    setTexIcon(ic, texFind('gui', ov.image));
    head.append(ic, el('span', 'ck-name', 'Оверлей ' + (idx + 1)));

    const up = el('button', 'btn icon', '↑'); up.type = 'button'; up.title = 'Выше';
    up.disabled = idx === 0;
    up.onclick = () => { spec.overlays.splice(idx - 1, 0, spec.overlays.splice(idx, 1)[0]); afterBgEdit(); renderMenuBackground(); };
    const down = el('button', 'btn icon', '↓'); down.type = 'button'; down.title = 'Ниже';
    down.disabled = idx === spec.overlays.length - 1;
    down.onclick = () => { spec.overlays.splice(idx + 1, 0, spec.overlays.splice(idx, 1)[0]); afterBgEdit(); renderMenuBackground(); };
    const del = el('button', 'btn icon', '×'); del.type = 'button'; del.title = 'Удалить оверлей';
    del.onclick = () => {
      spec.overlays.splice(idx, 1);
      if (!spec.overlays.length) delete spec.overlays;
      dropEmptyBg(obj);
      afterBgEdit();
      renderMenuBackground();
    };
    head.append(up, down, del);
    row.append(head);

    const imgRow = el('div', 'bg-row');
    const img = document.createElement('input');
    img.type = 'text'; img.className = 'in';
    img.placeholder = 'banner — файл textures/gui/banner.png (обязательно)';
    img.value = ov.image != null ? String(ov.image) : '';
    img.disabled = !state.tex.enabled;
    const commit = () => { setOrDel(ov, 'image', img.value.trim()); setTexIcon(ic, texFind('gui', img.value)); afterBgEdit(); };
    img.oninput = commit;
    const pick = el('button', 'btn small', 'Выбрать…');
    pick.type = 'button';
    pick.disabled = !state.tex.enabled;
    pick.onclick = () => openTexturePicker({
      kind: 'gui', current: img.value,
      onPick: (name) => { img.value = name; commit(); renderMenuBackground(); }
    });
    imgRow.append(img, pick);
    row.append(imgRow);

    const entry = texFind('gui', ov.image);
    const note = noteEl('', 'warn');
    const paint = () => paintGeomNote(note, ov, false);
    img.addEventListener('input', paint);
    const edit = (fn) => { fn(); paint(); afterBgEdit(); };
    const nums = el('div', 'bg-nums');
    nums.append(bgNum('X', ov.x, (v) => edit(() => writeNum(ov, 'x', v)), { min: -256, max: 512, ph: '0' }));
    nums.append(bgNum('Y', readTop(ov) || null, (v) => edit(() => writeTop(ov, v || 0)),
      { min: -256, max: 512, ph: '0' }));
    nums.append(bgNum('Ширина', ov.width, (v) => edit(() => writeNum(ov, 'width', v)),
      { min: 1, max: MAX_GUI_PX, ph: String(bgSize(entry, 0, 0)[0] || 16) }));
    nums.append(bgNum('Высота', ov.height, (v) => edit(() => writeNum(ov, 'height', v)),
      { min: 1, max: MAX_GUI_PX, ph: String(bgSize(entry, 0, 0)[1] || 16) }));
    row.append(nums, note);
    paint();
    return row;
  }

  /**
   * Everything that can make one picture silently not appear, in priority order. Shared by the main
   * background and by every overlay so the two can never drift apart.
   */
  function paintGeomNote(node, spec, isMain) {
    if (!node) return;
    if (!spec) { node.textContent = ''; return; }
    const raw = String(spec.image == null ? '' : spec.image).trim();
    if (!raw) {
      node.textContent = isMain
        ? ''   // a background with overlays but no main picture is a legitimate setup
        : 'Без image запись будет пропущена плагином.';
      return;
    }
    const id = texSanitize(raw);
    if (!id) {
      node.textContent = 'Недопустимое имя «' + raw + '»: разрешены только a-z, 0-9, _ и -.';
      return;
    }
    if (id !== raw) {
      node.textContent = 'Плагин приведёт имя к «' + id + '» — файл должен называться textures/gui/'
                       + id + '.png.';
      return;
    }
    const entry = texFind('gui', id);
    if (state.tex.enabled && !entry) {
      node.textContent = 'В паке нет textures/gui/' + id
                       + '.png — плагин предупредит и нарисует окно без этой картинки.';
      return;
    }
    // ascent > height is forbidden by vanilla and would kill the WHOLE font, so GuiFont clamps it.
    // From the outside the clamp looks exactly like «картинка не слушается Y».
    const size = bgSize(entry, parseInt(spec.width, 10) || 0, parseInt(spec.height, 10) || 0);
    const asc = ascentFromTop(readTop(spec));
    if (size[1] > 0 && asc > size[1]) {
      node.textContent = 'Y = ' + readTop(spec) + ' даёт ascent ' + asc + ' при высоте ' + size[1]
        + ' — ванилла запрещает ascent больше высоты, плагин его зажмёт (картинка не поднимется выше). '
        + 'Дорисуй картинке прозрачные поля сверху или увеличь высоту.';
      return;
    }
    node.textContent = '';
  }

  // optional integer field: empty box = key absent (the plugin's own default), never a written 0
  function bgNum(label, val, onset, opts) {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'in';
    inp.min = String(opts.min); inp.max = String(opts.max); inp.step = '1';
    if (opts.ph != null) inp.placeholder = opts.ph;
    inp.value = (val != null && String(val).trim() !== '') ? String(val) : '';
    inp.disabled = !state.tex.enabled;
    inp.oninput = () => {
      const raw = inp.value.trim();
      if (raw === '') { onset(null); return; }
      const n = parseInt(raw, 10);
      onset(isNaN(n) ? null : Math.max(opts.min, Math.min(opts.max, n)));
    };
    return labelWrap(label, inp);
  }
  function writeNum(obj, key, v) {
    if (v == null || v === 0) delete obj[key]; else obj[key] = v;
  }
  function noteEl(text, cls) {
    return el('p', 'bg-note' + (cls ? ' ' + cls : ''), text);
  }
  function ensureBg(obj) {
    if (!obj.background || typeof obj.background !== 'object') obj.background = {};
    return obj.background;
  }
  // `background:` with neither image nor overlays is a warning on the plugin side — drop the key
  // instead of shipping YAML that shouts on every reload.
  function dropEmptyBg(obj) {
    const bg = bgOf(obj);
    if (!bg) return;
    const hasImage = String(bg.image || '').trim() !== '';
    const hasOv = Array.isArray(bg.overlays) && bg.overlays.length > 0;
    if (!hasImage && !hasOv) delete obj.background;
  }
  function bgSummary(obj) {
    const bg = bgOf(obj);
    if (!bg) return 'нет';
    const bits = [];
    if (bg.image) bits.push(String(bg.image));
    const n = Array.isArray(bg.overlays) ? bg.overlays.length : 0;
    if (n) bits.push(n + ' ' + plural(n, 'оверлей', 'оверлея', 'оверлеев'));
    return bits.length ? bits.join(' · ') : 'пусто';
  }
  function afterBgEdit() {
    renderBgSchema();
    scheduleSizeMeter();
    const m = current();
    if (m) setAccSub('ms-bg', bgSummary(m.obj));
  }

  // ---------- schematic overlay over the slot grid ----------
  // Game pixels -> screen pixels is read off the LIVE grid (cell pitch), so it keeps working after
  // the --cell token changes or the browser zooms.
  function renderBgSchema() {
    const layer = $('bg-schema');
    const wrap = $('grid-wrap');
    if (!layer || !wrap) return;
    clear(layer);
    layer.hidden = true;
    wrap.style.paddingTop = '';        // always start from the stylesheet value (see below)
    const m = current();
    if (!m || state.raw || state.graph || state.reqEdit) return;
    if ((m.obj.type || 'chest') !== 'chest') return;
    const bg = bgOf(m.obj);
    if (!bg) return;

    const cells = $('slot-grid').querySelectorAll('.cell');
    if (cells.length < 2) return;
    const scale = cells[1].offsetLeft - cells[0].offsetLeft;   // one slot pitch on screen
    if (!(scale > 0)) return;
    const px = scale / SLOT_PITCH;                              // screen px per game px

    // The window starts 17 game px ABOVE the first slot — at this zoom that is more room than the
    // grid's own padding, and a scroll container cannot be scrolled into negative space, so without
    // extra padding the top strip of the background would be permanently cut off. Reserve it here
    // (reset above first, so the computation never feeds on its own previous result).
    const need = SLOT_Y0 * px + 6;
    if (need > cells[0].offsetTop) {
      const base = parseFloat(getComputedStyle(wrap).paddingTop) || 0;
      wrap.style.paddingTop = (base + (need - cells[0].offsetTop)) + 'px';
    }

    const ox = cells[0].offsetLeft - SLOT_X0 * px;              // screen x of game x=0
    const oy = cells[0].offsetTop - SLOT_Y0 * px;
    const rows = rowsOf(m.obj);

    layer.hidden = false;
    const win = el('div', 'bgs-win');
    place(win, ox, oy, WIN_W * px, chestHeight(rows) * px);
    layer.append(win);

    const boxes = [];
    if (String(bg.image || '').trim()) boxes.push({ spec: bg, main: true, label: String(bg.image) });
    (Array.isArray(bg.overlays) ? bg.overlays : []).forEach((ov, i) => {
      if (String(ov.image || '').trim()) boxes.push({ spec: ov, main: false, label: (i + 1) + ': ' + ov.image });
    });

    boxes.forEach((b) => {
      const entry = texFind('gui', b.spec.image);
      const size = bgSize(entry, parseInt(b.spec.width, 10) || 0, parseInt(b.spec.height, 10) || 0);
      if (!size[0] || !size[1]) return;   // unknown natural size and nothing typed: nothing to draw
      const gx = parseInt(b.spec.x, 10) || 0;
      const gy = readTop(b.spec);
      const box = el('div', 'bgs-box ' + (b.main ? 'main' : 'ov'));
      const url = texDataUrl(entry);
      if (url) {
        const img = document.createElement('img');
        img.src = url; img.alt = '';
        box.append(img);
      } else {
        box.classList.add('empty');
      }
      box.append(el('span', 'bgs-lbl', b.label));
      place(box, ox + gx * px, oy + gy * px, size[0] * px, size[1] * px);
      layer.append(box);
    });

    const cap = el('div', 'bgs-cap', state.tex.enabled
      ? 'Схема · точная позиция подгоняется в игре'
      : 'Схема · текстуры на сервере выключены, в игре этого не будет');
    cap.style.left = ox + 'px';
    cap.style.top = (oy + chestHeight(rows) * px + 4) + 'px';
    layer.append(cap);
  }

  function place(node, left, top, w, h) {
    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';
    node.style.width = Math.max(1, Math.round(w)) + 'px';
    node.style.height = Math.max(1, Math.round(h)) + 'px';
  }

  // ---------- static wiring for the picker (called once from wireStaticUi) ----------
  function wireTextureUi() {
    $('tp-close').onclick = closeTexturePicker;
    $('tp-browse').onclick = () => $('tp-file').click();
    $('tp-none').onclick = () => {
      const cb = tpCtx && tpCtx.onPick;
      closeTexturePicker();
      if (cb) cb('');
    };
    $('tp-search').addEventListener('input', () => {
      clearTimeout(tpSearchTimer);
      tpSearchTimer = setTimeout(renderTexGrid, 110);
    });
    const file = $('tp-file');
    file.addEventListener('change', () => {
      const kind = tpCtx ? tpCtx.kind : 'item';
      const files = [...file.files];
      file.value = '';                        // so re-picking the SAME file fires `change` again
      addTextureFiles(files, kind);
    });

    // drag & drop anywhere inside the modal; the dashed zone is only where the highlight shows
    const modal = $('texture-modal');
    const zone = $('tp-drop');
    const hot = (on) => zone.classList.toggle('over', on);
    ['dragenter', 'dragover'].forEach((ev) => modal.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = state.tex.enabled ? 'copy' : 'none';
      hot(state.tex.enabled);
    }));
    ['dragleave', 'dragend'].forEach((ev) => modal.addEventListener(ev, (e) => {
      if (e.target === modal || !modal.contains(e.relatedTarget)) hot(false);
    }));
    modal.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hot(false);
      const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
      addTextureFiles(files, tpCtx ? tpCtx.kind : 'item');
    });

    // A file dropped ANYWHERE else would make the browser navigate to it — i.e. throw away every
    // unsaved edit in this tab. Swallow those drops instead.
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        toast('Открой «Выбрать…» у текстуры или фона и брось файл туда', 'err');
      }
    });
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
  let pickerOnChoose = null;       // when set, a picked material is passed here instead of assigned to slots

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

  // slot entry point (wired to the material-field + empty-slot buttons): picks assign to the selection
  function openMaterialPicker() {
    const m = current();
    if (!m || state.active == null) { toast('Сначала выберите слот', 'err'); return; }
    pickerOnChoose = null;
    showMaterialPicker();
  }
  // open the picker for a non-slot target (e.g. the menu open-item material); `cb(mat)` gets the choice
  function openMaterialPickerFor(cb) {
    if (!current()) { toast('Нет выбранного меню', 'err'); return; }
    pickerOnChoose = cb;
    showMaterialPicker();
  }
  // shared picker open/reset + material-list load (used by both entry points)
  function showMaterialPicker() {
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
    pickerOnChoose = null;
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
    const cb = pickerOnChoose;
    if (cb) { closeMaterialPicker(); cb(mat); toast('Материал: ' + mat, 'ok'); return; }
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
  // how many slots the menu's grid has: chest = rows*9, inventory = a fixed 27. Anything else has no
  // grid at all (edited as raw YAML), and 0 keeps every grid-builder loop empty instead of guessing.
  function slotCount(obj) {
    const type = (obj && obj.type) || 'chest';
    if (type === 'inventory') return 27;
    if (type !== 'chest') return 0;
    return rowsOf(obj) * 9;
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
    applyStoredTheme();
    $('theme-btn').onclick = toggleTheme;

    $('apply-btn').onclick = applyLive;
    $('save-btn').onclick = saveBundle;
    $('raw-toggle').onclick = toggleRaw;
    $('graph-toggle').onclick = toggleGraph;
    $('raw-yaml').addEventListener('blur', commitRaw);
    $('raw-yaml').addEventListener('input', updateRawView);
    $('raw-yaml').addEventListener('scroll', syncRawScroll);

    // graph: mouse-wheel zoom + background drag-pan (node drags handled separately)
    $('graph-svg').addEventListener('wheel', onGraphWheel, { passive: false });
    $('graph-svg').addEventListener('mousedown', onGraphDown);
    document.addEventListener('mousemove', onGraphMove);
    document.addEventListener('mouseup', onGraphUp);

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

    wireTextureUi();

    // Any edit anywhere changes the bundle's weight. One debounced document-level listener beats
    // sprinkling scheduleSizeMeter() through forty field handlers (and forgetting it in three).
    document.addEventListener('input', scheduleSizeMeter);
    document.addEventListener('change', scheduleSizeMeter);

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
          if (ov.id === 'texture-modal') tpCtx = null;   // hidden by the backdrop -> drop its callback
        }
      });
    });
    // Esc closes overlays and the context menu
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.overlay').forEach((o) => (o.hidden = true));
        if (pickerObserver) { pickerObserver.disconnect(); pickerObserver = null; }  // don't leak the picker's observer
        tpCtx = null;                                    // same for the texture picker's context
        hideContextMenu();
      }
    });
  }

  // go
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* ====================================================================================
 * AlexMenus web editor — LAYOUT CHROME MODULE  (splitters · accordions · number steppers)
 *
 * A completely self-contained IIFE appended after the main app. It NEVER touches the
 * editor's state, render functions or field handlers — it only:
 *   1. resizes the two side columns by writing --sidebar-w / --props-w on <html>,
 *   2. opens/closes <section class="acc"> blocks (grid 0fr->1fr, never display:none),
 *   3. decorates <input type="number"> with the themed up/down stepper markup.
 *
 * localStorage keys used here (all optional, all fail-soft in private mode):
 *   am_w_sidebar  - left column width in px
 *   am_w_props    - right column width in px
 *   am_acc        - JSON map { "<data-acc>": true|false } of accordion open state
 * ==================================================================================== */
(function () {
  'use strict';

  // ---------------------------------------------------------------- tiny storage helpers
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode / quota */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }

  // ================================================================== 1. COLUMN SPLITTERS
  // The grid is  sidebar | splitter | center | splitter | props  (see .layout in style.css).
  // Only the two custom properties below are ever written - nothing else knows about widths.
  const COLS = {
    sidebar: { varName: '--sidebar-w', key: 'am_w_sidebar', def: 240, min: 180, max: 520 },
    props:   { varName: '--props-w',   key: 'am_w_props',   def: 340, min: 280, max: 680 }
  };
  const CENTER_MIN = 300;   // the center column never collapses below this
  const SPLIT_W = 7;        // keep in sync with --split-w

  function currentWidth(name) {
    const c = COLS[name];
    const raw = getComputedStyle(document.documentElement).getPropertyValue(c.varName);
    const n = parseFloat(raw);
    return isFinite(n) ? n : c.def;
  }

  function clampWidth(name, px) {
    const c = COLS[name];
    let v = Math.round(Number(px));
    if (!isFinite(v)) v = c.def;
    v = Math.max(c.min, Math.min(c.max, v));
    // also guarantee the center keeps CENTER_MIN - the OTHER column's current width is fixed
    const layout = document.getElementById('layout');
    const total = layout ? layout.getBoundingClientRect().width : 0;
    if (total > 0) {
      const other = name === 'sidebar' ? 'props' : 'sidebar';
      const room = total - currentWidth(other) - SPLIT_W * 2 - CENTER_MIN;
      if (room > c.min) v = Math.min(v, Math.round(room));
    }
    return v;
  }

  function setWidth(name, px, persist) {
    const c = COLS[name];
    if (!c) return null;
    const v = clampWidth(name, px);
    document.documentElement.style.setProperty(c.varName, v + 'px');
    if (persist) lsSet(c.key, String(v));
    return v;
  }

  // restore saved widths as early as possible so there is no visible jump on load
  function restoreWidths() {
    Object.keys(COLS).forEach(function (name) {
      const c = COLS[name];
      const saved = parseFloat(lsGet(c.key));
      if (isFinite(saved)) {
        const v = Math.max(c.min, Math.min(c.max, Math.round(saved)));
        document.documentElement.style.setProperty(c.varName, v + 'px');
      }
    });
  }

  function wireSplitter(elm) {
    const name = elm.getAttribute('data-splitter');
    if (!COLS[name]) return;
    let dragging = false;

    elm.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;   // left button / touch / pen only
      dragging = true;
      elm.classList.add('is-dragging');
      document.body.classList.add('is-resizing');
      try { elm.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
      e.preventDefault();
    });

    elm.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const layout = document.getElementById('layout');
      if (!layout) return;
      const r = layout.getBoundingClientRect();
      const px = name === 'sidebar'
        ? (e.clientX - r.left - SPLIT_W / 2)
        : (r.right - e.clientX - SPLIT_W / 2);
      setWidth(name, px, false);
      e.preventDefault();
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      elm.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      try { if (e && e.pointerId != null) elm.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      lsSet(COLS[name].key, String(Math.round(currentWidth(name))));
    }
    elm.addEventListener('pointerup', endDrag);
    elm.addEventListener('pointercancel', endDrag);
    elm.addEventListener('lostpointercapture', endDrag);

    // double-click = back to the default width
    elm.addEventListener('dblclick', function (e) {
      e.preventDefault();
      document.documentElement.style.setProperty(COLS[name].varName, COLS[name].def + 'px');
      lsDel(COLS[name].key);
    });

    // keyboard: the divider is a focusable role="separator"
    elm.addEventListener('keydown', function (e) {
      const step = e.shiftKey ? 48 : 16;
      let px = null;
      if (e.key === 'ArrowLeft') px = currentWidth(name) + (name === 'sidebar' ? -step : step);
      else if (e.key === 'ArrowRight') px = currentWidth(name) + (name === 'sidebar' ? step : -step);
      else if (e.key === 'Home' || e.key === 'Enter' || e.key === ' ') px = COLS[name].def;
      else return;
      e.preventDefault();
      setWidth(name, px, true);
    });
  }

  // keep the columns legal when the window shrinks (never let the center vanish)
  function reclampWidths() {
    Object.keys(COLS).forEach(function (name) { setWidth(name, currentWidth(name), false); });
  }

  // ================================================================== 2. ACCORDIONS
  const ACC_KEY = 'am_acc';

  function readAccState() {
    try {
      const o = JSON.parse(lsGet(ACC_KEY) || '{}');
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }
  function writeAccState(map) { lsSet(ACC_KEY, JSON.stringify(map)); }

  function setAccOpen(acc, open, persist) {
    const btn = acc.querySelector('.acc-head');
    acc.setAttribute('data-open', open ? 'true' : 'false');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (persist) {
      const key = acc.getAttribute('data-acc');
      if (key) { const m = readAccState(); m[key] = !!open; writeAccState(m); }
    }
  }

  function initAccordions(root) {
    const saved = readAccState();
    (root || document).querySelectorAll('.acc[data-acc]').forEach(function (acc) {
      const key = acc.getAttribute('data-acc');
      // markup's data-open is the default; localStorage wins once the user has touched it
      const open = Object.prototype.hasOwnProperty.call(saved, key)
        ? !!saved[key]
        : acc.getAttribute('data-open') === 'true';
      setAccOpen(acc, open, false);
    });
  }

  // one delegated listener: works for accordions added later, and <button> gives Enter/Space for free
  function wireAccordions() {
    document.addEventListener('click', function (e) {
      const head = (e.target && e.target.closest) ? e.target.closest('.acc-head') : null;
      if (!head) return;
      const acc = head.closest('.acc');
      if (!acc) return;
      e.preventDefault();
      setAccOpen(acc, acc.getAttribute('data-open') !== 'true', true);
    });
  }

  // ================================================================== 3. NUMBER STEPPERS
  // Wraps a bare <input type="number" class="in"> into
  //   <div class="num-wrap"> input + <span class="num-steps"> two .num-step buttons </span></div>
  // The ORIGINAL input node is MOVED, never replaced: its id and its oninput/onchange properties
  // (set by renderProps/numField/pctField/...) survive untouched. Steps dispatch BOTH `input` and
  // `change` so handlers listening to only one of them (e.g. #menu-rows) still fire.
  const NUM_ROOTS = ['slot-editor', 'menu-settings', 'reqedit-wrap', 'center-toolbar'];

  function stepOf(input) {
    const s = parseFloat(input.getAttribute('step'));
    return (isFinite(s) && s > 0) ? s : 1;   // step="any" / missing -> 1
  }
  function limOf(input, attr) {
    const v = parseFloat(input.getAttribute(attr));
    return isFinite(v) ? v : null;
  }
  function decimalsOf(step) {
    const s = String(step);
    const i = s.indexOf('.');
    return i === -1 ? 0 : (s.length - i - 1);
  }
  function fmt(n, step) {
    const d = decimalsOf(step);
    return d ? String(Number(n.toFixed(d))) : String(Math.round(n));
  }

  function clampAndFire(input, min, max, step) {
    let n = parseFloat(input.value);
    if (isFinite(n)) {
      if (min != null && n < min) n = min;
      if (max != null && n > max) n = max;
      input.value = fmt(n, step);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // grey out an arrow once the value sits on its limit
  function refreshSteps(input) {
    const wrap = input.parentNode;
    if (!wrap || !wrap.classList || !wrap.classList.contains('num-wrap')) return;
    const up = wrap.querySelector('.num-step.up');
    const down = wrap.querySelector('.num-step.down');
    const min = limOf(input, 'min');
    const max = limOf(input, 'max');
    const n = parseFloat(input.value);
    if (up) up.classList.toggle('is-disabled', isFinite(n) && max != null && n >= max);
    if (down) down.classList.toggle('is-disabled', isFinite(n) && min != null && n <= min);
  }

  // One nudge. `mult` is the coarse-step factor: 1 for a plain click/arrow, 10 for Shift and PageUp/Dn.
  // Returns true when the value actually moved (false = already sitting on min/max), which is what
  // stops a key-repeat/hold from spinning uselessly against a limit such as «Рядов» 1..6.
  function bump(input, dir, mult) {
    if (input.disabled || input.readOnly) return false;
    const step = stepOf(input) * (mult && mult > 0 ? mult : 1);
    const min = limOf(input, 'min');
    const max = limOf(input, 'max');
    const before = input.value;
    const cur = parseFloat(input.value);
    if (!isFinite(cur)) {
      // An EMPTY box is a real state for pctField ("key absent"), so the first press must land on the
      // base value rather than base +/- step — otherwise «шанс» would jump straight to 0.1 instead of 0.
      const ph = parseFloat(input.placeholder);
      const base = isFinite(ph) ? ph : (min != null ? min : 0);
      input.value = fmt(base, step);
    } else {
      input.value = fmt(cur + dir * step, step);
    }
    clampAndFire(input, min, max, step);
    refreshSteps(input);
    return input.value !== before;
  }

  function makeStep(cls, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'num-step ' + cls;
    b.tabIndex = -1;
    b.title = title;
    return b;
  }

  // hold-to-repeat pacing: first repeat after HOLD_DELAY, then the gap shrinks geometrically down to
  // REPEAT_MIN — that is the "ускорение" (a long hold walks a 0..64 field quickly without overshooting
  // a 1..6 one, which stops itself as soon as the value can no longer move).
  const HOLD_DELAY = 380, REPEAT_START = 120, REPEAT_MIN = 28, REPEAT_DECAY = 0.85;

  function bindSteps(wrap) {
    if (wrap.dataset.numBound === '1') return;
    wrap.dataset.numBound = '1';
    const input = wrap.querySelector('input[type="number"]');
    if (!input) return;

    wrap.querySelectorAll('.num-step').forEach(function (btn) {
      const dir = btn.classList.contains('up') ? 1 : -1;
      let timer = null;
      const stop = function () { clearTimeout(timer); timer = null; };
      btn.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button !== 0) return;
        // inside a <label class="field"> a click would otherwise be forwarded to the labelled control
        e.preventDefault();
        e.stopPropagation();
        const mult = e.shiftKey ? 10 : 1;   // Shift+клик = шаг ×10
        stop();
        if (!bump(input, dir, mult)) return;   // already at the limit — nothing to repeat
        let gap = REPEAT_START;
        const tick = function () {
          // a re-render may have thrown this input away mid-hold; never keep stepping a detached node
          if (!input.isConnected || !bump(input, dir, mult)) { stop(); return; }
          gap = Math.max(REPEAT_MIN, gap * REPEAT_DECAY);
          timer = setTimeout(tick, gap);
        };
        timer = setTimeout(tick, HOLD_DELAY);
      });
      // NB: only listeners on the button itself — a window/document listener here would be added once
      // per stepper and never removed, so every renderProps() would pile up another copy.
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
        btn.addEventListener(ev, stop);
      });
      btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    });

    // Keyboard. The native ↑/↓ of <input type=number> only fires `input`, so a field wired with
    // .onchange alone (#menu-rows) would not commit until blur — and native stepping ignores our
    // "empty box starts at the base value" rule. Take it over: same clamps, same both-events dispatch.
    input.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let dir = 0, mult = 1;
      if (e.key === 'ArrowUp') dir = 1;
      else if (e.key === 'ArrowDown') dir = -1;
      else if (e.key === 'PageUp') { dir = 1; mult = 10; }
      else if (e.key === 'PageDown') { dir = -1; mult = 10; }
      else return;
      if (e.shiftKey) mult *= 10;
      e.preventDefault();
      bump(input, dir, mult);
    });

    input.addEventListener('input', function () { refreshSteps(input); });
    refreshSteps(input);
  }

  // Wrap every bare number input under `root` and (re)bind the arrows. Idempotent - safe to call
  // after any re-render. Exposed as window.AlexMenusChrome.enhanceNumbers(root).
  function enhanceNumbers(root) {
    const host = root || document;
    host.querySelectorAll('input[type="number"]').forEach(function (input) {
      const parent = input.parentNode;
      if (!parent) return;
      if (parent.classList && parent.classList.contains('num-wrap')) return;   // already wrapped
      const wrap = document.createElement('div');
      const narrow = input.closest('.inline') || input.closest('.rows-field');
      wrap.className = 'num-wrap' + (narrow ? ' compact' : '');
      parent.insertBefore(wrap, input);
      wrap.appendChild(input);
      const steps = document.createElement('span');
      steps.className = 'num-steps';
      steps.setAttribute('aria-hidden', 'true');
      steps.append(makeStep('up', 'Больше'), makeStep('down', 'Меньше'));
      wrap.appendChild(steps);
    });
    host.querySelectorAll('.num-wrap').forEach(function (wrap) {
      bindSteps(wrap);
      // values are often set programmatically (renderTitleRows / renderMenuSettings / ...) without
      // firing `input`, so refresh the at-limit greying on every pass, not only on first bind
      const n = wrap.querySelector('input[type="number"]');
      if (n) refreshSteps(n);
    });
  }

  // Dynamic fields are rebuilt by renderProps()/renderActionList()/... on every edit. Rather than
  // patching those functions, watch their hosts and re-decorate whatever appears. The pass is
  // idempotent, so the mutations it causes settle on the next frame instead of looping.
  function watchNumbers() {
    if (typeof MutationObserver !== 'function') return;
    let queued = false;
    const obs = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        NUM_ROOTS.forEach(function (id) {
          const n = document.getElementById(id);
          if (n) enhanceNumbers(n);
        });
      });
    });
    NUM_ROOTS.forEach(function (id) {
      const n = document.getElementById(id);
      if (n) obs.observe(n, { childList: true, subtree: true });
    });
  }

  // ================================================================== boot
  restoreWidths();   // before first paint - no width flash

  function boot() {
    document.querySelectorAll('.splitter[data-splitter]').forEach(wireSplitter);
    window.addEventListener('resize', reclampWidths);

    initAccordions(document);
    wireAccordions();

    NUM_ROOTS.forEach(function (id) {
      const n = document.getElementById(id);
      if (n) enhanceNumbers(n);
    });
    watchNumbers();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // public hook for the rest of the app (e.g. after a manual re-render outside NUM_ROOTS)
  window.AlexMenusChrome = {
    enhanceNumbers: enhanceNumbers,
    setColumnWidth: setWidth,
    setAccordion: function (key, open) {
      const acc = document.querySelector('.acc[data-acc="' + key + '"]');
      if (acc) setAccOpen(acc, !!open, true);
    }
  };
})();
