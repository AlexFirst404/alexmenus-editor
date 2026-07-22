# Примеры

Готовые, аннотированные меню. Клади файлы в `plugins/AlexMenus/menus/` и делай `/am reload`. Ключи и
поведение соответствуют парсеру; см. [Items-and-Clicks](Items-and-Clicks.md), [Actions](Actions.md),
[Requirements](Requirements.md).

## 1. Магазин с requirements — `menus/shop.yml`

Меню открывается только с правом; покупки гейтятся деньгами; один предмет виден лишь богатым.

```yaml
type: chest
title: "<gold>Магазин"
rows: 3
commands: [shop, магазин]                 # /shop и /магазин
command-description: "Открыть магазин"

# Гейт открытия: нужен пермишен, иначе deny-сообщение и меню не откроется.
open-requirement:
  require:
    type: permission
    permission: alexmenus.shop.use
  deny:
    - type: message
      text: "<red>Нет доступа к магазину."

items:
  # Покупка за деньги (Vault): click-requirement проверяет баланс, действия его списывают.
  '11':
    material: GOLDEN_APPLE
    name: "<gold>Золотое яблоко — 100$"
    lore:
      - "<gray>ЛКМ — купить за <green>100$"
    click-requirement:
      require: { type: money, amount: 100 }
      deny:
        - type: message
          text: "<red>Недостаточно денег (нужно 100$)."
    clicks:
      any:
        - type: take_money
          amount: 100
        - type: give_item
          material: GOLDEN_APPLE
          amount: 1
        - type: message
          text: "<green>Куплено! <gray>(-100$)"

  # Покупка уровней опыта.
  '13':
    material: EXPERIENCE_BOTTLE
    name: "<green>+5 уровней — 50$"
    click-requirement:
      require: { type: money, amount: 50 }
      deny:
        - type: message
          text: "<red>Нужно 50$."
    clicks:
      any:
        - type: take_money
          amount: 50
        - type: give_exp
          amount: 5
          level: true
        - type: message
          text: "<green>+5 уровней!"

  # Виден только если баланс >= 1000 (через плейсхолдер Vault).
  '15':
    material: NETHER_STAR
    name: "<light_purple>Для богатых"
    lore:
      - "<gray>Виден при балансе <white>>= 1000"
    view-requirement:
      type: placeholder
      placeholder: "%vault_eco_balance%"
      operator: ">="
      value: "1000"
    clicks:
      any:
        - type: message
          text: "<light_purple>Ты богат!"

  '22':
    material: ARROW
    name: "<yellow>Назад"
    clicks:
      any:
        - type: back
```

## 2. Меню варпов — `menus/warps.yml`

Кнопки-телепорты через `run_command`, платный варп, звук при клике.

```yaml
type: chest
title: "<aqua>Телепорты"
rows: 3
commands: [warps, варпы]
command-description: "Открыть меню варпов"

items:
  '10':
    material: GRASS_BLOCK
    name: "<green>Спавн"
    lore: [ "<gray>ЛКМ — телепорт на спавн" ]
    clicks:
      left:
        - type: run_command
          as: player
          command: "spawn"
        - type: sound
          sound: "minecraft:entity.enderman.teleport"
        - type: close

  '12':
    material: DIAMOND_SWORD
    name: "<red>PvP-арена"
    lore: [ "<gray>ЛКМ — на арену" ]
    clicks:
      left:
        - type: run_command
          command: "warp pvp"
        - type: close

  # Платный варп в шахты: списываем деньги, только если хватает.
  '14':
    material: IRON_PICKAXE
    name: "<gold>Шахты — 25$"
    lore: [ "<gray>ЛКМ — телепорт за <green>25$" ]
    click-requirement:
      require: { type: money, amount: 25 }
      deny:
        - type: message
          text: "<red>Нужно 25$ для телепорта."
      success:
        - type: sound
          sound: "minecraft:entity.experience_orb.pickup"
    clicks:
      left:
        - type: take_money
          amount: 25
        - type: run_command
          command: "warp mines"
        - type: close

  # VIP-варп: кнопка видна только VIP.
  '16':
    material: BEACON
    name: "<light_purple>VIP-остров"
    view-requirement:
      type: permission
      permission: alexmenus.vip
    clicks:
      left:
        - type: run_command
          command: "warp vipisland"
        - type: close

  '22':
    material: BARRIER
    name: "<red>Закрыть"
    clicks:
      any:
        - type: close
```

## 3. Inventory-HUD — `menus/hud.yml`

Меню в основном инвентаре игрока. Слоты в YAML — **0..26** (ложатся в слоты инвентаря 9–35).

```yaml
type: inventory
title: "HUD"                    # у inventory-меню не отображается как заголовок окна

items:
  '0':                          # физически слот 9 инвентаря
    material: COMPASS
    name: "<green>Спавн"
    hide-all: true
    clicks:
      any:
        - type: run_command
          command: "spawn"

  '4':                          # центр верхнего ряда меню-зоны
    material: NETHER_STAR
    name: "<gold>Меню сервера"
    hide-all: true
    clicks:
      any:
        - type: open_menu
          menu: shop

  '8':
    material: PLAYER_HEAD
    name: "<yellow>%player_name%"
    lore:
      - "<gray>Баланс: <green>%vault_eco_balance%"
    hide-all: true
    clicks:
      any:
        - type: refresh          # обновить лор (пере-вычислить плейсхолдеры)

  '26':                         # физически слот 35 инвентаря
    material: RED_DYE
    name: "<red>Скрыть HUD"
    hide-all: true
    clicks:
      any:
        - type: run_command
          command: "am invclose"
```

Чтобы этот HUD показывался всем при входе — в `config.yml`:

```yaml
inventory-menu:
  enabled: true
  default: hud
```

⚠️ Inventory-меню экспериментально — читай предупреждения в [Menu-Types](Menu-Types.md) (слоты 9–35 становятся
«только меню», реальные вещи оттуда при первом показе выпадают игроку).

## 4. Хаб с навигацией и conditional — `menus/hub.yml`

Центральное меню: переходы в под-меню, ветвление по VIP, платная награда с шансом.

```yaml
type: chest
title: "<gradient:#ff5555:#ffaa00>Хаб</gradient>"
rows: 3
commands: [hub, меню]
command-description: "Главное меню сервера"

items:
  '11':
    material: EMERALD
    name: "<gold>Магазин"
    clicks:
      left:
        - type: open_menu
          menu: shop

  '13':
    material: ENDER_PEARL
    name: "<aqua>Варпы"
    clicks:
      left:
        - type: open_menu
          menu: warps

  # Ветвление: VIP видит благодарность, остальные — предложение купить VIP.
  '15':
    material: NETHER_STAR
    name: "<light_purple>Статус"
    clicks:
      left:
        - type: conditional
          requirement:
            type: permission
            permission: alexmenus.vip
          then:
            - type: message
              text: "<aqua>Спасибо за VIP!"
          else:
            - type: message
              text: "<gray>Купи VIP на сайте."

  # Ежедневная награда с шансом бонуса и отложенным сообщением.
  '22':
    material: CHEST
    name: "<green>Награда"
    clicks:
      left:
        - type: give_money
          amount: 100
        - type: give_item          # бонус выпадает примерно в 20% случаев
          material: DIAMOND
          chance: 20
        - type: message
          text: "<green>Награда получена!"
        - type: message
          text: "<gray>Заходи завтра ещё."
          delay: 40                 # через 2 секунды
        - type: refresh
```

Дальше: [Requirements](Requirements.md) — все типы условий; [Actions](Actions.md) — все действия;
[Web-Editor](Web-Editor.md) — собрать такое мышкой.
