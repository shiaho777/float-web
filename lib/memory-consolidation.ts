// lib/memory-consolidation.ts
// 空闲固化循环：角色在空闲时自主整理记忆——GA 的 reflection 层 + MemGPT 式自管理。
// 三件事：
//   1. 反思：把近期记忆编号喂给主对话模型，生成跨记忆高层洞察（kind=reflection，links→证据）
//   2. 性格漂移：反思附带 TRAIT 提案 → trait_shift 记忆 + PersonaState 覆盖层（全自动，driftLog 可撤销）
//   3. 去重：内容几乎相同的同 kind 条目合并（保新删旧，links 并集）——只合并不删记忆红线不破
//
// 触发：总结管线尾部（重要性积累到位自然跟上）+ 空闲调度器周期 tick。
// 兼容：全部走 saveMemoryEntry，字段可选；无任何 LLM 绑定时安静跳过。

import type { MemoryEntry } from "./memory-types";
import { memoryKindOf, effectiveSalience, isUserAuthoredMemory } from "./memory-types";
import {
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getLastConsolidatedTimestamp,
    setLastConsolidatedTimestamp,
} from "./memory-storage";
import { loadApiConfigs, loadBindingConfig, resolveAuxiliaryApiConfig, resolveBinding } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { applyTraitShift } from "./persona-state";

/** 固化水位线无活动时多久强制跑一次（毫秒）；有活动时靠总结尾部触发 */
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 参与反思的近期记忆上限 */
const REFLECTION_CANDIDATE_LIMIT = 40;
/** 反思输出上限 */
const MAX_REFLECTIONS = 3;
const MAX_TRAIT_SHIFTS = 2;
/** 去重判定阈值：归一化文本重叠度 */
const DEDUPE_SIMILARITY = 0.9;

const consolidatingSet = new Set<string>();

export type ConsolidationResult = {
    ran: boolean;
    reflections: number;
    traitShifts: number;
    deduped: number;
    error?: string;
};

/** 门控：距上次固化够久 且 期间有新记忆积累，才值得跑。 */
export async function maybeRunConsolidation(
    characterId: string,
    characterName: string,
): Promise<void> {
    if (consolidatingSet.has(characterId)) return;
    const last = getLastConsolidatedTimestamp(characterId);
    if (last && Date.now() - Date.parse(last) < MIN_INTERVAL_MS) return;

    const entries = await loadMemoryEntries(characterId);
    const fresh = last ? entries.filter(e => e.createdAt > last) : entries;
    // 新积累量太少（<4 条或累计重要性 <12）不值得一次反思调用
    const salienceSum = fresh.reduce((acc, e) => acc + effectiveSalience(e), 0);
    if (fresh.length < 4 || salienceSum < 12) {
        if (fresh.length === 0) setLastConsolidatedTimestamp(characterId, new Date().toISOString());
        return;
    }

    consolidatingSet.add(characterId);
    try {
        await runConsolidation(characterId, characterName, fresh);
    } catch (error) {
        console.warn("[MemoryConsolidation] failed:", error);
    } finally {
        consolidatingSet.delete(characterId);
    }
}

/** 对所有角色跑一遍固化门控（空闲调度器调用）。 */
export async function runConsolidationSweep(
    characters: { id: string; name: string }[],
): Promise<void> {
    for (const c of characters) {
        try {
            await maybeRunConsolidation(c.id, c.name);
        } catch { /* 单角色失败不阻塞全局 */ }
    }
}

const CONSOLIDATION_PROMPT = `你正在扮演{{char}}的内心独白系统。{{char}}刚闲下来，脑子里的记忆开始沉淀。

以下是{{char}}近期最重要的记忆（按编号列出）：
{{memories}}

请站在{{char}}的视角输出（不要输出任何其他内容）：

REFLECTION|<一句话高层洞察：这些记忆放在一起说明了什么>|EVIDENCE:<编号,逗号分隔>
（最多{{maxReflections}}条；只写真正需要跨多条记忆才能得出的结论，比如"她最近在用忙碌逃避压力"）

TRAIT|<性格维度名>|<漂移量-1到1>|<一句话描述变化>|EVIDENCE:<编号,逗号分隔>
（最多{{maxTraits}}条；仅当记忆明确显示{{char}}的性格/习惯发生了持续变化才写，如"TRAIT|对用户的依赖|0.3|吵架和好后变得更黏人|EVIDENCE:2,5"。没有就别写）`;

type ParsedReflection = { content: string; evidenceIdx: number[] };
type ParsedTrait = { key: string; delta: number; desc: string; evidenceIdx: number[] };

function parseConsolidationOutput(raw: string): { reflections: ParsedReflection[]; traits: ParsedTrait[] } {
    const reflections: ParsedReflection[] = [];
    const traits: ParsedTrait[] = [];
    const evidenceOf = (tail: string): number[] =>
        Array.from(tail.matchAll(/\d+/g)).map(m => Number(m[0])).filter(n => n > 0);
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim().replace(/^[-*]\s*/, "");
        const ref = /^REFLECTION\s*[|｜](.+?)(?:[|｜]\s*EVIDENCE\s*[:：]?\s*(.*))?$/i.exec(trimmed);
        if (ref) {
            const content = ref[1].trim();
            if (content) reflections.push({ content, evidenceIdx: evidenceOf(ref[2] ?? "") });
            continue;
        }
        const tr = /^TRAIT\s*[|｜]([^|｜]+)[|｜](-?\d*\.?\d+)[|｜](.+?)(?:[|｜]\s*EVIDENCE\s*[:：]?\s*(.*))?$/i.exec(trimmed);
        if (tr) {
            const key = tr[1].trim();
            const delta = Math.min(1, Math.max(-1, Number(tr[2]) || 0));
            const desc = tr[3].trim();
            if (key && desc && Math.abs(delta) >= 0.05) {
                traits.push({ key, delta, desc, evidenceIdx: evidenceOf(tr[4] ?? "") });
            }
        }
    }
    return { reflections: reflections.slice(0, MAX_REFLECTIONS), traits: traits.slice(0, MAX_TRAIT_SHIFTS) };
}

/** 归一化相似度：去标点+小写后的字符 bigram Jaccard；>=0.9 视为重复 */
function normalizedSimilarity(a: string, b: string): number {
    const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
    const na = norm(a);
    const nb = norm(b);
    if (!na.length || !nb.length) return 0;
    if (na === nb) return 1;
    const grams = (s: string) => {
        const set = new Set<string>();
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
    };
    const ga = grams(na);
    const gb = grams(nb);
    let inter = 0;
    for (const g of ga) if (gb.has(g)) inter++;
    return inter / (ga.size + gb.size - inter);
}

/** 相似记忆留一条：用户改正优先于自动总结；两边同类时，改正看修改时间，自动总结看创建时间。 */
function preferMemoryKeep(a: MemoryEntry, b: MemoryEntry): [MemoryEntry, MemoryEntry] {
    const aUser = isUserAuthoredMemory(a);
    const bUser = isUserAuthoredMemory(b);
    if (aUser !== bUser) return aUser ? [a, b] : [b, a];
    const stamp = (entry: MemoryEntry) => (aUser ? (entry.updatedAt || entry.createdAt) : entry.createdAt);
    return stamp(a) >= stamp(b) ? [a, b] : [b, a];
}

export async function runConsolidation(
    characterId: string,
    characterName: string,
    freshEntries?: MemoryEntry[],
): Promise<ConsolidationResult> {
    // 主对话绑定优先（与总结管线一致：反思必须用角色本体模型）
    const bindings = loadBindingConfig();
    const mainSlotApiId = resolveBinding(bindings, characterId).apiConfigId;
    const apiConfig = (mainSlotApiId ? loadApiConfigs().find(c => c.id === mainSlotApiId) : undefined)
        ?? resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { ran: false, reflections: 0, traitShifts: 0, deduped: 0, error: "未配置 API" };
    }

    const all = (await loadMemoryEntries(characterId)).filter(e => e.type === "long_term");
    const last = getLastConsolidatedTimestamp(characterId);
    const candidates = (freshEntries ?? (last ? all.filter(e => e.createdAt > last) : all))
        .filter(e => e.type === "long_term")
        .sort((a, b) => effectiveSalience(b) - effectiveSalience(a))
        .slice(0, REFLECTION_CANDIDATE_LIMIT);

    if (candidates.length < 4) {
        setLastConsolidatedTimestamp(characterId, new Date().toISOString());
        return { ran: false, reflections: 0, traitShifts: 0, deduped: 0, error: "素材不足" };
    }

    const memoriesText = candidates
        .map((e, i) => `[${i + 1}] (重要性${effectiveSalience(e)}) ${e.content}`)
        .join("\n");

    const prompt = CONSOLIDATION_PROMPT
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{memories\}\}/gi, memoriesText)
        .replace(/\{\{maxReflections\}\}/gi, String(MAX_REFLECTIONS))
        .replace(/\{\{maxTraits\}\}/gi, String(MAX_TRAIT_SHIFTS));

    const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.4 });
    if (!result.content || result.wasTruncated) {
        return { ran: false, reflections: 0, traitShifts: 0, deduped: 0, error: result.error || "空输出/截断" };
    }

    const parsed = parseConsolidationOutput(result.content);
    const now = new Date().toISOString();
    let reflectionCount = 0;
    let traitCount = 0;

    const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    const embeddingEnabled = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig!));

    const existingReflections = all.filter(e => memoryKindOf(e) === "reflection");
    const evidenceIdsFor = (idx: number[]): string[] =>
        idx.map(i => candidates[i - 1]?.id).filter((id): id is string => Boolean(id));

    for (const ref of parsed.reflections) {
        // 与已有 reflection 近重复 → 跳过（不删旧条目）
        if (existingReflections.some(e => normalizedSimilarity(e.content, ref.content) >= DEDUPE_SIMILARITY)) {
            continue;
        }
        let embedding: number[] | undefined;
        if (embeddingEnabled) {
            try {
                embedding = (await generateEmbedding(ref.content, embeddingApiConfig!)) ?? undefined;
            } catch { /* ignore */ }
        }
        const id = `mem_rf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await saveMemoryEntry({
            id,
            characterId,
            sourceApp: "chat",
            type: "long_term",
            kind: "reflection",
            content: ref.content,
            embedding,
            importance: 0.9,
            salience: 9,
            links: evidenceIdsFor(ref.evidenceIdx),
            createdAt: now,
            updatedAt: now,
            metadata: { generatedBy: "consolidation" },
        });
        existingReflections.push({ content: ref.content } as MemoryEntry);
        reflectionCount++;
    }

    for (const tr of parsed.traits) {
        const id = `mem_ts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const evidenceIds = evidenceIdsFor(tr.evidenceIdx);
        await saveMemoryEntry({
            id,
            characterId,
            sourceApp: "chat",
            type: "long_term",
            kind: "trait_shift",
            content: `性格变化：${tr.desc}（${tr.key} ${tr.delta > 0 ? "+" : ""}${tr.delta}）`,
            importance: 0.85,
            salience: 8,
            links: evidenceIds,
            createdAt: now,
            updatedAt: now,
            metadata: { generatedBy: "consolidation", traitKey: tr.key, delta: tr.delta },
        });
        applyTraitShift(characterId, {
            traitKey: tr.key,
            delta: tr.delta,
            confidence: Math.min(1, 0.3 + evidenceIds.length * 0.2),
            evidenceEntryIds: evidenceIds,
            change: `${tr.desc}（${tr.key} ${tr.delta > 0 ? "+" : ""}${tr.delta.toFixed(2)}）`,
            sourceEntryId: id,
        });
        traitCount++;
    }

    // 去重合并：同 kind 且内容近似 → 用户改正优先，否则保新删旧；links 并集留在保留的那条上
    let deduped = 0;
    const longTerm = (await loadMemoryEntries(characterId)).filter(e => e.type === "long_term");
    const byKind = new Map<string, MemoryEntry[]>();
    for (const e of longTerm) {
        const k = memoryKindOf(e);
        const list = byKind.get(k) ?? [];
        list.push(e);
        byKind.set(k, list);
    }
    const toDelete = new Set<string>();
    for (const list of byKind.values()) {
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            if (toDelete.has(a.id)) continue;
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                if (toDelete.has(b.id)) continue;
                if (normalizedSimilarity(a.content, b.content) < DEDUPE_SIMILARITY) continue;
                // 用户改过的正文不能被后写的自动总结盖掉：相似时留下改正的那条。
                const [keep, drop] = preferMemoryKeep(a, b);
                const mergedLinks = Array.from(new Set([...(keep.links ?? []), ...(drop.links ?? [])]));
                if (mergedLinks.length !== (keep.links?.length ?? 0)) {
                    keep.links = mergedLinks;
                    keep.updatedAt = now;
                    await saveMemoryEntry(keep);
                }
                toDelete.add(drop.id);
                deduped++;
            }
        }
    }
    if (toDelete.size) await deleteMemoryEntries([...toDelete]);

    setLastConsolidatedTimestamp(characterId, now);
    console.log(`[MemoryConsolidation] ${characterName}: ${reflectionCount} reflections, ${traitCount} trait shifts, ${deduped} deduped`);
    return { ran: true, reflections: reflectionCount, traitShifts: traitCount, deduped };
}
