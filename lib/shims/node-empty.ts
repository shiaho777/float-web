// node: 内置模块的浏览器空实现。
// @gltf-transform/* 的 dist 里 import "node:fs"/"node:path"（浏览器路径实际只用 WebIO，
// 不会真调这些 API）。原 webpack 用 resolve.fallback=false 置空，Vite 侧用别名指到这里。
const empty = {};
export default empty;
export const readFileSync = () => { throw new Error("node:fs is not available in browser"); };
export const writeFileSync = () => { throw new Error("node:fs is not available in browser"); };
export const existsSync = () => false;
