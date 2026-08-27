export type SseMessage = {
  event?: string;
  id?: string;
  retry?: number;
  data: string;
};

/** Incremental SSE parser. It follows the WHATWG field grammar and accepts
 * LF, CRLF, and CR line endings, including UTF-8 characters split between
 * arbitrary network chunks. */
export class SseParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private event = "";
  private id: string | undefined;
  private retry: number | undefined;
  private data: string[] = [];

  push(chunk: Uint8Array): SseMessage[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  flush(): SseMessage[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(flush: boolean): SseMessage[] {
    const messages: SseMessage[] = [];
    let index = 0;
    while (index < this.buffer.length) {
      const lineEnd = this.buffer.slice(index).search(/[\r\n]/);
      if (lineEnd < 0) break;
      const end = index + lineEnd;
      const separator = this.buffer[end] === "\r" && this.buffer[end + 1] === "\n" ? 2 : 1;
      const line = this.buffer.slice(index, end);
      index = end + separator;
      if (line === "") {
        const message = this.dispatch();
        if (message) messages.push(message);
        continue;
      }
      this.field(line);
    }
    this.buffer = this.buffer.slice(index);
    if (flush && this.buffer) {
      this.field(this.buffer);
      this.buffer = "";
    }
    if (flush) {
      const message = this.dispatch();
      if (message) messages.push(message);
    }
    return messages;
  }

  private field(line: string) {
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const name = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") this.event = value;
    else if (name === "id" && !value.includes("\0")) this.id = value;
    else if (name === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
    else if (name === "data") this.data.push(value);
  }

  private dispatch(): SseMessage | undefined {
    if (!this.data.length && !this.event && this.id === undefined && this.retry === undefined) return undefined;
    const message: SseMessage = { data: this.data.join("\n") };
    if (this.event) message.event = this.event;
    if (this.id !== undefined) message.id = this.id;
    if (this.retry !== undefined) message.retry = this.retry;
    this.event = "";
    this.id = undefined;
    this.retry = undefined;
    this.data = [];
    return message;
  }
}
