# HANDOFF: код-ревью SomaFM Player

Документ для продолжения работы в новой сессии (например, на компьютере).
Всё ниже — состояние на момент последнего коммита `6913bb8`.

- Репозиторий: `pavelminchenko/somafmplayer` (Vue 3 + Vite + Pinia + TypeScript)
- Рабочая ветка: `claude/code-review-bugs-security-c78xhv` (отведена от `main`)
- Pull request **не создавался**: создавать только по явной просьбе.

## Как продолжить на компьютере

Нужен Node.js `^22.12 || ^24 || >=26` (проверка: `node -v`).

```bash
git fetch origin claude/code-review-bugs-security-c78xhv
git checkout claude/code-review-bugs-security-c78xhv
npm ci
npm run dev        # http://localhost:3000
```

Проверки перед коммитом:

```bash
npx vue-tsc --build --force          # типы
npx eslint "src/**/*.{vue,ts,js}"    # линт (см. примечание про CRLF ниже)
npx vite build                       # сборка
npm test                             # Vitest
```

Стартовый промпт для новой сессии (скопируйте):

> Прочитай HANDOFF.md в корне репозитория и продолжи работу над пунктами из
> раздела «Что осталось». Работай в ветке `claude/code-review-bugs-security-c78xhv`.
> Сначала спроси, с какого пункта начать.

## Что сделано (3 коммита)

### 1. `ced4e2a` — исправление багов

| Проблема | Где | Решение |
|---|---|---|
| Гонка при смене канала, рассинхрон канала/песен/стрима, ошибки не обрабатывались | `src/stores/main-store.ts` | `AbortController` отменяет предыдущий запрос, канал/песни/стрим применяются разом, ошибки в `channelError`; убрано дублирующее `currentChannelSongs`; добавлены `loadChannels`, `refreshCurrentSongs` |
| Утечка таймера и гонка при опросе треков (15 с) | `AudioPlayerChannelInfo.vue` | `useIntervalFn` (авто-остановка), пропуск на скрытой вкладке, ответ чужого канала игнорируется |
| Вечный прелоадер при ошибке сети | `Home.vue` | сообщение + кнопка Retry, очистка таймера |
| `<audio>`: `waiting` ставил `false`, `loadstart` ставил `isPlaying=true`, `play()` без обработки `NotAllowedError`, `throw` в обработчике ошибки | `AudioPlayerElement.vue` | исправлены состояния, ошибки показываются текстом, пауза пользователя не перебивается `canplay` |
| Визуализатор: бесконечный `requestAnimationFrame`, `AudioContext` не закрывался, контекст мог остаться `suspended` (тишина), захардкоженные 22028 Гц | `src/lib/audio-visualizer.js`, `AudioPlayerElementVisualizer.vue` | `destroy()`, `resume()` на событии `play`, `sampleRate / 2`, `webkitAudioContext`, `shallowRef` |
| Парсинг `.pls` (CRLF, нет `trim`), нет отмены запросов | `src/api.ts`, `src/composables/fetch.ts` | `trim`, поддержка `AbortSignal`, `encodeURIComponent(channelId)` |
| Глобы в npm-скриптах без кавычек не доходили до вложенных папок в `sh` | `package.json` | глобы в кавычках |
| `index.html` с `src="src/main.ts"` без `/`; `useMediaQuery` стартовал с `false`; путь локальных картинок в `AppImage` | `index.html`, `media-query.ts`, `AppImage.vue` | исправлено |

### 2. `da669f9` — безопасность

- `npm audit fix`: в **продакшен**-зависимостях теперь 0 уязвимостей
  (`npm audit --omit=dev`).
- `src/api.ts`: URL плейлиста и стрима из API принимаются только с
  `somafm.com` и его поддоменов, всегда переводятся на `https`
  (константа `TRUSTED_HOST`).
- `vercel.json`: CSP (`script-src 'self'`, `connect-src` только `*.somafm.com`,
  `frame-ancestors 'none'`, `upgrade-insecure-requests`), `nosniff`,
  `Referrer-Policy`, `Permissions-Policy`.
- `vite.config.ts`: убран `server.host: true` (dev-сервер только на localhost;
  для проверки с телефона: `npx vite --host`).

### 3. `6913bb8` — рефакторинг и оптимизация

- Удалён мёртвый код: `debounce.ts`, `window-resize-end.ts`, `css-variable.ts`,
  `rem-calc.ts`, `utils.ts`, тип `RequiredFields`.
- `useMediaQuery` заменён на VueUse; `AppTransition` — реактивные пропсы
  вместо одноразовой копии.
- Визуализатор без аллокаций на кадр (кольцо буферов). Результат сверен со
  старой реализацией: все 57 600 координат совпали (режимы offset 1 и -1,
  кадр с `-Infinity`).
- Доступность: убран `maximum-scale=1`, понятные подписи кнопок
  (`Play <канал>`, Play/Pause, Mute/Unmute), `aria-label="Volume"`.

## Как это проверялось и чего НЕ проверялось

Проверено: `vue-tsc`, ESLint (0 ошибок), `vite build`, Chromium (Playwright)
с замоканным API и заголовком CSP: нет нарушений CSP, чужие хосты в
плейлисте/стриме отклоняются, гонка A→B даёт канал B, ошибка стрима
показывается, Retry при падении каналов работает, мобильная и десктопная
ширина переключаются.

**Не проверялось** (в среде сессии закрыта сеть до `somafm.com`):

- реальное воспроизведение звука и визуализатор на живом стриме;
- поведение `AudioContext.resume()` в Safari/iOS;
- что реальные плейлисты и стримы SomaFM действительно лежат на
  `*.somafm.com` (иначе плеер покажет «Untrusted URL host»; тогда расширить
  `TRUSTED_HOST` в `src/api.ts` и `connect-src`/`media-src` в `vercel.json`);
- что стрим-сервер отдаёт CORS-заголовки (нужны из-за `crossorigin="anonymous"`
  на `<audio>`; без них звук не загрузится).

**Первым делом на компьютере:** запустить `npm run dev`, выбрать несколько
каналов, проверить звук, переключение каналов, паузу, громкость, визуализатор,
и затем `npm run build && npm run preview` (CSP действует только на Vercel).

## Что осталось сделать

### Приоритет 1: проверка и безопасность dev-окружения

1. Ручная проверка с реальным SomaFM (см. выше).
2. ✅ Dev-зависимости обновлены, `npm audit` показывает **0 уязвимостей**
   (было 53, из них 1 critical). Сделано: Vite 5→7, `@vitejs/plugin-vue` 6,
   Vitest 1→5 (Vitest 1.x сам принёс 2 critical: `vitest`, `tinypool`),
   `vue-tsc` 1→3 (1.x падал на TypeScript 5.9), `@typescript-eslint` 6→8,
   `npm-check-updates` 23, `inquirer` 8.2.7, `@types/node` 22; `npm update`
   в пределах semver. Удалены неиспользуемые `vue-tsc-files` и `npm-run-all2`
   (`npm run build` теперь `type-check && build-only`, последовательно).
   Sass `@import` заменён на `@use`; сгенерированный CSS побайтово тот же.
   **Требуется Node `^22.12 || ^24 || >=26`** (Vitest 5 и Vite 7; для
   `npm run ncu` нужен ≥ 22.22.2). Если Vercel собирает на Node 20 — сменить
   версию Node в настройках проекта Vercel.
   Остальные пакеты можно обновлять по желанию (`npm run ncu`): ESLint 8→10,
   Stylelint 16→18, Pinia 2→3/4, vue-router 4→5, TypeScript 5.9→6/7 и др. —
   это уже не про безопасность, а про актуальность.

### Приоритет 2: тесты (частично сделано)

3. ✅ Подключён Vitest (`npm test`), 33 теста: `src/api.test.ts` (парсинг `.pls`,
   `toTrustedHttpsUrl`, чужие/похожие хосты, кодирование `channelId`) и
   `src/stores/main-store.test.ts` (гонка A→B, abort, ошибка стрима, канал без
   плейлистов, повтор после ошибки, устаревший ответ опроса песен). Тест гонки
   нашёл реальный дефект (запоздавший ответ заменённого канала перезаписывал
   новый выбор): в `setCurrentChannel` добавлена проверка `signal.aborted`.
   - Осталось: компонентные тесты (`@vue/test-utils`) для `AudioPlayerElement`.

### Приоритет 3: рефакторинг (по желанию)

4. Вынести логику плеера в composable `usePlayer(audioRef)`; контролы не должны
   ходить в store за списком каналов (передавать `onPrev`/`onNext` событиями).
5. В store завести единый `status: 'idle' | 'loading' | 'error'`.
6. ✅ Визуализатор переписан на TypeScript (`src/lib/audio-visualizer.ts`): убраны
   мёртвый код (`filterLP`/`filterHP`, `isAlpha`, `Sound.count`), опечатка
   `calcPolorCoord`, `@ts-expect-error` и `eslint-disable`; нет аллокаций на
   каждую точку. Геометрия закреплена «золотым» тестом
   (`src/lib/audio-visualizer.test.ts`): SHA-256 координат совпадает с хешем
   исходной JS-версии. Проверено в Chromium на реальном синусе: холст
   рисуется, звук идёт через `AudioContext`.
7. `src/router/layout-middleware.ts` избыточен для одного layout: типизировать
   `RouteMeta` или подключить layout статически.
8. `<link rel="preconnect" href="https://api.somafm.com">` добавлен в `index.html`.
   Осталось: кэшировать `getChannels` (sessionStorage / stale-while-revalidate).
9. ✅ Громкость сохраняется (`useStorage`, ключ `somafm-player:volume`, мусор в
   хранилище сбрасывается на 1); mute определяется по `volume === 0`. Последний
   канал пока не сохраняется (автозапуск звука после перезагрузки браузеры
   блокируют, так что это только подсветка в списке).
10. ✅ Media Session (`src/composables/media-session.ts`): метаданные (песня,
    исполнитель, канал, обложка), состояние play/pause, медиаклавиши
    play/pause/previous/next. Логика «предыдущий/следующий канал» перенесена в
    `store.selectAdjacentChannel` (быстрые повторные клики двигаются дальше).
    Проверено в Chromium через перехват `setActionHandler`; на реальной
    блокировке экрана/гарнитуре не проверялось.
11. Холст визуализатора: учитывать `devicePixelRatio`, задавать размер через
    CSS (сейчас 1000×1000 / 1500×1500 px bitmap).
12. Семантика списка каналов (`<ul>/<li>`), индикатор буферизации
    (`isWaiting` уже есть в `AudioPlayerElement.vue`, но в UI не показывается).

### Прочее

13. ✅ CRLF и Prettier: в `.prettierrc` стоит `endOfLine: auto` (репозиторий
    хранится с LF, раньше требовался CRLF и выдавалось ~1900 предупреждений).
    ESLint, Stylelint и Prettier теперь без замечаний (`.editorconfig` по-прежнему
    говорит `crlf` — при желании привести к единому виду).
14. `vite.config.ts`: `base: '/'`, а скрипт `deploy` использует `gh-pages`.
    На GitHub Pages как project-сайте пути сломаются; на Vercel всё работает.
    CSP из `vercel.json` на `gh-pages` не применяется.
15. В `AppImage.vue` ветка внешних картинок принимает и `http://` (CSP
    `upgrade-insecure-requests` это компенсирует, но можно ограничить `https`).
16. Pull request из этой ветки в `main` ещё не создан.

## Структура проекта (для ориентира)

```
src/
  api.ts                      запросы к SomaFM, валидация URL
  stores/main-store.ts        Pinia: каналы, текущий канал, стрим, ошибки
  composables/                fetch, screen-size (VueUse useMediaQuery)
  *.test.ts                   Vitest (api, store)
  components/                 AudioPlayer*, Channel*, App*
  lib/audio-visualizer.js     Web Audio API + canvas (без типов)
  views/Home.vue              главная страница
  router/                     роуты и layout-middleware
vercel.json                   CSP и заголовки безопасности
```
