# AlexMenus

Лёгкий движок **меню** для **Paper 1.21.11** (Java 21) — сундук-GUI и меню-в-инвентаре, действия, триггеры,
**requirements-движок** и **хостед веб-редактор в стиле LuckPerms** (на сервере порты открывать **не надо**).

> Этот репозиторий = **хостед-редактор** (GitHub Pages, `index.html`) **+** дистрибутив плагина
> (jar в [Releases](../../releases)) **+** код paste-сервиса (`cloudflare-worker/`).

## Скачать
Плагин: **[Releases](../../releases)** → `AlexMenus-<версия>.jar` → положи в `plugins/`.

**📖 Документация:** **[Wiki](wiki/Home.md)** — меню, условия (все типы/форматы), действия, интеграции (LuckPerms / PlaceholderAPI / MyCommand), примеры.

## Скриншоты
> Скриншоты интерфейса добавляются. Пока проще всего посмотреть редактор **вживую**: запусти `/am editor`
> на сервере и открой ссылку (или подставь свой paste-код к адресу редактора).

<!-- screenshots: docs/editor.png, docs/requirements.png, docs/graph.png -->

## Возможности
- Меню **`type: chest`** (GUI-сундук) и **`type: inventory`** (меню в инвентаре игрока).
- **Цвета** в `title`/`name`/`lore`: легаси `&c&l`, hex `&#ff8800`, Bungee `&x&f&f…` **и** MiniMessage — вперемешку.
- **Команды меню** (`commands: [shop]`) как настоящие команды (tab-комплит, `/help`, `command-description`, `show-in-help`).
- **Права** меню: `permission:` — на всех путях открытия.
- **Requirements-движок** (view/click/open) — см. ниже.
- **Действия** вкл. экономику Vault (`give_money`/`take_money`), опыт, `broadcast`, `sound`, и модификаторы `chance`/`delay`.
- **`/am reload`** перезагружает плагин целиком.
- **Редактор:** **пикер всех блоков/предметов 1.21.11** (поиск+иконки), **точные иконки как в майне**
  (блоки — 3D-рендер vanilla через deepslate), **node-граф условий**, панель requirements (view/click/open),
  граф навигации, свои модалки/чекбоксы, мультивыделение, контекстное меню (ПКМ).

## Requirements-движок
Три места для условий:
- **`view-requirement`** на предмете — предмет **виден** только при условии;
- **`click-requirement`** на предмете — **гейт клика** с `deny`/`success`;
- **`open-requirement`** на меню — **гейт открытия** с `deny`.

Краткая форма (весь блок = условие) и полная (`require:` + `deny:`/`success:`):
```yaml
view-requirement: { type: permission, permission: alexmenus.vip }

click-requirement:
  require: { type: money, amount: 100 }
  deny:
    - type: message
      text: "<red>Недостаточно денег"
```
Типы: `permission`, `placeholder` (`== != contains regex > < >= <=` и др.; **обе стороны** через PAPI),
`money` (Vault), `has_item`, `exp` (очки/уровни), композиты `all`/`any`/`not`, флаг `negate`.
В редакторе — визуальными билдерами, **node-графом** из узлов, или raw-YAML.

## Действия
`run_command` · `message` · `broadcast` · `open_menu` · `refresh` · `back` · `close` · `sound` · `give_item` ·
`give_money`/`take_money` (Vault) · `give_exp`/`take_exp` · `conditional`. На любом действии — `chance: 0–100`
и `delay: <тики>`.

## Настройка
**Ничего настраивать не надо** — `/am editor` работает из коробки (общий публичный paste-воркер по умолчанию).
Хочешь свой воркер — разверни его из [`cloudflare-worker/`](cloudflare-worker/) и впиши адрес в `config.yml`:
```yaml
editor:
  worker-url: ""   # пусто = общий публичный воркер; или впиши адрес своего
```

## Как пользоваться
```
/am editor        → ссылка <editor>#<код>   (правишь меню в браузере, «Сохранить» даёт новый код)
/am apply <код>   → плагин скачивает правки → menus/*.yml + reload
```
Плагин делает только **исходящие** HTTPS-запросы к воркеру — порты на игровом сервере не открываются.
Правки применяет **админ командой**, а не «у кого ссылка — тот рулит».

## Команды и права
`/am open <id> [игрок]` · `preview <id>` · `reload` · `editor` · `apply <код>` · `invclose [игрок]`.
Права: `alexmenus.use`, `alexmenus.admin`, и `permission` конкретного меню.

## Сборка из исходников
Paper 1.21.11, Java 21, Maven Wrapper: `./mvnw.cmd clean package` (шейдится InvUI).
**PlaceholderAPI** и **Vault** — мягкие зависимости.

## Свой редактор
SPA — это `index.html` / `style.css` / `app.js` в корне (хостится на GitHub Pages). Хочешь свой — форкни и
укажи свой `editor.url` в конфиге плагина. Адрес воркера редактор спрашивает один раз и запоминает (в браузере).
