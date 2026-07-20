"use client";

export type ClientEvents = {
  onData: (bytes: Uint8Array) => void;
  onLog: (message: string, kind?: "info" | "success" | "error") => void;
  onClosed: () => void;
};

type WorkerRequest = {
  id: number;
  action: "start" | "connect" | "send" | "closeWrite" | "stop";
  payload?: Record<string, unknown>;
};

type WorkerResponse =
  | { type: "result"; id: number; value?: unknown }
  | { type: "error"; id: number; message: string }
  | { type: "data"; bytes: ArrayBuffer }
  | { type: "log"; message: string; kind: "info" | "success" | "error" }
  | { type: "closed" };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class BrowserP2PClient {
  private readonly worker: Worker;
  private readonly events: ClientEvents;
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private stopped = false;

  constructor(events: ClientEvents) {
    this.events = events;
    this.worker = new Worker(new URL("./p2p.worker.ts", import.meta.url), {
      type: "module",
      name: "p2p-netcat-network",
    });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data));
    this.worker.addEventListener("error", (event) => {
      this.events.onLog(event.message || "Ошибка сетевого Web Worker", "error");
    });
  }

  async start() {
    return this.request<string>("start");
  }

  async connect(targetPeerId: string, logicalPort: number, relayAddress: string) {
    await this.request("connect", { targetPeerId, logicalPort, relayAddress });
  }

  async send(bytes: Uint8Array) {
    const transferable = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice();
    await this.request("send", { bytes: transferable.buffer }, [transferable.buffer]);
  }

  async sendText(text: string) {
    await this.send(new TextEncoder().encode(text));
  }

  async sendFile(file: File, onProgress: (sent: number, total: number) => void) {
    const reader = file.stream().getReader();
    let sent = 0;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await this.send(value);
      sent += value.byteLength;
      onProgress(sent, file.size);
    }
  }

  async closeWrite() {
    await this.request("closeWrite");
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.request("stop");
    } finally {
      this.worker.terminate();
      for (const request of this.pending.values()) request.reject(new Error("Web Worker остановлен"));
      this.pending.clear();
    }
  }

  private request<T = void>(action: WorkerRequest["action"], payload?: Record<string, unknown>, transfer: Transferable[] = []) {
    if (this.stopped && action !== "stop") return Promise.reject(new Error("Клиент уже остановлен"));
    const id = ++this.requestId;
    const message: WorkerRequest = { id, action, payload };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage(message, transfer);
    });
  }

  private onMessage(message: WorkerResponse) {
    if (message.type === "result" || message.type === "error") {
      const request = this.pending.get(message.id);
      if (request == null) return;
      this.pending.delete(message.id);
      if (message.type === "error") request.reject(new Error(message.message));
      else request.resolve(message.value);
      return;
    }

    if (message.type === "data") {
      this.events.onData(new Uint8Array(message.bytes));
    } else if (message.type === "log") {
      this.events.onLog(message.message, message.kind);
    } else if (message.type === "closed") {
      this.events.onClosed();
    }
  }
}

