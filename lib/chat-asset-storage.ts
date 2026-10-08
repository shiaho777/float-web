import { getThemeAssetDataUrl } from "./theme-storage";
import { loadMediaBlob, MEDIA_STORE_PROTOCOL, storeMediaBlob } from "./media-cache-storage";

// asset:// 是逻辑协议，不再绑定具体物理后端：
//  - 老记录 → theme 资产表（base64 dataURL），永久可读
//  - 新写入 → 媒体仓（内容寻址、原生文件后端），调用方拿到的仍是裸 id，
//    照旧拼 asset://<id> 存进记录，读侧双协议解析，全部兼容。
// 这样二十多个调用点（朋友圈配图、小红书图、聊天背景、提示音、重试管线…）
// 一行都不用改，而新写入不再产生 base64 膨胀。

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsDataURL(blob);
    });
}

async function resolveAssetId(id: string): Promise<string | null> {
    // 先查 theme 表（老记录），miss 再查媒体仓（新写入/已迁移记录）
    const themed = await getThemeAssetDataUrl(id).catch(() => null);
    if (themed) return themed;
    const media = await loadMediaBlob(`${MEDIA_STORE_PROTOCOL}${id}`).catch(() => null);
    if (!media) return null;
    return blobToDataUrl(media.blob);
}

export async function saveChatImageToIndexedDB(blob: Blob): Promise<string> {
    const ref = await storeMediaBlob(blob, blob.type || "image/png", "image");
    return ref.slice(MEDIA_STORE_PROTOCOL.length);
}

export async function getChatImageFromIndexedDB(id: string): Promise<string | null> {
    return resolveAssetId(id);
}

// 聊天提示音：同一套资产协议，类型标记换成 audio 类。

export async function saveChatAudioToIndexedDB(blob: Blob): Promise<string> {
    const ref = await storeMediaBlob(blob, blob.type || "audio/mpeg", "audio");
    return ref.slice(MEDIA_STORE_PROTOCOL.length);
}

export async function getChatAudioFromIndexedDB(id: string): Promise<string | null> {
    return resolveAssetId(id);
}
