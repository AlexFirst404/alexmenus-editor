# AlexMenus

Лёгкий движок **меню** для **Paper 1.21.11** — сундук-GUI и меню-в-инвентаре, действия, триггеры, и
**хостед веб-редактор в стиле LuckPerms** (на сервере порты открывать **не надо**).

> Этот репозиторий = **хостед-редактор** (GitHub Pages, страница `index.html`) **+** дистрибутив плагина
> (jar в [Releases](../../releases)) **+** код paste-сервиса (`cloudflare-worker/`).

## Скачать
Плагин: **[Releases](../../releases)** → `AlexMenus-<версия>.jar` → положи в `plugins/`.

## Возможности
- Меню **`type: chest`** (GUI-сундук) и **`type: inventory`** (меню в инвентаре игрока).
- Действия: `run_command / open_menu / give_item / message / sound / conditional / …`.
- **Цвета** в `title`/`name`/`lore`: легаси `&c&l`, hex `&#ff8800`, Bungee `&x&f&f…` **и** MiniMessage — вперемешку.
- **Команды меню** (`commands: [shop]`) как настоящие команды (tab-комплит, `/help`, `command-description`, `show-in-help`).
- **Права** меню: `permission:` — на всех путях открытия.
- **`/am reload`** перезагружает плагин целиком (конфиг + меню + команды + триггеры + редактор).
- **Редактор:** мультивыделение слотов, контекстное меню (ПКМ), 3D-иконки блоков, **граф** навигации, панель «Настройки меню».

## Настройка (один раз, ~10 мин)
1. **Paste-сервис (Cloudflare Worker, бесплатно):** разверни воркер из папки [`cloudflare-worker/`](cloudflare-worker/)
   (пошаговая инструкция там, есть вариант без CLI). Скопируй его адрес.
2. **`plugins/AlexMenus/config.yml`:**
   ```yaml
   editor:
     worker-url: "https://alexmenus-paste.<твой-акк>.workers.dev"   # адрес ТВОЕГО воркера
     url: "https://<твой-акк>.github.io/alexmenus-editor/"          # хостед-редактор (эта страница)
   ```
3. `/reload` в игре.

## Как пользоваться
```
/am editor        → ссылка вида  <editor>/#<код>   (правишь меню в браузере, «Сохранить» даёт новый код)
/am apply <код>   → плагин скачивает правки и записывает menus/*.yml + reload
```
Плагин делает только **исходящие** HTTPS-запросы к воркеру — на игровом сервере порты не открываются.
Правки применяет **админ командой**, а не «у кого ссылка — тот рулит».

## Команды и права
`/am open <id> [игрок]` · `preview <id>` · `reload` · `editor` · `apply <код>` · `invclose [игрок]`.
Права: `alexmenus.use`, `alexmenus.admin`, и `permission` конкретного меню.

## Сборка из исходников
Требования: Paper 1.21.11, Java 21. Сборка Maven Wrapper: `./mvnw.cmd clean package` (шейдится InvUI).
PlaceholderAPI — мягкая зависимость.

## Свой редактор
SPA — это `index.html` / `style.css` / `app.js` в корне. Хостится на GitHub Pages. Хочешь свой —
форкни, при необходимости поправь адрес воркера и укажи свой `editor.url` в конфиге плагина.
