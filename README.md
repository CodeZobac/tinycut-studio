# TinyCut Studio

A local-first browser video editor built around **small specialist brains**, not a cloud editing backend. Import footage, transcribe speech, find highlights and scene changes, review filler cuts, clean up the voice track, and export a new MP4. Your original stays untouched.

**Status: initial working implementation, not a production-certified release.** Real transcription, embeddings, media export, and editor flows have been tested. Desert Ant Clear and Uhm are implemented but their actual model inference has **not** been exercised in this build: a human must first review and accept the Desert Ant license in the app. Do not treat static integration tests as model-quality verification.

## Run locally

Node.js 22+ and npm are required. These commands run on your own computer:

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. `dev` and `build` prepare the installed WASM assets automatically; weights download only when a model is first used. There are no API keys or media-processing servers.

```sh
npm run build
npm run preview
```

The built `dist/` folder can be served on HTTPS (or localhost). No hosting service is configured and this repository is **not** itself a deployed editor. Runtime files are large; ensure your host permits the emitted WASM file sizes and serves `.wasm` with `application/wasm`. No COOP/COEP headers are needed for the single-thread paths tested here. Allow same-origin workers, Blob workers, dynamic module imports, WASM execution, model downloads from Hugging Face and its redirect hosts, and Desert Ant's SDK reporting endpoints. Do not deploy a restrictive CSP without testing these requirements.

## Editing workflow

1. Import a browser-readable video with audio. Start with a short MP4 (H.264/AAC) or WebM. The UI guards at 200 MB / 20 minutes; these are conservative limits, **not** measured device capacity guarantees.
2. Set source IN/OUT times manually, or transcribe locally with Whisper Tiny. Select English, Portuguese, or automatic language detection; click transcript words to seek.
3. In **Clips**, choose a target duration and rank sentence-aligned passages using local embeddings. These are semantic relevance suggestions, not predictions of virality or equivalents to Desert Ant Clips.
4. In **Scenes**, scan actual decoded frames for visual changes. Sensitivity is adjustable. A marker is a visual boundary, not necessarily a story boundary.
5. Optionally review the Desert Ant terms and check the license acknowledgment. Clear enhances speech; Uhm proposes acoustic filler intervals. All detected fillers start **unchecked**. Audition and select the ones to remove. English is Uhm's training language; Portuguese filler accuracy is unverified.
6. Switch Original/Clean to compare audio. Enhanced audio is mono; original export retains the source audio path unless Clean is selected. Use Undo to revert range/filler edits.
7. Export MP4 or matching SRT captions. Export uses the same kept intervals for video, audio, and caption retiming. MP4 is H.264/AAC and resized to a maximum dimension of 1280 pixels. It is re-encoded, not a lossless remux.
8. Save project JSON to retain transcript, markers, selection and filler decisions. The JSON contains **no media**, but its transcript can be sensitive. Reload it and reimport the same original file (name, size, modification time, and duration must match). Enhanced PCM is not saved; run Clear again after restoration.

## The tiny brains

| Job                       | Implementation                                                                         | Execution                                                     |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Transcription             | `Xenova/whisper-tiny`, pinned attention-enabled multilingual ONNX export               | Transformers.js, WASM worker; real word alignment             |
| Voice enhancement         | Desert Ant **Clear** 3.3.0 SDK                                                         | Browser WASM/LiteRT worker; unmodified SDK                    |
| Acoustic filler detection | Desert Ant **Uhm**, pinned fp32 ONNX                                                   | ONNX Runtime Web worker; 30-second windows, overlap averaging |
| Highlight ranking         | Multilingual MiniLM embeddings plus centrality/diversity and sentence-boundary ranking | Transformers.js WASM worker + deterministic selection         |
| Scene changes             | Pixel differences at 64×36, sampled every 0.5 s                                        | Local browser video/canvas; no model download                 |
| Media decode/export       | FFmpeg.wasm single-thread core                                                         | Dedicated local worker                                        |

Desert Ant **Voz** has no web build; **Clips** has no supported web SDK. This implementation uses the user's approved local alternatives rather than presenting unavailable APIs as working integrations. This project is not affiliated with Desert Ant Labs.

### Architecture

- `src/App.tsx`: editor UI, explicit license gate, serial cancellable job lifecycle, validated project persistence.
- `src/lib/ai.ts`: typed disposable-worker API. Caller PCM is copied rather than detached. A job is terminated on completion, error, or cancellation.
- `src/workers/ai.worker.ts`: real model providers. No network inference fallback or invented timestamps.
- `src/workers/ai-dsp.ts`: antialias resampling, Uhm normalization and posterior grouping.
- `src/lib/media.ts`: 48 kHz mono working PCM, immutable source video, matched trim/atrim/concat, MP4 export. Speech recognition and Uhm separately resample to 16 kHz.
- `src/lib/editing.ts`: bounded interval algebra, highlight candidates/ranking, retimed SRT.
- `src/lib/scenes.ts`: cancellable frame sampling with codec/time-out errors and resource cleanup.
- `scripts/*prepare*`: copy installed runtime assets, never model weights.

Only one heavy job runs at a time. Cancelling media import/export terminates the FFmpeg engine and requires reimport; cancelling AI leaves source and edits intact. Models are lazy-loaded, and their workers are discarded after a job. Cached models may be evicted by browser quota/private browsing. The application is not an installed offline PWA, and offline reload is not guaranteed.

## Privacy and licensing

Processing is local, but **local does not mean zero network traffic**. Model/runtime downloads occur, and the unmodified Desert Ant SDK sends usage metadata. No audio/video upload backend exists in this application. No analytics SDK is added by TinyCut. See [PRIVACY.md](PRIVACY.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Clear/Uhm are **source-available, not generally open-source models**. Their app checkbox links the [Desert Ant license](https://license.desertant.com/1.0). Free use thresholds and commercial terms apply. The app never checks that box automatically. Model weights, SDK binaries and generated runtime copies are not committed to this repository.

The FFmpeg core uses GPL-2.0-or-later and includes codecs with separate distribution considerations. Before distributing a hosted/downloadable build, review the full dependency and model license obligations, including source/notice requirements and compatibility. This initial repository does not select a license for original application code or assert commercial redistribution clearance.

[Powered by Desert Ant Labs](https://desertant.com/)

## Verification

```sh
npm test                         # deterministic unit/contract tests
npm run build                    # strict TypeScript + production bundle
npm audit                        # dependency advisory scan
```

Real editor tests require native FFmpeg/ffprobe plus Playwright Chromium. On a development machine with FFmpeg installed:

```sh
npx playwright install chromium
node scripts/create-fixtures.mjs
npm run build
npm run test:e2e
TINYCUT_REAL_MEDIA=1 npm test
```

Real Whisper/MiniLM smoke (downloads open model weights; no Desert Ant license acceptance):

```sh
node scripts/verify-ai.mjs --models
```

The smoke uses a public JFK speech fixture unless `--fixture=/absolute/path/speech.wav` is supplied. It verifies actual word timing and 384-dimensional normalized embeddings. `node scripts/verify-ai.mjs` without the flag exercises the worker/consent/runtime paths without loading models.

See [VERIFICATION.md](VERIFICATION.md) for evidence and deliberate gaps. CI runs unit tests, the production build, and synthetic browser edit/export tests. Clear/Uhm inference is **not** claimed by CI and no license is accepted by automation.

## Known limits

- Clear is for speech, not a music-preserving mix or overlapping-speaker separation. Listen before exporting.
- Uhm confidence is a model score, not a guarantee. Its raw-ONNX adapter is not an official web SDK.
- Short transcripts may yield few highlights. Long sentences may exceed target duration. Missing word alignment is reported, never fabricated.
- Pixel-difference scenes can confuse motion/flashes with edits and miss sub-half-second cuts.
- Browser preview/scene support depends on codecs. Import rejects videos whose duration the browser cannot read, even if FFmpeg could decode them.
- Full footage and decoded PCM use memory; long/4K files can exceed browser capacity. Export is capped at 1280 pixels, not advertised as 4K editing.
- This is a single-source editor, not a multi-track NLE, automatic portrait reframer, or collaborative cloud project system.
