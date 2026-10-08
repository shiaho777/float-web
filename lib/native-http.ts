// Web edition transport. Every request goes through fetch.
// The Android build used an OkHttp bridge so streams survived WebView throttling
// and skipped CORS. This repository runs in a normal browser, so fetch is the transport.

export type NativeHttpRequestOptions = {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: boolean;
    signal?: AbortSignal;
};

/** Body types httpFetch accepts (a subset of RequestInit.body). */
export type HttpFetchBody = string | FormData | Blob | ArrayBuffer | ArrayBufferView | URLSearchParams;

/** Always false. Callers use this to decide whether a request can bypass CORS. */
export function isNativeHttpAvailable(): boolean {
    return false;
}

function decodeBase64Body(body: string): Blob {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes.buffer]);
}

/** Same call shape as the old native helper. Implemented with fetch. */
export async function fetchViaNativeHttp(options: NativeHttpRequestOptions): Promise<Response> {
    const body = options.body == null
        ? undefined
        : options.bodyBase64
            ? decodeBase64Body(options.body)
            : options.body;
    return fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body,
        signal: options.signal,
    });
}

/** fetch, with the same signature callers already use. */
export async function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, init);
}
