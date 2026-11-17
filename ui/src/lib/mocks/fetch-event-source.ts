/**
 * An EventSource over fetch, for the mock on a plain-http LAN or public IP (a phone opening the
 * dev server). That is not a secure context, so there is no service worker: MSW intercepts fetch
 * and XHR in the page instead, but not EventSource, and the events stream would reach the dev
 * server (503) and the app would show Offline. Only browser.ts installs it, in that case only.
 * It covers what the app uses (admin-events.tsx): open, error, named events, close. No
 * automatic reconnect: the app closes the source on error and opens a new one with a new ticket.
 */
const BLANK_LINE = /\r?\n\r?\n/;

export class FetchEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readonly withCredentials = false;
  readyState = FetchEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private readonly controller = new AbortController();

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    void this.run();
  }

  close(): void {
    this.readyState = FetchEventSource.CLOSED;
    this.controller.abort();
  }

  private async run(): Promise<void> {
    try {
      const response = await fetch(this.url, {
        cache: "no-store",
        headers: { accept: "text/event-stream" },
        signal: this.controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`events: HTTP ${response.status}`);
      this.readyState = FetchEventSource.OPEN;
      this.emit(new Event("open"));
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        // Events end at a blank line.
        for (let gap = BLANK_LINE.exec(buffer); gap; gap = BLANK_LINE.exec(buffer)) {
          this.dispatchBlock(buffer.slice(0, gap.index));
          buffer = buffer.slice(gap.index + gap[0].length);
        }
      }
      throw new Error("events: stream ended");
    } catch {
      if (this.readyState === FetchEventSource.CLOSED) return;
      this.readyState = FetchEventSource.CLOSED;
      this.emit(new Event("error"));
    }
  }

  private dispatchBlock(block: string): void {
    let type = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") type = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    this.emit(new MessageEvent(type, { data: data.join("\n"), origin: location.origin }));
  }

  private emit(event: Event): void {
    if (event.type === "open") this.onopen?.(event);
    else if (event.type === "error") this.onerror?.(event);
    else if (event.type === "message") this.onmessage?.(event as MessageEvent);
    this.dispatchEvent(event);
  }
}
