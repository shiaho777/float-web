import Dexie from "dexie";
import { kvGet, kvSet } from "./kv-db";
import {
    getNativeMediaEntry,
    isNativeMediaAvailable,
    isNativeMediaId,
    nativeMediaDelete,
    nativeMediaDisplayUrl,
    nativeMediaList,
    nativeMediaReadBlob,
    nativeMediaStoreDedupeBase64,
    nativeMediaStoreDedupeBlob,
} from "./native-media";

// ── Database ─────────────────────────────────────

interface MediaCacheEntry {
    id: string;
    blob: Blob;
    mimeType: string;
    mediaCategory: "audio" | "image" | "video" | "file";
    createdAt: number;
}

class MediaCacheDatabase extends Dexie {
    entries!: Dexie.Table<MediaCacheEntry, string>;

    constructor() {
        super("AiPhoneMediaCacheDB");
        this.version(1).stores({
            entries: "id, createdAt",
        });
    }
}

let db: MediaCacheDatabase | null = null;

function getDb(): MediaCacheDatabase {
    if (!db) db = new MediaCacheDatabase();
    return db;
}

// ── MIME Sniffing ────────────────────────────────

const MAGIC_SIGNATURES: Array<{ prefix: string; mime: string; category: MediaCacheEntry["mediaCategory"] }> = [
    // Images
    { prefix: "iVBORw0KGgo", mime: "image/png", category: "image" },
    { prefix: "/9j/", mime: "image/jpeg", category: "image" },
    { prefix: "R0lGOD", mime: "image/gif", category: "image" },
    { prefix: "UklGRg", mime: "image/webp", category: "image" },
    // Audio
    { prefix: "SUQz", mime: "audio/mpeg", category: "audio" },
    { prefix: "//u", mime: "audio/mpeg", category: "audio" },
    { prefix: "T2dnUw", mime: "audio/ogg", category: "audio" },
    { prefix: "ZkxhQw", mime: "audio/flac", category: "audio" },
    // Video
    { prefix: "AAAAIG", mime: "video/mp4", category: "video" },
    { prefix: "AAAAHG", mime: "video/mp4", category: "video" },
    { prefix: "GkXfo", mime: "video/webm", category: "video" },
    // Documents
    { prefix: "JVBERi", mime: "application/pdf", category: "file" },
];

function sniffBase64(b64: string): { mime: string; category: MediaCacheEntry["mediaCategory"] } {
    for (const sig of MAGIC_SIGNATURES) {
        if (b64.startsWith(sig.prefix)) return { mime: sig.mime, category: sig.category };
    }
    return { mime: "application/octet-stream", category: "file" };
}

// WAV shares UklGR prefix with WebP — disambiguate by checking bytes 8-11 for "WAVE"
function refineWavOrWebp(b64: string): { mime: string; category: MediaCacheEntry["mediaCategory"] } | null {
    if (!b64.startsWith("UklGR")) return null;
    try {
        const raw = atob(b64.slice(0, 24));
        if (raw.length >= 12 && raw.slice(8, 12) === "WAVE") {
            return { mime: "audio/wav", category: "audio" };
        }
    } catch { /* ignore */ }
    return null;
}

export function detectMediaType(b64: string, declaredMime?: string): { mime: string; category: MediaCacheEntry["mediaCategory"] } {
    if (declaredMime && declaredMime !== "application/octet-stream") {
        const category: MediaCacheEntry["mediaCategory"] =
            declaredMime.startsWith("image/") ? "image" :
            declaredMime.startsWith("audio/") ? "audio" :
            declaredMime.startsWith("video/") ? "video" : "file";
        return { mime: declaredMime, category };
    }
    const wavCheck = refineWavOrWebp(b64);
    if (wavCheck) return wavCheck;
    return sniffBase64(b64);
}

// ── Store & Retrieve ─────────────────────────────

export const MEDIA_STORE_PROTOCOL = "media-store://";

// ── 内容寻址 + 删除语义 ──────────────────────────
// 新写入一律内容寻址：id = mc_<sha256>，相同字节永远落到同一条目——
// 同一张图重发/重试/多处引用不再重复占盘。旧随机 id（mc_<ts>_<rand>）永久可读。
//
// 代价：内容寻址条目可能被多条记录共享，"删一条记录就删字节"不再安全。
// 因此对哈希 id 的删除走墓碑队列，由 media GC（storage-space.runMediaSweep，
// 启动时/手动清理时跑）在确认全库无引用后才物理删除；
// 旧随机 id 保持即删（它们永远独占，和旧行为一致）。

const HASH_ID_RE = /^mc_[0-9a-f]{64}$/;
const TOMBSTONE_KEY = "ai_phone_media_tombstones_v1";

export function isHashMediaId(id: string): boolean {
    return HASH_ID_RE.test(id);
}

function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
    const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
    return crypto.subtle.digest("SHA-256", buf as ArrayBuffer).then((digest) =>
        Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")
    );
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function loadTombstones(): string[] {
    try {
        const parsed = JSON.parse(kvGet(TOMBSTONE_KEY) || "[]") as unknown;
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
        return [];
    }
}

function tombstone(id: string): void {
    const list = loadTombstones();
    if (!list.includes(id)) {
        list.push(id);
        try { kvSet(TOMBSTONE_KEY, JSON.stringify(list)); } catch { /* ignore */ }
    }
    // 防抖清扫：堆墓碑期间不反复全库扫描，安静 30s 后在后台跑一次
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => {
        sweepTimer = null;
        void import("./storage-space").then(m => m.runMediaSweep()).catch(() => {});
    }, 30_000);
}

let sweepTimer: ReturnType<typeof setTimeout> | null = null;

/** GC 用：取墓碑表并原子清空（清扫失败时由调用方决定是否回填）。 */
export function drainMediaTombstones(): string[] {
    const list = loadTombstones();
    if (list.length) try { kvSet(TOMBSTONE_KEY, "[]"); } catch { /* ignore */ }
    return list;
}

/** GC 用：墓碑里仍有引用的 id 回填，下轮再判。 */
export function restoreMediaTombstones(ids: string[]): void {
    if (!ids.length) return;
    const merged = new Set([...loadTombstones(), ...ids]);
    try { kvSet(TOMBSTONE_KEY, JSON.stringify([...merged])); } catch { /* ignore */ }
}

async function hashIdForBytes(bytes: Uint8Array): Promise<string> {
    return `mc_${await sha256Hex(bytes)}`;
}

export async function storeMediaBlob(blob: Blob, mimeType: string, category: MediaCacheEntry["mediaCategory"]): Promise<string> {
    // 原生端：hash 与落盘都在原生侧完成，JS 只过一次 base64 桥
    if (isNativeMediaAvailable()) {
        try {
            const { id } = await nativeMediaStoreDedupeBlob(blob, mimeType, category);
            return `${MEDIA_STORE_PROTOCOL}${id}`;
        } catch (err) {
            console.warn("[MediaCache] native store failed, fallback to IDB:", err);
        }
    }
    const id = await hashIdForBytes(new Uint8Array(await blob.arrayBuffer()));
    if (!(await getDb().entries.get(id))) {
        await getDb().entries.put({ id, blob, mimeType, mediaCategory: category, createdAt: Date.now() });
    }
    return `${MEDIA_STORE_PROTOCOL}${id}`;
}

export async function storeMediaBase64(b64: string, declaredMime?: string): Promise<{ ref: string; category: MediaCacheEntry["mediaCategory"]; mime: string }> {
    const { mime, category } = detectMediaType(b64, declaredMime);
    if (isNativeMediaAvailable()) {
        try {
            // 原生路径：base64 原样交给原生解码+哈希+落盘，JS 完全不物化字节
            const { id } = await nativeMediaStoreDedupeBase64(b64, mime, category);
            return { ref: `${MEDIA_STORE_PROTOCOL}${id}`, category, mime };
        } catch (err) {
            console.warn("[MediaCache] native store failed, fallback to IDB:", err);
        }
    }
    const bytes = base64ToBytes(b64);
    const id = await hashIdForBytes(bytes);
    if (!(await getDb().entries.get(id))) {
        const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        await getDb().entries.put({ id, blob: new Blob([body], { type: mime }), mimeType: mime, mediaCategory: category, createdAt: Date.now() });
    }
    return { ref: `${MEDIA_STORE_PROTOCOL}${id}`, category, mime };
}

export async function loadMediaBlob(ref: string): Promise<{ blob: Blob; mimeType: string; category: MediaCacheEntry["mediaCategory"] } | null> {
    const id = ref.startsWith(MEDIA_STORE_PROTOCOL) ? ref.slice(MEDIA_STORE_PROTOCOL.length) : ref;
    if (await isNativeMediaId(id)) {
        const meta = await getNativeMediaEntry(id);
        const blob = await nativeMediaReadBlob(id, meta?.mime ?? "application/octet-stream");
        if (blob) return { blob, mimeType: meta?.mime ?? blob.type, category: meta?.category ?? "file" };
        // 文件缺失时继续走 IDB 兜底（同名 id 理论上不会两边都有）
    }
    const entry = await getDb().entries.get(id);
    if (!entry) return null;
    return { blob: entry.blob, mimeType: entry.mimeType, category: entry.mediaCategory };
}

export async function deleteMediaRef(ref: string | undefined): Promise<void> {
    if (!ref || !ref.startsWith(MEDIA_STORE_PROTOCOL)) return;
    const id = ref.slice(MEDIA_STORE_PROTOCOL.length);
    // 内容寻址条目可能被多条记录共享：进墓碑队列，等 GC 确认零引用再删
    if (isHashMediaId(id)) {
        tombstone(id);
        return;
    }
    if (await isNativeMediaId(id)) await nativeMediaDelete(id);
    await getDb().entries.delete(id);
}

/** 物理删除（仅供 GC 在确认零引用后调用）。 */
export async function deleteMediaEntryPhysically(id: string): Promise<void> {
    if (await isNativeMediaId(id)) await nativeMediaDelete(id);
    await getDb().entries.delete(id);
}

export async function loadMediaObjectUrl(ref: string): Promise<string | null> {
    const id = ref.startsWith(MEDIA_STORE_PROTOCOL) ? ref.slice(MEDIA_STORE_PROTOCOL.length) : ref;
    // 原生端：返回 _capacitor_file_ URL，WebView 直接读盘；大图给到缩略图
    if (await isNativeMediaId(id)) {
        const url = await nativeMediaDisplayUrl(id);
        if (url) return url;
    }
    const result = await loadMediaBlob(ref);
    if (!result) return null;
    return URL.createObjectURL(result.blob);
}

export function isMediaStoreRef(url: string): boolean {
    return url.startsWith(MEDIA_STORE_PROTOCOL);
}

export type MediaCacheSummary = {
    id: string;
    bytes: number;
    category: MediaCacheEntry["mediaCategory"];
    createdAt: number;
};

/** 逐条流式读取 id/大小/类别——blob.size 只读元数据，不会把媒体内容载入内存。 */
export async function listMediaCacheSummaries(): Promise<MediaCacheSummary[]> {
    const out: MediaCacheSummary[] = [];
    await getDb().entries.each((entry) => {
        out.push({
            id: entry.id,
            bytes: entry.blob?.size ?? 0,
            category: entry.mediaCategory,
            createdAt: entry.createdAt,
        });
    });
    for (const e of await nativeMediaList()) {
        out.push({ id: e.id, bytes: e.bytes, category: e.category, createdAt: e.createdAt });
    }
    return out;
}

// ── Bulk detection in JSON text ──────────────────

const B64_BLOCK_RE = /(?:data:([^;]+);base64,)?([A-Za-z0-9+/]{200,}={0,2})/g;

export function extractBase64Blocks(text: string): Array<{ fullMatch: string; declaredMime?: string; b64: string; start: number }> {
    const results: Array<{ fullMatch: string; declaredMime?: string; b64: string; start: number }> = [];
    let match: RegExpExecArray | null;
    B64_BLOCK_RE.lastIndex = 0;
    while ((match = B64_BLOCK_RE.exec(text)) !== null) {
        results.push({
            fullMatch: match[0],
            declaredMime: match[1] || undefined,
            b64: match[2],
            start: match.index,
        });
    }
    return results;
}
