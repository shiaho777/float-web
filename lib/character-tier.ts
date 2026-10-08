// lib/character-tier.ts
// 主角 / 配角（NPC）戏份分层：
//   有效层级 = character.tier（显式写入）→ 缺省按「配角」tag 推断 → 否则主角。
//   用户在角色卡里切换层级会写 tier + tierPinned=true，之后评估不再动它。
//   未钉住的角色由互动分自动驱动：
//     · 配角近 14 天加权互动分 ≥ 阈值 → 即时升主角（一见钟情：聊得密/打过电话立竿见影）
//     · 主角 30 天零互动且建档满 30 天 → 定期评估降为配角（交情淡了就退回背景板）
//   互动信号：私聊用户消息(+1) / 朋友圈回复(+2) / 语音视频通话(+4)。
//   每次自动变更弹 global-notice 告知，角色卡里可随时手动改回。

import { kvGet, kvSet } from "./kv-db";
import { loadCharacters, saveCharacters } from "./character-storage";

import type { Character } from "./character-types";

export const NPC_TAG = "配角";
export type CharacterTier = "main" | "npc";
type TierEventKind = "message" | "moment" | "call";

const STATS_KEY = "char_tier_stats_v1";
const LAST_EVAL_KEY = "char_tier_last_eval_v1";
const KEEP_MS = 45 * 24 * 3600_000;        // 事件保留窗口（须覆盖降级判定窗）
const PROMOTE_WINDOW_MS = 14 * 24 * 3600_000;
const PROMOTE_SCORE = 6;
const DEMOTE_IDLE_MS = 30 * 24 * 3600_000;
const EVAL_INTERVAL_MS = 12 * 3600_000;
const MAX_EVENTS_PER_CHAR = 240;

const EVENT_WEIGHTS: Record<TierEventKind, number> = { message: 1, moment: 2, call: 4 };

type TierEvent = { t: number; w: number };
type TierStatsMap = Record<string, TierEvent[]>;

// ── 层级读取 ─────────────────────────────────────────────

export function getCharacterTier(char: Character): CharacterTier {
    if (char.tier === "main" || char.tier === "npc") return char.tier;
    return char.tags?.includes(NPC_TAG) ? "npc" : "main";
}

export function isNpcCharacter(char: Character): boolean {
    return getCharacterTier(char) === "npc";
}

/** 主角 = 全量生成的那批；配角 = 批量简版/后台默认跳过的那批 */
export function partitionByTier<T extends Character>(chars: T[]): { mains: T[]; npcs: T[] } {
    const mains: T[] = [];
    const npcs: T[] = [];
    for (const c of chars) (isNpcCharacter(c) ? npcs : mains).push(c);
    return { mains, npcs };
}

// ── 戏份统计 ─────────────────────────────────────────────

function loadStats(): TierStatsMap {
    try {
        const raw = kvGet(STATS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== "object" || !parsed) return {};
        return parsed as TierStatsMap;
    } catch {
        return {};
    }
}

function saveStats(stats: TierStatsMap): void {
    kvSet(STATS_KEY, JSON.stringify(stats));
}

function trimEvents(events: TierEvent[], now: number): TierEvent[] {
    const cutoff = now - KEEP_MS;
    const kept = events.filter(e => e.t >= cutoff);
    return kept.length > MAX_EVENTS_PER_CHAR ? kept.slice(-MAX_EVENTS_PER_CHAR) : kept;
}

/** 近 windowMs 的加权互动分 */
export function recentInteractionScore(characterId: string, windowMs = PROMOTE_WINDOW_MS): number {
    const events = loadStats()[characterId];
    if (!events?.length) return 0;
    const cutoff = Date.now() - windowMs;
    return events.reduce((sum, e) => sum + (e.t >= cutoff ? e.w : 0), 0);
}

function latestInteractionAt(characterId: string): number {
    const events = loadStats()[characterId];
    return events?.length ? events[events.length - 1].t : 0;
}

function notify(message: string): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("global-notice", { detail: message }));
}

/** 写入层级。pinned=true 表示用户手动钉住（不再自动调整）。 */
export function setCharacterTier(characterId: string, tier: CharacterTier, pinned: boolean): void {
    const chars = loadCharacters();
    const idx = chars.findIndex(c => c.id === characterId);
    if (idx === -1) return;
    chars[idx] = { ...chars[idx], tier, tierPinned: pinned };
    saveCharacters(chars);
}

// ── 互动埋点 ─────────────────────────────────────────────

/**
 * 记录一次用户主动互动（私聊消息 / 朋友圈回复 / 通话）。
 * 配角累计到阈值当场升主角——一见钟情就是这么发生的。
 */
export function recordUserInteraction(characterId: string, kind: TierEventKind): void {
    if (!characterId) return;
    const now = Date.now();
    const stats = loadStats();
    const events = stats[characterId] ?? [];
    events.push({ t: now, w: EVENT_WEIGHTS[kind] });
    stats[characterId] = trimEvents(events, now);
    saveStats(stats);

    const char = loadCharacters().find(c => c.id === characterId);
    if (!char || char.tierPinned || getCharacterTier(char) !== "npc") return;
    if (recentInteractionScore(characterId) >= PROMOTE_SCORE) {
        setCharacterTier(characterId, "main", false);
        notify(`「${char.name}」最近戏份变多，已升为主角（角色卡里可改回）`);
    }
}

// ── 定期评估（降级 + 兜底升级）──────────────────────────────

/** 每 12h 最多跑一次；main-app 水合后调用 */
export function evaluateTierAdjustments(): void {
    if (typeof window === "undefined") return;
    const now = Date.now();
    const last = Number(kvGet(LAST_EVAL_KEY) || 0);
    if (now - last < EVAL_INTERVAL_MS) return;
    kvSet(LAST_EVAL_KEY, String(now));

    const chars = loadCharacters();
    let dirty = false;
    const promoted: string[] = [];
    const demoted: string[] = [];

    for (const char of chars) {
        if (char.tierPinned) continue;
        const tier = getCharacterTier(char);
        if (tier === "npc") {
            // 兜底升级：正常路径在 recordUserInteraction 里即时触发，
            // 这里兜住统计早于功能上线/事件被截断漏判的情况。
            if (recentInteractionScore(char.id) >= PROMOTE_SCORE) {
                char.tier = "main";
                promoted.push(char.name);
                dirty = true;
            }
            continue;
        }
        // 主角降级：30 天零互动。建档不满 30 天的新角色不降（还没机会互动）。
        const createdAt = Date.parse(char.createdAt || "") || 0;
        if (now - createdAt < DEMOTE_IDLE_MS) continue;
        const lastSeen = latestInteractionAt(char.id);
        if (lastSeen && now - lastSeen < DEMOTE_IDLE_MS) continue;
        char.tier = "npc";
        demoted.push(char.name);
        dirty = true;
    }

    if (dirty) saveCharacters(chars);
    if (promoted.length) notify(`「${promoted.join("」「")}」最近戏份变多，已升为主角`);
    if (demoted.length) notify(`「${demoted.join("」「")}」最近没什么戏份，已标记为配角（角色卡里可改回）`);
}
