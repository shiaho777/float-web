// lib/vn-asset-storage.ts
// VN scene/sprite asset management.
// Metadata in localStorage, binary data in IndexedDB via theme-storage.

import { deleteThemeAsset, getThemeAssetDataUrl, getThemeAssetMap } from "./theme-storage";
import { deleteMediaRef, loadMediaBlob, MEDIA_STORE_PROTOCOL, storeMediaBlob } from "./media-cache-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// assetId 双后端：老记录是 theme 表 id（base64 dataURL），新写入是媒体仓
// 内容寻址 id（mc_<sha256>，原生端落文件）。读侧先 theme 后媒体仓，删侧两边
// 都走（各自对不属于自己的 id 静默 no-op），老数据零迁移。
// 例外：原地覆盖更新（去底色等）仍走 theme 表——media-store id 由内容决定，
// 表达不了"同 id 换字节"；双协议读侧对两种 id 都认。

async function saveVnAsset(blob: Blob): Promise<string> {
  const ref = await storeMediaBlob(blob, blob.type || "image/png", "image");
  return ref.slice(MEDIA_STORE_PROTOCOL.length);
}

/** 单 assetId → dataURL：theme 优先，miss 回落媒体仓。 */
export async function resolveVnAssetDataUrl(id: string): Promise<string | null> {
  const themed = await getThemeAssetDataUrl(id).catch(() => null);
  if (themed) return themed;
  const media = await loadMediaBlob(`${MEDIA_STORE_PROTOCOL}${id}`).catch(() => null);
  if (!media) return null;
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(media.blob);
  });
}

async function resolveVnAssetIdMap(ids: string[]): Promise<Record<string, string>> {
  const map = await getThemeAssetMap(ids).catch(() => ({} as Record<string, string>));
  const missing = ids.filter((id) => !map[id]);
  await Promise.all(missing.map(async (id) => {
    const url = await resolveVnAssetDataUrl(id).catch(() => null);
    if (url) map[id] = url;
  }));
  return map;
}

async function deleteVnAsset(id: string): Promise<void> {
  if (!id) return;
  await deleteThemeAsset(id).catch(() => undefined);
  await deleteMediaRef(`${MEDIA_STORE_PROTOCOL}${id}`).catch(() => undefined);
}

const SCENES_KEY = "ai_phone_vn_scenes_v1";
const SPRITES_KEY = "ai_phone_vn_sprites_v1";
registerKvMigration(SCENES_KEY);
registerKvMigration(SPRITES_KEY);

// ── Types ──

export interface VnAssetLayout {
  scale?: number;  // % (default 100)
  x?: number;      // % (default 50 for sprite, 50 for scene)
  y?: number;      // % (default 100 for sprite bottom, 50 for scene center)
}

export interface VnSceneAsset {
  id: string;
  characterId: string;
  name: string;
  assetId: string;
  layout?: VnAssetLayout;
}

export interface VnSpriteAsset {
  id: string;
  characterId: string;
  key: string;
  assetId: string;
  layout?: VnAssetLayout;
}

// ── localStorage helpers ──

function readScenes(): VnSceneAsset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(SCENES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeScenes(scenes: VnSceneAsset[]): void {
  if (typeof window === "undefined") return;
  kvSet(SCENES_KEY, JSON.stringify(scenes));
}

function readSprites(): VnSpriteAsset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(SPRITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeSprites(sprites: VnSpriteAsset[]): void {
  if (typeof window === "undefined") return;
  kvSet(SPRITES_KEY, JSON.stringify(sprites));
}

// ── Scene CRUD ──

export function loadVnScenes(characterId?: string): VnSceneAsset[] {
  const all = readScenes();
  if (!characterId) return all;
  return all.filter((s) => s.characterId === characterId || s.characterId === "");
}

export async function addVnScene(characterId: string, name: string, blob: Blob): Promise<VnSceneAsset> {
  const assetId = await saveVnAsset(blob);
  const scene: VnSceneAsset = {
    id: `vn_scene_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    characterId,
    name,
    assetId,
  };
  const scenes = readScenes();
  scenes.push(scene);
  writeScenes(scenes);
  return scene;
}

export async function deleteVnScene(id: string): Promise<void> {
  const scenes = readScenes();
  const idx = scenes.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [removed] = scenes.splice(idx, 1);
  writeScenes(scenes);
  await deleteVnAsset(removed.assetId);
}

// ── Sprite CRUD ──

export function loadVnSprites(characterId?: string): VnSpriteAsset[] {
  const all = readSprites();
  if (!characterId) return all;
  return all.filter((s) => s.characterId === characterId || s.characterId === "");
}

export async function addVnSprite(characterId: string, key: string, blob: Blob): Promise<VnSpriteAsset> {
  const assetId = await saveVnAsset(blob);
  const sprite: VnSpriteAsset = {
    id: `vn_sprite_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    characterId,
    key,
    assetId,
  };
  const sprites = readSprites();
  sprites.push(sprite);
  writeSprites(sprites);
  return sprite;
}

export async function deleteVnSprite(id: string): Promise<void> {
  const sprites = readSprites();
  const idx = sprites.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [removed] = sprites.splice(idx, 1);
  writeSprites(sprites);
  await deleteVnAsset(removed.assetId);
}

// ── Layout update ──

export function updateVnSceneLayout(id: string, layout: VnAssetLayout): void {
  const scenes = readScenes();
  const idx = scenes.findIndex((s) => s.id === id);
  if (idx === -1) return;
  scenes[idx] = { ...scenes[idx], layout };
  writeScenes(scenes);
}

export function updateVnSpriteLayout(id: string, layout: VnAssetLayout): void {
  const sprites = readSprites();
  const idx = sprites.findIndex((s) => s.id === id);
  if (idx === -1) return;
  sprites[idx] = { ...sprites[idx], layout };
  writeSprites(sprites);
}

// ── Layout lookup for rendering ──

function findSpriteAsset(sprites: VnSpriteAsset[], key: string, characterId?: string): VnSpriteAsset | undefined {
  const nameAfterSlash = key.includes("/") ? key.split("/").pop()! : key;
  const candidates = characterId
    ? sprites.filter((s) => s.characterId === characterId || s.characterId === "")
    : sprites;

  return (
    (characterId ? candidates.find((s) => s.characterId === characterId && s.key === key) : undefined) ||
    (characterId ? candidates.find((s) => s.characterId === characterId && s.key === nameAfterSlash) : undefined) ||
    candidates.find((s) => s.key === key) ||
    candidates.find((s) => s.key === nameAfterSlash)
  );
}

export function getVnSceneLayout(name: string): VnAssetLayout {
  const scene = readScenes().find((s) => s.name === name);
  return scene?.layout ?? {};
}

export function getVnSpriteLayout(key: string, characterId?: string): VnAssetLayout {
  const sprites = readSprites();
  const sprite = findSpriteAsset(sprites, key, characterId);
  return sprite?.layout ?? {};
}

// ── Prompt injection helpers ──

export function getVnSceneNames(characterId: string): string {
  const scenes = loadVnScenes(characterId);
  if (scenes.length === 0) return "暂无";
  return scenes.map((s) => s.name).join("，");
}

export function getVnSpriteNames(characterId: string): string {
  const sprites = loadVnSprites(characterId);
  if (sprites.length === 0) return "暂无";
  return sprites.map((s) => s.key).join("，");
}

// ── Rendering helpers ──

export async function resolveVnAssetMap(
  names: string[],
  type: "scene" | "sprite",
  characterId?: string
): Promise<Record<string, string>> {
  if (names.length === 0) return {};

  const items = type === "scene"
    ? (characterId ? loadVnScenes(characterId) : readScenes())
    : (characterId ? loadVnSprites(characterId) : readSprites());
  const matched: { name: string; assetId: string }[] = [];
  for (const name of names) {
    let item;
    if (type === "scene") {
      item = (items as VnSceneAsset[]).find((i) => i.name === name);
    } else {
      // Match exact key, or strip "角色名/" prefix from AI output
      item = findSpriteAsset(items as VnSpriteAsset[], name, characterId);
    }
    if (item) matched.push({ name, assetId: item.assetId });
  }

  if (matched.length === 0) return {};

  const assetIds = matched.map((m) => m.assetId);
  const assetMap = await resolveVnAssetIdMap(assetIds);

  const result: Record<string, string> = {};
  for (const m of matched) {
    if (assetMap[m.assetId]) {
      result[m.name] = assetMap[m.assetId];
    }
  }
  return result;
}
