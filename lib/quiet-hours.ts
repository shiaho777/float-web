import { kvGet, kvSet, kvRemove } from "./kv-db";

// ── 安静时段：时段内不触发"角色主动"类本地任务（追问/定时唤醒/经期关怀），
//    不影响普通回复。格式 "23:00-08:00"，空 = 不启用 ──

const QUIET_HOURS_KV = "push_quiet_hours_v1";

export function loadPushQuietHours(): string {
    if (typeof window === "undefined") return "";
    return (kvGet(QUIET_HOURS_KV) || "").trim();
}

export function savePushQuietHours(value: string): void {
    if (typeof window === "undefined") return;
    const trimmed = value.trim();
    if (trimmed) kvSet(QUIET_HOURS_KV, trimmed);
    else kvRemove(QUIET_HOURS_KV);
}

/** 某个时间点是否落在安静时段内（支持跨零点，如 23:00-08:00）。格式非法视为未启用。 */
function isTimeInQuietRange(setting: string, atMs: number): boolean {
    const match = setting.match(/^(\d{1,2}):(\d{2})\s*[-~—]\s*(\d{1,2}):(\d{2})$/);
    if (!match) return false;
    const startMinutes = Number(match[1]) * 60 + Number(match[2]);
    const endMinutes = Number(match[3]) * 60 + Number(match[4]);
    if (startMinutes === endMinutes) return false;
    const date = new Date(atMs);
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    return startMinutes < endMinutes
        ? nowMinutes >= startMinutes && nowMinutes < endMinutes
        : nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function isWithinPushQuietHours(atMs: number): boolean {
    return isTimeInQuietRange(loadPushQuietHours(), atMs);
}

// ── 角色专属安静时段 ──
// characterId → 时段字符串。键不存在 = 跟随全局；"off" = 该角色永不安静；
// "HH:MM-HH:MM" = 该角色自己的时段（覆盖全局）。

const QUIET_HOURS_BY_CHAR_KV = "push_quiet_hours_by_char_v1";

export function loadCharQuietHoursMap(): Record<string, string> {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(QUIET_HOURS_BY_CHAR_KV);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof key === "string" && typeof value === "string") out[key] = value;
        }
        return out;
    } catch {
        return {};
    }
}

function saveCharQuietHoursMap(map: Record<string, string>): void {
    if (typeof window === "undefined") return;
    if (Object.keys(map).length === 0) kvRemove(QUIET_HOURS_BY_CHAR_KV);
    else kvSet(QUIET_HOURS_BY_CHAR_KV, JSON.stringify(map));
}

/** null = 跟随全局；"off" = 永不安安静；"HH:MM-HH:MM" = 专属时段。 */
export function getCharQuietHours(characterId: string): string | null {
    const map = loadCharQuietHoursMap();
    return Object.prototype.hasOwnProperty.call(map, characterId) ? map[characterId] : null;
}

/** value 传 null 删除覆盖（跟随全局）。 */
export function setCharQuietHours(characterId: string, value: string | null): void {
    if (typeof window === "undefined" || !characterId) return;
    const map = loadCharQuietHoursMap();
    if (value === null) delete map[characterId];
    else map[characterId] = value.trim() || "off";
    saveCharQuietHoursMap(map);
}

/** 角色感知版安静时段判定：角色有专属设置就用专属（含 "off"=永不），否则用全局。 */
export function isWithinQuietHours(atMs: number, characterId?: string | null): boolean {
    if (characterId) {
        const own = getCharQuietHours(characterId);
        if (own !== null) {
            if (own === "off") return false;
            return isTimeInQuietRange(own, atMs);
        }
    }
    return isWithinPushQuietHours(atMs);
}
