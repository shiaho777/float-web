// scripts/compress-models.mjs
// 对 public/models 下的预设 glb 做 meshopt 压缩（EXT_meshopt_compression）。
// 加载侧已在 GLTFLoader 上接 MeshoptDecoder（scene-store/thumbnail-generator/drei useGLTF）。

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, prune, resample, meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { glob } from "node:fs/promises";
import { stat } from "node:fs/promises";

await MeshoptEncoder.ready;

const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });

let totalBefore = 0, totalAfter = 0;
for await (const path of glob("public/models/**/*.glb")) {
    const before = (await stat(path)).size;
    const doc = await io.read(path);
    await doc.transform(
        dedup(),
        flatten(),
        join(),
        resample(),
        prune(),
        meshopt({ encoder: MeshoptEncoder, level: "medium" }),
    );
    await io.write(path, doc);
    const after = (await stat(path)).size;
    totalBefore += before; totalAfter += after;
    console.log(`${(after / 1048576).toFixed(2)}MB <- ${(before / 1048576).toFixed(2)}MB  ${path}`);
}
console.log(`\nTOTAL: ${(totalBefore / 1048576).toFixed(1)}MB -> ${(totalAfter / 1048576).toFixed(1)}MB`);
