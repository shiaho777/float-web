// Ask a character to sit with an ABC score: listen, write one, or revise one.
// Uses the music binding, so the persona, preset, and memory are the character's.

import { loadCharacters } from "./character-storage";
import {
    loadApiConfigs,
    loadBindingConfig,
    loadPresets,
    loadRegexes,
    loadWorldBooks,
    resolveBinding,
    resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { sendLLMRequest } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { describeTune, extractAbcFromReply, extractSpokenReply } from "./abc-score";
import { recordAbcSession, type AbcSessionMode } from "./abc-listen-memory";

export type AbcTurnResult = {
    mode: AbcSessionMode;
    prose: string;
    abc: string | null;
    title: string;
};

const SCORE_CHAR_LIMIT = 24_000;

export async function askCharacterAboutScore(input: {
    characterId: string;
    mode: AbcSessionMode;
    scoreAbc: string;
    note: string;
    signal?: AbortSignal;
}): Promise<AbcTurnResult> {
    const character = loadCharacters().find(item => item.id === input.characterId);
    if (!character) throw new Error("找不到这个角色。");

    const { apiConfig, preset, worldBooks, regexes } = resolveMusicConfigs(input.characterId);
    if (!apiConfig) {
        throw new Error("这个角色还没接上模型。到设置里，给音乐或全局选一个 API。");
    }

    const userIdentity = resolveUserIdentity(input.characterId, "music");
    const userName = userIdentity?.name?.trim() || "用户";
    const memConfig = loadMemoryConfig();
    const { recentBlocks, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(character.id, "music", {
        userName,
        history: [],
    });
    const [memories, coreMemories] = await Promise.all([
        retrieveMemoriesForPrompt(character.id, wbActivationContext, memConfig).catch(() => null),
        retrieveCoreMemoriesForPrompt(character.id, memConfig).catch(() => null),
    ]);

    const messages = assemblePromptPayload({
        character,
        history: [],
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "music",
        appTags: ["music"],
        scheduleSummary: buildCalendarScheduleMarker("character", character.id, getWeekStartIso(new Date())),
        coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
        longTermMemories: memories ? formatLongTermMemories(memories) : "",
        worldBookActivationContext: wbActivationContext,
        recentBlocks,
        unifiedRecentItems,
    });
    const current = describeTune(input.scoreAbc);
    messages.push({
        role: "system",
        content: sceneSystem(input.mode, character.name, userName),
    });
    messages.push({
        role: "user",
        content: sceneUser(input.mode, input.scoreAbc, input.note, current.title),
    });

    const raw = await sendLLMRequest(apiConfig, preset, messages, regexes, {
        characterName: character.name,
        userName,
    }, {
        appId: "music",
        appTags: ["music"],
        signal: input.signal,
    });

    const prose = extractSpokenReply(raw);
    const abc = input.mode === "listen" ? null : extractAbcFromReply(raw);
    const title = abc ? describeTune(abc).title : current.title;
    recordAbcSession({
        characterId: character.id,
        mode: input.mode,
        title: title || current.title || "未命名",
        prose,
        userName,
    });
    return { mode: input.mode, prose, abc, title };
}

function resolveMusicConfigs(characterId: string): {
    apiConfig: ApiConfig | null;
    preset: PresetConfig | null;
    worldBooks: WorldBookConfig[];
    regexes: RegexConfig[];
} {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "music");
    const apiConfigs = loadApiConfigs();
    const apiConfig = apiConfigs.find(item => item.id === slot.apiConfigId) ?? apiConfigs[0] ?? null;
    const presets = loadPresets();
    let preset = slot.presetId ? presets.find(item => item.id === slot.presetId) ?? null : null;
    if (!preset) preset = presets.find(item => item.builtIn) ?? null;
    const allBooks = loadWorldBooks();
    const worldBooks = (slot.worldBookIds || [])
        .map(id => allBooks.find(item => item.id === id))
        .filter((item): item is WorldBookConfig => Boolean(item));
    const allRegexes = loadRegexes();
    const regexes = (slot.regexIds || [])
        .map(id => allRegexes.find(item => item.id === id))
        .filter((item): item is RegexConfig => Boolean(item));
    return { apiConfig, preset, worldBooks, regexes };
}

function sceneSystem(mode: AbcSessionMode, name: string, userName: string): string {
    if (mode === "listen") {
        return [
            `${userName}把谱架上的曲子放给你听。你是${name}，人就在旁边。`,
            "ABC 是记谱，不是一段录音。先在心里把旋律过一遍，再开口。",
            "用你平时说话的样子谈这首曲子：哪里顺，哪里别扭，它让你想起什么。一段话就够。",
            "不要交新的谱，不要改谱，不要讲解符号，也不要说自己是程序。",
        ].join("\n");
    }
    if (mode === "write") {
        return [
            `${userName}想让你写一首新曲子，用 ABC 记谱。你是${name}。`,
            "先用一两句说你想写什么，然后只给一个 abc 代码块。",
            "代码块里是完整的一首：要有 X:、T:、M:、L:、Q:、K:，接着是旋律。",
            "大约八到十六小节，能真的唱出来。调子和拍子你自己定，但要自洽。",
            "不要写第二首，不要在代码块里夹说明。",
        ].join("\n");
    }
    return [
        `${userName}想让你改谱架上这一首。你是${name}。`,
        "先用一两句说你动了哪里，然后给一个 abc 代码块。",
        "代码块里是改完的整首，不是几小节补丁。保留原来的 X:。标题若改了，就改 T:。",
        "不要另写一首。",
    ].join("\n");
}

function sceneUser(mode: AbcSessionMode, scoreAbc: string, note: string, title: string): string {
    const wish = note.trim().slice(0, 500);
    const score = clipScore(scoreAbc);
    if (mode === "listen") {
        return [
            wish ? `听的时候帮我留意：${wish}` : "听听这首，然后告诉我你的感觉。",
            "",
            `《${title || "未命名"}》`,
            "```abc",
            score || "（谱架上是空的）",
            "```",
        ].join("\n");
    }
    if (mode === "write") {
        const ask = wish || "按你自己的性子，写一首短的。";
        const reference = score
            ? `\n\n谱架上现在有一首《${title || "未命名"}》，那只是参考，别照抄，除非我明说要在它上面改。\n\`\`\`abc\n${score}\n\`\`\``
            : "";
        return `${ask}${reference}`;
    }
    const ask = wish || "把它改得更像你会写的样子，但别把曲子改没了。";
    return [
        ask,
        "",
        `现在这首是《${title || "未命名"}》。`,
        "```abc",
        score || "（谱架上是空的）",
        "```",
    ].join("\n");
}

function clipScore(abc: string): string {
    const trimmed = abc.trim();
    if (trimmed.length <= SCORE_CHAR_LIMIT) return trimmed;
    return `${trimmed.slice(0, SCORE_CHAR_LIMIT)}\n% 后面还有，这里先截断`;
}
