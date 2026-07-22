# AlexMenus

**AlexMenus** — лёгкий движок **меню** для **Paper 1.21.11** (Java 21). Поддерживает сундук-GUI и меню
прямо в инвентаре игрока, действия по клику, требования (requirements), триггеры открытия и **хостед
веб-редактор в стиле LuckPerms** — порты на игровом сервере открывать не надо.

Автор: **AlexFirst** · Версия: **1.4.0** · Репозиторий: <https://github.com/AlexFirst404/AlexMenus>

---

## Что умеет

- **Два бэкенда меню**: `chest` (сундук-GUI через шейдённый InvUI, 1–6 рядов) и `inventory` (меню в основных
  27 слотах инвентаря игрока).
- **Действия по типу клика**: `run_command`, `message`, `broadcast`, `title`, `actionbar`, `open_menu`,
  `back`, `refresh`, `close`, `sound`, `connect`/`server`, `give_item`, `give_money`/`take_money`,
  `give_exp`/`take_exp`, `give_permission`/`take_permission`, `conditional`. У любого действия — модификаторы
  `chance` (шанс) и `delay` (задержка в тиках).
- **Requirements-движок**: три места условий (`view-requirement`, `click-requirement`, `open-requirement`),
  типы `permission`, `placeholder`, `money`, `has_item`, `exp`, композиты `all`/`any`/`not`, флаг `negate`.
- **Продвинутые опции меню**: `update-interval` (живое обновление плейсхолдеров), `args` (аргументы команды →
  `{имя}`/`{argN}`/`{args}`), `open-item` (предмет-открывашка в хотбаре), `open-animation` (пошаговое
  появление предметов).
- **Цвета вперемешку**: легаси `&c&l`, hex `&#ff8800`, Bungee `&x&f&f…` и MiniMessage `<gradient:…>`.
- **Настоящие команды меню**: список `commands:` регистрируется как реальные Bukkit-команды (tab-комплит,
  `/help`, права).
- **Триггеры открытия**: своя команда, `/am open`, предмет с PDC-тегом (ПКМ), Java-API через ServicesManager.
- **Веб-редактор**: `/am editor` → правки в браузере → `/am apply <код>`. Только исходящие HTTPS.
- **Гибкая конфигурация**: кулдауны кликов/открытий, стандартные звуки, настраиваемые сообщения
  (MiniMessage), debug, проверка обновлений (`/am info`) — см. [Configuration](Configuration.md).
- **Мягкие интеграции**: PlaceholderAPI (`%...%`), Vault (экономика) и LuckPerms (права). Работают, если
  установлены; без них плагин не падает.

## Установка

1. Скачай `AlexMenus-<версия>.jar` из **Releases** репозитория.
2. Положи в `plugins/` на Paper 1.21.11.
3. `/reload` (или перезапуск сервера). Появится папка `plugins/AlexMenus/` с `config.yml` и примерами
   `menus/sample.yml`, `menus/shop.yml`.
4. (Опционально) Поставь **PlaceholderAPI** и **Vault** + плагин экономики — это мягкие зависимости
   (`softdepend`), нужны только для плейсхолдеров и денежных функций.

Требования: **Paper 1.21.11**, **Java 21**. InvUI шейдится в jar, отдельно ставить не нужно.

## Страницы

- [Getting-Started](Getting-Started.md) — первое меню, структура папок, редактор, reload.
- [Menu-Types](Menu-Types.md) — `chest` против `inventory`, ряды, заголовок, цвета.
- [Items-and-Clicks](Items-and-Clicks.md) — поля предмета и типы клика.
- [Advanced-Menu-Options](Advanced-Menu-Options.md) — `update-interval`, `args`, `open-item`, `open-animation`.
- [Requirements](Requirements.md) — условия: три места, все типы, рецепты.
- [Actions](Actions.md) — все действия с параметрами и примерами, `chance`/`delay`.
- [Placeholders-and-Integrations](Placeholders-and-Integrations.md) — PlaceholderAPI, Vault, LuckPerms, командные плагины.
- [Configuration](Configuration.md) — `config.yml`: кулдауны, звуки, сообщения, debug, обновления.
- [Commands-and-Permissions](Commands-and-Permissions.md) — `/am`, команды меню, права.
- [Web-Editor](Web-Editor.md) — как работает редактор, self-host воркера.
- [Examples](Examples.md) — готовые аннотированные YAML-меню.
