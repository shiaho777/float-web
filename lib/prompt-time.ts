import { loadChatAppSettings } from "./chat-storage";
import { formatZonedPromptTimestamp, getSystemTimeZone } from "./character-time";

const PROMPT_TIMESTAMP_PATTERN = "\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}";
const PROMPT_TIMESTAMP_WITH_ZONE_PATTERN = `${PROMPT_TIMESTAMP_PATTERN}(?:\\s+[^)）\\]]+)?`;
const PROMPT_EVENT_LABEL_PATTERN = [
  "私聊",
  "群聊「[^」]*」",
  "朋友圈",
  "事件",
  "跑团游戏",
  "小游戏",
  "便签墙",
  "小红书",
  "访谈",
  "共创",
  "小剧场",
  "查手机",
  "共读",
].join("|");

export type PromptTimestampOptions = {
  timeZone?: string;
  includeTimeZone?: boolean;
};

export function getPromptTimestampOptionsForTimeContext(
  context: { hasDifference: boolean; systemTimeZone: string },
): PromptTimestampOptions | undefined {
  return context.hasDifference
    ? { timeZone: context.systemTimeZone, includeTimeZone: true }
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolvePromptTimeAware(value?: boolean): boolean {
  if (typeof value === "boolean") return value;
  return loadChatAppSettings().timeAware !== false;
}

export function formatPromptTimestamp(isoStr: string, options?: PromptTimestampOptions): string {
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) return "";
  if (options?.timeZone || options?.includeTimeZone) {
    const timeZone = options.timeZone || getSystemTimeZone();
    return `(${formatZonedPromptTimestamp(date, timeZone, options.includeTimeZone === true)})`;
  }
  const pad = (n: number) => n < 10 ? `0${n}` : `${n}`;
  return `(${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())})`;
}

export function formatPromptEventLabel(label: string, timestamp: string, timeAware?: boolean, timestampOptions?: PromptTimestampOptions): string {
  const enabled = resolvePromptTimeAware(timeAware);
  if (!enabled) return `[${label}]`;
  const formatted = formatPromptTimestamp(timestamp, timestampOptions);
  return formatted ? `[${label} ${formatted}]` : `[${label}]`;
}

export function stripPromptEventTimestamps(text: string): string {
  if (!text) return text;
  let next = text.replace(
    new RegExp(`(^|\\n)\\[(${PROMPT_EVENT_LABEL_PATTERN})\\s*[（(]${PROMPT_TIMESTAMP_WITH_ZONE_PATTERN}[)）]\\]`, "g"),
    "$1[$2]",
  );
  next = next.replace(
    new RegExp(`(^|\\n)(\\s*💬\\s*)[（(]${PROMPT_TIMESTAMP_WITH_ZONE_PATTERN}[)）]\\s*`, "g"),
    "$1$2",
  );
  next = next.replace(
    new RegExp(`(^|\\n)(\\s*↳\\s*)[（(]${PROMPT_TIMESTAMP_WITH_ZONE_PATTERN}[)）]\\s*`, "g"),
    "$1$2",
  );
  return next;
}

/**
 * 间隔感知提示：算出"对方这条消息距你们上一次说话过了多久"，把差值直接喂给模型。
 *
 * 模型不擅长从历史消息的逐条时间戳里做减法——典型错位：用户 11 点说"快去吃饭"，
 * 15 点再说话时模型回"好的我马上吃"，因为它没意识到那顿饭早该吃完了。
 * 在末位注入已算好的差值 + 明确的语义指令，让它按"此刻"接话而不是按"刚说完"接话。
 *
 * 只在前一条消息与最新一条消息之间差值 ≥30 分钟时返回提示；连续对话不注入。
 */
export function buildTurnGapNote(
    history: Array<{ createdAt?: string }>,
    options?: PromptTimestampOptions,
): string | null {
    let latestTs = "";
    let prevTs = "";
    for (let i = history.length - 1; i >= 0; i--) {
        const ts = history[i]?.createdAt;
        if (!ts || isNaN(new Date(ts).getTime())) continue;
        if (!latestTs) latestTs = ts;
        else { prevTs = ts; break; }
    }
    if (!latestTs || !prevTs) return null;
    const gapMs = new Date(latestTs).getTime() - new Date(prevTs).getTime();
    if (gapMs < 30 * 60 * 1000) return null;

    const min = Math.round(gapMs / 60000);
    let gapText: string;
    if (min < 60) gapText = `${min} 分钟`;
    else if (min < 60 * 24) {
        const h = Math.floor(min / 60);
        gapText = min % 60 ? `${h} 小时 ${min % 60} 分钟` : `${h} 小时`;
    } else {
        const d = Math.floor(min / 1440);
        const h = Math.floor((min % 1440) / 60);
        gapText = h ? `${d} 天 ${h} 小时` : `${d} 天`;
    }
    const lastLabel = formatPromptTimestamp(prevTs, options) || prevTs;
    return [
        `[时间流逝提示] 这条消息距你们上一次说话已过去约 ${gapText}（上次说话 ${lastLabel}）。`,
        "请把这段时间当作真实流逝：之前提到要做的事（吃饭、出门、睡觉、上课、见面等）到现在应该已经发生或结束；",
        "回复请符合此刻的时间与状态——该吃完的说吃完了，该到家的说到家了，不要当成上一轮刚刚说完来接话。",
    ].join(" ");
}

export function formatStoredPromptEventContent(
  content: string,
  options: { label: string; timestamp: string; timeAware?: boolean; timestampOptions?: PromptTimestampOptions },
): string {
  const enabled = resolvePromptTimeAware(options.timeAware);
  if (!enabled) return stripPromptEventTimestamps(content);

  const formatted = formatPromptTimestamp(options.timestamp, options.timestampOptions);
  if (!formatted) return content;

  const labelPattern = escapeRegExp(options.label);
  const timestampedHead = new RegExp(`^\\[${labelPattern}\\s*[（(]${PROMPT_TIMESTAMP_WITH_ZONE_PATTERN}[)）]\\]`);
  if (timestampedHead.test(content)) return content.replace(timestampedHead, `[${options.label} ${formatted}]`);

  return content.replace(new RegExp(`^\\[${labelPattern}\\]`), `[${options.label} ${formatted}]`);
}
