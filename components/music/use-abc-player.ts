// Staff preview and a small oscillator player.
// abcjs draws the tune, but the visual timing events have no pitches until
// setUpAudio runs. Soundfonts stay remote, so each note is scheduled on the
// audio clock as a short triangle tone.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AbcElem, AudioTrackNoteItem, NoteTimingEvent, TuneObject } from "abcjs";

export type AbcPlayPhase = "ready" | "playing" | "paused";

type Range = { start: number; end: number };

type Hit = {
    ms: number;
    durMs: number;
    pitches: Array<{ midi: number; volume: number }>;
    elements: Element[][];
    ranges: Range[];
};

type Session = {
    totalMs: number;
    source: string;
    width: number;
    color: string;
    hits: Hit[];
    originMs: number;
    originTime: number;
};

type Voice = { osc: OscillatorNode; gain: GainNode };

type AbcjsApi = {
    renderAbc: typeof import("abcjs").renderAbc;
    TimingCallbacks: typeof import("abcjs").TimingCallbacks;
};

export function useAbcPlayer(sourceRef: { current: string }, onStart?: () => void) {
    const paperRef = useRef<HTMLDivElement | null>(null);
    const sessionRef = useRef<Session | null>(null);
    const ctxRef = useRef<AudioContext | null>(null);
    const voicesRef = useRef<Voice[]>([]);
    const litRef = useRef<Element[]>([]);
    const litKeyRef = useRef("");
    const phaseRef = useRef<AbcPlayPhase>("ready");
    const tokenRef = useRef(0);
    const jobRef = useRef<Promise<boolean>>(Promise.resolve(false));
    const onStartRef = useRef(onStart);
    const playFromRef = useRef<(ratio: number) => void>(() => {});
    const onNoteRef = useRef<(elem: AbcElem) => void>(() => {});
    onStartRef.current = onStart;

    const [phase, setPhase] = useState<AbcPlayPhase>("ready");
    const [progress, setProgress] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [notice, setNotice] = useState("");

    const setPhaseBoth = useCallback((next: AbcPlayPhase) => {
        phaseRef.current = next;
        setPhase(next);
    }, []);

    const hush = useCallback(() => {
        const ctx = ctxRef.current;
        const now = ctx?.currentTime ?? 0;
        for (const voice of voicesRef.current) {
            try {
                voice.gain.gain.cancelScheduledValues(now);
                voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now);
                voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
                voice.osc.stop(now + 0.04);
            } catch { /* already stopped */ }
        }
        voicesRef.current = [];
    }, []);

    const clearLit = useCallback(() => {
        for (const el of litRef.current) el.classList.remove("abc-on");
        litRef.current = [];
        litKeyRef.current = "";
    }, []);

    const prime = useCallback(() => {
        const ctx = audioContext(ctxRef);
        if (ctx.state !== "running") void ctx.resume();
        return ctx;
    }, []);

    const readMs = useCallback(() => {
        const session = sessionRef.current;
        const ctx = ctxRef.current;
        if (!session) return 0;
        if (phaseRef.current !== "playing" || !ctx) return session.originMs;
        return session.originMs + (ctx.currentTime - session.originTime) * 1000;
    }, []);

    const paint = useCallback((session: Session, ms: number) => {
        const paper = paperRef.current;
        if (!paper) return;
        let current: Hit | null = null;
        for (const hit of session.hits) {
            if (hit.ms <= ms + 30) current = hit;
            else break;
        }
        const key = current ? `${current.ms}` : "";
        if (key === litKeyRef.current) return;
        litKeyRef.current = key;
        for (const el of litRef.current) el.classList.remove("abc-on");
        litRef.current = [];
        if (!current) return;
        let first: Element | null = null;
        for (const group of current.elements) {
            for (const el of group) {
                if (!el.isConnected) continue;
                el.classList.add("abc-on");
                litRef.current.push(el);
                first ??= el;
            }
        }
        if (!first) return;
        const paperBox = paper.getBoundingClientRect();
        const noteBox = first.getBoundingClientRect();
        if (noteBox.top < paperBox.top + 8 || noteBox.bottom > paperBox.bottom - 8) {
            paper.scrollTop += noteBox.top - paperBox.top - 24;
        }
    }, []);

    const playFrom = useCallback((ratio: number) => {
        const session = sessionRef.current;
        if (!session || session.totalMs <= 0) return;
        const ctx = prime();
        onStartRef.current?.();
        hush();
        clearLit();
        const startMs = Math.min(session.totalMs, Math.max(0, ratio * session.totalMs));
        const origin = ctx.currentTime;
        session.originMs = startMs;
        session.originTime = origin;
        setPhaseBoth("playing");
        setProgress(startMs / session.totalMs);
        paint(session, startMs);
        const lead = 0.03;
        for (const hit of session.hits) {
            if (hit.pitches.length === 0) continue;
            const into = startMs - hit.ms;
            if (into > hit.durMs - 25) continue;
            const when = origin + lead + Math.max(0, hit.ms - startMs) / 1000;
            const remain = (hit.durMs - Math.max(0, into)) / 1000;
            soundHit(hit, ctx, when, remain, voicesRef);
        }
    }, [clearLit, hush, paint, prime, setPhaseBoth]);
    playFromRef.current = playFrom;

    onNoteRef.current = (elem) => {
        const session = sessionRef.current;
        const paper = paperRef.current;
        const start = elem.startChar;
        if (paper) stripSelection(paper, session?.color ?? "");
        if (!session || session.totalMs <= 0 || start == null || elem.el_type !== "note") return;
        const now = readMs();
        const matches = session.hits.filter(hit => hit.ranges.some(range => start >= range.start && start < range.end));
        const hit = matches.find(item => item.ms >= now - 40) ?? matches[0];
        if (!hit) return;
        playFrom(hit.ms / session.totalMs);
    };

    const stop = useCallback(() => {
        hush();
        clearLit();
        const session = sessionRef.current;
        if (session) session.originMs = 0;
        setProgress(0);
        setPhaseBoth("ready");
    }, [clearLit, hush, setPhaseBoth]);

    const preview = useCallback((source: string): Promise<boolean> => {
        const job = jobRef.current.then(() => renderScore({
            source,
            paperRef,
            sessionRef,
            phaseRef,
            tokenRef,
            voicesRef,
            litRef,
            litKeyRef,
            ctxRef,
            onNoteRef,
            playFromRef,
            setNotice,
            setDurationMs,
            setProgress,
            setPhaseBoth,
        }));
        jobRef.current = job.then(ok => ok, () => false);
        return job;
    }, [setPhaseBoth]);

    const play = useCallback(async () => {
        prime();
        const source = sourceRef.current.trim();
        const session = sessionRef.current;
        if (phaseRef.current === "paused" && session?.source === source && session.totalMs > 0) {
            const at = session.originMs >= session.totalMs - 150 ? 0 : session.originMs / session.totalMs;
            playFrom(at);
            return;
        }
        let ready = session?.source === source && (session?.totalMs ?? 0) > 0;
        if (!ready) ready = await preview(source);
        if (!ready || sessionRef.current?.source !== source) ready = await jobRef.current;
        if (!ready || sessionRef.current?.source !== source || (sessionRef.current?.totalMs ?? 0) <= 0) return;
        playFrom(0);
    }, [playFrom, preview, prime, sourceRef]);

    const pause = useCallback(() => {
        const session = sessionRef.current;
        if (!session || phaseRef.current !== "playing") return;
        const ms = readMs();
        hush();
        session.originMs = Math.min(session.totalMs, Math.max(0, ms));
        setProgress(session.totalMs > 0 ? session.originMs / session.totalMs : 0);
        setPhaseBoth("paused");
    }, [hush, readMs, setPhaseBoth]);

    const seek = useCallback((ratio: number) => {
        const session = sessionRef.current;
        if (!session || session.totalMs <= 0) return;
        const clamped = Math.min(1, Math.max(0, ratio));
        if (phaseRef.current === "playing") {
            playFrom(clamped);
            return;
        }
        hush();
        session.originMs = clamped * session.totalMs;
        setProgress(clamped);
        paint(session, session.originMs);
        setPhaseBoth(clamped <= 0.001 ? "ready" : "paused");
    }, [hush, paint, playFrom, setPhaseBoth]);

    useEffect(() => {
        if (phase !== "playing") return;
        let frame = 0;
        let lastBucket = -1;
        const loop = () => {
            const session = sessionRef.current;
            const ctx = ctxRef.current;
            if (!session || session.totalMs <= 0 || !ctx || phaseRef.current !== "playing") return;
            const ms = session.originMs + (ctx.currentTime - session.originTime) * 1000;
            if (ms >= session.totalMs) {
                clearLit();
                session.originMs = 0;
                setProgress(1);
                setPhaseBoth("ready");
                return;
            }
            paint(session, ms);
            const bucket = Math.round((ms / session.totalMs) * 250);
            if (bucket !== lastBucket) {
                lastBucket = bucket;
                setProgress(ms / session.totalMs);
            }
            frame = requestAnimationFrame(loop);
        };
        frame = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(frame);
    }, [clearLit, paint, phase, setPhaseBoth]);

    useEffect(() => () => {
        tokenRef.current += 1;
        hush();
        void ctxRef.current?.close();
        ctxRef.current = null;
    }, [hush]);

    return { paperRef, phase, progress, durationMs, notice, preview, prime, play, pause, stop, seek };
}

async function renderScore(input: {
    source: string;
    paperRef: { current: HTMLDivElement | null };
    sessionRef: { current: Session | null };
    phaseRef: { current: AbcPlayPhase };
    tokenRef: { current: number };
    voicesRef: { current: Voice[] };
    litRef: { current: Element[] };
    litKeyRef: { current: string };
    ctxRef: { current: AudioContext | null };
    onNoteRef: { current: (elem: AbcElem) => void };
    playFromRef: { current: (ratio: number) => void };
    setNotice: (value: string) => void;
    setDurationMs: (value: number) => void;
    setProgress: (value: number) => void;
    setPhaseBoth: (value: AbcPlayPhase) => void;
}): Promise<boolean> {
    const paper = input.paperRef.current;
    const trimmed = input.source.trim();
    const width = paper?.clientWidth ?? 0;
    const previous = input.sessionRef.current;
    if (!paper || width < 40) {
        return Boolean(previous && previous.source === trimmed && previous.totalMs > 0);
    }
    const color = getComputedStyle(paper).color || "#222";
    const widthSlack = input.phaseRef.current === "ready" ? 12 : 64;
    if (previous && previous.source === trimmed && previous.color === color && Math.abs(previous.width - width) < widthSlack) {
        return previous.totalMs > 0;
    }

    const resumeAt = input.phaseRef.current === "playing" && previous && previous.totalMs > 0
        ? Math.min(1, Math.max(0, (previous.originMs + ((input.ctxRef.current?.currentTime ?? previous.originTime) - previous.originTime) * 1000) / previous.totalMs))
        : null;
    const token = ++input.tokenRef.current;
    stopVoices(input.voicesRef, input.ctxRef.current);
    for (const el of input.litRef.current) el.classList.remove("abc-on");
    input.litRef.current = [];
    input.litKeyRef.current = "";
    input.sessionRef.current = null;
    paper.replaceChildren();
    if (resumeAt == null) {
        input.setPhaseBoth("ready");
        input.setProgress(0);
    }

    if (!trimmed) {
        input.setNotice("");
        input.setDurationMs(0);
        return false;
    }

    let api: AbcjsApi;
    try {
        api = await loadAbcjs();
    } catch {
        if (token !== input.tokenRef.current) return false;
        input.setNotice("乐谱库没有载入。");
        return false;
    }
    if (token !== input.tokenRef.current) return false;

    let tunes: TuneObject[];
    try {
        tunes = api.renderAbc(paper, trimmed, {
            add_classes: true,
            responsive: "resize",
            staffwidth: Math.max(180, width - 28),
            dragging: false,
            selectionColor: color,
            dragColor: color,
            foregroundColor: color,
            paddingleft: 8,
            paddingright: 8,
            paddingtop: 8,
            paddingbottom: 12,
            wrap: { preferredMeasuresPerLine: 4, minSpacing: 1.5, maxSpacing: 2.6 },
            clickListener: (elem) => {
                if (token !== input.tokenRef.current) return;
                stripSelection(paper, color);
                input.onNoteRef.current(elem);
                queueMicrotask(() => stripSelection(paper, color));
            },
        });
    } catch (err) {
        if (token !== input.tokenRef.current) return false;
        input.setNotice(err instanceof Error ? err.message : "这段谱还画不出来。");
        input.setDurationMs(0);
        return false;
    }
    if (token !== input.tokenRef.current) return false;
    paper.style.overflow = "auto";

    const tune = tunes[0];
    if (!tune || tune.lines.length === 0) {
        input.setNotice(tune?.warnings?.[0] || "这段谱还画不出来。");
        input.setDurationMs(0);
        return false;
    }

    let events: NoteTimingEvent[] = [];
    try {
        events = new api.TimingCallbacks(tune, {}).noteTimings ?? [];
    } catch {
        events = [];
    }
    const { hits, totalMs, pitched } = collectHits(tune, events);
    input.sessionRef.current = {
        totalMs,
        source: trimmed,
        width,
        color,
        hits,
        originMs: 0,
        originTime: input.ctxRef.current?.currentTime ?? 0,
    };
    input.setDurationMs(totalMs);
    input.setNotice(tune.warnings?.[0] || (pitched ? "" : "这段谱没有能发出的音。"));
    if (resumeAt != null && totalMs > 0 && token === input.tokenRef.current) {
        input.playFromRef.current(resumeAt);
    }
    return totalMs > 0;
}

function collectHits(tune: TuneObject, events: NoteTimingEvent[]): { hits: Hit[]; totalMs: number; pitched: boolean } {
    const hits: Hit[] = [];
    const byMs = new Map<number, Hit>();
    let pitched = false;
    try {
        const audio = tune.setUpAudio({ chordsOff: true });
        const bar = tune.getBarLength() || 1;
        const msPerWhole = (tune.millisecondsPerMeasure(audio.tempo) || 2000) / bar;
        for (const track of audio.tracks) {
            for (const item of track) {
                if (!isNote(item) || item.instrument > 127) continue;
                if (!Number.isFinite(item.pitch) || item.pitch < 1) continue;
                const event = eventFor(events, item.startChar);
                const ms = item.start * msPerWhole;
                const key = Math.round(ms);
                let hit = byMs.get(key);
                if (!hit) {
                    hit = { ms, durMs: 0, pitches: [], elements: event?.elements ?? [], ranges: [] };
                    byMs.set(key, hit);
                    hits.push(hit);
                }
                hit.pitches.push({ midi: item.pitch, volume: item.volume || 90 });
                hit.durMs = Math.max(hit.durMs, Math.max(70, item.duration * msPerWhole));
                if (hit.elements.length === 0 && event?.elements?.length) hit.elements = event.elements;
                pushRange(hit, item.startChar, item.endChar);
                pitched = true;
            }
        }
    } catch {
        pitched = false;
    }

    for (const event of events) {
        if (event.type === "end" || event.startChar == null) continue;
        const covered = hits.some(hit => Math.abs(hit.ms - event.milliseconds) < 20
            || hit.ranges.some(range => event.startChar != null && event.startChar >= range.start && event.startChar < range.end));
        if (covered) {
            const hit = hits.find(item => item.ranges.some(range => event.startChar != null && event.startChar >= range.start && event.startChar < range.end));
            if (hit && hit.elements.length === 0 && event.elements?.length) hit.elements = event.elements;
            if (hit && event.startChar != null) pushRange(hit, event.startChar, event.endChar ?? event.startChar + 1);
            continue;
        }
        const hit: Hit = {
            ms: event.milliseconds,
            durMs: 0,
            pitches: [],
            elements: event.elements ?? [],
            ranges: [],
        };
        pushRange(hit, event.startChar, event.endChar ?? event.startChar + 1);
        hits.push(hit);
    }

    hits.sort((a, b) => a.ms - b.ms);
    let totalMs = 0;
    for (const event of events) totalMs = Math.max(totalMs, event.milliseconds || 0);
    for (const hit of hits) totalMs = Math.max(totalMs, hit.ms + hit.durMs);
    return { hits, totalMs, pitched };
}

function eventFor(events: NoteTimingEvent[], start: number | undefined): NoteTimingEvent | undefined {
    if (start == null) return undefined;
    return events.find(event => {
        if (event.type === "end") return false;
        const chars = event.startCharArray?.length ? event.startCharArray : event.startChar != null ? [event.startChar] : [];
        return chars.some(char => char === start) || (event.startChar != null && event.endChar != null && start >= event.startChar && start < event.endChar);
    });
}

function pushRange(hit: Hit, start: number | undefined, end: number | undefined) {
    if (start == null || !Number.isFinite(start)) return;
    const close = end != null && end > start ? end : start + 1;
    if (hit.ranges.some(range => range.start === start && range.end === close)) return;
    hit.ranges.push({ start, end: close });
}

function isNote(item: { cmd: string }): item is AudioTrackNoteItem {
    return item.cmd === "note";
}

function soundHit(hit: Hit, ctx: AudioContext, when: number, seconds: number, voicesRef: { current: Voice[] }) {
    const startAt = Math.max(when, ctx.currentTime);
    const dur = Math.min(6, Math.max(0.06, seconds * 0.94));
    const share = 1 / Math.sqrt(hit.pitches.length);
    for (const pitch of hit.pitches) {
        const freq = 440 * 2 ** ((pitch.midi - 69) / 12);
        if (!Number.isFinite(freq) || freq < 40 || freq > 4200) continue;
        const level = Math.min(0.2, Math.max(0.05, (pitch.volume / 127) * 0.18)) * share;
        playVoice(ctx, voicesRef, "triangle", freq, level * 0.85, startAt, dur);
        playVoice(ctx, voicesRef, "sine", freq, level * 0.45, startAt, dur);
    }
}

function playVoice(
    ctx: AudioContext,
    voicesRef: { current: Voice[] },
    type: OscillatorType,
    freq: number,
    level: number,
    startAt: number,
    dur: number,
) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startAt);
    const attack = Math.min(0.012, dur * 0.25);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), startAt + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + dur + 0.02);
    const voice = { osc, gain };
    voicesRef.current.push(voice);
    osc.onended = () => {
        voicesRef.current = voicesRef.current.filter(item => item !== voice);
    };
}

function stopVoices(voicesRef: { current: Voice[] }, ctx: AudioContext | null) {
    const now = ctx?.currentTime ?? 0;
    for (const voice of voicesRef.current) {
        try { voice.osc.stop(now); } catch { /* already stopped */ }
    }
    voicesRef.current = [];
}

function stripSelection(root: ParentNode, ink: string) {
    root.querySelectorAll(".abcjs-note_selected").forEach(el => {
        el.classList.remove("abcjs-note_selected");
        const attr = el.getAttribute("highlight") || "fill";
        if (ink) el.setAttribute(attr, ink);
    });
}

function audioContext(ref: { current: AudioContext | null }): AudioContext {
    if (!ref.current || ref.current.state === "closed") {
        ref.current = new AudioContext();
    }
    return ref.current;
}

async function loadAbcjs(): Promise<AbcjsApi> {
    const mod = await import("abcjs");
    const named = mod as AbcjsApi & { default?: AbcjsApi };
    if (typeof named.renderAbc === "function") return named;
    if (named.default && typeof named.default.renderAbc === "function") return named.default;
    throw new Error("abcjs");
}

export function formatAbcClock(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
