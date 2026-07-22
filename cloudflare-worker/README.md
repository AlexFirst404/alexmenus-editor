# AlexMenus paste service (Cloudflare Worker)

Крошечный «paste» для веб-редактора AlexMenus (в стиле LuckPerms bytebin). Плагин заливает сюда бандл
меню и забирает правки по коду — **на игровом сервере порты открывать не надо**, только исходящие HTTPS.

Бесплатно (free tier Cloudflare с запасом: 100k запросов/день, KV бесплатно).

## Деплой за ~10 минут

### Вариант A — через `wrangler` (CLI, рекомендую)
1. Аккаунт на [cloudflare.com](https://dash.cloudflare.com) (бесплатный).
2. Установи CLI: `npm i -g wrangler`, затем `wrangler login`.
3. Создай KV-хранилище и вставь его id в `wrangler.toml` (поле `id`):
   ```
   wrangler kv namespace create PASTES
   ```
4. Из этой папки: `wrangler deploy`.
5. Скопируй адрес воркера из вывода (вида `https://alexmenus-paste.<акк>.workers.dev`).

### Вариант B — через дашборд (без CLI)
1. Cloudflare → **Workers & Pages** → **Create** → **Worker** → назови `alexmenus-paste` → **Deploy**.
2. **Edit code** → вставь содержимое `worker.js` целиком → **Deploy**.
3. **Storage & Databases → KV** → **Create namespace** (напр. `alexmenus-pastes`).
4. Вернись в воркер → **Settings → Bindings → Add → KV namespace**: имя переменной **`PASTES`**, выбери созданный namespace → сохрани.
5. Адрес воркера — на его странице (вида `https://alexmenus-paste.<акк>.workers.dev`).

## Подключение к плагину
В `plugins/AlexMenus/config.yml`:
```yaml
editor:
  worker-url: "https://alexmenus-paste.<акк>.workers.dev"   # адрес из деплоя
  url: "https://alexfirst404.github.io/alexmenus-editor/"    # хостед-редактор (по умолчанию)
```
`/reload` или рестарт. Дальше: `/am editor` → ссылка → правишь → «Сохранить» → код → `/am apply <код>`.

## API
- `POST /post` тело = JSON-бандл → `{ "key": "<код>" }` (хранится 24ч).
- `GET /<код>` → тот же JSON (или 404, если истёк).
