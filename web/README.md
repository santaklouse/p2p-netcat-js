# p2p-netcat web

Статический браузерный клиент для `p2p-netcat`. В проекте нет SSR, API routes,
базы данных и серверных скриптов: production-сборка состоит только из HTML,
CSS, JavaScript, Web Worker, Service Worker, manifest и изображений.

## Возможности

- подключение к CLI-серверу по `PeerId` и логическому порту;
- WebSocket/WSS-транспорт через libp2p Circuit Relay v2;
- Noise-шифрование и Yamux внутри отдельного Web Worker;
- терминальный виджет для текста и бинарного вывода;
- отправка текста, файлов и EOF, сохранение принятых байтов в файл;
- устанавливаемая PWA с офлайн-кешем интерфейса и автообновлением Service Worker;
- адаптивный интерфейс для компьютера, планшета и телефона.

## Установка и сборка

Требуется Node.js 22.13 или новее.

```bash
cd web
npm install
npm run lint
npm run build
```

Готовый автономный статический пакет находится в `web/dist`. Его можно
разместить на любом HTTPS-хостинге статических файлов: backend для приложения
не требуется.

Для разработки:

```bash
cd web
npm run dev
```

## GitHub Pages

В корне репозитория уже находится workflow `.github/workflows/pages.yml`. Он
проверяет TypeScript, собирает только каталог `web`, автоматически вычисляет
базовый путь из имени GitHub-репозитория и публикует содержимое `web/dist`.

После загрузки репозитория откройте **Settings → Pages** и выберите
**Build and deployment → Source → GitHub Actions**. После следующего push в
ветку `main` страница будет опубликована автоматически. Для репозитория
`santaklouse/p2p-netcat-js` ожидаемый адрес:

```text
https://santaklouse.github.io/p2p-netcat-js/
```

GitHub Pages предоставляет HTTPS, поэтому Service Worker и установка PWA будут
работать. Сам P2P relay при этом тоже должен быть доступен через WSS.

## Проверяемый локальный маршрут

В первом терминале запустите relay с отдельным WebSocket-портом:

```bash
p2p-nc relay -4 -p 9090 --websocket-port 9091
```

Скопируйте напечатанный адрес, который содержит `/tcp/9091/ws/p2p/`. Во втором
терминале запустите сервер и передайте ему этот адрес через `--relay`:

```bash
p2p-nc -l 31337 --relay /ip4/127.0.0.1/tcp/9091/ws/p2p/12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW
```

В веб-интерфейсе укажите PeerId, напечатанный сервером, логический порт `31337`
и тот же WebSocket relay multiaddr.

PeerId в команде выше относится к проверочному ключу разработчика. При обычном
запуске relay напечатает другой PeerId — всегда используйте фактически
напечатанный полный адрес.

## HTTPS, WSS и запуск без backend

Service Worker и установка PWA доступны только в secure context: на HTTPS или
на `localhost`. Поэтому открытие `dist/index.html` через `file://` не является
поддерживаемым режимом браузеров. Это ограничение безопасности браузера, а не
потребность приложения в серверной логике.

При размещении страницы по HTTPS relay должен быть доступен по WSS. Обычно TLS
завершается на статическом reverse proxy/CDN, который проксирует WebSocket на
порт `9091`, а публичный multiaddr имеет вид:

```text
/dns4/p2p.example.com/tcp/443/wss/p2p/12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW
```

Веб-приложение само не принимает HTTP-запросы и не выполняет серверный код.
После первой загрузки оболочка интерфейса доступна офлайн; для P2P-сеанса,
разумеется, требуется сеть и доступный relay.

## Проверка

```bash
cd web
npm test
npm run lint
```
