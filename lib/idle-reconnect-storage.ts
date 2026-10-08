// 冷场重连：用户超过 X 时间没有发消息时，角色主动发一次消息。
// 计时锚定"用户最后一条消息"；角色的重连消息不重置计时，用连发计数控制；
// 用户回复后计数清零，周期重新开始。每个角色一条规则。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const IDLE_RECONNECT_RULES_KEY = "ai_phone_idle_reconnect_rules_v1";
registerKvMigration(IDLE_RECONNECT_RULES_KEY);

/** 连发上限：用户不回复时最多主动发这么多次，回复后清零 */
export const IDLE_RECONNECT_MAX_CONSECUTIVE = 3;

export type IdleReconnectRule = {
    id: string;
    characterId: string;
    sessionId: string;
    /** 沉默阈值（分钟），1 分钟 ~ 72 小时；随机区间模式下为下限 */
    intervalMinutes: number;
    /** 随机区间上限（分钟）；> intervalMinutes 时每周期在 [intervalMinutes, intervalMaxMinutes] 内随机 */
    intervalMaxMinutes?: number;
    /** 随机模式本周期的已 roll 间隔（分钟）；触发/用户回复后重 roll，避免每轮轮询抖动 */
    pendingIntervalMinutes?: number;
    /** 用户附加意图（可空） */
    intent: string;
    /** 自上次用户消息以来已连发次数 */
    consecutiveCount: number;
    /** 上次触发时刻（毫秒） */
    lastFiredAt?: number;
    /** 当前这次主动生成被用户停止后，短时间内不再重试 */
    suppressedUntil?: number;
    createdAt: number;
};

function isRule(value: unknown): value is IdleReconnectRule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<IdleReconnectRule>;
    return typeof item.id === "string"
        && typeof item.characterId === "string"
        && typeof item.sessionId === "string"
        && typeof item.intervalMinutes === "number"
        && typeof item.intent === "string"
        && typeof item.consecutiveCount === "number"
        && typeof item.createdAt === "number";
}

export function loadIdleReconnectRules(): IdleReconnectRule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(IDLE_RECONNECT_RULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(isRule) : [];
    } catch {
        return [];
    }
}

function saveRules(rules: IdleReconnectRule[]): void {
    if (typeof window === "undefined") return;
    kvSet(IDLE_RECONNECT_RULES_KEY, JSON.stringify(rules.slice(0, 100)));
}

/** 每角色一条：同角色再建即替换。 */
export function upsertIdleReconnectRule(rule: IdleReconnectRule): void {
    const rest = loadIdleReconnectRules().filter(item => item.characterId !== rule.characterId);
    saveRules([...rest, rule]);
}

export function removeIdleReconnectRule(id: string): void {
    saveRules(loadIdleReconnectRules().filter(item => item.id !== id));
}

function rollIntervalMinutes(min: number, max: number): number {
    const lo = Math.max(1, Math.round(min));
    const hi = Math.max(lo, Math.round(max));
    return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 规则是否启用了随机区间（max > min）。 */
export function isRandomIdleInterval(rule: IdleReconnectRule): boolean {
    return typeof rule.intervalMaxMinutes === "number" && rule.intervalMaxMinutes > rule.intervalMinutes;
}

/**
 * 本周期生效的沉默阈值（分钟）。随机模式下返回已 roll 的 pendingIntervalMinutes；
 * 没 roll 过（新规则/刚被清）就现场 roll 一次固化，保证 dueAt 不在轮询间漂移。
 */
export function effectiveIdleIntervalMinutes(rule: IdleReconnectRule): number {
    if (!isRandomIdleInterval(rule)) return Math.max(1, rule.intervalMinutes);
    if (typeof rule.pendingIntervalMinutes === "number" && rule.pendingIntervalMinutes >= 1) {
        return rule.pendingIntervalMinutes;
    }
    const rolled = rollIntervalMinutes(rule.intervalMinutes, rule.intervalMaxMinutes!);
    const rules = loadIdleReconnectRules();
    const stored = rules.find(item => item.id === rule.id);
    if (stored) {
        stored.pendingIntervalMinutes = rolled;
        saveRules(rules);
    }
    return rolled;
}

/** 记一次触发（本地触发或服务端触发回端合并时都调用）。 */
export function markIdleReconnectFired(id: string, firedAtMs: number): void {
    const rules = loadIdleReconnectRules();
    const rule = rules.find(item => item.id === id);
    if (!rule) return;
    if (!rule.lastFiredAt || firedAtMs > rule.lastFiredAt) {
        rule.lastFiredAt = firedAtMs;
        rule.consecutiveCount = Math.min(IDLE_RECONNECT_MAX_CONSECUTIVE, rule.consecutiveCount + 1);
        // 随机区间：清掉本周期 pending，下轮轮询重 roll —— 每次触发间隔都不同
        rule.pendingIntervalMinutes = undefined;
        saveRules(rules);
    }
}

/** 用户停止了当前这次冷场生成：不计入连发，只推迟下一次尝试。 */
export function suppressIdleReconnectUntil(id: string, untilMs: number): IdleReconnectRule | null {
    const rules = loadIdleReconnectRules();
    const rule = rules.find(item => item.id === id);
    if (!rule) return null;
    rule.suppressedUntil = Math.max(rule.suppressedUntil ?? 0, untilMs);
    saveRules(rules);
    return rule;
}

/** 用户在该会话发了消息：连发计数清零。返回被重置的规则（用于重挂预约）。 */
export function resetIdleReconnectForSession(sessionId: string): IdleReconnectRule | null {
    const rules = loadIdleReconnectRules();
    const rule = rules.find(item => item.sessionId === sessionId);
    if (!rule) return null;
    if (rule.consecutiveCount !== 0) {
        rule.consecutiveCount = 0;
    }
    rule.suppressedUntil = undefined;
    rule.pendingIntervalMinutes = undefined; // 用户回复开启新周期，随机规则重 roll
    saveRules(rules);
    return rule;
}
