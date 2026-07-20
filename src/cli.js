import { Command, InvalidArgumentError } from 'commander'
import { resolve } from 'node:path'
import { createP2PNode } from './node.js'
import { defaultIdentityPath, loadOrCreateIdentity } from './identity.js'
import { DEFAULT_SERVICE, protocolForService, validateService } from '@santaklouse/p2p-netcat-core'
import { APP_VERSION, IPFS_BOOTSTRAP_PEERS } from './constants.js'
import { bridgeSession, execSession } from './session.js'
import { advertiseSelf, resolveTarget } from './discovery.js'
import { connectTrystero, startTrysteroListener } from './trystero.js'

function integer (value, previous) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new InvalidArgumentError(`ожидалось неотрицательное целое число, получено: ${value}`)
  }
  return number
}

function positiveInteger (value) {
  const number = integer(value)
  if (number === 0) throw new InvalidArgumentError('значение должно быть больше нуля')
  return number
}

function collect (value, values) {
  return [...values, value]
}

function stderr (message) {
  process.stderr.write(`${message}\n`)
}

function addressLines (node) {
  const peerId = node.peerId.toString()
  return node.getMultiaddrs().map(address => {
    const value = address.toString()
    return value.includes('/p2p/') ? value : `${value}/p2p/${peerId}`
  })
}

function printNodeInfo (node, { json = false, label = 'узел' } = {}) {
  const payload = {
    peerId: node.peerId.toString(),
    addresses: addressLines(node)
  }

  if (json) {
    stderr(JSON.stringify(payload))
    return
  }

  stderr(`[p2p-nc] ${label} PeerId: ${payload.peerId}`)
  for (const address of payload.addresses) stderr(`[p2p-nc] адрес: ${address}`)
}

function installShutdown (node) {
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await node.stop().catch(() => {})
  }

  const onSignal = signal => {
    stop().finally(() => process.kill(process.pid, signal))
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  return () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

function commonNodeOptions (command) {
  return command
    .option('-p, --local-port <port>', 'локальный TCP/UDP-порт libp2p (0 = выбрать автоматически)', integer, 0)
    .option('-4, --ipv4', 'слушать только IPv4')
    .option('-6, --ipv6', 'слушать только IPv6')
    .option('-i, --identity <file>', 'файл постоянного приватного ключа')
    .option('--relay <multiaddr>', 'Circuit Relay v2; можно указать несколько раз', collect, [])
    .option('--bootstrap <multiaddr>', 'заменить стандартные IPFS bootstrap-узлы', collect, [])
    .option('--announce <multiaddr>', 'публичный адрес, объявляемый через DHT; можно повторять', collect, [])
    .option('--no-dht', 'не подключаться к публичной IPFS Amino DHT')
    .option('--no-mdns', 'отключить обнаружение соседей в локальной сети')
    .option('--no-quic', 'отключить QUIC и использовать TCP/relay')
    .option('--no-webrtc', 'отключить прямой Trystero/WebRTC fallback')
    .option('--json', 'выводить сведения об узле в JSON в stderr')
    .option('-v, --verbose', 'подробная диагностика в stderr')
}

function nodeOptionsFrom (options, { privateKey, dhtServer = false, relayServer = false } = {}) {
  if (options.ipv4 && options.ipv6) throw new Error('Опции -4 и -6 нельзя использовать одновременно')
  const enableDht = options.dht !== false

  return {
    privateKey,
    localPort: options.localPort,
    websocketPort: options.websocketPort,
    ipVersion: options.ipv4 ? 4 : options.ipv6 ? 6 : undefined,
    announce: options.announce,
    relays: options.relay,
    bootstrapPeers: options.bootstrap.length > 0
      ? options.bootstrap
      : enableDht ? IPFS_BOOTSTRAP_PEERS : [],
    enableDht,
    enableMdns: options.mdns !== false,
    enableQuic: options.quic !== false,
    dhtServer,
    relayServer
  }
}

async function runListener (target, serviceArgument, options) {
  if (serviceArgument != null) {
    throw new Error('В режиме -l укажите только логический порт: p2p-nc -l 8080')
  }

  const service = validateService(target ?? DEFAULT_SERVICE)
  const identityPath = resolve(options.identity ?? defaultIdentityPath())
  const privateKey = await loadOrCreateIdentity(identityPath)
  const node = await createP2PNode(nodeOptionsFrom(options, { privateKey, dhtServer: true }))
  const removeSignalHandlers = installShutdown(node)
  const advertiseController = new AbortController()
  const advertiseTask = options.dht === false
    ? Promise.resolve()
    : advertiseSelf(node, { signal: advertiseController.signal, verbose: options.verbose })
  const protocol = protocolForService(service)
  let completed
  const firstSession = new Promise((resolve, reject) => { completed = { resolve, reject } })
  let handled = false

  const handleIncoming = async (stream, remotePeer) => {
    if (handled && !options.keepOpen) {
      stream.abort(new Error('Слушатель принимает только одно подключение'))
      return
    }
    handled = true
    stderr(`[p2p-nc] подключен ${remotePeer} к логическому порту ${service}`)

    try {
      if (options.exec != null) {
        await execSession(stream, options.exec, options)
      } else {
        await bridgeSession(stream, {
          closeDelayMs: options.quitDelay * 1000,
          inactivityTimeoutMs: options.timeoutExplicit ? options.timeout * 1000 : 0
        })
      }
      completed.resolve()
    } catch (error) {
      completed.reject(error)
    }
  }

  await node.handle(protocol, async (stream, connection) => {
    await handleIncoming(stream, connection.remotePeer)
  }, {
    maxInboundStreams: 1,
    runOnLimitedConnection: true
  })

  const trysteroListener = options.webrtc === false
    ? null
    : startTrysteroListener({
        privateKey,
        service,
        verbose: options.verbose,
        onStream: (stream, remotePeer) => void handleIncoming(stream, `webrtc:${remotePeer}`)
      })

  printNodeInfo(node, { json: options.json, label: `слушатель:${service}` })
  stderr(`[p2p-nc] постоянный ключ: ${identityPath}`)

  let previousAddresses = new Set(addressLines(node))
  node.addEventListener('self:peer:update', () => {
    for (const address of addressLines(node)) {
      if (!previousAddresses.has(address)) stderr(`[p2p-nc] новый адрес: ${address}`)
      previousAddresses.add(address)
    }
  })

  try {
    if (options.keepOpen) {
      await new Promise(() => {})
    } else {
      await firstSession
    }
  } finally {
    advertiseController.abort()
    await advertiseTask.catch(() => {})
    await trysteroListener?.close().catch(() => {})
    removeSignalHandlers()
    await node.stop()
  }
}

async function runClient (target, serviceArgument, options) {
  if (target == null) {
    throw new Error('Не указан PeerId. Пример: p2p-nc 12D3KooW... 8080')
  }

  const service = validateService(serviceArgument ?? DEFAULT_SERVICE)
  const privateKey = await loadOrCreateIdentity(options.identity == null ? null : resolve(options.identity))
  const node = await createP2PNode(nodeOptionsFrom(options, { privateKey }))
  const removeSignalHandlers = installShutdown(node)
  const timeoutMs = options.timeout * 1000
  const libp2pController = new AbortController()
  let trysteroAttempt

  try {
    if (options.verbose) printNodeInfo(node, { json: options.json, label: 'клиент' })
    const libp2pAttempt = (async () => {
      const dialTarget = await resolveTarget(node, target, {
        relays: options.relay,
        timeoutMs,
        verbose: options.verbose,
        signal: libp2pController.signal
      })
      return node.dialProtocol(dialTarget, protocolForService(service), {
        signal: AbortSignal.any([libp2pController.signal, AbortSignal.timeout(timeoutMs)]),
        runOnLimitedConnection: true
      })
    })()

    const useTrystero = options.webrtc !== false && !target.startsWith('/') && options.relay.length === 0
    if (useTrystero) trysteroAttempt = connectTrystero({ peerId: target, service, timeoutMs, verbose: options.verbose })
    let winner
    try {
      winner = await Promise.any([
        libp2pAttempt.then(stream => ({ transport: 'libp2p', stream })),
        ...(trysteroAttempt == null ? [] : [trysteroAttempt.promise.then(stream => ({ transport: 'Trystero/WebRTC', stream }))])
      ])
    } catch (error) {
      const reasons = error instanceof AggregateError ? error.errors.map(item => item.message).join('; ') : error.message
      throw new Error(`Ни один транспорт не установил соединение: ${reasons}`, { cause: error })
    }

    if (winner.transport === 'libp2p') await trysteroAttempt?.close().catch(() => {})
    else libp2pController.abort(new Error('Выбран более быстрый Trystero/WebRTC-канал'))
    const stream = winner.stream
    if (options.verbose || options.zero) stderr(`[p2p-nc] соединение с ${target}:${service} установлено`)
    if (options.verbose) stderr(`[p2p-nc] выбран транспорт: ${winner.transport}`)
    if (options.zero) {
      await stream.close()
      return
    }

    await bridgeSession(stream, {
      closeDelayMs: options.quitDelay * 1000,
      inactivityTimeoutMs: options.timeoutExplicit ? timeoutMs : 0
    })
  } finally {
    libp2pController.abort(new Error('Клиент завершён'))
    await trysteroAttempt?.close().catch(() => {})
    removeSignalHandlers()
    await node.stop()
  }
}

async function runRelay (options) {
  if (options.ipv4 && options.ipv6) throw new Error('Опции -4 и -6 нельзя использовать одновременно')
  const identityPath = resolve(options.identity ?? `${defaultIdentityPath()}.relay`)
  const privateKey = await loadOrCreateIdentity(identityPath)
  const node = await createP2PNode({
    privateKey,
    localPort: options.localPort,
    websocketPort: options.websocketPort,
    ipVersion: options.ipv4 ? 4 : options.ipv6 ? 6 : undefined,
    announce: options.announce,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: options.mdns !== false,
    enableQuic: options.quic !== false,
    relayServer: true
  })
  installShutdown(node)
  printNodeInfo(node, { json: options.json, label: 'relay' })
  stderr(`[p2p-nc] relay готов; постоянный ключ: ${identityPath}`)
  await new Promise(() => {})
}

async function printIdentity (options) {
  const identityPath = resolve(options.identity ?? defaultIdentityPath())
  const privateKey = await loadOrCreateIdentity(identityPath)
  const node = await createP2PNode({
    privateKey,
    listen: false,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false
  })
  process.stdout.write(`${node.peerId}\n`)
  await node.stop()
}

export function createProgram () {
  const program = new Command()
    .name('p2p-nc')
    .enablePositionalOptions()
    .description('Netcat-подобный потоковый P2P-клиент на libp2p/IPFS, адресуемый по PeerId')
    .version(APP_VERSION)
    .usage('[опции] [PeerId|multiaddr] [логический-порт]')
    .argument('[target]', 'PeerId/multiaddr сервера; с -l это логический порт')
    .argument('[service]', 'логический порт сервиса', value => validateService(value))
    .option('-l, --listen', 'режим сервера')
    .option('-k, --keep-open', 'после сеанса продолжать принимать подключения')
    .option('-w, --timeout <seconds>', 'таймаут поиска/подключения; при явном -w также простоя', positiveInteger, 60)
    .option('-q, --quit-delay <seconds>', 'задержка закрытия после EOF stdin', integer, 0)
    .option('-z, --zero', 'только проверить возможность подключения')
    .option('-e, --exec <command>', 'на сервере подключить поток к команде (опасно без доверия к клиенту)')
    .option('-u, --udp', 'UDP-режим (не поддерживается: libp2p-поток надёжен)')

  commonNodeOptions(program)

  program.action(async (target, service, options) => {
    options.timeoutExplicit = program.getOptionValueSource('timeout') === 'cli'
    if (options.udp) throw new Error('Опция -u пока не поддерживается: текущий протокол передаёт надёжный двунаправленный поток')
    if (options.exec != null && !options.listen) throw new Error('Опция -e доступна только вместе с -l')
    if (options.listen) return runListener(target, service, options)
    return runClient(target, service, options)
  })

  program.command('relay')
    .description('запустить собственный публичный Circuit Relay v2')
    .option('-p, --local-port <port>', 'публичный TCP/UDP-порт relay', integer, 9090)
    .option('--websocket-port <port>', 'WebSocket-порт для браузерных клиентов', positiveInteger, 9091)
    .option('-4, --ipv4', 'слушать только IPv4')
    .option('-6, --ipv6', 'слушать только IPv6')
    .option('-i, --identity <file>', 'файл постоянного приватного ключа')
    .option('--announce <multiaddr>', 'публичный адрес relay; можно повторять', collect, [])
    .option('--no-mdns', 'отключить обнаружение в LAN')
    .option('--no-quic', 'отключить QUIC и использовать только TCP')
    .option('--json', 'вывести сведения в JSON')
    .option('-v, --verbose', 'подробная диагностика')
    .action(runRelay)

  program.command('id')
    .description('показать постоянный PeerId слушателя и завершиться')
    .option('-i, --identity <file>', 'файл постоянного приватного ключа')
    .action(printIdentity)

  return program
}

export async function main (argv = process.argv) {
  try {
    await createProgram().parseAsync(argv)
  } catch (error) {
    stderr(`[p2p-nc] ошибка: ${error.message}`)
    if (process.env.DEBUG?.includes('p2p-netcat')) stderr(error.stack)
    process.exitCode = 1
  }
}
