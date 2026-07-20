/// <reference lib="webworker" />

import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";

const PROTOCOL_PREFIX = "/p2p-netcat/1.0.0";
const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
type Node = Awaited<ReturnType<typeof createLibp2p>>;
type Stream = Awaited<ReturnType<Node["dialProtocol"]>>;

type WorkerRequest = {
  id: number;
  action: "start" | "connect" | "send" | "closeWrite" | "stop";
  payload?: Record<string, unknown>;
};

let node: Node | null = null;
let stream: Stream | null = null;
let receiveTask: Promise<void> | null = null;

function postLog(message: string, kind: "info" | "success" | "error" = "info") {
  workerScope.postMessage({ type: "log", message, kind });
}

function normalizeRelayAddress(value: string) {
  const relay = value.trim().replace(/\/$/, "");
  const text = multiaddr(relay).toString();

  if (!text.includes("/p2p/")) throw new Error("Relay-адрес должен содержать /p2p/PeerId");
  if (!text.includes("/ws") && !text.includes("/wss")) {
    throw new Error("Браузеру нужен WebSocket relay-адрес с /ws или /wss");
  }
  if (workerScope.location.protocol === "https:" && !text.includes("/wss")) {
    throw new Error("HTTPS-страница может подключаться только к защищённому /wss relay");
  }
  return text;
}

function logicalPort(value: unknown) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Логический порт должен быть числом от 1 до 65535");
  }
  return port;
}

async function startNode() {
  if (node != null) return node.peerId.toString();
  postLog("Сетевой стек запускается в Web Worker…");

  node = await createLibp2p({
    addresses: { listen: [] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
    },
    connectionGater: {
      denyDialMultiaddr: () => false,
    },
  });

  const peerId = node.peerId.toString();
  postLog(`Браузерный PeerId: ${peerId}`, "success");
  return peerId;
}

async function connect(payload: Record<string, unknown>) {
  if (stream != null) throw new Error("Соединение уже открыто");
  await startNode();

  const target = peerIdFromString(String(payload.targetPeerId ?? "").trim());
  const relay = normalizeRelayAddress(String(payload.relayAddress ?? ""));
  const port = logicalPort(payload.logicalPort);
  const destination = multiaddr(`${relay}/p2p-circuit/p2p/${target}`);

  postLog(`Открываем relay-маршрут к ${target}:${port}…`);
  stream = await node!.dialProtocol(destination, `${PROTOCOL_PREFIX}/${port}`, {
    signal: AbortSignal.timeout(30_000),
    runOnLimitedConnection: true,
  });
  postLog(`Канал ${target}:${port} открыт`, "success");
  receiveTask = receiveLoop(stream);
}

async function send(bytes: ArrayBuffer) {
  if (stream == null) throw new Error("Сначала установите соединение");
  if (stream.writeStatus !== "writable") throw new Error("Запись в канал уже закрыта");
  if (!stream.send(new Uint8Array(bytes))) await stream.onDrain();
}

async function receiveLoop(activeStream: Stream) {
  try {
    for await (const chunk of activeStream) {
      const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
      const transferable = bytes.slice().buffer;
      workerScope.postMessage({ type: "data", bytes: transferable }, [transferable]);
    }
    postLog("Удалённая сторона завершила передачу");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("закрыто пользователем")) postLog(message, "error");
  } finally {
    if (stream === activeStream) stream = null;
    workerScope.postMessage({ type: "closed" });
  }
}

async function stop() {
  const activeStream = stream;
  stream = null;
  if (activeStream != null && activeStream.status !== "closed") {
    activeStream.abort(new Error("Соединение закрыто пользователем"));
  }
  await receiveTask?.catch(() => {});
  receiveTask = null;
  await node?.stop();
  node = null;
}

workerScope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const { id, action, payload = {} } = event.data;
  void (async () => {
    try {
      let value: unknown;
      if (action === "start") value = await startNode();
      else if (action === "connect") value = await connect(payload);
      else if (action === "send") value = await send(payload.bytes as ArrayBuffer);
      else if (action === "closeWrite") {
        if (stream != null && stream.writeStatus === "writable") await stream.close();
        postLog("EOF отправлен; канал остаётся открытым для приёма");
      } else if (action === "stop") value = await stop();
      workerScope.postMessage({ type: "result", id, value });
    } catch (error) {
      workerScope.postMessage({
        type: "error",
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});

export {};
