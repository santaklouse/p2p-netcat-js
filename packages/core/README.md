# @santaklouse/p2p-netcat-core

Общее browser-safe ядро `p2p-netcat`. Пакет не использует Node.js API и может
импортироваться одновременно консольным приложением, Web Worker и другими
JavaScript-клиентами.

Пакет отвечает за:

- логические порты и protocol ID;
- нормализацию PeerId и multiaddr;
- валидацию relay-адресов;
- построение Circuit Relay dial plan;
- определение browser-compatible адресов;
- единый порядок предпочтения транспортов.

Создание libp2p-узла, DHT, Web Worker RPC и stdin/stdout остаются в платформенных
пакетах.

CLI и Web Worker подключают библиотеку как локальную npm-зависимость. Для CLI
используется путь `file:packages/core`, для веб-проекта —
`file:../packages/core`.

Пример использования общего плана подключения:

```js
import { createRelayDialPlan } from '@santaklouse/p2p-netcat-core'

const plan = createRelayDialPlan({
  peerId: '12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9',
  service: 31337,
  relay: '/dns4/relay.example/tcp/443/wss/p2p/12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW',
  requireWebSocket: true,
  secureContext: true
})

console.log(plan.destination)
console.log(plan.protocol)
```
