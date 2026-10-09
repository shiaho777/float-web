// ABC notation helpers for the score shelf.
// A book is one or more tunes. Each tune starts at its own X: header.

export type AbcTuneInfo = {
    title: string;
    composer: string;
    meter: string;
    key: string;
};

const THINK_BLOCK = /<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi;

export function readAbcField(abc: string, key: string): string {
    const match = abc.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`, "im"));
    return match?.[1]?.trim() ?? "";
}

export function describeTune(abc: string): AbcTuneInfo {
    return {
        title: readAbcField(abc, "T") || "未命名",
        composer: readAbcField(abc, "C"),
        meter: readAbcField(abc, "M"),
        key: readAbcField(abc, "K"),
    };
}

export function looksLikeAbc(text: string): boolean {
    const source = text.trim();
    if (!source) return false;
    const hasTuneHeader = /^X:\s*\d+/m.test(source) || /^K:/m.test(source);
    const hasBar = /[|\]]/.test(source);
    const hasNote = /(?:^|\s|\|)[A-Ga-g][,']*\d/.test(source) || /\[[A-Ga-g]/.test(source);
    return hasTuneHeader && (hasBar || hasNote);
}

/** Split a file into tunes. Prose with no tune header comes back empty. */
export function splitAbcBook(text: string): string[] {
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
    if (!normalized) return [];
    return normalized
        .split(/\n(?=X:\s*\d+\b)/)
        .map(chunk => chunk.trim())
        .filter(looksLikeAbc);
}

export function ensureAbcHeaders(raw: string): string {
    const lines = raw.replace(/\r\n?/g, "\n").trim().split("\n");
    const leading: string[] = [];
    let index = 0;
    while (index < lines.length && (lines[index].trim() === "" || lines[index].trim().startsWith("%"))) {
        if (lines[index].trim()) leading.push(lines[index].trim());
        index += 1;
    }
    const fields: string[] = [];
    while (index < lines.length && /^[A-Za-z]:/.test(lines[index].trim())) {
        fields.push(lines[index].trim());
        index += 1;
    }
    const music = lines.slice(index);
    const has = (key: string) => fields.some(field => field.toUpperCase().startsWith(`${key}:`));
    const extras: string[] = [];
    if (!has("X")) extras.push("X:1");
    if (!has("T")) extras.push("T:未命名");
    if (!has("M")) extras.push("M:4/4");
    if (!has("L")) extras.push("L:1/8");
    const keyLine = fields.find(field => /^K:/i.test(field)) ?? "K:C";
    const body = [...fields.filter(field => !/^K:/i.test(field)), ...extras];
    const head = body
        .filter(field => /^[XT]:/i.test(field))
        .sort((a, b) => (a[0].toUpperCase() === "X" ? -1 : 1));
    const tail = body.filter(field => !/^[XT]:/i.test(field));
    return [...leading, ...head, ...tail, keyLine, ...music].join("\n").trim() + "\n";
}

export function replaceAbcField(abc: string, key: string, value: string): string {
    const normalized = ensureAbcHeaders(abc);
    const line = `${key}:${value.replace(/\s+/g, " ").trim()}`;
    if (new RegExp(`^${escapeRegExp(key)}:`, "im").test(normalized)) {
        return normalized.replace(new RegExp(`^${escapeRegExp(key)}:.*$`, "im"), line);
    }
    return normalized.replace(/^K:.*$/m, `${line}\n$&`);
}

export function extractSpokenReply(text: string): string {
    return stripThink(text)
        .replace(/```[\s\S]*?```/g, "")
        .replace(/^X:[\s\S]*$/m, "")
        .trim();
}

export function extractAbcFromReply(text: string): string | null {
    const cleaned = stripThink(text);
    const fences = [...cleaned.matchAll(/```([a-z0-9_-]*)[^\n]*\n?([\s\S]*?)```/gi)];
    const tagged = fences.filter(match => /^(abc|abcnotation)$/i.test(match[1]));
    const ordered = [...tagged.reverse(), ...[...fences].reverse()];
    for (const match of ordered) {
        const body = match[2].trim();
        if (looksLikeAbc(body)) return ensureAbcHeaders(body);
    }
    const bareAt = cleaned.search(/^X:\s*\d+/m);
    if (bareAt < 0) return null;
    const bare = trimAfterMusic(cleaned.slice(bareAt));
    return looksLikeAbc(bare) ? ensureAbcHeaders(bare) : null;
}

export function abcFilename(title: string): string {
    const safe = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${safe || "未命名"}.abc`;
}

export function matchAbcScore<T extends { title: string; composer: string; abc: string }>(
    scores: readonly T[],
    query: string,
    artist?: string,
): T | null {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    const artistNeedle = artist?.trim().toLowerCase() ?? "";
    let best: { score: T; rank: number } | null = null;
    for (const score of scores) {
        const info = describeTune(score.abc);
        const title = (score.title || info.title).toLowerCase();
        const composer = (score.composer || info.composer).toLowerCase();
        let rank = 0;
        if (title === needle) rank += 5;
        else if (title.includes(needle) || needle.includes(title)) rank += 3;
        if (artistNeedle && composer && composer.includes(artistNeedle)) rank += 2;
        if (rank === 0) continue;
        if (!best || rank > best.rank) best = { score, rank };
    }
    return best?.score ?? null;
}

function stripThink(text: string): string {
    return text.replace(THINK_BLOCK, "").trim();
}

function trimAfterMusic(slice: string): string {
    const lines = slice.replace(/\r\n?/g, "\n").split("\n");
    const kept: string[] = [];
    for (const line of lines) {
        if (/^```/.test(line.trim())) break;
        const prose = /[\u4e00-\u9fff]/.test(line)
            && !/^[A-Za-z]:/.test(line.trim())
            && !/[|:\]]/.test(line);
        if (kept.filter(item => item.trim()).length > 4 && prose) break;
        kept.push(line);
    }
    return kept.join("\n").trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
