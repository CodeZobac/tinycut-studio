import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronRight,
  Download,
  Film,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Save,
  ScanLine,
  Scissors,
  Search,
  ShieldCheck,
  Sparkles,
  Subtitles,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { MediaEngine, pcmToWav, type PCM } from "./lib/media";
import {
  makeCandidates,
  rankCandidates,
  subtractRanges,
  toSrt,
  type Clip,
  type Filler,
  type Range,
  type Word,
} from "./lib/editing";
import { runAI, setDesertAntConsent, DESERT_ANT_LICENSE_URL } from "./lib/ai";
import { detectScenes } from "./lib/scenes";

type Tab = "transcript" | "clips" | "fillers" | "scenes";
type Edit = { range: Range; checked: number[] };
type Identity = { name: string; size: number; lastModified: number };
type Project = {
  format: "tinycut-studio";
  version: 1;
  source: Identity;
  duration: number;
  range: Range;
  fillers: Filler[];
  checked: number[];
  words: Word[];
  clips: Clip[];
  scenes: number[];
};
const MAX_SIZE = 200 * 1024 * 1024;
const MAX_DURATION = 20 * 60;
const time = (s: number) =>
  `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, "0")}:${(Math.max(0, s) % 60).toFixed(1).padStart(4, "0")}`;
const identity = (f: File): Identity => ({
  name: f.name,
  size: f.size,
  lastModified: f.lastModified,
});
const matches = (f: File, s: Identity) =>
  f.name === s.name && f.size === s.size && f.lastModified === s.lastModified;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const aborted = (e: unknown) => e instanceof Error && e.name === "AbortError";
const abortCheck = (s: AbortSignal) => {
  if (s.aborted) throw new DOMException("Cancelled", "AbortError");
};
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function validateProject(value: unknown): Project {
  const fail = (): never => {
    throw new Error(
      "Invalid TinyCut project. Expected version 1, matching source identity, and valid bounded edit data.",
    );
  };
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : fail();
  const num = (v: unknown, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
      ? v
      : fail();
  const str = (v: unknown, max: number): string =>
    typeof v === "string" && v.length <= max ? v : fail();
  const arr = (v: unknown, max: number): unknown[] =>
    Array.isArray(v) && v.length <= max ? v : fail();
  const p = obj(value);
  if (
    p.format !== "tinycut-studio" ||
    p.version !== 1 ||
    Object.keys(p).some(
      (k) =>
        ![
          "format",
          "version",
          "source",
          "duration",
          "range",
          "fillers",
          "checked",
          "words",
          "clips",
          "scenes",
        ].includes(k),
    )
  )
    fail();
  const s = obj(p.source);
  const duration = num(p.duration, 0.001, MAX_DURATION);
  const source = {
    name: str(s.name, 1024),
    size: num(s.size, 1, MAX_SIZE),
    lastModified: num(s.lastModified, 0, Number.MAX_SAFE_INTEGER),
  };
  if (
    !source.name ||
    !Number.isInteger(source.size) ||
    !Number.isInteger(source.lastModified)
  )
    fail();
  const range = (v: unknown): Range => {
    const r = obj(v);
    const start = num(r.start, 0, duration);
    const end = num(r.end, 0, duration);
    if (end <= start) fail();
    return { start, end };
  };
  const fillers = arr(p.fillers, 20000).map((v) => ({
    ...range(v),
    confidence: num(obj(v).confidence, 0, 1),
  }));
  const checked = arr(p.checked, fillers.length).map((v) => {
    const n = num(v, 0, fillers.length - 1);
    return Number.isInteger(n) ? n : fail();
  });
  if (new Set(checked).size !== checked.length) fail();
  const words = arr(p.words, 100000).map((v) => ({
    ...range(v),
    text: str(obj(v).text, 10000),
  }));
  const clips = arr(p.clips, 1000).map((v) => ({
    ...range(v),
    id: str(obj(v).id, 200),
    title: str(obj(v).title, 1000),
    text: str(obj(v).text, 100000),
    score: num(obj(v).score, 0, 1),
  }));
  const scenes = arr(p.scenes, 2400).map((v) => num(v, 0, duration));
  if (
    scenes.some(
      (v, i) => v <= 0 || v >= duration || (i > 0 && v <= scenes[i - 1]),
    )
  )
    fail();
  return {
    format: "tinycut-studio",
    version: 1,
    source,
    duration,
    range: range(p.range),
    fillers,
    checked,
    words,
    clips,
    scenes,
  };
}
function probe(file: File, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      const duration = v.duration;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      v.onloadedmetadata = null;
      v.onerror = null;
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(duration);
    };
    const cancel = () =>
      finish(new DOMException("Import cancelled", "AbortError"));
    const timer = window.setTimeout(
      () =>
        finish(
          new Error(
            "Could not read video duration. Try an MP4 with H.264/AAC.",
          ),
        ),
      15000,
    );
    signal.addEventListener("abort", cancel, { once: true });
    v.onloadedmetadata = () =>
      finish(
        !Number.isFinite(v.duration) || v.duration <= 0
          ? new Error("A finite video duration is required.")
          : v.duration > MAX_DURATION
            ? new Error(
                "This video exceeds the conservative 20-minute limit. Trim it first.",
              )
            : undefined,
      );
    v.onerror = () =>
      finish(
        new Error(
          "This browser could not read the video metadata. Try an MP4 with H.264/AAC.",
        ),
      );
    v.preload = "metadata";
    v.src = url;
    if (signal.aborted) cancel();
  });
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [pcm, setPCM] = useState<PCM | null>(null);
  const [enhanced, setEnhanced] = useState<PCM | null>(null);
  const [cleanUrl, setCleanUrl] = useState("");
  const [clean, setClean] = useState(false);
  const [duration, setDuration] = useState(0);
  const [edit, setEdit] = useState<Edit>({
    range: { start: 0, end: 0 },
    checked: [],
  });
  const [history, setHistory] = useState<Edit[]>([]);
  const [words, setWords] = useState<Word[]>([]);
  const [fullText, setFullText] = useState("");
  const [fillers, setFillers] = useState<Filler[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [scenes, setScenes] = useState<number[]>([]);
  const [tab, setTab] = useState<Tab>("transcript");
  const [query, setQuery] = useState("");
  const [threshold, setThreshold] = useState(0.2);
  const [language, setLanguage] = useState("auto");
  const [target, setTarget] = useState(30);
  const [consent, setConsent] = useState(false);
  const [editedPreview, setEditedPreview] = useState(true);
  const [job, setJob] = useState("");
  const [status, setStatus] = useState("Your next great cut starts here.");
  const [error, setError] = useState("");
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState<Project | null>(null);
  const [drag, setDrag] = useState(false);
  const [rangeStart, setRangeStart] = useState("0");
  const [rangeEnd, setRangeEnd] = useState("0");
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const engine = useRef<MediaEngine | null>(null);
  const active = useRef<AbortController | null>(null);
  const sourceRef = useRef("");
  const cleanRef = useRef("");
  useEffect(() => {
    engine.current = new MediaEngine();
    return () => {
      active.current?.abort();
      engine.current?.dispose();
      URL.revokeObjectURL(sourceRef.current);
      URL.revokeObjectURL(cleanRef.current);
    };
  }, []);
  useEffect(() => {
    setRangeStart(String(+edit.range.start.toFixed(3)));
    setRangeEnd(String(+edit.range.end.toFixed(3)));
  }, [edit.range]);
  const keep = useMemo(
    () =>
      subtractRanges(
        edit.range,
        edit.checked.map((i) => fillers[i]).filter(Boolean),
      ),
    [edit, fillers],
  );
  const outputDuration = keep.reduce((sum, r) => sum + r.end - r.start, 0);
  const waveform = useMemo(() => {
    if (!pcm) return [];
    const bars = 140,
      size = Math.max(1, Math.ceil(pcm.samples.length / bars));
    const values = Array.from({ length: bars }, (_, i) => {
      let peak = 0;
      for (
        let j = i * size;
        j < Math.min((i + 1) * size, pcm.samples.length);
        j += 8
      )
        peak = Math.max(peak, Math.abs(pcm.samples[j]));
      return peak;
    });
    const maximum = Math.max(...values, 0.001);
    return values.map((v) => v / maximum);
  }, [pcm]);
  const filteredWords = useMemo(
    () =>
      words.filter(
        (w) =>
          !query ||
          w.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ),
    [words, query],
  );
  const busy = !!job;
  function pause() {
    video.current?.pause();
    audio.current?.pause();
    setPlaying(false);
  }
  function seek(value: number) {
    const t = Math.min(duration, Math.max(0, value));
    if (video.current) video.current.currentTime = t;
    if (audio.current && cleanUrl) audio.current.currentTime = t;
    setCurrent(t);
  }
  function changeEdit(next: Edit) {
    pause();
    setHistory((h) => [...h.slice(-99), edit]);
    setEdit(next);
  }
  function selectRange(range: Range) {
    changeEdit({
      ...edit,
      range: {
        start: Math.max(0, range.start),
        end: Math.min(duration, range.end),
      },
    });
    seek(range.start);
  }
  function commitRange() {
    const start = Number(rangeStart),
      end = Number(rangeEnd);
    if (
      !rangeStart.trim() ||
      !rangeEnd.trim() ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end > duration ||
      end <= start
    ) {
      setError("Set a start before the end, both inside the source duration.");
      return;
    }
    setError("");
    selectRange({ start, end });
  }
  function clearSource() {
    pause();
    URL.revokeObjectURL(sourceRef.current);
    URL.revokeObjectURL(cleanRef.current);
    sourceRef.current = "";
    cleanRef.current = "";
    setFile(null);
    setSourceUrl("");
    setPCM(null);
    setEnhanced(null);
    setCleanUrl("");
    setClean(false);
    setDuration(0);
    setCurrent(0);
    setEdit({ range: { start: 0, end: 0 }, checked: [] });
    setHistory([]);
    setWords([]);
    setFullText("");
    setFillers([]);
    setClips([]);
    setScenes([]);
  }
  async function work(
    name: string,
    media: boolean,
    operation: (signal: AbortSignal) => Promise<void>,
  ) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setJob(name);
    setError("");
    setStatus(name + "…");
    pause();
    try {
      await operation(controller.signal);
      abortCheck(controller.signal);
    } catch (e) {
      if (aborted(e)) {
        if (media) {
          engine.current?.dispose();
          engine.current = new MediaEngine();
          clearSource();
        }
        setStatus(
          media
            ? "Cancelled. Media engine released; reimport the original to continue."
            : "Cancelled. Your source and existing edits are unchanged.",
        );
      } else {
        setError(message(e));
        setStatus("Could not complete this action.");
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setJob("");
      }
    }
  }
  function applyProject(p: Project) {
    setClean(false);
    setEnhanced(null);
    setCleanUrl("");
    URL.revokeObjectURL(cleanRef.current);
    cleanRef.current = "";
    setEdit({ range: p.range, checked: p.checked });
    setFillers(p.fillers);
    setWords(p.words);
    setFullText(p.words.map((w) => w.text).join(" "));
    setClips(p.clips);
    setScenes(p.scenes);
    setHistory([]);
    setPending(null);
    setStatus(
      "Project restored. Enhanced audio is not saved in JSON; run Clear again if needed.",
    );
  }
  async function importFile(next: File) {
    if (active.current) return;
    if (!next.size || next.size > MAX_SIZE) {
      setError(
        "Choose a nonempty video up to 200 MB. This conservative limit protects browser memory.",
      );
      return;
    }
    if (pending && !matches(next, pending.source)) {
      setError(
        `Source mismatch. Reimport “${pending.source.name}” with the same size and last-modified time, or discard the pending project.`,
      );
      return;
    }
    await work("Importing video", true, async (signal) => {
      const seconds = await probe(next, signal);
      abortCheck(signal);
      if (pending && Math.abs(pending.duration - seconds) > 0.1)
        throw new Error("The source duration does not match this project.");
      clearSource();
      try {
        const decoded = await engine.current!.load(next, setStatus, signal);
        abortCheck(signal);
        if (decoded.samples.length / decoded.sampleRate > MAX_DURATION + 1) {
          engine.current?.dispose();
          throw new Error("Decoded audio exceeds the 20-minute limit.");
        }
        const url = URL.createObjectURL(next);
        sourceRef.current = url;
        setSourceUrl(url);
        setFile(next);
        setDuration(seconds);
        setPCM(decoded);
        setEdit({ range: { start: 0, end: seconds }, checked: [] });
        if (pending) applyProject(pending);
        else
          setStatus(
            "Source ready. Trim manually or let a tiny brain lend a hand.",
          );
      } catch (e) {
        clearSource();
        throw e;
      }
    });
  }
  async function loadProject(f: File) {
    await work("Reading project", false, async (signal) => {
      if (f.size > 5 * 1024 * 1024)
        throw new Error("Project JSON must be smaller than 5 MB.");
      const p = validateProject(JSON.parse(await f.text()));
      abortCheck(signal);
      if (
        file &&
        matches(file, p.source) &&
        Math.abs(duration - p.duration) <= 0.1
      )
        applyProject(p);
      else {
        setPending(p);
        setStatus(
          `Project validated. Reimport the original “${p.source.name}” to restore its edits.`,
        );
      }
    });
  }
  function saveProject() {
    if (!file) return;
    const p: Project = {
      format: "tinycut-studio",
      version: 1,
      source: identity(file),
      duration,
      range: edit.range,
      checked: edit.checked,
      words,
      fillers,
      clips,
      scenes,
    };
    download(
      new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }),
      file.name.replace(/\.[^.]+$/, "") + ".tinycut.json",
    );
    setStatus(
      "Project JSON saved. Keep your original video; media and enhanced audio are not embedded.",
    );
  }
  function transcribe() {
    if (!pcm) return;
    void work("Transcribing locally", false, async (signal) => {
      const r = await runAI(
        "transcribe",
        pcm.samples,
        pcm.sampleRate,
        { language },
        setStatus,
        signal,
      );
      abortCheck(signal);
      setWords(r.words);
      setFullText(r.text);
      setClips([]);
      setTab("transcript");
      setStatus(
        r.words.length
          ? `Transcript ready: ${r.words.length} timed words. Review automatic recognition before publishing.`
          : "No timed speech was detected. Manual trimming is still available.",
      );
    });
  }
  function enhance() {
    if (!pcm) return;
    void work("Enhancing audio", false, async (signal) => {
      const r = await runAI(
        "enhance",
        pcm.samples,
        pcm.sampleRate,
        {},
        setStatus,
        signal,
      );
      abortCheck(signal);
      const url = URL.createObjectURL(pcmToWav(r.samples, r.sampleRate));
      URL.revokeObjectURL(cleanRef.current);
      cleanRef.current = url;
      setCleanUrl(url);
      setEnhanced(r);
      setClean(true);
      setStatus(
        "Clear audio is ready. Switch Original / Clean to compare; your original is untouched.",
      );
    });
  }
  function findFillers() {
    if (!pcm) return;
    void work("Finding filler sounds", false, async (signal) => {
      const r = await runAI(
        "fillers",
        pcm.samples,
        pcm.sampleRate,
        {},
        setStatus,
        signal,
      );
      abortCheck(signal);
      setFillers(
        r.fillers.filter(
          (f) => f.start >= 0 && f.end <= duration && f.end > f.start,
        ),
      );
      setEdit((e) => ({ ...e, checked: [] }));
      setHistory([]);
      setTab("fillers");
      setStatus(
        `${r.fillers.length} suggestions found. Nothing is cut until you check it. Previous filler edits and undo history were reset.`,
      );
    });
  }
  function findClips() {
    if (!pcm || !words.length) return;
    void work("Finding highlight candidates", false, async (signal) => {
      const candidates = makeCandidates(words, target).filter(
        (c) => c.end <= duration,
      );
      if (!candidates.length)
        throw new Error("No valid timed passages to rank.");
      const r = await runAI(
        "embed",
        pcm.samples,
        pcm.sampleRate,
        { texts: candidates.map((c) => c.text) },
        setStatus,
        signal,
      );
      abortCheck(signal);
      const ranked = rankCandidates(candidates, r.vectors, 6);
      setClips(ranked);
      setTab("clips");
      setStatus(
        `${ranked.length} local highlight candidates ready. Relevance is not a prediction of virality.`,
      );
    });
  }
  function scanScenes() {
    if (!file) return;
    void work("Detecting scene changes", false, async (signal) => {
      const r = await detectScenes(file, threshold, setStatus, signal);
      abortCheck(signal);
      setScenes(r);
      setTab("scenes");
      setStatus(`${r.length} scene changes detected from actual video frames.`);
    });
  }
  function exportVideo() {
    if (!file || !keep.length || outputDuration <= 0.01) {
      setError(
        "Keep at least one nonempty interval before exporting. Uncheck a filler or expand the selection.",
      );
      return;
    }
    void work("Exporting MP4", true, async (signal) => {
      const blob = await engine.current!.exportVideo(
        keep,
        clean ? enhanced : null,
        setStatus,
        signal,
      );
      abortCheck(signal);
      download(blob, file.name.replace(/\.[^.]+$/, "") + "-tinycut.mp4");
      setStatus("MP4 export downloaded. Your original file was not changed.");
    });
  }
  function exportSubtitles() {
    const text = toSrt(words, keep);
    if (!text) {
      setError("No timed transcript remains inside the kept selection.");
      return;
    }
    download(
      new Blob([text], { type: "application/x-subrip;charset=utf-8" }),
      "tinycut-subtitles.srt",
    );
    setStatus("SRT downloaded, retimed to match the exported cuts.");
  }
  async function togglePlay() {
    if (!video.current || !file) return;
    if (!video.current.paused) {
      pause();
      return;
    }
    if (current < edit.range.start || current >= edit.range.end)
      seek(edit.range.start);
    if (editedPreview && !keep.length) {
      setError("The edited preview has no kept intervals.");
      return;
    }
    try {
      await video.current.play();
    } catch (e) {
      setError(
        `Playback unavailable: ${message(e)}. Try a browser-supported codec. Manual range editing and export remain available.`,
      );
    }
  }
  function syncAudio() {
    const v = video.current,
      a = audio.current;
    if (!v || !a || !clean) return;
    if (Math.abs(a.currentTime - v.currentTime) > 0.15)
      a.currentTime = v.currentTime;
    a.playbackRate = v.playbackRate;
    if (!v.paused && a.paused)
      void a.play().catch((e) => {
        pause();
        setError(`Clean audio playback failed: ${message(e)}`);
      });
    if (v.paused) a.pause();
  }
  useEffect(() => {
    if (video.current) video.current.muted = clean;
    if (!clean) audio.current?.pause();
    else syncAudio();
  }, [clean, cleanUrl]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        if (
          v.currentTime >= edit.range.end ||
          v.currentTime < edit.range.start - 0.05
        ) {
          pause();
          if (v.currentTime >= edit.range.end) seek(edit.range.end);
          return;
        }
        if (editedPreview) {
          const cut = edit.checked
            .map((i) => fillers[i])
            .find(
              (f) => f && v.currentTime >= f.start && v.currentTime < f.end,
            );
          if (cut) {
            if (cut.end >= edit.range.end) {
              pause();
              seek(edit.range.end);
              return;
            }
            seek(cut.end);
          }
        }
        setCurrent(v.currentTime);
        syncAudio();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, edit, fillers, editedPreview, clean, cleanUrl]);
  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href="#workspace"
          aria-label="TinyCut Studio workspace"
        >
          <span className="brand-icon">
            <Scissors size={22} />
          </span>
          <span>
            TinyCut<span className="brand-studio"> Studio</span>
          </span>
        </a>
        <span className="local-chip">
          <span /> LOCAL MEDIA · YOUR DEVICE
        </span>
        <nav className="top-actions" aria-label="Project actions">
          <button
            className="quiet load-project"
            disabled={busy}
            onClick={() => projectInput.current?.click()}
            title="Load editing project JSON"
          >
            <FolderOpen size={16} />
            <span>Open project</span>
          </button>
          <button
            className="quiet"
            disabled={!file || busy || !!pending}
            onClick={saveProject}
          >
            <Save size={16} />
            <span>Save project</span>
          </button>
          <span className="divider" />
          <button disabled={busy} onClick={() => input.current?.click()}>
            <Upload size={15} />
            <span>Import video</span>
          </button>
          <button
            className="primary"
            disabled={!file || busy || !!pending}
            onClick={exportVideo}
          >
            <Download size={15} />
            <span>Export MP4</span>
          </button>
        </nav>
      </header>
      <input
        hidden
        ref={input}
        type="file"
        accept="video/*,.mkv,.mov,.mp4,.webm"
        aria-label="Import video file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importFile(f);
        }}
      />
      <input
        hidden
        ref={projectInput}
        type="file"
        accept=".json,application/json"
        aria-label="Open TinyCut project JSON"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void loadProject(f);
        }}
      />
      {pending && (
        <div className="project-banner">
          <FolderOpen size={18} />
          <span>
            Waiting for original: <b>{pending.source.name}</b> ·{" "}
            {(pending.source.size / 1048576).toFixed(1)} MB. Name, size, and
            last-modified time must match.
          </span>
          <button disabled={busy} onClick={() => input.current?.click()}>
            Reimport original
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setPending(null);
              setStatus("Pending project discarded.");
            }}
          >
            Discard
          </button>
        </div>
      )}
      <main className="workspace" id="workspace">
        <aside className="tools-panel">
          <div className="panel-heading">
            <span className="eyebrow">THE TOOLKIT</span>
            <span className="little-badge">ON DEVICE</span>
          </div>
          <h1>
            Small brains.
            <br />
            <span>Sharp edits.</span>
          </h1>
          <p className="tools-intro">
            A few clever tools. One good story.
            <br />
            You make the final cut.
          </p>
          <div className="tool-card">
            <div className="tool-top">
              <span className="tool-icon">
                <Subtitles size={20} />
              </span>
              <div>
                <h2>Find your words</h2>
                <span>WHISPER TINY</span>
              </div>
              <span className="step">01</span>
            </div>
            <p>
              Turn speech into a searchable,
              <br className="desktop-br" /> time-aligned transcript.
            </p>
            <label className="field-label">
              Speech language
              <select
                aria-label="Speech language"
                value={language}
                disabled={busy}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="auto">Auto-detect</option>
                <option value="english">English</option>
                <option value="portuguese">Portuguese</option>
              </select>
            </label>
            <button disabled={!pcm || busy || !!pending} onClick={transcribe}>
              {words.length ? "Transcribe again" : "Transcribe audio"}
              <ArrowUpRight size={15} />
            </button>
            <small>First run ≈ 40–100 MB + runtime</small>
          </div>
          <div className="tool-card">
            <div className="tool-top">
              <span className="tool-icon violet">
                <AudioLines size={20} />
              </span>
              <div>
                <h2>A little clarity</h2>
                <span>DESERT ANT · CLEAR</span>
              </div>
              <span className="step">02</span>
            </div>
            <p>
              Reduce noise and room echo.
              <br />
              Compare before you commit.
            </p>
            <button
              disabled={!pcm || busy || !consent || !!pending}
              onClick={enhance}
            >
              {enhanced ? "Enhance again" : "Enhance audio"}
              <ArrowUpRight size={15} />
            </button>
            <small>Model + runtime download; size varies</small>
          </div>
          <div className="tool-card">
            <div className="tool-top">
              <span className="tool-icon peach">
                <Scissors size={20} />
              </span>
              <div>
                <h2>Less “uhm.” More you.</h2>
                <span>DESERT ANT · UHM</span>
              </div>
              <span className="step">03</span>
            </div>
            <p>
              Spot filler sounds. Listen back.
              <br />
              Only remove the ones you choose.
            </p>
            <button
              disabled={!pcm || busy || !consent || !!pending}
              onClick={findFillers}
            >
              Find filler sounds
              <ArrowUpRight size={15} />
            </button>
            <small>First model download ≈ 98 MB + runtime</small>
          </div>
          <div className="license-box">
            <label>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => {
                  setConsent(e.target.checked);
                  setDesertAntConsent(e.target.checked);
                }}
              />{" "}
              <span>
                I have read and agree to the{" "}
                <a
                  href={DESERT_ANT_LICENSE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Desert Ant license ↗
                </a>{" "}
                for Clear and Uhm.
              </span>
            </label>
            <p>
              Required before use. Their SDK reports usage metadata, not media.
              Models and runtimes download on demand; internet is required for
              first use. Clear/Uhm inference is not yet verified in this build;
              test on a short clip first.
            </p>
          </div>
          <div className="device-note">
            <ShieldCheck size={17} />
            <span>
              Your media is processed locally.
              <br />
              Your original stays untouched.
            </span>
          </div>
        </aside>
        <section className="editor-panel" aria-label="Video editor">
          <div className="editor-heading">
            <div>
              <span className="eyebrow">WORKSPACE</span>
              <h2>
                {file ? file.name : "Untitled cut"}
                <span className="project-dot" />
              </h2>
            </div>
            <span className="source-pill">
              <Film size={13} />
              {file ? "SOURCE LOADED" : "NO SOURCE YET"}
            </span>
          </div>
          <div
            className={"preview " + (drag ? "dragging" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files[0];
              if (f) void importFile(f);
            }}
          >
            {sourceUrl ? (
              <>
                <video
                  ref={video}
                  src={sourceUrl}
                  playsInline
                  preload="metadata"
                  muted={clean}
                  onPlay={() => {
                    setPlaying(true);
                    syncAudio();
                  }}
                  onPause={() => {
                    setPlaying(false);
                    audio.current?.pause();
                  }}
                  onSeeked={syncAudio}
                  onWaiting={() => audio.current?.pause()}
                  onPlaying={syncAudio}
                  onEnded={pause}
                  onError={() =>
                    setError(
                      "Browser preview cannot decode this codec. Scene detection may also fail; manual range editing and local export are still available.",
                    )
                  }
                  aria-label="Source video preview"
                />
                <span className="preview-badge">
                  {clean ? "CLEAN AUDIO" : "ORIGINAL AUDIO"}
                </span>
              </>
            ) : (
              <div className="empty-preview">
                <div className="film-art" aria-hidden="true">
                  <div className="film-frame back">
                    <span />
                  </div>
                  <div className="film-frame front">
                    <Scissors size={38} strokeWidth={1.4} />
                  </div>
                  <span className="art-spark">✳</span>
                </div>
                <span className="eyebrow">BIG IDEAS. TINY CUTS.</span>
                <h2>Make room for the good parts.</h2>
                <p>Drop a video here. Leave the noise behind.</p>
                <button
                  className="primary import-cta"
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  <Upload size={16} />
                  Choose a video
                </button>
                <small>MP4, MOV, WebM · up to 200 MB / 20 min</small>
              </div>
            )}
          </div>
          <audio
            ref={audio}
            src={cleanUrl || undefined}
            preload="auto"
            onError={() => {
              setClean(false);
              setError(
                "Enhanced audio preview could not load. Original audio is selected.",
              );
            }}
          />
          <div className="transport">
            <div className="time-display">
              <strong>{time(current)}</strong>
              <span>/ {time(duration)}</span>
            </div>
            <div className="play-controls">
              <button
                className="icon-button"
                disabled={!file || busy}
                aria-label="Go to selection start"
                onClick={() => {
                  pause();
                  seek(edit.range.start);
                }}
              >
                <RotateCcw size={16} />
              </button>
              <button
                className="play-button"
                disabled={!file || busy}
                aria-label={playing ? "Pause video" : "Play selection"}
                onClick={() => void togglePlay()}
              >
                {playing ? (
                  <Pause size={19} fill="currentColor" />
                ) : (
                  <Play size={19} fill="currentColor" />
                )}
              </button>
              <span className="selection-label">SELECTION</span>
            </div>
            <div className="audio-toggle" aria-label="Audio comparison">
              <button
                aria-pressed={!clean}
                className={!clean ? "active" : ""}
                onClick={() => setClean(false)}
                disabled={!file}
              >
                Original
              </button>
              <button
                aria-pressed={clean}
                className={clean ? "active" : ""}
                disabled={!enhanced}
                onClick={() => setClean(true)}
              >
                Clean <Sparkles size={11} />
              </button>
            </div>
          </div>
          <div className="timeline-section">
            <div className="timeline-header">
              <div>
                <AudioLines size={16} />
                <h3>Source timeline</h3>
                <span>NON-DESTRUCTIVE</span>
              </div>
              <button
                className="quiet undo"
                disabled={!history.length || busy || !!pending}
                onClick={() => {
                  pause();
                  const previous = history[history.length - 1];
                  setEdit(previous);
                  setHistory((h) => h.slice(0, -1));
                }}
              >
                <RotateCcw size={14} />
                Undo edit
              </button>
            </div>
            <div className="ruler">
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i}>{time((duration * i) / 5)}</span>
              ))}
            </div>
            <div className={"waveform " + (!file ? "empty-wave" : "")}>
              <div className="bars" aria-hidden="true">
                {waveform.map((v, i) => (
                  <i key={i} style={{ height: `${Math.max(3, v * 70)}px` }} />
                ))}
              </div>
              {file ? (
                <>
                  <div
                    className="selection-window"
                    style={{
                      left: `${(edit.range.start / duration) * 100}%`,
                      width: `${((edit.range.end - edit.range.start) / duration) * 100}%`,
                    }}
                  />
                  <div
                    className="playhead"
                    style={{ left: `${(current / duration) * 100}%` }}
                  />
                  {scenes.map((s) => (
                    <span
                      className="scene-marker"
                      key={s}
                      style={{ left: `${(s / duration) * 100}%` }}
                      title={`Scene at ${time(s)}`}
                    />
                  ))}
                  {edit.checked
                    .map((i) => fillers[i])
                    .filter(Boolean)
                    .map((f, i) => (
                      <span
                        key={i}
                        className="cut-marker"
                        style={{
                          left: `${(f.start / duration) * 100}%`,
                          width: `${((f.end - f.start) / duration) * 100}%`,
                        }}
                      />
                    ))}
                  <input
                    className="timeline-seek"
                    type="range"
                    min="0"
                    max={duration}
                    step="0.01"
                    value={current}
                    aria-label="Seek source timeline"
                    onChange={(e) => {
                      pause();
                      seek(Number(e.target.value));
                    }}
                  />
                </>
              ) : (
                <span className="empty-wave-label">
                  Your waveform will appear here
                </span>
              )}
            </div>
            <div className="range-controls">
              <div className="range-fields">
                <label>
                  IN{" "}
                  <input
                    aria-label="Selection start in seconds"
                    type="number"
                    min="0"
                    max={duration}
                    step="0.01"
                    value={rangeStart}
                    disabled={!file || busy || !!pending}
                    onChange={(e) => setRangeStart(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRange();
                    }}
                  />
                </label>
                <span>→</span>
                <label>
                  OUT{" "}
                  <input
                    aria-label="Selection end in seconds"
                    type="number"
                    min="0"
                    max={duration}
                    step="0.01"
                    value={rangeEnd}
                    disabled={!file || busy || !!pending}
                    onChange={(e) => setRangeEnd(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRange();
                    }}
                  />
                </label>
                <button
                  disabled={!file || busy || !!pending}
                  onClick={commitRange}
                >
                  Set range
                </button>
              </div>
              <span className="kept-time">
                {time(outputDuration)} <span>kept</span>
              </span>
            </div>
            <div className="timeline-foot">
              <label>
                <input
                  type="checkbox"
                  checked={editedPreview}
                  onChange={(e) => {
                    pause();
                    setEditedPreview(e.target.checked);
                  }}
                />
                Skip checked fillers in preview
              </label>
              <span>
                <i /> Selection <i className="amber" /> Scene{" "}
                <i className="red" /> Cut
              </span>
            </div>
          </div>
          <div className="memory-notice">
            <HardDrive size={15} />
            <p>
              Built for smaller footage. The 200 MB / 20 min limits are
              conservative, not benchmarked. Decoding, models and export can use
              substantially more memory than the file size. Close other heavy
              tabs.
            </p>
          </div>
        </section>
        <aside className="inspector">
          <div className="inspector-top">
            <span className="eyebrow">THE GOOD PARTS</span>
            <span className="little-badge">REVIEW & REFINE</span>
          </div>
          <div className="tabs" role="tablist" aria-label="Review panels">
            {(["transcript", "clips", "fillers", "scenes"] as Tab[]).map(
              (t) => (
                <button
                  role="tab"
                  aria-selected={tab === t}
                  aria-controls={`panel-${t}`}
                  id={`tab-${t}`}
                  key={t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ),
            )}
          </div>
          <div
            className="tab-content"
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
          >
            {tab === "transcript" && (
              <>
                <div className="search-box">
                  <Search size={15} />
                  <input
                    aria-label="Search transcript"
                    placeholder="Find a word or moment…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="inspector-caption">
                  <span>
                    {words.length
                      ? `${words.length} TIMED WORDS`
                      : "YOUR STORY, IN WORDS"}
                  </span>
                  <button
                    className="quiet icon-button"
                    aria-label="Download cut subtitles as SRT"
                    disabled={!words.length || !keep.length || busy}
                    onClick={exportSubtitles}
                  >
                    <Download size={15} />
                  </button>
                </div>
                {words.length ? (
                  <>
                    <p className="hint">
                      Click a word to jump to its source time.
                    </p>
                    <div className="transcript-words">
                      {filteredWords.map((w, i) => (
                        <button
                          key={`${w.start}-${i}`}
                          className={
                            current >= w.start && current < w.end
                              ? "current-word"
                              : ""
                          }
                          onClick={() => {
                            pause();
                            seek(w.start);
                          }}
                          title={`${time(w.start)}–${time(w.end)}`}
                        >
                          <span>{w.text}</span>
                          <small>{time(w.start)}</small>
                        </button>
                      ))}
                    </div>
                    {!filteredWords.length && (
                      <p className="hint">No matching timed words.</p>
                    )}
                    <details>
                      <summary>Full recognized text</summary>
                      <p className="full-text">{fullText}</p>
                    </details>
                    <button
                      className="wide"
                      onClick={exportSubtitles}
                      disabled={!keep.length || busy}
                    >
                      <Subtitles size={15} />
                      Download edited SRT
                    </button>
                  </>
                ) : (
                  <div className="inspector-empty">
                    <span className="empty-icon">
                      <Subtitles size={27} />
                    </span>
                    <h3>Every word. In its place.</h3>
                    <p>
                      Run Whisper to turn your audio into a timed transcript.
                      Find a moment, then jump right to it.
                    </p>
                    <button
                      disabled={!pcm || busy || !!pending}
                      onClick={transcribe}
                    >
                      Create transcript
                      <ChevronRight size={14} />
                    </button>
                    <small>
                      Automatic transcription can make mistakes.
                      <br />
                      Review before sharing.
                    </small>
                  </div>
                )}
              </>
            )}
            {tab === "clips" && (
              <>
                <div className="section-title">
                  <Sparkles size={17} />
                  <h3>Find the highlights</h3>
                </div>
                <p className="hint">
                  Local MiniLM embeddings rank sentence-aligned candidates for
                  relevance and variety—not virality.
                </p>
                <label className="field-label">
                  Target clip length
                  <select
                    value={target}
                    onChange={(e) => setTarget(Number(e.target.value))}
                  >
                    <option value={15}>About 15 seconds</option>
                    <option value={30}>About 30 seconds</option>
                    <option value={60}>About 60 seconds</option>
                  </select>
                </label>
                <button
                  className="wide"
                  disabled={!words.length || busy || !!pending}
                  onClick={findClips}
                >
                  <WandSparkles size={15} />
                  Find candidates
                </button>
                <p className="hint">
                  Transcribe first. First model download ≈ 120 MB + runtime;
                  estimates vary.
                </p>
                {clips.map((c, i) => (
                  <button
                    className="result-card"
                    key={c.id}
                    onClick={() => selectRange(c)}
                    disabled={busy || !!pending}
                  >
                    <div>
                      <span className="result-number">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span>
                        {time(c.start)} — {time(c.end)}
                      </span>
                    </div>
                    <h4>{c.title}</h4>
                    <p>{c.text}</p>
                    <small>
                      {Math.round(c.score * 100)}% semantic relevance{" "}
                      <ArrowUpRight size={13} />
                    </small>
                  </button>
                ))}
                {!clips.length && (
                  <div className="mini-empty">
                    <Film size={26} />
                    <p>Your candidates will appear here.</p>
                  </div>
                )}
              </>
            )}
            {tab === "fillers" && (
              <>
                <div className="section-title">
                  <Scissors size={17} />
                  <h3>You decide what goes</h3>
                </div>
                <p className="hint">
                  Uhm suggests filler sounds, not mistakes. All new suggestions
                  start unchecked. Listen before removing.
                </p>
                <div className="filler-summary">
                  <span>
                    {edit.checked.length} / {fillers.length} selected
                  </span>
                  <button
                    className="quiet"
                    disabled={!fillers.length || busy || !!pending}
                    onClick={() =>
                      changeEdit({
                        ...edit,
                        checked:
                          edit.checked.length === fillers.length
                            ? []
                            : fillers.map((_, i) => i),
                      })
                    }
                  >
                    {edit.checked.length === fillers.length && fillers.length
                      ? "Deselect all"
                      : "Select all"}
                  </button>
                </div>
                {fillers.map((f, i) => (
                  <div
                    className={
                      "filler-row " +
                      (edit.checked.includes(i) ? "selected" : "")
                    }
                    key={`${f.start}-${i}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Remove filler ${i + 1} at ${time(f.start)}`}
                      checked={edit.checked.includes(i)}
                      disabled={busy || !!pending}
                      onChange={(e) =>
                        changeEdit({
                          ...edit,
                          checked: e.target.checked
                            ? [...edit.checked, i]
                            : edit.checked.filter((n) => n !== i),
                        })
                      }
                    />
                    <button
                      className="filler-listen"
                      onClick={() => {
                        pause();
                        seek(Math.max(edit.range.start, f.start - 0.25));
                      }}
                    >
                      <strong>Filler suggestion {i + 1}</strong>
                      <span>
                        {time(f.start)} – {time(f.end)} ·{" "}
                        {Math.round(f.confidence * 100)}%
                      </span>
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Select and audition filler ${i + 1}`}
                      disabled={busy || !!pending}
                      onClick={() => {
                        selectRange({
                          start: Math.max(0, f.start - 0.3),
                          end: Math.min(duration, f.end + 0.3),
                        });
                        setEditedPreview(false);
                      }}
                    >
                      <Play size={14} />
                    </button>
                  </div>
                ))}
                {!fillers.length && (
                  <div className="mini-empty">
                    <AudioLines size={26} />
                    <p>Run Uhm to review real suggestions.</p>
                    <button
                      disabled={!pcm || busy || !consent || !!pending}
                      onClick={findFillers}
                    >
                      Find filler sounds
                    </button>
                  </div>
                )}
              </>
            )}
            {tab === "scenes" && (
              <>
                <div className="section-title">
                  <ScanLine size={18} />
                  <h3>A change of scene</h3>
                </div>
                <p className="hint">
                  Compare actual frames every 0.5 seconds. Lower thresholds
                  detect subtler changes; motion can also trigger a marker.
                </p>
                <label className="field-label">
                  Visual difference threshold{" "}
                  <strong>{threshold.toFixed(2)}</strong>
                  <input
                    aria-label="Scene detection threshold"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  />
                </label>
                <button
                  className="wide"
                  disabled={!file || busy || !!pending}
                  onClick={scanScenes}
                >
                  <ScanLine size={15} />
                  Detect scenes
                </button>
                <p className="hint">
                  No model download. Requires browser codec support. If
                  detection fails, manual editing still works.
                </p>
                {scenes.map((s, i) => (
                  <button
                    className="scene-row"
                    key={s}
                    disabled={busy || !!pending}
                    onClick={() =>
                      selectRange({ start: s, end: scenes[i + 1] ?? duration })
                    }
                  >
                    <span>
                      <ScanLine size={15} />
                      Scene boundary {i + 1}
                    </span>
                    <b>{time(s)}</b>
                  </button>
                ))}
                {!scenes.length && (
                  <div className="mini-empty">
                    <ScanLine size={26} />
                    <p>No scene boundaries yet.</p>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="inspector-footer">
            <Scissors size={14} />
            <a
              href="https://desertant.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Powered by Desert Ant Labs
            </a>
          </div>
        </aside>
      </main>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <footer className="statusbar">
        <div className="status-message" role="status" aria-live="polite">
          {busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Check size={14} />
          )}
          <span>{status}</span>
        </div>
        {busy && (
          <button className="cancel" onClick={() => active.current?.abort()}>
            <X size={13} />
            Cancel{" "}
            {job.includes("Import") || job.includes("Export")
              ? "& release media"
              : ""}
          </button>
        )}
        <span className="status-tail">
          LOCAL PROCESSING <span>·</span> ORIGINALS PRESERVED
        </span>
      </footer>
    </div>
  );
}
