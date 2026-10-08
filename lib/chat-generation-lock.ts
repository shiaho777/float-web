// lib/chat-generation-lock.ts
// 「这个会话的房间里正在生成回复」的跨模块共享锁。
// 原本定义在 chat-room.tsx 内部，后台主动消息（追问/冷场重连等）看不见它，
// 会出现房间一轮 + 后台一轮并发双写。抽出来让 follow-up-service 也能避让。

import { kvGet, kvRemove, kvSet } from "./kv-db";

export const GENERATING_PREFIX = "chat-generating:";
const GENERATING_LOCK_TTL_MS = 5 * 60 * 1000;

export function generationLockKey(sessionId: string): string {
    return GENERATING_PREFIX + sessionId;
}

export function setGenerationLock(sessionId: string): void {
    kvSet(generationLockKey(sessionId), JSON.stringify({ startedAt: Date.now() }));
}

export function clearGenerationLock(sessionId: string): void {
    kvRemove(generationLockKey(sessionId));
}

export function hasActiveGenerationLock(sessionId: string): boolean {
    const key = generationLockKey(sessionId);
    const raw = kvGet(key);
    if (!raw) return false;
    let startedAt = 0;
    try {
        const parsed = JSON.parse(raw);
        startedAt = Number(parsed?.startedAt) || 0;
    } catch {
        startedAt = 0;
    }
    if (!startedAt || Date.now() - startedAt > GENERATING_LOCK_TTL_MS) {
        kvRemove(key);
        return false;
    }
    return true;
}
