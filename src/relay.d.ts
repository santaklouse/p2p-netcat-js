import type { Libp2p, Libp2pInit } from 'libp2p'

export type RelayOptions = {
  identityPath?: string | null
  privateKey?: Libp2pInit['privateKey']
  localPort?: number
  websocketPort?: number | null
  ipVersion?: 4 | 6
  announce?: readonly string[]
  enableMdns?: boolean
  enablePubsub?: boolean
  enableQuic?: boolean
}

export type RelayHandle = Readonly<{
  node: Libp2p
  identityPath: string | null
  peerId: string
  addresses: readonly string[]
  stop(): Promise<void>
}>

export function startRelay(options?: RelayOptions): Promise<RelayHandle>
