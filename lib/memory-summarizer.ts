// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT, DEFAULT_SUMMARIZATION_PROMPT_V2 } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { loadApiConfigs, loadBindingConfig, resolveAuxiliaryApiConfig, resolveBinding } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";
import { maybeRunConsolidation } from "./memory-consolidation";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

export type ParsedSummarizationOutput = {
    summary: string;
    episodes: { salience: number; content: string }[];
};

/** 解析 v2 总结输出：SUMMARY: 段 + EPISODE|<1-10>|<内容> 行。
 *  旧格式（纯文本摘要）/解析失败 → 整段当 summary，episodes 为空。 */
export function parseSummarizationOutput(raw: string): ParsedSummarizationOutput {
    const text = raw.trim();
    const episodes: { salience: number; content: string }[] = [];
    const episodeRe = /^\s*(?:[-*]\s*)?EPISODE\s*[|｜]\s*(\d{1,2})\s*[|｜]\s*(.+)\s*$/gim;
    let match: RegExpExecArray | null;
    let firstEpisodeStart = -1;
    while ((match = episodeRe.exec(text)) !== null) {
        if (firstEpisodeStart === -1) firstEpisodeStart = match.index;
        const salience = Math.min(10, Math.max(1, Number(match[1]) || 1));
        const content = match[2].trim();
        if (content) episodes.push({ salience, content });
    }

    // SUMMARY: 段 = "SUMMARY:" 到 "EPISODES:" 或第一条 EPISODE 行之间
    const summaryMatch = /SUMMARY\s*[:：]/i.exec(text);
    let summary = "";
    if (summaryMatch) {
        const start = summaryMatch.index + summaryMatch[0].length;
        const tail = text.slice(start);
        const episodesHeader = /^\s*EPISODES?\s*[:：]?\s*$/im.exec(tail);
        const episodeLineIdx = firstEpisodeStart > start ? firstEpisodeStart - start : -1;
        const cutAt = episodesHeader
            ? episodesHeader.index
            : (episodeLineIdx >= 0 ? episodeLineIdx : tail.length);
        summary = tail.slice(0, cutAt).trim();
    }
    if (!summary) {
        // 无结构标记：剥掉 EPISODE 行后整体当摘要
        summary = text.replace(episodeRe, "").replace(/EPISODES\s*[:：]?\s*$/im, "").trim();
    }
    if (!summary) summary = text;
    return { summary, episodes };
}

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // API 解析：角色主对话绑定优先（重要性评分/事件抽取要跟角色本体同模型），
    // 回落到辅助「记忆总结」绑定——两条路都没有才报错。
    const bindings = loadBindingConfig();
    const mainSlotApiId = resolveBinding(bindings, characterId).apiConfigId;
    const apiConfig = (mainSlotApiId ? loadApiConfigs().find(c => c.id === mainSlotApiId) : undefined)
        ?? resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在配置绑定中设置主对话或辅助记忆 API）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    // Use user-editable prompt template from config, with placeholder substitution.
    // 存量用户若还存着 v1 默认模板文本，自动升级到 v2（episode 抽取格式）。
    let promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT_V2;
    if (promptTemplate === DEFAULT_SUMMARIZATION_PROMPT.trim()) {
        promptTemplate = DEFAULT_SUMMARIZATION_PROMPT_V2;
    }
    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    // Call LLM for summarization — compatible with all providers
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: summaryPrompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    const rawOutput = result.content;
    const parsed = parseSummarizationOutput(rawOutput);
    const summary = parsed.summary;

    // Generate embedding for the summary (only if vector recall is enabled)
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const emb = await generateEmbedding(summary, embeddingApiConfig);
            if (emb) embedding = emb;
        } catch { /* ignore */ }
    }

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));
    const allSourceMessageIds = Array.from(new Set(
        allEntries.map(entry => entry.id).filter(Boolean),
    ));

    // Save as long-term memory (kind=summary，旧格式输出也走这里，episodes 为空即等价旧行为)
    const now = new Date().toISOString();
    const summaryId = `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const longTermEntry: MemoryEntry = {
        id: summaryId,
        characterId,
        sourceApp: dominantSource as MemoryEntry["sourceApp"],
        type: "long_term",
        kind: "summary",
        content: summary,
        embedding,
        importance: 0.8,
        createdAt: now,
        updatedAt: now,
        sourceMessageIds: allSourceMessageIds.length ? allSourceMessageIds : undefined,
        metadata: {
            summarizedEvents: allEntries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(longTermEntry);

    // Episode 条目：每条一句话事件 + LLM 重要性评分，links 指回 summary。
    // 上限 8 条（prompt 约束），解析失败的行已被 parser 丢掉。
    for (const [index, episode] of parsed.episodes.slice(0, 8).entries()) {
        let episodeEmbedding: number[] | undefined;
        if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
            try {
                const emb = await generateEmbedding(episode.content, embeddingApiConfig);
                if (emb) episodeEmbedding = emb;
            } catch { /* ignore */ }
        }
        await saveMemoryEntry({
            id: `mem_ep_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
            characterId,
            sourceApp: dominantSource as MemoryEntry["sourceApp"],
            type: "long_term",
            kind: "episode",
            content: episode.content,
            embedding: episodeEmbedding,
            importance: Math.min(1, Math.max(0.1, episode.salience / 10)),
            salience: episode.salience,
            links: [summaryId],
            createdAt: now,
            updatedAt: now,
            sourceMessageIds: allSourceMessageIds.length ? allSourceMessageIds : undefined,
            metadata: { timeSpan: `${earliest} ~ ${latest}` },
        });
    }

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);

    // 空闲固化：新记忆积累够重要时后台反思+性格漂移（自身有水位线门控，不怕频繁调用）
    void maybeRunConsolidation(characterId, characterName).catch((error) => {
        console.warn("[MemorySummarizer] consolidation tail failed:", error);
    });

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → 1 long-term memory`);
    return { success: true };
}
