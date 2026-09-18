import { boundedText } from "../validation.ts";

const ESC = "\x1b";
// ANSI only when the terminal can render it; piped output stays plain text.
const color = (code: number, text: string) => process.env.NO_COLOR === undefined && process.stdout.isTTY ? `${ESC}[${code}m${text}${ESC}[0m` : text;
export const dim = (text: string) => color(90, text);
export const bold = (text: string) => color(1, text);
export const cyan = (text: string) => color(36, text);
export const yellow = (text: string) => color(33, text);
export const red = (text: string) => color(31, text);
export const green = (text: string) => color(32, text);

const MAX_LINE_BYTES = 16 * 1024;
const MAX_HISTORY = 200;

/** Single-line editor over raw stdin: printable input, bracketed paste, history,
 * cursor movement and the usual readline control keys. No dependencies. */
export class LineEditor {
  private history: string[] = [];
  private stdin = process.stdin;
  private stdout = process.stdout;
  private interrupted: (() => void) | null = null;
  private readonly interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  constructor() {
    if (this.interactive) {
      this.stdin.setRawMode(true);
      this.stdout.write(`${ESC}[?2004h`); // bracketed paste
    }
    this.stdin.on("data", (chunk: Buffer) => this.feed(chunk));
    this.stdin.on("end", this.onEnd);
  }

  /** Piped input ends at EOF — a pending read resolves like Ctrl-D. */
  private onEnd = (): void => {
    if (this.resolveLine) { const done = this.resolveLine; done(null); }
  };

  onInterrupt(handler: () => void): void {
    this.interrupted = handler;
  }

  close(): void {
    if (this.interactive) {
      this.stdout.write(`${ESC}[?2004l`);
      this.stdin.setRawMode(false);
    }
    this.stdin.removeAllListeners("data");
    this.stdin.removeListener("end", this.onEnd);
  }

  private buffer = "";
  private cursor = 0;
  private historyIndex = -1;
  private draft = "";
  private paste = false;
  private resolveLine: ((line: string | null) => void) | null = null;

  async readLine(prompt: string): Promise<string | null> {
    if (this.resolveLine) throw new Error("TUI_BUSY");
    this.buffer = ""; this.cursor = 0; this.historyIndex = -1; this.draft = "";
    this.stdout.write(prompt);
    return await new Promise<string | null>((resolve) => {
      this.resolveLine = (line) => {
        this.resolveLine = null;
        if (line !== null && line.trim() !== "" && this.history[0] !== line) {
          this.history.unshift(boundedText(line, MAX_LINE_BYTES));
          if (this.history.length > MAX_HISTORY) this.history.pop();
        }
        this.stdout.write("\n");
        resolve(line);
      };
    });
  }

  private render(): void {
    if (!this.interactive) return;
    const shown = this.buffer;
    this.stdout.write(`\r${ESC}[K` + dim("›") + " " + shown);
    const back = shown.length - this.cursor;
    if (back > 0) this.stdout.write(`${ESC}[${back}D`);
  }

  private feed(chunk: Buffer): void {
    let i = 0;
    const bytes = chunk;
    while (i < bytes.length) {
      const b = bytes[i]!;
      // Bracketed paste delimiters.
      if (b === 0x1b && bytes.subarray(i, i + 6).toString("latin1") === `${ESC}[200~`) { this.paste = true; i += 6; continue; }
      if (b === 0x1b && bytes.subarray(i, i + 6).toString("latin1") === `${ESC}[201~`) { this.paste = false; i += 6; continue; }
      if (b === 0x03) { // Ctrl-C
        this.interrupted?.();
        if (this.resolveLine) { const done = this.resolveLine; this.buffer = ""; this.render(); done(""); }
        i += 1; continue;
      }
      if (b === 0x04) { // Ctrl-D
        if (this.resolveLine && this.buffer.length === 0) { const done = this.resolveLine; done(null); }
        i += 1; continue;
      }
      if (!this.resolveLine) { i += 1; continue; }
      if (b === 0x0d || (b === 0x0a && !this.paste)) {
        const done = this.resolveLine, line = this.buffer;
        this.buffer = ""; this.cursor = 0;
        done(line === null ? null : boundedText(line, MAX_LINE_BYTES));
        i += 1; continue;
      }
      if (b === 0x7f) { // Backspace
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor -= 1; this.render();
        }
        i += 1; continue;
      }
      if (b === 0x01) { this.cursor = 0; this.render(); i += 1; continue; } // Ctrl-A
      if (b === 0x05) { this.cursor = this.buffer.length; this.render(); i += 1; continue; } // Ctrl-E
      if (b === 0x0b) { this.buffer = this.buffer.slice(0, this.cursor); this.render(); i += 1; continue; } // Ctrl-K
      if (b === 0x15) { this.buffer = this.buffer.slice(this.cursor); this.cursor = 0; this.render(); i += 1; continue; } // Ctrl-U
      if (b === 0x17) { // Ctrl-W
        const before = this.buffer.slice(0, this.cursor).replace(/\s+$/u, "").replace(/\S+$/u, "");
        this.buffer = before + this.buffer.slice(this.cursor); this.cursor = before.length; this.render(); i += 1; continue;
      }
      if (b === 0x1b) { // escape sequences
        const seq = bytes.subarray(i, i + 4).toString("latin1");
        if (seq.startsWith(`${ESC}[A`) || seq.startsWith(`${ESC}OA`)) { // up
          if (this.historyIndex === -1) this.draft = this.buffer;
          if (this.historyIndex + 1 < this.history.length) {
            this.historyIndex += 1; this.buffer = this.history[this.historyIndex]!; this.cursor = this.buffer.length; this.render();
          }
          i += 3; continue;
        }
        if (seq.startsWith(`${ESC}[B`) || seq.startsWith(`${ESC}OB`)) { // down
          if (this.historyIndex > 0) { this.historyIndex -= 1; this.buffer = this.history[this.historyIndex]!; }
          else { this.historyIndex = -1; this.buffer = this.draft; }
          this.cursor = this.buffer.length; this.render(); i += 3; continue;
        }
        if (seq.startsWith(`${ESC}[C`) || seq.startsWith(`${ESC}OC`)) { this.cursor = Math.min(this.buffer.length, this.cursor + 1); this.render(); i += 3; continue; }
        if (seq.startsWith(`${ESC}[D`) || seq.startsWith(`${ESC}OD`)) { this.cursor = Math.max(0, this.cursor - 1); this.render(); i += 3; continue; }
        if (seq.startsWith(`${ESC}[H`) || seq.startsWith(`${ESC}[1~`)) { this.cursor = 0; this.render(); i += 3; continue; }
        if (seq.startsWith(`${ESC}[F`) || seq.startsWith(`${ESC}[4~`)) { this.cursor = this.buffer.length; this.render(); i += 3; continue; }
        i += 1; continue; // unknown escape byte: drop
      }
      // UTF-8 printable input (and pasted newlines as spaces).
      const rest = bytes.subarray(i);
      const charLength = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
      const text = rest.subarray(0, charLength).toString("utf8");
      const insert = text === "\n" || text === "\r" ? " " : text;
      if (Buffer.byteLength(this.buffer) + Buffer.byteLength(insert) <= MAX_LINE_BYTES) {
        this.buffer = this.buffer.slice(0, this.cursor) + insert + this.buffer.slice(this.cursor);
        this.cursor += insert.length;
        this.render();
      }
      i += charLength;
    }
  }
}

export type Spinner = Readonly<{ stop(): void }>;

export function startSpinner(label: () => string): Spinner {
  if (!process.stdout.isTTY) return Object.freeze({ stop() {} });
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let index = 0;
  const write = () => process.stdout.write(`\r${ESC}[K${cyan(frames[index % frames.length]!)} ${dim(label())}`);
  const timer = setInterval(() => { index += 1; write(); }, 80);
  write();
  return Object.freeze({
    stop() {
      clearInterval(timer);
      process.stdout.write(`\r${ESC}[K`);
    },
  });
}

export function printTool(name: string, input: unknown): void {
  let detail = "";
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const first = typeof record.path === "string" ? record.path : typeof record.url === "string" ? record.url : typeof record.query === "string" ? record.query : "";
    detail = first === "" ? "" : ` ${boundedText(first, 96)}`;
  }
  process.stdout.write(`${dim("  ⚙")} ${dim(name)}${dim(detail)}\n`);
}

/** After live-streamed blocks, prints only the part of `output` not yet shown.
 * `streamedAll` is every emitted block joined by newlines; `streamedLast` the
 * final block. Non-TTY callers pass empty strings and get the full output. */
export function printRemainingText(output: string | null, streamedAll: string, streamedLast: string): void {
  const final = output ?? "";
  if (final === "") return;
  if (streamedAll === "") {
    process.stdout.write(`${final}\n`);
    return;
  }
  const tail = final === streamedLast || final === streamedAll ? ""
    : final.startsWith(streamedAll) ? final.slice(streamedAll.length).replaceAll(/^\n+/u, "") : final;
  if (tail !== "") process.stdout.write(`${tail}\n`);
}
