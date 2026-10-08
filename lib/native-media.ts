// Web edition media store.
// Bytes live in IndexedDB via media-cache-storage. These helpers stay so the
// cache layer can ask "is this id on a native disk?" and always get no.

export type NativeMediaEntry = {
    id: string;
    mime: string;
    category: "image" | "audio" | "video" | "file";
    bytes: number;
    createdAt: number;
    displayUrl?: string;
};

export function isNativeMediaAvailable(): boolean {
    return false;
}

export async function isNativeMediaId(_id: string): Promise<boolean> {
    return false;
}

export async function getNativeMediaEntry(_id: string): Promise<NativeMediaEntry | null> {
    return null;
}

export async function nativeMediaStoreBase64(
    _id: string,
    _base64: string,
    _mime?: string,
    _category?: NativeMediaEntry["category"],
): Promise<void> {
    throw new Error("NativeMedia not available");
}

export async function nativeMediaStoreBlob(
    _id: string,
    _blob: Blob,
    _mime?: string,
    _category?: NativeMediaEntry["category"],
): Promise<void> {
    throw new Error("NativeMedia not available");
}

export async function nativeMediaStoreDedupeBase64(
    _base64: string,
    _mime?: string,
    _category?: NativeMediaEntry["category"],
): Promise<{ id: string; bytes: number }> {
    throw new Error("NativeMedia not available");
}

export async function nativeMediaStoreDedupeBlob(
    _blob: Blob,
    _mime?: string,
    _category?: NativeMediaEntry["category"],
): Promise<{ id: string; bytes: number }> {
    throw new Error("NativeMedia not available");
}

export async function nativeMediaDisplayUrl(_id: string): Promise<string | null> {
    return null;
}

export async function nativeMediaReadBlob(_id: string, _mime: string): Promise<Blob | null> {
    return null;
}

export async function nativeMediaDelete(_id: string): Promise<void> {}

export async function nativeMediaList(): Promise<NativeMediaEntry[]> {
    return [];
}

export async function nativeMediaClear(): Promise<number> {
    return 0;
}
