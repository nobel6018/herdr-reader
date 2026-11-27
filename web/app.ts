// Phone app: session list and one session as a chat. Live updates come from /api/stream.
// @see docs/herdr-reader.md

import { Marked, type Tokens } from "marked";
import { GROUP_LABEL, GROUP_OF, GROUPS, STATUS_LABEL } from "../src/sessions.ts";
import type { Entry, SessionSummary, StreamEvent } from "../src/types.ts";

type Child = Node | string | null | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
    else if (key === "class") el.className = String(value);
    else if (key === "html") el.innerHTML = String(value);
    else if (key in el && typeof value !== "string") (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Transcript text is untrusted: raw HTML is shown as text, links only to http(s) and mailto. */
const markdown = new Marked({ gfm: true, breaks: true });
markdown.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    image(token: Tokens.Image) {
      return escapeHtml(token.text);
    },
    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link) {
      const label = this.parser.parseInline(token.tokens);
      if (!/^(https?:|mailto:)/i.test(token.href)) return label;
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

const app = document.getElementById("app")!;
let sessions: SessionSummary[] = [];
let current: string | null = null;
let source: EventSource | null = null;
let connected = false;
const entries = new Map<string, Entry>();
const nodes = new Map<string, HTMLElement>();
let view: SessionView | null = null;
let screenTimer: ReturnType<typeof setInterval> | null = null;

const AGENT_BADGE = { "claude-code": "CC", codex: "Cx" } as const;

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간`;
  return `${Math.floor(s / 86400)}일`;
}

function names(where: string): { title: string; space: string } {
  const i = where.lastIndexOf(" / ");
  return i < 0 ? { title: where, space: "" } : { title: where.slice(i + 3), space: where.slice(0, i) };
}

function badge(s: SessionSummary | undefined): HTMLElement {
  const agent = s?.agent ?? null;
  return h("div", { class: `ag ${agent ?? "other"}`, "aria-hidden": "true" }, agent ? AGENT_BADGE[agent] : ">_");
}

function pill(s: SessionSummary): HTMLElement {
  return h("span", { class: `pill ${GROUP_OF[s.status]}` }, STATUS_LABEL[s.status]);
}

async function post(path: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return data.error ?? `요청이 실패했습니다 (${res.status}).`;
  } catch {
    return "서버에 닿지 못했습니다.";
  }
}

function api(address: string, rest: string): string {
  return `/api/sessions/${encodeURIComponent(address)}/${rest}`;
}

// ---- list ----

function renderList(): void {
  const live = sessions;
  const count = (g: string) => live.filter((s) => GROUP_OF[s.status] === g).length;
  const body = h("div", { class: "body" });
  body.append(h("div", { class: "sum" }, ...GROUPS.map((g) => h("div", {}, h("b", {}, String(count(g))), h("span", {}, GROUP_LABEL[g])))));
  if (live.length === 0) body.append(h("p", { class: "empty" }, connected ? "열린 세션이 없습니다." : "연결하는 중입니다."));
  for (const group of GROUPS) {
    const items = live.filter((s) => GROUP_OF[s.status] === group);
    if (items.length === 0) continue;
    body.append(h("div", { class: "grp" }, GROUP_LABEL[group]));
    for (const s of items) {
      const { title, space } = names(s.where);
      body.append(
        h(
          "button",
          { class: `sess ${group}`, type: "button", onclick: () => (location.hash = `#/s/${encodeURIComponent(s.address)}`) },
          badge(s),
          h(
            "div",
            { class: "m" },
            h("div", { class: "r1" }, h("span", { class: "p" }, title), pill(s), h("span", { class: "tm" }, ago(s.updatedMs))),
            h("div", { class: "sp" }, [space, s.machine].filter(Boolean).join(" | ")),
            s.lastText ? h("div", { class: "last" }, s.lastText) : null,
          ),
        ),
      );
    }
  }
  app.replaceChildren(
    h("div", { class: "bar" }, h("span", { class: "t" }, "herdr"), h("span", { class: "s" }, connected ? "실시간" : "다시 연결하는 중")),
    body,
  );
}

// ---- one session ----

interface SessionView {
  title: HTMLElement;
  pill: HTMLElement;
  status: HTMLElement;
  scroller: HTMLElement;
  list: HTMLElement;
  live: HTMLElement;
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  goOn: HTMLButtonElement;
  error: HTMLElement;
}

function session(): SessionSummary | undefined {
  return sessions.find((s) => s.address === current);
}

function shortPath(text: string): string {
  const cwd = session()?.cwd;
  return cwd ? text.split(`${cwd}/`).join("") : text;
}

function diffBlock(text: string): HTMLElement {
  const pre = h("pre", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("@@") ? "h" : line.startsWith("+") ? "a" : line.startsWith("-") ? "r" : "";
    pre.append(h("span", { class: cls }, line || " "));
  }
  return pre;
}

function entryNode(entry: Entry): HTMLElement {
  switch (entry.kind) {
    case "user":
      return h("div", { class: "me" }, entry.text);
    case "assistant":
      return h("div", { class: "ai", html: markdown.parse(entry.markdown, { async: false }) as string });
    case "screen":
      return h("pre", { class: "screen" }, entry.text.replace(/\s+$/, ""));
    case "tool": {
      const st = entry.ok === null ? ["run", "진행 중"] : entry.ok ? ["ok", "완료"] : ["fail", "실패"];
      const detail = entry.detail ? (entry.detail.type === "diff" ? diffBlock(entry.detail.text) : h("pre", { class: "out" }, entry.detail.text || "(출력 없음)")) : null;
      const summary = h("summary", {}, h("span", { class: "k" }, entry.name), h("span", { class: "d" }, shortPath(entry.summary)), h("span", { class: `st ${st[0]}` }, st[1]!));
      return detail ? h("details", { class: "tool" }, summary, detail) : h("div", { class: "tool" }, summary);
    }
  }
}

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function upsert(list: Entry[], reset: boolean): void {
  if (!view) return;
  const stick = reset || atBottom(view.scroller);
  if (reset) {
    entries.clear();
    nodes.clear();
    view.list.replaceChildren();
  }
  for (const entry of list) {
    entries.set(entry.id, entry);
    const node = entryNode(entry);
    const old = nodes.get(entry.id);
    if (old) {
      if (old instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) node.open = old.open;
      old.replaceWith(node);
    } else {
      view.list.append(node);
    }
    nodes.set(entry.id, node);
  }
  if (reset && entries.size === 0) view.list.append(h("p", { class: "empty" }, "아직 읽을 대화가 없습니다."));
  if (stick) view.scroller.scrollTop = view.scroller.scrollHeight;
}

async function pressKey(key: string): Promise<void> {
  if (!current || !view) return;
  view.error.textContent = (await post(api(current, "keys"), { key })) ?? "";
}

async function sendText(text: string): Promise<void> {
  if (!current || !view || !text.trim()) return;
  view.sendBtn.disabled = true;
  const error = await post(api(current, "send"), { text });
  view.error.textContent = error ?? "";
  if (!error && text === view.input.value) {
    view.input.value = "";
    view.input.style.height = "";
  }
  updateChrome();
}

function renderSessionShell(): void {
  const title = h("span", { class: "t" });
  const pillEl = h("span", { class: "pill ended" });
  const list = h("div", { class: "body-list", style: "display:contents" });
  const live = h("div", { style: "display:contents" });
  const scroller = h("div", { class: "body" }, list, live);
  const input = h("textarea", {
    rows: 1,
    placeholder: "이 세션에 보내기",
    "aria-label": "메시지",
    enterkeyhint: "send",
    oninput: () => {
      input.style.height = "";
      input.style.height = `${input.scrollHeight}px`;
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendText(input.value);
    },
  });
  const sendBtn = h("button", { class: "send", type: "button", "aria-label": "보내기", onclick: () => void sendText(input.value) }, "↑");
  const goOn = h("button", { class: "chip", type: "button", onclick: () => void sendText("계속") }, "계속");
  const stop = h("button", { class: "chip", type: "button", onclick: () => void pressKey("esc") }, "중단 (Esc)");
  const error = h("p", { class: "err", role: "status" });
  const status = h("p", { class: "hint" });
  view = { title, pill: pillEl, status, scroller, list, live, input, sendBtn, goOn, error };
  app.replaceChildren(
    h("div", { class: "bar" }, h("button", { class: "back", type: "button", "aria-label": "목록으로", onclick: () => (location.hash = "") }, "‹"), title, pillEl),
    scroller,
    h("div", { class: "comp" }, h("div", { class: "chips" }, goOn, stop), h("div", { class: "inrow" }, input, sendBtn), error, status),
  );
  updateChrome();
}

function askCard(screen: string): HTMLElement {
  const lines = screen.replace(/\s+$/, "").split("\n").slice(-30).join("\n");
  const keys = ["up", "down", "enter", "1", "2", "3", "esc"];
  const label: Record<string, string> = { up: "↑ 위", down: "↓ 아래", enter: "선택 (Enter)", esc: "취소 (Esc)" };
  return h(
    "div",
    { class: "ask" },
    h("b", {}, "승인 요청"),
    h("pre", { class: "screen" }, lines || "화면을 읽는 중입니다."),
    h("div", { class: "btns" }, ...keys.map((k) => h("button", { class: k === "enter" ? "btn pri" : "btn", type: "button", onclick: () => void pressKey(k) }, label[k] ?? k))),
  );
}

async function refreshScreen(): Promise<void> {
  if (!current || !view) return;
  const res = await fetch(api(current, "screen")).catch(() => null);
  const data = res?.ok ? ((await res.json()) as { text: string }) : null;
  if (!view || session()?.status !== "blocked") return;
  const stick = atBottom(view.scroller);
  view.live.replaceChildren(askCard(data?.text ?? ""));
  if (stick) view.scroller.scrollTop = view.scroller.scrollHeight;
}

function updateChrome(): void {
  if (!view) return;
  const s = session();
  const { title } = names(s?.where ?? current ?? "");
  view.title.textContent = title;
  view.pill.className = s ? `pill ${GROUP_OF[s.status]}` : "pill ended";
  view.pill.textContent = s ? STATUS_LABEL[s.status] : "없음";
  const working = s?.status === "working";
  const blocked = s?.status === "blocked";
  const closed = !s;
  view.input.disabled = working || blocked || closed;
  view.sendBtn.disabled = working || blocked || closed;
  view.goOn.disabled = working || blocked || closed;
  view.input.placeholder = working ? "작업 중에는 보낼 수 없습니다" : blocked ? "승인 요청에 먼저 답하세요" : "이 세션에 보내기";
  view.status.textContent = closed ? "이 세션은 지금 열려 있지 않습니다." : connected ? "" : "다시 연결하는 중입니다.";

  if (blocked) {
    if (!screenTimer) {
      void refreshScreen();
      screenTimer = setInterval(() => void refreshScreen(), 3000);
    }
  } else {
    if (screenTimer) clearInterval(screenTimer);
    screenTimer = null;
    const stick = atBottom(view.scroller);
    view.live.replaceChildren(working ? h("div", { class: "working" }, h("span", { class: "dot" }), "작업 중") : "");
    if (stick) view.scroller.scrollTop = view.scroller.scrollHeight;
  }
}

// ---- wiring ----

function connect(): void {
  source?.close();
  const url = current ? `/api/stream?session=${encodeURIComponent(current)}` : "/api/stream";
  const es = new EventSource(url);
  source = es;
  const on = (type: StreamEvent["type"], fn: (event: StreamEvent) => void) =>
    es.addEventListener(type, (e) => {
      if (source === es) fn(JSON.parse((e as MessageEvent).data) as StreamEvent);
    });
  es.onopen = () => {
    connected = true;
    current ? updateChrome() : renderList();
  };
  es.onerror = () => {
    connected = false;
    current ? updateChrome() : renderList();
  };
  on("sessions", (e) => {
    if (e.type !== "sessions") return;
    sessions = e.sessions;
    current ? updateChrome() : renderList();
  });
  on("reset", (e) => {
    if (e.type === "reset" && e.address === current) upsert(e.entries, true);
  });
  on("entries", (e) => {
    if (e.type === "entries" && e.address === current) upsert(e.entries, false);
  });
}

function route(): void {
  const match = /^#\/s\/(.+)$/.exec(location.hash);
  current = match ? decodeURIComponent(match[1]!) : null;
  if (screenTimer) clearInterval(screenTimer);
  screenTimer = null;
  view = null;
  entries.clear();
  nodes.clear();
  current ? renderSessionShell() : renderList();
  connect();
}

window.addEventListener("hashchange", route);
setInterval(() => {
  if (!current) renderList();
}, 30_000);
route();
