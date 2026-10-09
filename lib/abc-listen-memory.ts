// A character who sat with a score should remember it later.
// The stored line is the visit, not the whole ABC file.

import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import { USER_NAME_MACRO, normalizeUserNameToMacro } from "./user-macro";

const ABC_EVENT_PREFIX = "ai_phone_abc_events_";
const MAX_ABC_EVENTS = 80;

registerDynamicPrefix(ABC_EVENT_PREFIX);

export type AbcSessionMode = "listen" | "write" | "revise";

export type AbcProjectionEntry = {
    id: string;
    timestamp: string;
    mode: AbcSessionMode;
    title: string;
    content: string;
};

type RecordAbcSessionInput = {
    characterId: string;
    mode: AbcSessionMode;
    title: string;
    prose: string;
    userName: string;
    timestamp?: string;
};

function storageKey(characterId: string): string {
    return `${ABC_EVENT_PREFIX}${characterId}`;
}

function clean(value: unknown, maxLength: number): string {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function loadEvents(key: string): AbcProjectionEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((entry): entry is AbcProjectionEntry => Boolean(entry)
                && typeof (entry as Partial<AbcProjectionEntry>).id === "string"
                && typeof (entry as Partial<AbcProjectionEntry>).timestamp === "string"
                && typeof (entry as Partial<AbcProjectionEntry>).content === "string")
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch {
        return [];
    }
}

function saveEvents(key: string, events: AbcProjectionEntry[]): void {
    if (typeof window === "undefined") return;
    const compacted = [...events]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(-MAX_ABC_EVENTS);
    kvSet(key, JSON.stringify(compacted));
}

export function recordAbcSession(input: RecordAbcSessionInput): AbcProjectionEntry | null {
    const characterId = clean(input.characterId, 160);
    if (!characterId) return null;
    const title = clean(input.title, 80) || "未命名";
    const userName = clean(input.userName, 80) || "用户";
    const spoken = normalizeUserNameToMacro(clean(input.prose, 420), userName);
    const line = spoken ? `{{char}}说：${spoken}` : "";
    let body = "";
    if (input.mode === "listen") {
        body = `${USER_NAME_MACRO}把《${title}》放给{{char}}听。${line}`.trim();
    } else if (input.mode === "write") {
        body = `{{char}}写了一首《${title}》。${line}`.trim();
    } else {
        body = `{{char}}改了《${title}》。${line}`.trim();
    }
    const timestamp = input.timestamp || new Date().toISOString();
    const entry: AbcProjectionEntry = {
        id: `abc_${input.mode}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp,
        mode: input.mode,
        title,
        content: `[音乐] ${body}`,
    };
    const key = storageKey(characterId);
    const current = loadEvents(key);
    saveEvents(key, [...current, entry]);
    return entry;
}

export function loadAbcProjectionEntries(
    characterId: string,
    options?: { afterTimestamp?: string },
): AbcProjectionEntry[] {
    const entries = loadEvents(storageKey(characterId));
    if (!options?.afterTimestamp) return entries;
    return entries.filter(entry => entry.timestamp > options.afterTimestamp!);
}
