import type { Multiaddr } from "@multiformats/multiaddr";

export const APP_NAME: "p2p-netcat";
export const PROTOCOL_PREFIX: "/p2p-netcat/1.0.0";
export const DEFAULT_SERVICE: 31337;

export type RelayValidationOptions = {
  requireWebSocket?: boolean;
  secureContext?: boolean;
};

export type RelayDialPlan = Readonly<{
  peerId: string;
  service: number;
  protocol: string;
  relay: string;
  destination: string;
}>;

export type AddressLike = string | { toString(): string } | { multiaddr: { toString(): string } };

export function validateService(value?: unknown): number;
export function protocolForService(service: unknown): string;
export function normalizePeerId(value: unknown): string;
export function normalizeMultiaddr(value: unknown): string;
export function isWebSocketAddress(value: unknown): boolean;
export function isSecureWebSocketAddress(value: unknown): boolean;
export function normalizeRelayAddress(value: unknown, options?: RelayValidationOptions): string;
export function relayedTargetAddress(relay: unknown, peerId: unknown, options?: RelayValidationOptions): Multiaddr;
export function createRelayDialPlan(input: {
  peerId: unknown;
  service?: unknown;
  relay: unknown;
  requireWebSocket?: boolean;
  secureContext?: boolean;
}): RelayDialPlan;
export function addressRank(address: AddressLike): number;
export function preferDialAddresses(a: AddressLike, b: AddressLike): number;
export function browserDialableAddress(address: AddressLike, options?: { secureContext?: boolean }): boolean;
