"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input } from "@/vendor/dsh/primitives/index.ts";
import { CHARACTERS_UPDATED_EVENT, loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    abcFilename,
    describeTune,
    ensureAbcHeaders,
    readAbcField,
    looksLikeAbc,
    matchAbcScore,
    replaceAbcField,
    splitAbcBook,
} from "@/lib/abc-score";
import {
    createAbcScore,
    deleteAbcScore,
    loadAbcScores,
    saveAbcScore,
    type AbcScore,
} from "@/lib/abc-score-storage";
import { askCharacterAboutScore, type AbcTurnResult } from "@/lib/abc-listen-engine";
import type { AbcSessionMode } from "@/lib/abc-listen-memory";
import { ABC_PLAY_REQUEST, ABC_PLAY_RESULT, type AbcPlayRequest } from "@/lib/abc-playback-bridge";
import { downloadFile } from "@/lib/download-utils";
import { useMusicControlsOptional } from "@/lib/music-context";
import { formatAbcClock, useAbcPlayer } from "./use-abc-player";
import "./abc-studio.css";

const BLANK_ABC = `X:1
T:未命名
M:4/4
L:1/8
Q:1/4=96
K:C
C2 E2 G2 c2 | c2 G2 E2 C2 |]
`;

type Props = { onClose?: () => void };

export default function AbcStudio({ onClose: _onClose }: Props) {
    const [scores, setScores] = useState<AbcScore[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [draft, setDraft] = useState("");
    const [query, setQuery] = useState("");
    const [ready, setReady] = useState(false);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [characterId, setCharacterId] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState<AbcSessionMode | null>(null);
    const [status, setStatus] = useState("");
    const [reply, setReply] = useState<AbcTurnResult | null>(null);
    const [pendingDelete, setPendingDelete] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [appearance, setAppearance] = useState(0);

    const scoresRef = useRef<AbcScore[]>([]);
    const draftRef = useRef("");
    const selectedRef = useRef("");
    const fileRef = useRef<HTMLInputElement | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const armPlay = useRef(false);
    const playRef = useRef<() => Promise<void>>(async () => {});
    const sourceRef = useRef("");
    sourceRef.current = draft;
    draftRef.current = draft;
    selectedRef.current = selectedId;

    const music = useMusicControlsOptional();
    const musicRef = useRef(music);
    musicRef.current = music;
    const pauseShelfAudio = useCallback(() => {
        musicRef.current?.pause();
    }, []);
    const player = useAbcPlayer(sourceRef, pauseShelfAudio);
    playRef.current = player.play;

    useEffect(() => {
        let gone = false;
        void loadAbcScores().then(rows => {
            if (gone) return;
            scoresRef.current = rows;
            setScores(rows);
            const first = rows[0];
            if (first) {
                setSelectedId(first.id);
                setDraft(first.abc);
            }
            setReady(true);
        });
        return () => {
            gone = true;
        };
    }, []);

    useEffect(() => {
        const refresh = () => setCharacters(loadCharacters());
        refresh();
        window.addEventListener(CHARACTERS_UPDATED_EVENT, refresh);
        return () => window.removeEventListener(CHARACTERS_UPDATED_EVENT, refresh);
    }, []);

    useEffect(() => {
        if (characterId && !characters.some(item => item.id === characterId)) {
            setCharacterId("");
        }
    }, [characterId, characters]);

    useEffect(() => {
        const body = document.body;
        const observer = new MutationObserver(() => setAppearance(value => value + 1));
        observer.observe(body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "data-ds-theme-source"] });
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!ready) return;
        const timer = window.setTimeout(() => {
            void player.preview(draft);
        }, 160);
        return () => window.clearTimeout(timer);
    }, [draft, ready, player.preview]);

    useEffect(() => {
        if (!ready || appearance === 0) return;
        void player.preview(draftRef.current);
    }, [appearance, ready, player.preview]);

    useEffect(() => {
        const paper = player.paperRef.current;
        if (!paper || !ready) return;
        let timer = 0;
        const observer = new ResizeObserver(() => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                void player.preview(draftRef.current);
            }, 180);
        });
        observer.observe(paper);
        return () => {
            observer.disconnect();
            window.clearTimeout(timer);
        };
    }, [ready, player.paperRef, player.preview]);

    useEffect(() => {
        if (!armPlay.current) return;
        armPlay.current = false;
        void playRef.current();
    }, [draft, selectedId]);

    useEffect(() => {
        if (!music?.isPlaying) return;
        player.stop();
    }, [music?.isPlaying, player.stop]);

    useEffect(() => {
        const onRequest = (event: Event) => {
            const detail = (event as CustomEvent<AbcPlayRequest>).detail;
            if (!detail?.id) return;
            const hit = matchAbcScore(scoresRef.current, detail.query, detail.artist);
            const answer = (ok: boolean, title?: string) => {
                window.dispatchEvent(new CustomEvent(ABC_PLAY_RESULT, {
                    detail: { id: detail.id, ok, title },
                }));
            };
            if (!hit) {
                answer(false);
                return;
            }
            const abc = hit.id === selectedRef.current ? draftRef.current : hit.abc;
            const title = describeTune(abc).title;
            answer(true, title);
            if (hit.id === selectedRef.current && abc === draftRef.current) {
                void playRef.current();
                return;
            }
            armPlay.current = true;
            setSelectedId(hit.id);
            setDraft(abc);
        };
        window.addEventListener(ABC_PLAY_REQUEST, onRequest);
        return () => window.removeEventListener(ABC_PLAY_REQUEST, onRequest);
    }, []);

    const info = describeTune(draft);
    const shown = scores.filter(score => {
        const needle = query.trim().toLowerCase();
        if (!needle) return true;
        const tune = score.id === selectedId ? info : describeTune(score.abc);
        return `${tune.title} ${tune.composer} ${tune.key} ${tune.meter}`.toLowerCase().includes(needle);
    });

    function remember(next: AbcScore[]) {
        scoresRef.current = next;
        setScores(next);
    }

    function flush(id = selectedRef.current, abc = draftRef.current) {
        const existing = scoresRef.current.find(score => score.id === id);
        if (!existing || existing.abc === abc) return;
        const tune = describeTune(abc);
        const saved: AbcScore = {
            ...existing,
            abc,
            title: tune.title,
            composer: tune.composer,
            updatedAt: new Date().toISOString(),
        };
        const next = scoresRef.current.map(score => score.id === id ? saved : score).sort(byRecent);
        remember(next);
        void saveAbcScore(saved);
    }

    function choose(id: string) {
        if (id === selectedId) return;
        flush();
        const score = scoresRef.current.find(item => item.id === id);
        setPendingDelete(false);
        setSelectedId(id);
        setDraft(score?.abc ?? "");
    }

    async function addBlank() {
        flush();
        const score = createAbcScore(BLANK_ABC);
        await saveAbcScore(score);
        remember([score, ...scoresRef.current].sort(byRecent));
        setSelectedId(score.id);
        setDraft(score.abc);
        setPendingDelete(false);
        setStatus("新的一首，写在谱架上了。");
    }

    async function removeCurrent() {
        if (!selectedId) return;
        if (!pendingDelete) {
            setPendingDelete(true);
            return;
        }
        const id = selectedId;
        await deleteAbcScore(id);
        const next = scoresRef.current.filter(score => score.id !== id);
        remember(next);
        const fallback = next[0];
        setSelectedId(fallback?.id ?? "");
        setDraft(fallback?.abc ?? "");
        setPendingDelete(false);
        setReply(null);
        setStatus("从谱架上拿下去了。");
    }

    async function importFiles(files: File[]) {
        flush();
        const created: AbcScore[] = [];
        for (const file of files) {
            let text = "";
            try {
                text = await file.text();
            } catch {
                setStatus(`「${file.name}」没有读出来。`);
                continue;
            }
            const tunes = splitAbcBook(text).map(ensureAbcHeaders).filter(looksLikeAbc);
            if (tunes.length === 0) {
                setStatus(`「${file.name}」里没有能认出来的 ABC。`);
                continue;
            }
            for (const abc of tunes) created.push(createAbcScore(abc));
        }
        if (created.length === 0) return;
        for (const score of created) await saveAbcScore(score);
        remember([...created, ...scoresRef.current].sort(byRecent));
        setSelectedId(created[0].id);
        setDraft(created[0].abc);
        setPendingDelete(false);
        setStatus(created.length === 1 ? `放进谱架：《${created[0].title}》。` : `放进谱架 ${created.length} 首。`);
    }

    async function exportCurrent() {
        if (!draft.trim()) {
            setStatus("没有可以导出的谱。");
            return;
        }
        flush();
        const tune = describeTune(draft);
        await downloadFile(new Blob([ensureAbcHeaders(draft)], { type: "text/plain;charset=utf-8" }), abcFilename(tune.title));
    }

    async function exportAll() {
        flush();
        const book = scoresRef.current.map(score => (score.id === selectedRef.current ? draftRef.current : score.abc).trim()).filter(Boolean);
        if (book.length === 0) {
            setStatus("谱架是空的。");
            return;
        }
        await downloadFile(new Blob([`${book.join("\n\n")}\n`], { type: "text/plain;charset=utf-8" }), "abc-book.abc");
    }

    async function run(mode: AbcSessionMode) {
        if (!characterId) {
            setStatus("先选一个过来坐着的人。");
            return;
        }
        if ((mode === "listen" || mode === "revise") && !draft.trim()) {
            setStatus("谱架上还没有谱。");
            return;
        }
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(mode);
        setReply(null);
        setStatus(mode === "listen" ? "正在听…" : mode === "write" ? "正在写…" : "正在改…");
        if (mode === "listen") void player.play();
        try {
            const result = await askCharacterAboutScore({
                characterId,
                mode,
                scoreAbc: draftRef.current,
                note,
                signal: controller.signal,
            });
            if (controller.signal.aborted) return;
            setReply(result);
            if (mode !== "listen" && !result.abc) {
                setStatus(result.prose ? "说了话，但没交出一份能用的谱。" : "没有交出谱。");
            } else if (!result.prose) {
                setStatus(mode === "listen" ? "听完了，这一次没留下话。" : "");
            } else {
                setStatus("");
            }
        } catch (err) {
            if (controller.signal.aborted) {
                setStatus("停了。");
                return;
            }
            setStatus(err instanceof Error ? err.message : "这次没有完成。");
        } finally {
            if (abortRef.current === controller) setBusy(null);
        }
    }

    function keepReplyAsNew() {
        if (!reply?.abc) return;
        flush();
        const score = createAbcScore(reply.abc);
        void saveAbcScore(score);
        remember([score, ...scoresRef.current].sort(byRecent));
        setSelectedId(score.id);
        setDraft(score.abc);
        setStatus(`《${score.title}》单独放上谱架了。`);
    }

    function replaceWithReply() {
        if (!reply?.abc || !selectedId) {
            if (reply?.abc) keepReplyAsNew();
            return;
        }
        const tune = describeTune(reply.abc);
        const existing = scoresRef.current.find(score => score.id === selectedId);
        const saved: AbcScore = {
            id: selectedId,
            title: tune.title,
            composer: tune.composer,
            abc: ensureAbcHeaders(reply.abc),
            createdAt: existing?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        remember(scoresRef.current.map(score => score.id === selectedId ? saved : score).sort(byRecent));
        void saveAbcScore(saved);
        setDraft(saved.abc);
        setStatus(`谱架上的这首换成《${saved.title}》了。`);
    }

    const shelf = shown.some(score => score.id === selectedId) ? shown : scores;
    const shelfIndex = shelf.findIndex(score => score.id === selectedId);
    const prevScore = shelfIndex > 0 ? shelf[shelfIndex - 1] : undefined;
    const nextScore = shelfIndex >= 0 && shelfIndex < shelf.length - 1 ? shelf[shelfIndex + 1] : undefined;

    function goTo(score: AbcScore | undefined) {
        if (!score || score.id === selectedId) return;
        player.prime();
        flush();
        player.stop();
        armPlay.current = true;
        setPendingDelete(false);
        setReply(null);
        setSelectedId(score.id);
        setDraft(score.abc);
    }

    const currentSeconds = player.progress * player.durationMs;
    const tuneMeta = [info.composer, info.meter, info.key].filter(Boolean).join(" · ");

    return (
        <div
            className="abc-studio abc-drop"
            data-over={dragOver ? "1" : undefined}
            onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                void importFiles([...event.dataTransfer.files]);
            }}
        >
            <aside className="abc-list">
                <div className="abc-list-head">
                    <p className="abc-kicker">谱架</p>
                    <Button size="sm" variant="ghost" onClick={() => void addBlank()}>新的一首</Button>
                </div>
                <Input
                    className="abc-search"
                    value={query}
                    placeholder="找一首"
                    aria-label="找一首"
                    onChange={(event) => setQuery(event.target.value)}
                />
                <div className="abc-row">
                    <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>导入</Button>
                    <Button size="sm" variant="ghost" onClick={() => void exportAll()} disabled={scores.length === 0}>全部导出</Button>
                </div>
                <input
                    ref={fileRef}
                    className="abc-file"
                    type="file"
                    accept=".abc,.txt,text/plain"
                    multiple
                    onChange={(event) => {
                        const files = [...(event.target.files ?? [])];
                        event.target.value = "";
                        void importFiles(files);
                    }}
                />
                {shown.length === 0 ? (
                    <p className="abc-quiet">{ready ? "谱架是空的。导入一份 ABC，或让谁写一首。" : "正在把谱架搬出来。"}</p>
                ) : (
                    <ul className="abc-scores">
                        {shown.map(score => {
                            const tune = score.id === selectedId ? info : describeTune(score.abc);
                            return (
                                <li key={score.id}>
                                    <button
                                        type="button"
                                        className="abc-score"
                                        data-on={score.id === selectedId ? "1" : undefined}
                                        onClick={() => choose(score.id)}
                                    >
                                        <span className="abc-score-title">
                                            {score.id === selectedId && player.phase === "playing" ? <span className="abc-live" aria-hidden="true" /> : null}
                                            {tune.title}
                                        </span>
                                        <span className="abc-score-meta">{[tune.composer, tune.meter, tune.key].filter(Boolean).join(" · ") || "还没有调号"}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </aside>

            <aside className="abc-stage" aria-label="实时谱面">
                <div className="abc-sheet">
                    <div className="abc-now">
                        <p className="abc-kicker">正在听</p>
                        <h2 className="abc-now-title">{draft.trim() ? info.title : "还没有谱"}</h2>
                        <p className="abc-now-meta">{draft.trim() ? (tuneMeta || "还没有调号") : "从左边选一首，或新写一份。"}</p>
                    </div>
                    <div ref={player.paperRef} className="abc-paper" />
                    {player.notice ? <p className="abc-quiet abc-notice">{player.notice}</p> : null}
                    <div className="abc-playbar">
                        <div className="abc-transport">
                            <Button size="sm" variant="outline" onClick={() => goTo(prevScore)} disabled={!prevScore}>上一首</Button>
                            {player.phase === "playing" ? (
                                <Button variant="primary" onClick={player.pause}>暂停</Button>
                            ) : (
                                <Button variant="primary" onClick={() => void player.play()} disabled={!draft.trim()}>
                                    {player.phase === "paused" ? "继续" : "播放"}
                                </Button>
                            )}
                            <Button size="sm" variant="outline" onClick={() => goTo(nextScore)} disabled={!nextScore}>下一首</Button>
                            <Button size="sm" variant="ghost" onClick={player.stop} disabled={player.phase === "ready" && player.progress === 0}>停止</Button>
                            <span className="abc-clock">{formatAbcClock(currentSeconds)} / {formatAbcClock(player.durationMs)}</span>
                        </div>
                        <input
                            className="abc-progress"
                            type="range"
                            min={0}
                            max={1000}
                            step={1}
                            value={Math.round(player.progress * 1000)}
                            aria-label="播放进度"
                            disabled={player.durationMs <= 0}
                            onChange={(event) => player.seek(Number(event.target.value) / 1000)}
                        />
                        <p className="abc-hint">点一个音，就从那里接着放。</p>
                    </div>
                </div>
            </aside>

            <section className="abc-desk">
                <p className="abc-kicker">乐谱</p>
                <div className="abc-title-row">
                    <Input
                        aria-label="曲名"
                        value={draft ? readAbcField(draft, "T") : ""}
                        placeholder="曲名"
                        disabled={!selectedId}
                        onChange={(event) => setDraft(replaceAbcField(draftRef.current || BLANK_ABC, "T", event.target.value))}
                    />
                    <Input
                        aria-label="谁写的"
                        value={draft ? info.composer : ""}
                        placeholder="谁写的"
                        disabled={!selectedId}
                        onChange={(event) => setDraft(replaceAbcField(draftRef.current || BLANK_ABC, "C", event.target.value))}
                    />
                </div>
                <div className="abc-row">
                    <Button size="sm" variant="outline" onClick={() => void exportCurrent()} disabled={!draft.trim()}>导出这首</Button>
                    <Button size="sm" variant={pendingDelete ? "primary" : "ghost"} onClick={() => void removeCurrent()} disabled={!selectedId}>
                        {pendingDelete ? "确认拿下" : "从谱架拿下"}
                    </Button>
                    {pendingDelete ? <Button size="sm" variant="ghost" onClick={() => setPendingDelete(false)}>留下</Button> : null}
                </div>
                <textarea
                    className="abc-editor"
                    aria-label="ABC 乐谱"
                    spellCheck={false}
                    value={draft}
                    placeholder={"X:1\nT:未命名\nM:4/4\nL:1/8\nK:C"}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setPendingDelete(false);
                    }}
                    onBlur={() => flush()}
                />
                <div className="abc-character">
                    <p className="abc-kicker">请来坐一会儿</p>
                    {characters.length === 0 ? (
                        <p className="abc-quiet">还没有角色。先去角色里认识一个人。</p>
                    ) : (
                        <select
                            className="abc-select"
                            aria-label="选一个角色"
                            value={characterId}
                            onChange={(event) => setCharacterId(event.target.value)}
                        >
                            <option value="">选一个角色</option>
                            {characters.map(character => (
                                <option key={character.id} value={character.id}>{character.name}</option>
                            ))}
                        </select>
                    )}
                    <input
                        className="abc-note"
                        aria-label="想跟他们说的"
                        value={note}
                        placeholder="想让他们留意什么，或想让他们写成什么样"
                        onChange={(event) => setNote(event.target.value)}
                    />
                    <div className="abc-character-actions">
                        <Button variant="primary" disabled={busy !== null || characters.length === 0} onClick={() => void run("listen")}>
                            {busy === "listen" ? "在听" : "请来听"}
                        </Button>
                        <Button variant="outline" disabled={busy !== null || characters.length === 0} onClick={() => void run("write")}>
                            {busy === "write" ? "在写" : "写一首"}
                        </Button>
                        <Button variant="outline" disabled={busy !== null || characters.length === 0 || !draft.trim()} onClick={() => void run("revise")}>
                            {busy === "revise" ? "在改" : "改这首"}
                        </Button>
                        {busy ? <Button variant="ghost" onClick={() => abortRef.current?.abort()}>停一下</Button> : null}
                    </div>
                    <p className="abc-status" data-live={status ? "1" : undefined} role="status">{status}</p>
                    {reply ? (
                        <div className="abc-reply">
                            <p>{reply.prose || (reply.abc ? "谱放在下面。" : "没有留下话。")}</p>
                            {reply.abc ? (
                                <>
                                    <pre>{reply.abc}</pre>
                                    <div className="abc-reply-actions">
                                        <Button size="sm" variant="primary" onClick={replaceWithReply}>换掉谱架上这首</Button>
                                        <Button size="sm" variant="outline" onClick={keepReplyAsNew}>另存一首</Button>
                                    </div>
                                </>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </section>
        </div>
    );
}

function byRecent(a: AbcScore, b: AbcScore): number {
    return b.updatedAt.localeCompare(a.updatedAt);
}
