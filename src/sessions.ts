// How statuses group on the phone, and the order of the session list. Pure; the app imports it too.
// @see docs/herdr-reader.md

import type { SessionSummary, TerminalStatus } from "./types.ts";

export type Group = "waiting" | "working" | "ended";

/** waiting: something for the operator to look at (approval, an unseen answer, an error). */
export const GROUP_OF: Record<TerminalStatus, Group> = {
  blocked: "waiting",
  done: "waiting",
  error: "waiting",
  working: "working",
  idle: "ended",
  unknown: "ended",
};

export const GROUPS: readonly Group[] = ["waiting", "working", "ended"];

export const GROUP_LABEL: Record<Group, string> = { waiting: "입력 기다림", working: "작업 중", ended: "끝남" };

export const STATUS_LABEL: Record<TerminalStatus, string> = {
  blocked: "승인 필요",
  done: "새 답변",
  error: "오류",
  working: "작업 중",
  idle: "대기",
  unknown: "상태 없음",
};

/** Agent sessions before other terminals, then waiting, working, ended, newest first within each. */
export function orderSessions(sessions: SessionSummary[]): SessionSummary[] {
  const rank = (s: SessionSummary) => (s.agent ? 0 : 3) + GROUPS.indexOf(GROUP_OF[s.status]);
  return [...sessions].sort((a, b) => rank(a) - rank(b) || b.updatedMs - a.updatedMs);
}
