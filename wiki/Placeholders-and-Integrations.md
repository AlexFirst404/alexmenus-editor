# Плейсхолдеры и интеграции

AlexMenus держит внешние плагины как **мягкие зависимости** (`softdepend: [PlaceholderAPI, Vault]`): если их
нет — плагин работает, просто соответствующие функции становятся no-op (без `NoClassDefFoundError`).

## PlaceholderAPI

Интеграция мягкая (`integration/PlaceholderHook.java`). Если PlaceholderAPI **установлен**, строки
разворачиваются под конкретного игрока; если нет — возвращаются как есть.

### Где разворачиваются плейсхолдеры

| Место | Когда |
|---|---|
| `title` меню | при открытии, под зрителя |
| `name` предмета | при отрисовке |
| `lore` предмета | при отрисовке (каждая строка) |
| `text` в `message` / `broadcast` | при выполнении действия |
| `command` в `run_command` | перед выполнением команды |
| `value`/`placeholder` в условии `placeholder` | при вычислении требования |

```yaml
items:
  '13':
    material: PLAYER_HEAD
    name: "<yellow>%player_name%"
    lore:
      - "<gray>Мир: <white>%player_world%"
      - "<gray>Баланс: <green>%vault_eco_balance%"
    clicks:
      any:
        - type: message
          text: "<gray>У тебя %vault_eco_balance% монет."
```

### Какие плейсхолдеры работают

Любые, **экспансии которых установлены** в PlaceholderAPI. AlexMenus не поставляет свои плейсхолдеры — он
лишь прогоняет строки через PlaceholderAPI. Примеры (нужны соответствующие экспансии):

- `%player_name%`, `%player_level%`, `%player_world%` — экспансия **Player**.
- `%vault_eco_balance%` — экспансия **Vault** (баланс).
- `%luckperms_prefix%`, `%luckperms_primary_group_name%` — экспансия **LuckPerms**.

Ставятся через `/papi ecloud download <name>` + `/papi reload`.

### Денежное условие через плейсхолдер

Вместо `type: money` (который требует Vault-хук напрямую) можно сравнивать баланс строкой:

```yaml
view-requirement:
  type: placeholder
  placeholder: "%vault_eco_balance%"
  operator: ">="
  value: "1000"
```

Операторы сравнения — см. [Requirements](Requirements.md).

## Vault (экономика)

Мягкая интеграция (`integration/VaultHook.java`). Нужен **Vault** + плагин-провайдер экономики
(EssentialsX, CMI и т.п.). Используется в:

- условии [`money`](Requirements.md) (`type: money`, алиас `has_money`);
- действиях [`give_money` / `take_money`](Actions.md).

Без Vault или без провайдера экономики: `money`-условие всегда `false`, `give_money`/`take_money` —
no-op (транзакция не проходит). Краша нет.

```yaml
click-requirement:
  require: { type: money, amount: 100 }
  deny:
    - type: message
      text: "<red>Нужно 100$."
clicks:
  any:
    - type: take_money
      amount: 100
    - type: give_item
      material: DIAMOND
```

## LuckPerms (и любой пермишен-плагин)

Отдельного хука нет — AlexMenus использует стандартные права Bukkit, а LuckPerms (или другой плагин прав)
их предоставляет. Права применяются в двух местах:

- условие [`permission`](Requirements.md) (`type: permission`);
- ключ меню `permission:` (гейт открытия на всех путях — см. [Commands-and-Permissions](Commands-and-Permissions.md)).

```yaml
permission: alexmenus.menu.shop      # право на открытие всего меню
items:
  '11':
    material: DIAMOND
    view-requirement:
      type: permission
      permission: group.vip          # любой пермишен-нод, который выдаёт LuckPerms
```

Плюс, если стоит экспансия LuckPerms для PlaceholderAPI, доступны `%luckperms_...%` в тексте/условиях
`placeholder`.

## MyCommand и другие командные плагины

Действие [`run_command`](Actions.md) выполняет любую серверную команду — своей или чужой (MyCommand,
CommandAPI, Essentials, датапаки…). `as: console` — от консоли (для команд, требующих прав), `as: player`
— от имени игрока.

```yaml
clicks:
  any:
    - type: run_command
      as: console
      command: "mycmd runalias reward %player_name%"
    - type: run_command
      as: player
      command: "warp pvp"
```

Итог: PlaceholderAPI и Vault — **опциональны**; LuckPerms/командные плагины интегрируются через штатные
права и `run_command` без спец-настройки.
