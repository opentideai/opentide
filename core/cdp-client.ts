import { getKernelSettings } from "./config.ts";
const CDP_TIMEOUT_MS = getKernelSettings().cdpTimeoutMs;

export class CDPClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private listeners = new Map<string, Array<(params: unknown) => void>>();
  private connected = false;

  constructor(private wsUrl: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => {
        this.connected = false;
        for (const p of this.pending.values()) {
          p.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
      };
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        if ("id" in msg) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            msg.error ? p.reject(msg.error) : p.resolve(msg.result);
          }
        } else if ("method" in msg) {
          this.listeners.get(msg.method)?.forEach((fn) => fn(msg.params));
        }
      };
    });
  }

  // deno-lint-ignore no-explicit-any
  send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.connected) return Promise.reject(new Error("CDP not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: unknown) => void): void {
    const arr = this.listeners.get(event);
    if (arr) arr.push(handler);
    else this.listeners.set(event, [handler]);
  }

  off(event: string, handler: (params: unknown) => void): void {
    const arr = this.listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  close(): void {
    this.connected = false;
    try {
      this.ws.close();
    } catch { /* already closed */ }
    for (const p of this.pending.values()) {
      p.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
