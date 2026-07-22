# Конфигурация (`config.yml`)

Файл `plugins/AlexMenus/config.yml` — глобальные настройки плагина (сами меню лежат в `menus/*.yml`, см.
[Getting-Started](Getting-Started.md)). Все ключи **необязательны**: чего нет — берётся значение по умолчанию.
Файл перечитывается на каждом **`/am reload`** (и при рестарте) — рестарт сервера не нужен.

> Меню-специфичные настройки (`update-interval`, `args`, `open-item`, `open-animation`) задаются НЕ здесь, а
> в самом файле меню — см. [Advanced-Menu-Options](Advanced-Menu-Options.md).

## `inventory-menu` — меню прямо в инвентаре

Управляет экспериментальным бэкендом `type: inventory` (подробнее — [Menu-Types](Menu-Types.md)).

```yaml
inventory-menu:
  enabled: false      # true — показывать меню-инвентарь всем игрокам при входе
  default: ""         # id меню (type: inventory), которое показывать по умолчанию
```

| Ключ | По умолчанию | Назначение |
|---|---|---|
| `inventory-menu.enabled` | `false` | `true` — при входе всем игрокам авто-показывается меню-по-умолчанию. |
| `inventory-menu.default` | `""` | id `inventory`-меню для авто-показа. Из него переходят на другие через `open_menu`. Авто-показ **тихо** уважает `permission`/`open-requirement` меню (без спама deny всем). |

## `editor` — веб-редактор (zero-config)

Настройки хостед-редактора в стиле LuckPerms. Из коробки настраивать **ничего не надо** — см.
[Web-Editor](Web-Editor.md).

```yaml
editor:
  worker-url: ""      # paste-сервис. ПУСТО = общий публичный воркер
  url: "https://alexfirst404.github.io/alexmenus-editor/"   # адрес хостед-редактора
```

| Ключ | По умолчанию | Назначение |
|---|---|---|
| `editor.worker-url` | `""` | Адрес Cloudflare Worker (paste-сервис). Пусто = общий публичный воркер; свой — разверни из `cloudflare-worker/`. |
| `editor.url` | оф. GitHub Pages | Адрес хостед-редактора, в ссылку которого подставляется код (`<url>#<код>`). |

## `cooldowns` — антиспам-задержки (мс)

Персональные (на игрока) задержки в **миллисекундах**. `0` = функция выключена.

```yaml
cooldowns:
  click-ms: 0     # минимальная пауза между кликами по меню
  open-ms: 0      # минимальная пауза между открытиями меню
```

| Ключ | По умолчанию | Назначение |
|---|---|---|
| `cooldowns.click-ms` | `0` | Мин. пауза (мс) между кликами игрока по меню. Проверяется **до** requirements/действий; при отказе шлётся `on-cooldown` и звук `sounds.deny`. |
| `cooldowns.open-ms` | `0` | Мин. пауза (мс) между открытиями меню (`open`). При отказе — `on-cooldown` + `sounds.deny`. |

> Кулдауны считаются по «настенным» часам и переживают `reload`; записи игрока чистятся при выходе.

## `sounds` — стандартные звуки меню

Звук-ключи (`namespace:path`), проигрываемые на четырёх встроенных событиях. **Пусто/не задано = без
звука** (звуки выключены из коробки).

```yaml
sounds:
  open: ""        # напр. minecraft:block.chest.open
  close: ""
  click: ""       # напр. minecraft:ui.button.click
  deny: ""        # когда click-requirement отклоняет клик (и при кулдауне)
```

| Ключ | Когда проигрывается |
|---|---|
| `sounds.open` | При открытии меню. |
| `sounds.close` | При закрытии меню (`close`/`closeInventory`). |
| `sounds.click` | При клике, который **проходит** (после успешного `click-requirement`). |
| `sounds.deny` | Когда `click-requirement` отклонил клик, а также при срабатывании кулдауна. |

> Индивидуальный `sound:` в действии (`type: sound`, см. [Actions](Actions.md)) **приоритетнее** и не зависит от
> этих настроек — здесь только четыре встроенных события. Громкость/высота фиксированы (`1.0`), источник
> `MASTER`. Битый ключ логируется и пропускается (без краша).

## `debug` — подробные логи

```yaml
debug: false
```

`true` — писать в лог подробности: загрузка каждого меню (id, категория, файл), запуск каждого действия
(`action '<type>' -> <игрок>`), оценку требований, попытки give/revoke прав. Полезно при отладке YAML.

## `update-checker` — проверка обновлений

```yaml
update-checker: true
```

`true` — при запуске один раз асинхронно опросить GitHub Releases (только **исходящий** HTTPS), сравнить
версии. Если доступна новее — записать в лог и уведомлять админов (`alexmenus.admin`) при входе. Результат
виден в **`/am info`** (см. [Commands-and-Permissions](Commands-and-Permissions.md)). Никогда не блокирует
запуск; все ошибки проглатываются.

## `open-items` — мастер-выключатель предметов-открывашек

```yaml
open-items: true
```

Глобальный переключатель выдачи **предметов-открывашек** меню (`open-item`) при входе/респавне. `true` —
выдача разрешена; отдельные меню включают её у себя через `open-item.give-on-join: true` (см.
[Advanced-Menu-Options](Advanced-Menu-Options.md)). `false` — ни одно меню не будет раздавать опенер на входе.

## `messages` — тексты плагина

Настраиваемые строки, которые шлёт плагин. Формат — **MiniMessage + легаси `&`-коды** (как заголовки/лор,
см. [Menu-Types](Menu-Types.md)). Ко всем сообщениям спереди добавляется `prefix` (кроме самого `prefix`).
Отсутствующий ключ берётся из встроенных значений по умолчанию.

```yaml
messages:
  prefix: "<gray>[<gold>AlexMenus</gold>]</gray> "
  no-permission: "<red>Недостаточно прав."
  menu-not-found: "<red>Меню не найдено: {menu}"
  players-only: "<red>Только для игроков."
  reloaded: "<green>Перезагружено: {count} меню."
  on-cooldown: "<red>Подожди немного."
  applied: "<green>Применено: {count} меню."
  apply-failed: "<red>Не удалось применить код."
  invalid-code: "<red>Неверный код."
```

| Ключ | Плейсхолдеры | Где используется |
|---|---|---|
| `prefix` | — | Префикс перед всеми остальными сообщениями (сам рендерится «голым»). |
| `no-permission` | — | Нет права: `/am open` без `alexmenus.use`, гейт `permission:` меню, запуск команды меню. |
| `menu-not-found` | `{menu}` | Меню с таким id не найдено (`/am open`, команда меню, рендер). `{menu}` = запрошенный id. |
| `players-only` | — | Команда только для игрока (напр. `/am preview` из консоли). |
| `reloaded` | `{count}` | Успешный `/am reload`. `{count}` = число загруженных меню. |
| `on-cooldown` | — | Сработал кулдаун `cooldowns.click-ms` / `cooldowns.open-ms`. |
| `applied` | `{count}` | Успешный `/am apply <код>`. `{count}` = число применённых меню. |
| `apply-failed` | — | `/am apply` не смог скачать/применить код. |
| `invalid-code` | — | Зарезервированное сообщение о неверном коде (в текущих командах сбои `apply` показывают `apply-failed`). |

> Подстановка `{name}` работает для любых пар «имя-значение», но в стандартных строках реально используются
> только `{menu}` и `{count}` — прочие ключи плейсхолдеров не содержат.

## Полный `config.yml` (со значениями по умолчанию)

```yaml
inventory-menu:
  enabled: false
  default: ""

editor:
  worker-url: ""
  url: "https://alexfirst404.github.io/alexmenus-editor/"

cooldowns:
  click-ms: 0
  open-ms: 0

sounds:
  open: ""
  close: ""
  click: ""
  deny: ""

debug: false
update-checker: true
open-items: true

messages:
  prefix: "<gray>[<gold>AlexMenus</gold>]</gray> "
  no-permission: "<red>Недостаточно прав."
  menu-not-found: "<red>Меню не найдено: {menu}"
  players-only: "<red>Только для игроков."
  reloaded: "<green>Перезагружено: {count} меню."
  on-cooldown: "<red>Подожди немного."
  applied: "<green>Применено: {count} меню."
  apply-failed: "<red>Не удалось применить код."
  invalid-code: "<red>Неверный код."
```

Связанные страницы: [Menu-Types](Menu-Types.md) (типы меню и цвета), [Advanced-Menu-Options](Advanced-Menu-Options.md)
(меню-специфичные ключи), [Commands-and-Permissions](Commands-and-Permissions.md) (`/am reload`, `/am info`),
[Web-Editor](Web-Editor.md) (редактор и self-host воркера).
