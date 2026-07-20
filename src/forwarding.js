import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { bridgeSession } from './session.js'

const SOCKS_GRANTED = 0x5a
const SOCKS_REJECTED = 0x5b

function bytes (value) {
  return value instanceof Uint8Array ? value : value.subarray()
}

async function send (stream, value) {
  if (!stream.send(value) && typeof stream.onDrain === 'function') await stream.onDrain()
}

class ByteReader {
  #iterator
  #buffer = new Uint8Array(0)

  constructor (source) {
    this.#iterator = source[Symbol.asyncIterator]()
  }

  async read (length) {
    while (this.#buffer.byteLength < length) {
      const item = await this.#iterator.next()
      if (item.done) throw new Error('SOCKS-клиент закрыл соединение во время handshake')
      const chunk = bytes(item.value)
      const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength)
      combined.set(this.#buffer)
      combined.set(chunk, this.#buffer.byteLength)
      this.#buffer = combined
    }

    const result = this.#buffer.slice(0, length)
    this.#buffer = this.#buffer.slice(length)
    return result
  }

  async readCString (limit = 1024) {
    const result = []
    while (result.length < limit) {
      const [byte] = await this.read(1)
      if (byte === 0) return new TextDecoder().decode(Uint8Array.from(result))
      result.push(byte)
    }
    throw new Error(`Строка SOCKS превышает ${limit} байт`)
  }

  async * remaining () {
    if (this.#buffer.byteLength > 0) {
      yield this.#buffer
      this.#buffer = new Uint8Array(0)
    }
    for (;;) {
      const item = await this.#iterator.next()
      if (item.done) return
      yield bytes(item.value)
    }
  }
}

function portFrom (value) {
  return (value[0] << 8) | value[1]
}

function ipv4From (value) {
  return [...value].join('.')
}

function ipv6From (value) {
  const groups = []
  for (let index = 0; index < value.length; index += 2) {
    groups.push(((value[index] << 8) | value[index + 1]).toString(16))
  }
  return groups.join(':')
}

async function negotiateSocks5 (reader, stream) {
  const [methodCount] = await reader.read(1)
  const methods = await reader.read(methodCount)
  if (!methods.includes(0x00)) {
    await send(stream, Uint8Array.from([0x05, 0xff]))
    throw new Error('SOCKS5-клиент не предложил режим без аутентификации')
  }
  await send(stream, Uint8Array.from([0x05, 0x00]))

  const [version, command, reserved, addressType] = await reader.read(4)
  if (version !== 0x05 || reserved !== 0x00) throw new Error('Некорректный SOCKS5 request')
  if (command !== 0x01) {
    await send(stream, Uint8Array.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    throw new Error('Поддерживается только SOCKS5 CONNECT')
  }

  let host
  if (addressType === 0x01) {
    host = ipv4From(await reader.read(4))
  } else if (addressType === 0x03) {
    const [length] = await reader.read(1)
    host = new TextDecoder().decode(await reader.read(length))
  } else if (addressType === 0x04) {
    host = ipv6From(await reader.read(16))
  } else {
    await send(stream, Uint8Array.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    throw new Error(`Неподдерживаемый SOCKS5 address type: ${addressType}`)
  }
  const port = portFrom(await reader.read(2))

  return {
    version: 5,
    host,
    port,
    reader,
    success: () => send(stream, Uint8Array.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])),
    failure: () => send(stream, Uint8Array.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
  }
}

async function negotiateSocks4 (reader, stream, command) {
  const portBytes = await reader.read(2)
  const ip = await reader.read(4)
  await reader.readCString()
  if (command !== 0x01) {
    await send(stream, Uint8Array.from([0x00, SOCKS_REJECTED, ...portBytes, ...ip]))
    throw new Error('Поддерживается только SOCKS4 CONNECT')
  }

  const isSocks4a = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0
  const host = isSocks4a ? await reader.readCString() : ipv4From(ip)
  const port = portFrom(portBytes)

  return {
    version: 4,
    host,
    port,
    reader,
    success: () => send(stream, Uint8Array.from([0x00, SOCKS_GRANTED, ...portBytes, ...ip])),
    failure: () => send(stream, Uint8Array.from([0x00, SOCKS_REJECTED, ...portBytes, ...ip]))
  }
}

export async function negotiateSocks (stream) {
  const reader = new ByteReader(stream)
  const [version] = await reader.read(1)
  if (version === 0x05) return negotiateSocks5(reader, stream)
  if (version === 0x04) {
    const [command] = await reader.read(1)
    return negotiateSocks4(reader, stream, command)
  }
  throw new Error(`Неподдерживаемая версия SOCKS: ${version}`)
}

export async function connectTcp (host, port, { timeoutMs = 30_000 } = {}) {
  const socket = createConnection({ host, port, allowHalfOpen: true })
  socket.setNoDelay(true)
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`TCP ${host}:${port} не ответил за ${timeoutMs} мс`)))
  await once(socket, 'connect')
  socket.setTimeout(0)
  return socket
}

export async function tcpForwardSession (stream, { host, port, timeoutMs } = {}) {
  const socket = await connectTcp(host, port, { timeoutMs })
  try {
    await bridgeSession(stream, { input: socket, output: socket, closeOutput: true })
  } finally {
    if (!socket.destroyed) socket.destroy()
  }
}

export async function socksProxySession (stream, { timeoutMs } = {}) {
  const request = await negotiateSocks(stream)
  let socket
  try {
    socket = await connectTcp(request.host, request.port, { timeoutMs })
  } catch (error) {
    await request.failure().catch(() => {})
    throw error
  }

  try {
    await request.success()
    await bridgeSession(stream, {
      input: socket,
      output: socket,
      closeOutput: true,
      remoteInput: request.reader.remaining()
    })
  } finally {
    if (!socket.destroyed) socket.destroy()
  }
}

export async function startLocalForward ({
  host = '127.0.0.1',
  port,
  openStream,
  onError = () => {}
}) {
  const sessions = new Set()
  const sockets = new Set()
  const streams = new Set()
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.setNoDelay(true)
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const session = (async () => {
      const stream = await openStream()
      streams.add(stream)
      const onSocketClose = () => {
        if (stream.status !== 'closed') stream.abort(new Error('Локальное TCP-соединение закрыто'))
      }
      socket.once('close', onSocketClose)
      try {
        if (socket.destroyed) onSocketClose()
        else await bridgeSession(stream, { input: socket, output: socket, closeOutput: true })
      } finally {
        socket.off('close', onSocketClose)
        streams.delete(stream)
      }
    })().catch(error => {
      socket.destroy()
      onError(error)
    }).finally(() => sessions.delete(session))
    sessions.add(session)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port }, () => {
      server.off('error', reject)
      resolve()
    })
  })

  let closePromise
  return Object.freeze({
    server,
    get address () {
      return server.address()
    },
    close () {
      closePromise ??= (async () => {
        for (const socket of sockets) socket.destroy()
        for (const stream of streams) {
          if (stream.status !== 'closed') stream.abort(new Error('TCP forwarding listener остановлен'))
        }
        if (server.listening) {
          const closed = once(server, 'close')
          server.close()
          await closed
        }
        await Promise.allSettled([...sessions])
      })()
      return closePromise
    }
  })
}
