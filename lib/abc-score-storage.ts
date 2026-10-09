// Shelf of ABC scores. Separate from the audio-blob music database:
// a tune here is notation, not a recording.

import { openIndexedDbAtLeast } from "./idb-open";
import { kvGet, kvSet } from "./kv-db";
import { describeTune, ensureAbcHeaders } from "./abc-score";

export type AbcScore = {
    id: string;
    title: string;
    composer: string;
    abc: string;
    createdAt: string;
    updatedAt: string;
};

const DB_NAME = "ai_phone_abc_scores_v1";
const DB_VERSION = 1;
const STORE = "scores";
const SEEDED_KEY = "abc_studio_seeded_v1";

const SEED_ABC = `X:1
T:窗边
M:3/4
L:1/8
Q:1/4=92
K:G
D2 G2 B2 | d4 B2 | A2 G2 E2 | D6 | D2 G2 B2 | e4 d2 | B2 A2 G2 | G6 |]
`;

function openDb(): Promise<IDBDatabase | null> {
    if (typeof window === "undefined") return Promise.resolve(null);
    return openIndexedDbAtLeast(DB_NAME, DB_VERSION, (db) => {
        if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "id" });
        }
    }).catch((err) => {
        console.warn("[AbcScore] DB open error:", err);
        return null;
    });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function isScore(value: unknown): value is AbcScore {
    if (!value || typeof value !== "object") return false;
    const row = value as Partial<AbcScore>;
    return typeof row.id === "string"
        && typeof row.abc === "string"
        && typeof row.title === "string"
        && typeof row.createdAt === "string";
}

function normalizeScore(row: AbcScore): AbcScore {
    const info = describeTune(row.abc);
    return {
        id: row.id,
        title: row.title.trim() || info.title,
        composer: typeof row.composer === "string" ? row.composer : info.composer,
        abc: row.abc,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt || row.createdAt,
    };
}

function byRecent(a: AbcScore, b: AbcScore): number {
    return b.updatedAt.localeCompare(a.updatedAt);
}

async function readAll(): Promise<AbcScore[]> {
    const db = await openDb();
    if (!db) return [];
    const tx = db.transaction(STORE, "readonly");
    const rows = await requestToPromise(tx.objectStore(STORE).getAll());
    return (Array.isArray(rows) ? rows : []).filter(isScore).map(normalizeScore).sort(byRecent);
}

export function createAbcScore(abc: string, id = newAbcScoreId()): AbcScore {
    const now = new Date().toISOString();
    const normalized = ensureAbcHeaders(abc);
    const info = describeTune(normalized);
    return {
        id,
        title: info.title,
        composer: info.composer,
        abc: normalized,
        createdAt: now,
        updatedAt: now,
    };
}

export function newAbcScoreId(): string {
    return `abc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadAbcScores(): Promise<AbcScore[]> {
    await ensureSeed();
    return readAll();
}

export async function saveAbcScore(score: AbcScore): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(normalizeScore(score));
    await transactionDone(tx);
}

export async function deleteAbcScore(id: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await transactionDone(tx);
}

async function ensureSeed(): Promise<void> {
    if (typeof window === "undefined") return;
    if (kvGet(SEEDED_KEY) === "1") return;
    const existing = await readAll();
    if (existing.length > 0) {
        kvSet(SEEDED_KEY, "1");
        return;
    }
    await saveAbcScore(createAbcScore(SEED_ABC, "abc_seed_window"));
    kvSet(SEEDED_KEY, "1");
}
