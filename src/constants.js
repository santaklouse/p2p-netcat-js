export const APP_NAME = 'p2p-netcat'
export const APP_VERSION = '0.1.0'
export const PROTOCOL_PREFIX = '/p2p-netcat/1.0.0'
export const DEFAULT_SERVICE = 31337

// The same DNS bootstrap peers used by the public IPFS Amino DHT.
export const IPFS_BOOTSTRAP_PEERS = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
]

export function protocolForService (service) {
  return `${PROTOCOL_PREFIX}/${validateService(service)}`
}

export function validateService (value = DEFAULT_SERVICE) {
  const service = Number(value)

  if (!Number.isInteger(service) || service < 1 || service > 65535) {
    throw new Error(`Логический порт должен быть целым числом от 1 до 65535, получено: ${value}`)
  }

  return service
}

