import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { quic } from '@chainsafe/libp2p-quic'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { bootstrap } from '@libp2p/bootstrap'
import { mdns } from '@libp2p/mdns'
import { kadDHT, removePrivateAddressesMapper } from '@libp2p/kad-dht'
import { multiaddr } from '@multiformats/multiaddr'
import { IPFS_BOOTSTRAP_PEERS } from './constants.js'

function normalizeRelay (address) {
  const value = address.trim().replace(/\/$/, '')
  multiaddr(value)

  if (!value.includes('/p2p/')) {
    throw new Error(`Адрес relay должен содержать /p2p/<PeerId>: ${address}`)
  }

  return value
}

export async function createP2PNode ({
  privateKey,
  localPort = 0,
  websocketPort,
  ipVersion,
  announce = [],
  relays = [],
  bootstrapPeers = IPFS_BOOTSTRAP_PEERS,
  enableDht = true,
  enableMdns = true,
  enableQuic = true,
  relayServer = false,
  dhtServer = false,
  listen = true
} = {}) {
  const relayAddresses = relays.map(normalizeRelay)
  const listenAddresses = []

  if (listen) {
    if (enableQuic && ipVersion !== 6) listenAddresses.push(`/ip4/0.0.0.0/udp/${localPort}/quic-v1`)
    if (enableQuic && ipVersion !== 4) listenAddresses.push(`/ip6/::/udp/${localPort}/quic-v1`)
    if (ipVersion !== 6) listenAddresses.push(`/ip4/0.0.0.0/tcp/${localPort}`)
    if (ipVersion !== 4) listenAddresses.push(`/ip6/::/tcp/${localPort}`)
  }

  if (websocketPort != null) {
    if (ipVersion !== 6) listenAddresses.push(`/ip4/0.0.0.0/tcp/${websocketPort}/ws`)
    if (ipVersion !== 4) listenAddresses.push(`/ip6/::/tcp/${websocketPort}/ws`)
  }

  if (!relayServer) {
    if (relayAddresses.length > 0) {
      listenAddresses.push(...relayAddresses.map(address => `${address}/p2p-circuit`))
    } else if (listen) {
      // Ask suitable connected peers for an automatic Circuit Relay v2 reservation.
      listenAddresses.push('/p2p-circuit')
    }
  }

  const peerDiscovery = []
  if (enableMdns) peerDiscovery.push(mdns())
  if (bootstrapPeers.length > 0) {
    peerDiscovery.push(bootstrap({ list: bootstrapPeers, timeout: 10_000 }))
  }

  const services = {
    identify: identify({ agentVersion: 'p2p-netcat/0.1.0' }),
    ping: ping()
  }

  if (enableDht) {
    services.aminoDHT = kadDHT({
      protocol: '/ipfs/kad/1.0.0',
      peerInfoMapper: removePrivateAddressesMapper,
      clientMode: !dhtServer
    })
  }

  if (relayServer) {
    services.circuitRelay = circuitRelayServer({
      reservations: {
        maxReservations: 128,
        applyDefaultLimit: true,
        defaultDurationLimit: 2 * 60 * 60 * 1000,
        defaultDataLimit: 128n * 1024n * 1024n
      }
    })
  }

  return createLibp2p({
    privateKey,
    addresses: {
      listen: listenAddresses,
      announce: announce.map(address => multiaddr(address))
    },
    transports: [
      ...(enableQuic ? [quic({
        ipv4: ipVersion !== 6,
        ipv6: ipVersion !== 4
      })] : []),
      tcp({
        // Netcat sessions may legitimately stay silent for a long time.
        inboundSocketInactivityTimeout: 0,
        outboundSocketInactivityTimeout: 0
      }),
      webSockets(),
      circuitRelayTransport()
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services,
    connectionGater: {
      // Private addresses are necessary for localhost and LAN netcat sessions.
      denyDialMultiaddr: () => false
    },
    connectionManager: {
      maxConnections: relayServer ? 512 : 128,
      addressSorter: preferQuicAddresses
    }
  })
}

export function preferQuicAddresses (a, b) {
  return addressRank(a.multiaddr) - addressRank(b.multiaddr)
}

function addressRank (address) {
  const value = address.toString()
  if (value.includes('/p2p-circuit')) return 2
  if (value.includes('/quic-v1')) return 0
  return 1
}

export function relayedTargetAddress (relay, peerId) {
  return multiaddr(`${normalizeRelay(relay)}/p2p-circuit/p2p/${peerId}`)
}
