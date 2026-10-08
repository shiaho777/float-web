// lib/llm-http.ts
// LLM 请求的统一出口：所有走 buildProviderRequest 的调用点统一经它发请求。
// Android 原生环境优先走 NativeHttp 插件（OkHttp，socket 读取不受 WebView
// 节流影响）；浏览器/开发环境回落到直连 fetch。

import type { LlmRequestPayload } from "./llm-provider-adapter";
import { httpFetch } from "./native-http";

export type FetchLlmPayloadOptions = {
    signal?: AbortSignal;
};

export function fetchLlmPayload(
    payload: LlmRequestPayload,
    options: FetchLlmPayloadOptions = {},
): Promise<Response> {
    return httpFetch(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: JSON.stringify(payload.body),
        signal: options.signal,
    });
}
