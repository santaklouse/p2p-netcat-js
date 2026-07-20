import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'

export const APP_NAME = 'p2p-netcat'
export const PROTOCOL_PREFIX = '/p2p-netcat/1.0.0'
export const DEFAULT_SERVICE = 31337

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

function addressText (address) {
  if (address?.multiaddr != null) return address.multiaddr.toString()
  return address?.toString?.() ?? String(address)
}
