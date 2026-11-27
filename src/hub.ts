// Live state: the terminal list from hc events, and one follower per session someone is watching.
// @see docs/herdr-reader.md

import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { type Terminal, followTerminals, getTerminal, readScreen } from "./hc.ts";
import { type TranscriptParser, parseAll } from "./parse/common.ts";
import { orderSessions } from "./sessions.ts";
import { type TranscriptSource, sources } from "./sources.ts";
import { readLastLines, TailReader } from "./tail.ts";
import type { Entry, SessionSummary, StreamEvent } from "./types.ts";

export type Listener = (event: StreamEvent) => void;

/** Transcripts reach tens of MB, mostly tool output; read the tail and widen once if it is short. */
const INITIAL_BYTES = [4 * 1024 * 1024, 24 * 1024 * 1024];
const SUMMARY_BYTES = 512 * 1024;
const KEEP_ENTRIES = 1000;
/** Entries a new viewer gets at once; the phone renders every one. */
const SNAPSHOT_ENTRIES = 200;
const POLL_MS = 2_000;
const LAST_TEXT_CHARS = 160;

async function readEntries(file: string, source: TranscriptSource, limit: number) {
  let result = { entries: [] as Entry[], offset: 0, parser: source.createParser() };
  for (const bytes of INITIAL_BYTES) {
    const { lines, offset, whole } = await readLastLines(file, bytes);
    const parser = source.createParser();
    result = { entries: parseAll(parser, lines), offset, parser };
    if (result.entries.length >= limit || whole) break;
  }
  return { ...result, entries: result.entries.slice(-limit) };
}

function screenEntry(text: string): Entry {
  return { kind: "screen", id: "screen", at: Date.now(), text };
}

function flat(text: string): string {
  const one = text.replace(/\*\*|`|^#+ /gm, "").replace(/\s+/g, " ").trim();
  return one.length > LAST_TEXT_CHARS ? `${one.slice(0, LAST_TEXT_CHARS)}…` : one;
}

export class Hub {
  private terminals = new Map<string, Terminal>();
  private markReady: () => void = () => {};
  private readonly ready = new Promise<void>((resolve) => (this.markReady = resolve));
  private readonly listListeners = new Set<Listener>();
  private readonly followers = new Map<string, Follower>();
  private readonly located = new Map<string, { key: string; file: Promise<string | null> }>();
  private readonly lastTexts = new Map<string, { size: number; text: string | null }>();
  private lastList = "";
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changed = new Set<string>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopEvents: () => void = () => {};

  start(): void {
    this.stopEvents = followTerminals({
      snapshot: (terminals) => {
        this.apply(new Map(terminals.filter((t) => t.live).map((t) => [t.address, t])));
        this.markReady();
      },
      changed: (address) => this.onChanged(address),
      error: (message) => console.error(message),
    });
  }

  stop(): void {
    this.stopEvents();
    for (const follower of this.followers.values()) follower.close();
  }

  async terminal(address: string): Promise<Terminal | null> {
    await this.waitReady();
    return this.terminals.get(address) ?? null;
  }

  /** The transcript file for an agent terminal on this Mac; cached until its pid or status changes. */
  locate(terminal: Terminal): Promise<string | null> {
    if (!terminal.agent) return Promise.resolve(null);
    const key = `${terminal.pid}:${terminal.updatedMs}`;
    const hit = this.located.get(terminal.address);
    if (hit?.key === key) return hit.file;
    const file = sources[terminal.agent].locate(terminal).catch(() => null);
    this.located.set(terminal.address, { key, file });
    return file;
  }

  async sessions(): Promise<SessionSummary[]> {
    await this.waitReady();
    const live = [...this.terminals.values()];
    const summaries = await Promise.all(
      live.map(async (t): Promise<SessionSummary> => ({
        address: t.address,
        agent: t.agent,
        status: t.status,
        where: t.where,
        cwd: t.cwd,
        machine: t.machine,
        updatedMs: t.updatedMs,
        lastText: await this.lastText(t),
      })),
    );
    return orderSessions(summaries);
  }

  async entries(terminal: Terminal, limit: number): Promise<Entry[]> {
    const file = await this.locate(terminal);
    if (file && terminal.agent) return (await readEntries(file, sources[terminal.agent], limit)).entries;
    return [screenEntry(await readScreen(terminal.address))];
  }

  /** Session list changes, plus entry changes of one session when address is given. */
  async subscribe(address: string | null, listener: Listener): Promise<() => void> {
    this.listListeners.add(listener);
    listener({ type: "sessions", sessions: await this.sessions() });
    let follower: Follower | null = null;
    const terminal = address ? await this.terminal(address) : null;
    if (terminal) {
      follower = this.followers.get(terminal.address) ?? new Follower(this, terminal);
      this.followers.set(terminal.address, follower);
      await follower.attach(listener);
    }
    return () => {
      this.listListeners.delete(listener);
      if (follower && follower.detach(listener) === 0) {
        follower.close();
        this.followers.delete(follower.address);
      }
    };
  }

  private async waitReady(): Promise<void> {
    await Promise.race([this.ready, Bun.sleep(5_000)]);
  }

  /** Re-reads changed terminals in one batch: an event names what changed, `hc get` gives the whole terminal. */
  private onChanged(address: string): void {
    this.changed.add(address);
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(async () => {
      this.changeTimer = null;
      const addresses = [...this.changed];
      this.changed.clear();
      const fresh = await Promise.all(addresses.map((a) => getTerminal(a).catch(() => undefined)));
      const next = new Map(this.terminals);
      addresses.forEach((address, i) => {
        const terminal = fresh[i];
        if (terminal === undefined) return;
        if (terminal?.live) next.set(address, terminal);
        else next.delete(address);
      });
      this.apply(next);
    }, 250);
  }

  private apply(next: Map<string, Terminal>): void {
    const before = this.terminals;
    this.terminals = next;
    for (const [address, follower] of this.followers) {
      const now = this.terminals.get(address);
      const was = before.get(address);
      if (now && (now.status !== was?.status || now.pid !== was?.pid || now.updatedMs !== was?.updatedMs)) follower.refresh(now);
    }
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      void this.broadcastList();
    }, 200);
  }

  private async broadcastList(): Promise<void> {
    const sessions = await this.sessions();
    const json = JSON.stringify(sessions);
    if (json === this.lastList) return;
    this.lastList = json;
    for (const listener of this.listListeners) listener({ type: "sessions", sessions });
  }

  private async lastText(terminal: Terminal): Promise<string | null> {
    const file = await this.locate(terminal);
    if (!file || !terminal.agent) return terminal.title || null;
    try {
      const { size } = await stat(file);
      const hit = this.lastTexts.get(file);
      if (hit?.size === size) return hit.text;
      const { lines } = await readLastLines(file, SUMMARY_BYTES);
      const last = parseAll(sources[terminal.agent].createParser(), lines)
        .reverse()
        .find((e) => e.kind === "assistant" || e.kind === "tool" || e.kind === "user");
      const text = !last
        ? terminal.title || null
        : flat(last.kind === "assistant" ? last.markdown : last.kind === "tool" ? [last.name, last.summary].filter(Boolean).join(": ") : last.kind === "user" ? last.text : "");
      this.lastTexts.set(file, { size, text });
      return text;
    } catch {
      return terminal.title || null;
    }
  }
}

/** Streams one session's entries to its listeners: transcript tail when there is one, else the screen. */
class Follower {
  readonly address: string;
  private readonly listeners = new Set<Listener>();
  private readonly entries = new Map<string, Entry>();
  private file: string | null = null;
  private tail: TailReader | null = null;
  private parser: TranscriptParser | null = null;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private screen = "";
  private opening: Promise<void>;

  constructor(
    private readonly hub: Hub,
    private terminal: Terminal,
  ) {
    this.address = terminal.address;
    this.opening = this.open();
  }

  async attach(listener: Listener): Promise<void> {
    let opening: Promise<void>;
    do {
      opening = this.opening;
      await opening;
    } while (opening !== this.opening);
    listener({ type: "reset", address: this.address, entries: this.snapshot() });
    this.listeners.add(listener);
  }

  detach(listener: Listener): number {
    this.listeners.delete(listener);
    return this.listeners.size;
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tail = null;
  }

  refresh(terminal: Terminal): void {
    this.terminal = terminal;
    void this.hub.locate(terminal).then((file) => {
      if (file !== this.file) this.reopen();
      else if (this.tail) void this.pull();
      else void this.pullScreen();
    });
  }

  private reopen(): void {
    this.opening = this.open().then(() => this.emit({ type: "reset", address: this.address, entries: this.snapshot() }));
  }

  private snapshot(): Entry[] {
    return [...this.entries.values()].slice(-SNAPSHOT_ENTRIES);
  }

  private async open(): Promise<void> {
    this.close();
    this.entries.clear();
    this.screen = "";
    const terminal = this.terminal;
    this.file = await this.hub.locate(terminal);
    const read = this.file && terminal.agent ? await readEntries(this.file, sources[terminal.agent], KEEP_ENTRIES).catch(() => null) : null;
    if (this.file && read) {
      const { entries, offset, parser } = read;
      for (const entry of entries) this.entries.set(entry.id, entry);
      this.parser = parser;
      this.tail = new TailReader(this.file, offset);
      try {
        this.watcher = watch(this.file, () => void this.pull());
      } catch {
        // polling below still runs
      }
      this.timer = setInterval(() => void this.pull(), POLL_MS);
    } else {
      await this.pullScreen();
      this.timer = setInterval(() => void this.pullScreen(), POLL_MS);
    }
  }

  private async pull(): Promise<void> {
    const tail = this.tail;
    if (!tail || !this.parser) return;
    try {
      const chunk = await tail.read();
      if (tail !== this.tail) return;
      if (chunk.reset) return this.reopen();
      const changed = new Map<string, Entry>();
      for (const line of chunk.lines) for (const entry of this.parser.feed(line)) changed.set(entry.id, entry);
      if (changed.size === 0) return;
      for (const entry of changed.values()) this.entries.set(entry.id, entry);
      for (const id of this.entries.keys()) {
        if (this.entries.size <= KEEP_ENTRIES) break;
        this.entries.delete(id);
      }
      this.emit({ type: "entries", address: this.address, entries: [...changed.values()] });
    } catch (error) {
      console.error(`follow ${this.address}: ${(error as Error).message}`);
    }
  }

  private async pullScreen(): Promise<void> {
    try {
      const text = await readScreen(this.address);
      if (text === this.screen) return;
      this.screen = text;
      const entry = screenEntry(text);
      this.entries.set(entry.id, entry);
      this.emit({ type: "entries", address: this.address, entries: [entry] });
    } catch (error) {
      console.error(`screen ${this.address}: ${(error as Error).message}`);
    }
  }

  private emit(event: StreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
