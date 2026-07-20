import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'

export const APP_NAME = 'p2p-netcat'
export const PROTOCOL_PREFIX = '/p2p-netcat/1.0.0'
export const DEFAULT_SERVICE = 31337
export const TRYSTERO_APP_ID = 'io.github.santaklouse.p2p-netcat.v1'
export const TRYSTERO_AUTH_VERSION = 1

export function validateService (value = DEFAULT_SERVICE) {
  const service = Number(value)

  if (!Number.isInteger(service) || service < 1 || service > 65535) {
    throw new Error(`Логический порт должен быть целым числом от 1 до 65535, получено: ${value}`)
  }

  return service
}

export function protocolForService (service) {
  return `${PROTOCOL_PREFIX}/${validateService(service)}`
}

export function normalizePeerId (value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) throw new Error('PeerId не указан')
  return peerIdFromString(text).toString()
}

export function normalizeMultiaddr (value) {
  const text = String(value ?? '').trim().replace(/\/$/, '')
  if (text.length === 0) throw new Error('Multiaddr не указан')
  return multiaddr(text).toString().replace(/\/$/, '')
}

export function isWebSocketAddress (value) {
  const text = String(value)
  return /\/(?:ws|wss)(?:\/|$)/.test(text)
}

export function isSecureWebSocketAddress (value) {
  const text = String(value)
  return /\/wss(?:\/|$)/.test(text) || /\/tls\/ws(?:\/|$)/.test(text)
}

export function normalizeRelayAddress (value, {
  requireWebSocket = false,
  secureContext = false
} = {}) {
  const relay = normalizeMultiaddr(value)

  if (!/\/p2p\/[^/]+(?:\/|$)/.test(relay)) {
    throw new Error(`Адрес relay должен содержать /p2p/PeerId: ${value}`)
  }
  if (requireWebSocket && !isWebSocketAddress(relay)) {
    throw new Error('Браузеру нужен WebSocket relay-адрес с /ws или /wss')
  }
  if (secureContext && !isSecureWebSocketAddress(relay)) {
    throw new Error('HTTPS-страница может подключаться только к защищённому /wss relay')
  }

  return relay
}

export function relayedTargetAddress (relay, peerId, options) {
  const relayAddress = normalizeRelayAddress(relay, options)
  const targetPeerId = normalizePeerId(peerId)
  return multiaddr(`${relayAddress}/p2p-circuit/p2p/${targetPeerId}`)
}

export function createRelayDialPlan ({
  peerId,
  service = DEFAULT_SERVICE,
  relay,
  requireWebSocket = false,
  secureContext = false
}) {
  const targetPeerId = normalizePeerId(peerId)
  const logicalPort = validateService(service)
  const relayAddress = normalizeRelayAddress(relay, { requireWebSocket, secureContext })

  return Object.freeze({
    peerId: targetPeerId,
    service: logicalPort,
    protocol: protocolForService(logicalPort),
    relay: relayAddress,
    destination: `${relayAddress}/p2p-circuit/p2p/${targetPeerId}`
  })
}

export function addressRank (address) {
  const value = addressText(address)
  if (value.includes('/p2p-circuit')) return 50
  if (value.includes('/webrtc-direct')) return 0
  if (value.includes('/quic-v1')) return 10
  if (value.includes('/webtransport')) return 20
  if (isSecureWebSocketAddress(value)) return 30
  if (isWebSocketAddress(value)) return 35
  if (value.includes('/tcp/')) return 40
  return 45
}

export function preferDialAddresses (a, b) {
  return addressRank(addressText(a)) - addressRank(addressText(b))
}

export function browserDialableAddress (address, { secureContext = false } = {}) {
  const value = addressText(address)
  if (value.includes('/webrtc') || value.includes('/webtransport')) return true
  if (!isWebSocketAddress(value)) return false
  return !secureContext || isSecureWebSocketAddress(value)
}

export function trysteroRoomId (peerId, service = DEFAULT_SERVICE) {
  return `${normalizePeerId(peerId)}:${validateService(service)}`
}

export function trysteroAuthPayload (peerId, service, challenge) {
  const nonce = asBytes(challenge)
  if (nonce.byteLength !== 32) throw new Error(`Trystero challenge must contain 32 bytes, received: ${nonce.byteLength}`)
  const context = new TextEncoder().encode(`p2p-netcat/trystero-auth/v1\0${trysteroRoomId(peerId, service)}\0`)
  const payload = new Uint8Array(context.byteLength + nonce.byteLength)
  payload.set(context)
  payload.set(nonce, context.byteLength)
  return payload
}

export function encodeTrysteroAuthResponse (publicKey, signature) {
  const key = asBytes(publicKey)
  const proof = asBytes(signature)
  if (key.byteLength > 0xffff || proof.byteLength > 0xffff) throw new Error('Trystero authentication response is too large')
  const response = new Uint8Array(5 + key.byteLength + proof.byteLength)
  const view = new DataView(response.buffer)
  response[0] = TRYSTERO_AUTH_VERSION
  view.setUint16(1, key.byteLength)
  view.setUint16(3, proof.byteLength)
  response.set(key, 5)
  response.set(proof, 5 + key.byteLength)
  return response
}

export function decodeTrysteroAuthResponse (value) {
  const response = asBytes(value)
  if (response.byteLength < 5 || response[0] !== TRYSTERO_AUTH_VERSION) throw new Error('Unsupported Trystero authentication response')
  const view = new DataView(response.buffer, response.byteOffset, response.byteLength)
  const publicKeyLength = view.getUint16(1)
  const signatureLength = view.getUint16(3)
  if (5 + publicKeyLength + signatureLength !== response.byteLength) throw new Error('Malformed Trystero authentication response')
  return Object.freeze({
    publicKey: response.slice(5, 5 + publicKeyLength),
    signature: response.slice(5 + publicKeyLength)
  })
}

export class TrysteroStream {
  status = 'open'
  writeStatus = 'writable'
  #sendData
  #sendControl
  #onFinalize
  #pending = Promise.resolve()
  #items = []
  #waiters = []
  #readClosed = false
  #finalized = false

  constructor ({ sendData, sendControl, onFinalize = () => {} }) {
    this.#sendData = sendData
    this.#sendControl = sendControl
    this.#onFinalize = onFinalize
  }

  send (chunk) {
    if (this.writeStatus !== 'writable') throw new Error('Trystero stream is not writable')
    const bytes = asBytes(chunk).slice()
    this.#pending = this.#pending.then(() => this.#sendData(bytes))
    return false
  }

  onDrain () {
    return this.#pending
  }

  async close () {
    if (this.writeStatus !== 'writable') return
    this.writeStatus = 'closing'
    await this.#pending
    await this.#sendControl('eof')
    this.writeStatus = 'closed'
    this.#maybeFinalize()
  }

  abort (error = new Error('Trystero stream aborted')) {
    if (this.status === 'closed') return
    this.writeStatus = 'closed'
    this.status = 'closed'
    void this.#sendControl('abort').catch(() => {})
    this.#fail(error)
    this.#finalize()
  }

  receiveData (chunk) {
    if (this.#readClosed || this.status === 'closed') return
    const bytes = asBytes(chunk).slice()
    const waiter = this.#waiters.shift()
    if (waiter != null) waiter.resolve({ value: bytes, done: false })
    else this.#items.push(bytes)
  }

  receiveControl (control) {
    if (control === 'eof') {
      this.#endRead()
      this.#maybeFinalize()
    } else if (control === 'abort') {
      this.status = 'closed'
      this.writeStatus = 'closed'
      this.#fail(new Error('Remote Trystero peer aborted the stream'))
      this.#finalize()
    }
  }

  peerLeft () {
    if (this.status === 'closed') return
    this.status = 'closed'
    this.writeStatus = 'closed'
    this.#endRead()
    this.#finalize()
  }

  [Symbol.asyncIterator] () {
    return {
      next: () => {
        const item = this.#items.shift()
        if (item != null) return Promise.resolve({ value: item, done: false })
        if (this.#readClosed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
      }
    }
  }

  #endRead () {
    if (this.#readClosed) return
    this.#readClosed = true
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  #fail (error) {
    this.#readClosed = true
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  #maybeFinalize () {
    if (this.#readClosed && this.writeStatus === 'closed') {
      this.status = 'closed'
      this.#finalize()
    }
  }

  #finalize () {
    if (this.#finalized) return
    this.#finalized = true
    this.#onFinalize()
  }
}

function addressText (address) {
  if (address?.multiaddr != null) return address.multiaddr.toString()
  return address?.toString?.() ?? String(address)
}

function asBytes (value) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError('Expected binary data')
}
