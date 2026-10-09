// Lets the chat "play music" tool reach an open ABC shelf before the online search.
// If the shelf is not mounted, nothing answers and the caller keeps its old path.

export const ABC_PLAY_REQUEST = "abc-score-play";
export const ABC_PLAY_RESULT = "abc-score-played";

export type AbcPlayRequest = {
    id: string;
    query: string;
    artist?: string;
};

export type AbcPlayResult = {
    id: string;
    ok: boolean;
    title?: string;
};

export function requestAbcPlayback(query: string, artist?: string): Promise<AbcPlayResult | null> {
    if (typeof window === "undefined") return Promise.resolve(null);
    const id = `abcplay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise(resolve => {
        const timer = window.setTimeout(() => {
            window.removeEventListener(ABC_PLAY_RESULT, onResult);
            resolve(null);
        }, 120);
        function onResult(event: Event) {
            const detail = (event as CustomEvent<AbcPlayResult>).detail;
            if (!detail || detail.id !== id) return;
            window.clearTimeout(timer);
            window.removeEventListener(ABC_PLAY_RESULT, onResult);
            resolve(detail);
        }
        window.addEventListener(ABC_PLAY_RESULT, onResult);
        window.dispatchEvent(new CustomEvent<AbcPlayRequest>(ABC_PLAY_REQUEST, {
            detail: { id, query, artist },
        }));
    });
}
