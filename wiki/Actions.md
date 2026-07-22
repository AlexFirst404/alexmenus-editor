# Действия (actions)

Действие — YAML-карта с полем `type` и параметрами. Действия задаются списком: в `clicks.<тип>`, в
`deny`/`success` требований (см. [Requirements](Requirements.md)) и в ветках `then`/`else` действия
`conditional`. Выполняются по порядку.

```yaml
clicks:
  left:
    - type: message
      text: "<green>Привет!"
    - type: sound
      sound: "minecraft:ui.button.click"
```

## Модификаторы на ЛЮБОМ действии

| Модификатор | Значение | Поведение |
|---|---|---|
| `chance` | `0–100` | Шанс выполнения в процентах. `100`/нет = всегда; `0` = никогда; `50` ≈ половина случаев. Применяется, только если ключ `chance` присутствует. |
| `delay` | тики | Отложить действие на N тиков (20 тиков = 1 сек). Через `delay` тиков проверяется, что игрок ещё онлайн. `0`/нет = сразу. |

```yaml
- type: give_item
  material: DIAMOND
  chance: 25        # выпадет примерно в 25% кликов
- type: message
  text: "<gray>...сообщение через секунду"
  delay: 20         # покажется через 20 тиков
```

## Справочник действий

### `run_command`

Выполнить команду. `command` — сам текст (лидирующий `/` можно опустить). `as: player|console` (по
умолчанию `player`). Текст разворачивает плейсхолдеры (`%...%`).

```yaml
- type: run_command
  as: console
  command: "give %player_name% diamond 1"
- type: run_command
  as: player            # по умолчанию — от имени игрока
  command: "spawn"
```

### `message`

Отправить сообщение игроку. Поле `text` (цвета + плейсхолдеры).

```yaml
- type: message
  text: "<green>Ты нажал кнопку, %player_name%!"
```

### `broadcast`

Сообщение **всему серверу**. Поле `text`.

```yaml
- type: broadcast
  text: "<gold>%player_name% <yellow>купил награду!"
```

### `open_menu`

Открыть другое меню (переход, кладётся в историю навигации). Поле `menu` — id меню.

```yaml
- type: open_menu
  menu: shop
```

### `back`

Вернуться к предыдущему меню в истории. Если истории нет — закрывает окно.

```yaml
- type: back
```

### `refresh`

Перерисовать текущее меню на месте (пере-вычисляет плейсхолдеры/видимость).

```yaml
- type: refresh
```

### `close`

Закрыть меню и очистить историю навигации.

```yaml
- type: close
```

### `sound`

Проиграть звук игроку. Поле `sound` — ключ звука (`namespace:path`). Громкость/высота фиксированы (1.0),
источник `MASTER`. Битый ключ звука логируется, но не крашит.

```yaml
- type: sound
  sound: "minecraft:entity.experience_orb.pickup"
```

> Дополнительных полей громкости/высоты нет — читается только `sound`.

### `give_item`

Выдать предмет в инвентарь. Поля как у предмета меню + `amount` и `menu`.

| Поле | Назначение |
|---|---|
| `material` | Материал (не-предмет/неизвестный → `STONE`). |
| `cmd` | Строковый custom-model-data. |
| `name` | Имя. |
| `lore` | Лор (список). |
| `flags` / `hide-all` | Скрыть item-flags (`hide-all: true` — все). |
| `amount` | Количество (минимум 1). |
| `menu` | Если задано — на предмет вешается PDC-тег меню: **ПКМ этим предметом открывает меню** `menu`. |

```yaml
# обычная выдача
- type: give_item
  material: GOLDEN_APPLE
  amount: 2
# «предмет-открывашка» меню (ПКМ → открыть меню main)
- type: give_item
  material: NETHER_STAR
  name: "<gold>Меню сервера"
  hide-all: true
  menu: main
```

### `give_money` / `take_money` — нужен Vault

Выдать/снять деньги. Поле `amount` (парсится в число, минимум 0). Без Vault — no-op.

```yaml
- type: take_money
  amount: 100
- type: give_money
  amount: 50
```

### `give_exp` / `take_exp`

Выдать/снять опыт. Поля `amount` (минимум 0) и `level: true|false`.

- `level: true` — работает с **уровнями** (`setLevel`).
- `level: false`/нет — работает с **очками** опыта (`giveExp`).

```yaml
- type: give_exp
  amount: 5
  level: true          # +5 уровней
- type: take_exp
  amount: 100          # −100 очков опыта
```

### `conditional`

Ветвление по условию. Поле `requirement` (см. [Requirements](Requirements.md)) → выполнить `then` при успехе,
иначе `else`. Обе ветки — списки действий.

```yaml
- type: conditional
  requirement:
    type: permission
    permission: alexmenus.vip
  then:
    - type: message
      text: "<aqua>Ты VIP!"
  else:
    - type: message
      text: "<gray>Обычный игрок."
    - type: open_menu
      menu: buy_vip
```

## Разворачивание текста

В `command` и `text` сначала подставляются входные значения `{ключ}` (внутренний механизм; при клике по
меню обычно пусто), затем разворачиваются плейсхолдеры PlaceholderAPI (`%...%`), если он установлен.
Подробнее — [Placeholders-and-Integrations](Placeholders-and-Integrations.md).

> Неизвестный `type` действия просто логируется предупреждением и пропускается.
