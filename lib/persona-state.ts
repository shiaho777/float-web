// lib/persona-state.ts
// 人格状态：base persona（用户写的角色卡，永不改）+ 漂移覆盖层。
// 漂移由记忆反思全自动产生——真人不会被批准才改变性格。
// 每条漂移都带证据链（evidenceEntryIds → MemoryEntry.id），可视化页可逐条撤销。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { MemoryEntry } from "./memory-types";

const STATE_KEY = "ai_phone_persona_state_v1";
registerKvMigration(STATE_KEY);

export type PersonaTrait = {
    /** 自由标签："黏人度" "对工作的焦虑" "说话方式更软了" */
    key: string;
    /** -1..+1：相对原人设的漂移方向与强度（0=回到基线，自动清理） */
    delta: number;
    /** 0-1：证据有多硬；低置信条目先被淘汰 */
    confidence: number;
    /** 证据记忆链（MemoryEntry.id[]，多为 reflection/episode） */
    evidenceEntryIds: string[];
    since: string; // ISO
    updatedAt: string; // ISO
};

export type PersonaDriftLogEntry = {
    at: string;
    change: string;        // 人类可读描述："变得更黏人（+0.3）"
    sourceEntryId: string; // 触发它的 trait_shift 记忆条目 id
    traitKey: string;
    reverted?: boolean;
};

export type PersonaState = {
    characterId: string;
    traits: PersonaTrait[];             // 活跃漂移，上限 MAX_TRAITS
    moodBaseline?: string;              // 漂移后的常态心情一句话
    currentMood?: {
        label: string;                  // "低落" "亢奋" "烦躁"
        causeEntryId?: string;          // 诱因记忆
        until?: string;                 // ISO；过期的 currentMood 视为无效
    };
    driftLog: PersonaDriftLogEntry[];
    updatedAt: string;
};

const MAX_TRAITS = 8;
const MAX_DRIFT_LOG = 60;

type StateMap = Record<string, PersonaState>;

function loadMap(): StateMap {
    try {
        const raw = kvGet(STATE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
        return {};
    }
}

function saveMap(map: StateMap): void {
    kvSet(STATE_KEY, JSON.stringify(map));
}

export function loadPersonaState(characterId: string): PersonaState {
    const existing = loadMap()[characterId];
    if (existing) return existing;
    return { characterId, traits: [], driftLog: [], updatedAt: new Date().toISOString() };
}

export function savePersonaState(state: PersonaState): void {
    const map = loadMap();
    map[state.characterId] = { ...state, updatedAt: new Date().toISOString() };
    saveMap(map);
}

/** 应用一次性格漂移：同 key trait 合并（加权更新），新 key 追加，超限按 confidence 淘汰。
 *  全自动路径——由 trait_shift 记忆条目驱动；返回是否产生了实质变化。 */
export function applyTraitShift(
    characterId: string,
    input: {
        traitKey: string;
        delta: number;
        confidence?: number;
        evidenceEntryIds: string[];
        change: string;          // 写入 driftLog 的人类可读描述
        sourceEntryId: string;   // 触发漂移的记忆条目 id
        moodBaseline?: string;
        currentMood?: { label: string; causeEntryId?: string; until?: string };
    },
): boolean {
    const state = loadPersonaState(characterId);
    const now = new Date().toISOString();
    const delta = Math.min(1, Math.max(-1, input.delta));
    const confidence = Math.min(1, Math.max(0.1, input.confidence ?? 0.5));
    const key = input.traitKey.trim();
    if (!key || Math.abs(delta) < 0.05) return false;

    const existing = state.traits.find(t => t.key === key);
    if (existing) {
        // 加权合并：旧 delta 与提案按 confidence 加权收敛；证据链并集
        existing.delta = Math.min(1, Math.max(-1,
            existing.delta * (1 - confidence * 0.5) + delta * confidence * 0.5));
        existing.confidence = Math.min(1, existing.confidence * 0.7 + confidence * 0.5);
        existing.evidenceEntryIds = Array.from(new Set([...existing.evidenceEntryIds, ...input.evidenceEntryIds])).slice(-12);
        existing.updatedAt = now;
        // 漂移收敛回基线附近 → 视为已回到原人设，移除
        if (Math.abs(existing.delta) < 0.08) {
            state.traits = state.traits.filter(t => t !== existing);
        }
    } else {
        state.traits.push({
            key,
            delta,
            confidence,
            evidenceEntryIds: [...input.evidenceEntryIds],
            since: now,
            updatedAt: now,
        });
        if (state.traits.length > MAX_TRAITS) {
            state.traits.sort((a, b) => b.confidence - a.confidence);
            state.traits = state.traits.slice(0, MAX_TRAITS);
        }
    }

    if (input.moodBaseline?.trim()) state.moodBaseline = input.moodBaseline.trim();
    if (input.currentMood?.label?.trim()) state.currentMood = input.currentMood;

    state.driftLog.push({
        at: now,
        change: input.change,
        sourceEntryId: input.sourceEntryId,
        traitKey: key,
    });
    if (state.driftLog.length > MAX_DRIFT_LOG) {
        state.driftLog = state.driftLog.slice(-MAX_DRIFT_LOG);
    }
    savePersonaState(state);
    return true;
}

/** 撤销一条漂移日志：把对应 trait 回滚到漂移前（近似——直接移除该 trait 而非精确复原）。
 *  只处理"当前仍活跃"的 trait；已自然消退的记录标记 reverted 仅供展示。 */
export function revertTraitShift(characterId: string, driftLogIndex: number): boolean {
    const state = loadPersonaState(characterId);
    const log = state.driftLog[driftLogIndex];
    if (!log || log.reverted) return false;
    log.reverted = true;
    state.traits = state.traits.filter(t => t.key !== log.traitKey);
    savePersonaState(state);
    return true;
}

/** prompt 注入用的人格漂移覆盖层文本；无漂移时返回空串（调用方跳过注入）。 */
export function buildPersonaDriftOverlay(characterId: string, evidenceLookup?: (id: string) => MemoryEntry | undefined): string {
    const state = loadPersonaState(characterId);
    const lines: string[] = [];

    const activeTraits = state.traits.filter(t => Math.abs(t.delta) >= 0.08);
    if (activeTraits.length > 0) {
        const parts = activeTraits.map(t => {
            const dir = t.delta > 0 ? "更" : "不那么";
            const ev = evidenceLookup && t.evidenceEntryIds.length
                ? evidenceLookup(t.evidenceEntryIds[0])?.content.slice(0, 24)
                : undefined;
            return ev ? `${dir}「${t.key}」（源于：${ev}…）` : `${dir}「${t.key}」`;
        });
        lines.push(`近期性格变化：${parts.join("；")}`);
    }

    if (state.moodBaseline) lines.push(`最近的常态心情：${state.moodBaseline}`);
    const mood = state.currentMood;
    if (mood && (!mood.until || Date.parse(mood.until) > Date.now())) {
        lines.push(`此刻心情：${mood.label}`);
    }
    return lines.length ? lines.join("\n") : "";
}
