import { once } from 'node:events'
import { spawn } from 'node:child_process'

function asUint8Array (chunk) {
  return chunk instanceof Uint8Array ? chunk : chunk.subarray()
}

async function writeToNodeStream (output, chunk) {
  if (!output.write(Buffer.from(asUint8Array(chunk)))) {
    await once(output, 'drain')
  }
}

async function inputToP2P (input, stream, closeDelayMs = 0, onActivity = () => {}) {
  try {
    for await (const chunk of input) {
      onActivity()
      if (!stream.send(asUint8Array(chunk))) {
        await stream.onDrain()
      }
    }
    if (closeDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, closeDelayMs))
    }
    await stream.close()
  } catch (error) {
    if (stream.status !== 'closed') stream.abort(error)
    throw error
  }
}

async function p2pToOutput (stream, output, onActivity = () => {}) {
  for await (const chunk of stream) {
    onActivity()
    await writeToNodeStream(output, chunk)
  }
}

export async function bridgeSession (stream, {
  input = process.stdin,
  output = process.stdout,
  remoteInput = stream,
  closeOutput = false,
  closeDelayMs = 0,
  inactivityTimeoutMs = 0
} = {}) {
  let inactivityTimer
  const onActivity = () => {
    if (inactivityTimeoutMs <= 0) return
    clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => {
      stream.abort(new Error(`Таймаут простоя ${inactivityTimeoutMs} мс`))
    }, inactivityTimeoutMs)
  }
  onActivity()

  const sending = inputToP2P(input, stream, closeDelayMs, onActivity)
  const receiving = p2pToOutput(remoteInput, output, onActivity)

  try {
    await Promise.all([sending, receiving])
  } finally {
    clearTimeout(inactivityTimer)
    if (closeOutput && !output.destroyed) output.end()
  }
}

export async function execSession (stream, command, { verbose = false } = {}) {
  const child = spawn(command, {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  if (verbose) process.stderr.write(`[p2p-nc] запущена команда, pid=${child.pid}: ${command}\n`)

  const sendOutput = async function * () {
    const iterators = [child.stdout, child.stderr].map(source => source[Symbol.asyncIterator]())
    const pending = new Map(iterators.map(iterator => [iterator, iterator.next()]))

    while (pending.size > 0) {
      const result = await Promise.race([...pending.entries()].map(async ([iterator, next]) => ({
        iterator,
        item: await next
      })))

      if (result.item.done) {
        pending.delete(result.iterator)
      } else {
        yield result.item.value
        pending.set(result.iterator, result.iterator.next())
      }
    }
  }

  const remoteToStdin = p2pToOutput(stream, child.stdin).finally(() => {
    if (!child.stdin.destroyed) child.stdin.end()
  })

  const outputToRemote = inputToP2P(sendOutput(), stream)
  const [exit] = await once(child, 'exit')
  await Promise.allSettled([remoteToStdin, outputToRemote])

  if (verbose) process.stderr.write(`[p2p-nc] команда завершилась с кодом ${exit ?? 0}\n`)
  return exit ?? 0
}
