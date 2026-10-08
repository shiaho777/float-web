// lib/chat-auto-translate.ts
// 双语兜底:会话开了「双语翻译」但模型掉格式(没输出 原文|译文)时,
// 自动用「思维链翻译」辅助 API 补译,写进 mediaData.manualTranslation ——
// 与长按菜单「翻译」同一渲染通路,气泡照常出「中文」折叠块。
//
// 由回复落库方调用并带起始时间戳,只补本轮新增的 assistant 文本气泡:
//   - 房间前台:两条生成路径的 finally 里各调一次
//   - 后台主动消息:saveBackgroundCompletionRounds 收尾处统一调一次
// 按会话排队串行,避免多路回复把翻译 API 打爆。

import {
    loadChatMessages, loadChatSessions, updateMessageMediaData,
    type ChatMessage,
} from "./chat-storage";
import { isMostlyChineseText, splitBilingualText } from "./bilingual-text";
import { translateChatMessageText } from "./message-translate";
import { resolveAuxiliaryApiConfig } from "./settings-storage";

// 复用现成的「消息已更新」事件——聊天室/会话列表本来就在监听，无需新增订阅方
const MESSAGES_UPDATED_EVENT = "chat-messages-updated";

// 可补译的气泡类型:纯文本 + 引用回复(content 是回复正文);其余富媒体一律跳过
const TRANSLATABLE_MEDIA_TYPES = new Set([undefined, "text", "quote"]);

/** 需不需要补译:非空且不算"看起来是中文" → 外语(共享判定与通话/TTS 一致) */
function looksNonChinese(text: string): boolean {
    return Boolean(text.trim()) && !isMostlyChineseText(text);
}

function needsAutoTranslation(msg: ChatMessage): boolean {
    if (msg.role !== "assistant") return false;
    if (!TRANSLATABLE_MEDIA_TYPES.has(msg.mediaType)) return false;
    const content = (msg.content || "").trim();
    if (!content) return false;
    if (msg.mediaData?.manualTranslation) return false;        // 已有译文(手动或上次兜底)
    if (splitBilingualText(content)) return false;             // 模型正常出了双语
    return looksNonChinese(content);
}

async function runOnce(sessionId: string, sinceMs: number): Promise<void> {
    const session = loadChatSessions().find(s => s.id === sessionId);
    if (!session?.bilingualTranslationEnabled) return;
    // 没配翻译 API(辅助槽位或全局默认都没有)时静默跳过——用户没翻译后端可用,不是错误
    if (!resolveAuxiliaryApiConfig("reasoningTranslateApiConfigId")) return;

    const cutoff = new Date(Math.max(0, sinceMs - 5_000)).toISOString();
    const targets = loadChatMessages(sessionId)
        .filter(m => m.createdAt >= cutoff && needsAutoTranslation(m));
    if (targets.length === 0) return;

    for (const msg of targets) {
        const res = await translateChatMessageText(msg.content).catch(() => ({ error: "fail" as string }));
        if (!("content" in res) || !res.content) continue;
        // 写库前重新读一遍:等待期间可能已被手动翻译或编辑,mediaData 取最新再合
        const fresh = loadChatMessages(sessionId).find(m => m.id === msg.id);
        if (!fresh || !needsAutoTranslation(fresh)) continue;
        updateMessageMediaData(msg.id, { ...(fresh.mediaData ?? {}), manualTranslation: res.content });
    }
    window.dispatchEvent(new CustomEvent(MESSAGES_UPDATED_EVENT, { detail: { sessionId } }));
}

const sessionQueues = new Map<string, Promise<void>>();

/** 排进该会话的翻译队列。fire-and-forget,绝不阻塞回复主流程。 */
export function autoTranslateUnbilingualReplies(sessionId: string, sinceMs: number): void {
    const prev = sessionQueues.get(sessionId) ?? Promise.resolve();
    const task = prev.then(() => runOnce(sessionId, sinceMs)).catch(err => {
        console.warn("[autoTranslate] failed:", err);
    });
    sessionQueues.set(sessionId, task);
    void task.finally(() => {
        if (sessionQueues.get(sessionId) === task) sessionQueues.delete(sessionId);
    });
}
