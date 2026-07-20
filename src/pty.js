import { once } from 'node:events'
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import process from 'node:process'
import pty from 'node-pty'

const FRAME_DATA = 0
const FRAME_RESIZE = 1
const HEADER_LENGTH = 5
const MAX_FRAME_LENGTH = 1024 * 1024
const require = createRequire(import.meta.url)

function ensureSpawnHelperExecutable () {
  if (process.platform === 'win32') return
  const packageDirectory = dirname(require.resolve('node-pty/package.json'))
  const candidates = [
    join(packageDirectory, 'build', 'Release', 'spawn-helper'),
    join(packageDirectory, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      chmodSync(candidate, 0o755)
    } catch {}
  }
}

function asBytes (value) {
  return value instanceof Uint8Array ? value : value.subarray()
}

function frame (type, payload) {
  const bytes = asBytes(payload)
  const result = new Uint8Array(HEADER_LENGTH + bytes.byteLength)
  const view = new DataView(result.buffer)
  result[0] = type
  view.setUint32(1, bytes.byteLength)
  result.set(bytes, HEADER_LENGTH)
  return result
}

function resizePayload (columns, rows) {
  const result = new Uint8Array(4)
  const view = new DataView(result.buffer)
  view.setUint16(0, Math.max(1, Math.min(0xffff, columns || 80)))
  view.setUint16(2, Math.max(1, Math.min(0xffff, rows || 24)))
  return result
}

async function * decodeFrames (source) {
  let buffer = new Uint8Array(0)
  for await (const value of source) {
    const chunk = asBytes(value)
    const combined = new Uint8Array(buffer.byteLength + chunk.byteLength)
    combined.set(buffer)
    combined.set(chunk, buffer.byteLength)
    buffer = combined

    while (buffer.byteLength >= HEADER_LENGTH) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      const length = view.getUint32(1)
      if (length > MAX_FRAME_LENGTH) throw new Error(`PTY frame превышает ${MAX_FRAME_LENGTH} байт`)
      if (buffer.byteLength < HEADER_LENGTH + length) break
      yield { type: buffer[0], data: buffer.slice(HEADER_LENGTH, HEADER_LENGTH + length) }
      buffer = buffer.slice(HEADER_LENGTH + length)
    }
  }
  if (buffer.byteLength !== 0) throw new Error('PTY stream завершился внутри frame')
}

function createSender (stream) {
  let pending = Promise.resolve()
  return {
    send (type, payload) {
      pending = pending.then(async () => {
        if (!stream.send(frame(type, payload)) && typeof stream.onDrain === 'function') await stream.onDrain()
      })
      return pending
    },
    drain () {
      return pending
    }
  }
}

function interactiveBytes (chunk, state) {
  const output = []
  let quit = false
  for (const byte of asBytes(chunk)) {
    if (state.escape) {
      state.escape = false
      if (byte === 0x71) {
        quit = true
        break
      }
      output.push(0x05, byte)
    } else if (byte === 0x05) {
      state.escape = true
    } else {
      output.push(byte)
    }
  }
  return { bytes: Uint8Array.from(output), quit }
}

export async function interactiveClientSession (stream, {
  input = process.stdin,
  output = process.stdout
} = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Интерактивный режим -i требует TTY на stdin')
  }

  const sender = createSender(stream)
  const state = { escape: false }
  let quitting = false
  const wasRaw = input.isRaw
  const sendResize = () => {
    void sender.send(FRAME_RESIZE, resizePayload(output.columns, output.rows)).catch(() => {})
  }
  const onData = chunk => {
    if (quitting) return
    const parsed = interactiveBytes(chunk, state)
    if (parsed.bytes.byteLength > 0) void sender.send(FRAME_DATA, parsed.bytes).catch(() => {})
    if (parsed.quit) {
      quitting = true
      input.pause()
      void sender.drain().then(() => stream.close()).catch(() => {})
    }
  }

  input.setRawMode(true)
  input.resume()
  input.on('data', onData)
  output.on?.('resize', sendResize)
  sendResize()

  try {
    for await (const message of decodeFrames(stream)) {
      if (message.type === FRAME_DATA && !output.write(Buffer.from(message.data))) await once(output, 'drain')
    }
  } finally {
    input.off('data', onData)
    output.off?.('resize', sendResize)
    input.setRawMode(Boolean(wasRaw))
    input.pause()
    if (stream.writeStatus === 'writable') await stream.close().catch(() => {})
  }
}

export async function ptyServerSession (stream, {
  shell = process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'),
  cwd = process.env.HOME ?? process.cwd(),
  env = process.env,
  verbose = false
} = {}) {
  ensureSpawnHelperExecutable()
  const shellArguments = process.platform === 'win32' ? [] : ['-l']
  const terminal = pty.spawn(shell, shellArguments, {
    name: env.TERM ?? 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env
  })
  const sender = createSender(stream)
  const decoder = new StringDecoder('utf8')
  const outputSubscription = terminal.onData(data => {
    void sender.send(FRAME_DATA, Buffer.from(data, 'utf8')).catch(() => {})
  })
  const exitPromise = new Promise(resolve => {
    terminal.onExit(event => resolve(event.exitCode))
  })

  if (verbose) process.stderr.write(`[p2p-nc] PTY login shell запущен, pid=${terminal.pid}: ${shell}\n`)

  const receiveTask = (async () => {
    for await (const message of decodeFrames(stream)) {
      if (message.type === FRAME_DATA) {
        terminal.write(decoder.write(Buffer.from(message.data)))
      } else if (message.type === FRAME_RESIZE && message.data.byteLength === 4) {
        const view = new DataView(message.data.buffer, message.data.byteOffset, message.data.byteLength)
        terminal.resize(Math.max(1, view.getUint16(0)), Math.max(1, view.getUint16(2)))
      }
    }
  })()

  let exitCode = 0
  try {
    const result = await Promise.race([
      receiveTask.then(() => ({ source: 'remote' })),
      exitPromise.then(code => ({ source: 'pty', code }))
    ])
    if (result.source === 'remote') {
      terminal.kill()
      exitCode = await exitPromise
    } else {
      exitCode = result.code
    }
    await sender.drain()
    if (stream.writeStatus === 'writable') await stream.close()
    await receiveTask.catch(() => {})
  } finally {
    outputSubscription.dispose()
    try {
      terminal.kill()
    } catch {}
  }

  if (verbose) process.stderr.write(`[p2p-nc] PTY login shell завершён с кодом ${exitCode}\n`)
  return exitCode
}

export const PTY_PROTOCOL = Object.freeze({
  FRAME_DATA,
  FRAME_RESIZE,
  encodeData: value => frame(FRAME_DATA, value),
  encodeResize: (columns, rows) => frame(FRAME_RESIZE, resizePayload(columns, rows))
})
