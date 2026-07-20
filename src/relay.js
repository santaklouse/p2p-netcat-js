import { resolve } from 'node:path'
import { createP2PNode } from './node.js'
import { defaultIdentityPath, loadOrCreateIdentity } from './identity.js'

function relayAddresses (node) {
  const peerId = node.peerId.toString()
  return node.getMultiaddrs().map(address => {
    const value = address.toString()
    return value.includes('/p2p/') ? value : `${value}/p2p/${peerId}`
  })
}

export async function startRelay ({
  identityPath = `${defaultIdentityPath()}.relay`,
  privateKey,
  localPort = 9090,
  websocketPort = 9091,
  ipVersion,
  announce = [],
  enableMdns = true,
  enablePubsub = true,
  enableQuic = true
} = {}) {
  if (ipVersion !== undefined && ipVersion !== 4 && ipVersion !== 6) {
    throw new TypeError('ipVersion must be 4, 6, or undefined')
  }

  const resolvedIdentityPath = privateKey == null && identityPath != null
    ? resolve(identityPath)
    : null
  const relayPrivateKey = privateKey ?? await loadOrCreateIdentity(resolvedIdentityPath)
  const node = await createP2PNode({
    privateKey: relayPrivateKey,
    localPort,
    websocketPort,
    ipVersion,
    announce,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns,
    enablePubsub,
    enableQuic,
    relayServer: true
  })

  let stopPromise
  const handle = {
    node,
    identityPath: resolvedIdentityPath,
    get peerId () {
      return node.peerId.toString()
    },
    get addresses () {
      return Object.freeze(relayAddresses(node))
    },
    stop () {
      stopPromise ??= node.stop()
      return stopPromise
    }
  }

  return Object.freeze(handle)
}
