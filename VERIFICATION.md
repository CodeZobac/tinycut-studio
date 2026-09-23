# Verification — 23 September 2026

This document distinguishes executed behavior from integrations that are only implemented. Tests ran in Node 24 on Linux with Playwright Chromium against the actual production bundle.

## Passed

- Strict TypeScript checking and Vite production build.
- **84 tests** with `TINYCUT_REAL_MEDIA=1 npm test`, including actual Chromium FFmpeg WASM import/export/cancellation. The default `npm test` runs 83 and deliberately skips the optional real-media test.
- **3 Playwright end-to-end tests** on the full editor: responsive empty state/consent gate; real WebM import, waveform, scene scan, range edits, undo, project save/load, checked-cut application, caption retiming and MP4 export; invalid-project/range handling.
- Actual local Whisper Tiny ONNX inference: an 11-second public speech fixture returned **22 timestamped words**. The final pin is `Xenova/whisper-tiny` at `5332fcc35e32a33b86612b9a57a89be7906102b1`. An initially considered onnx-community export lacked cross-attention outputs and was replaced with this verified export of the same Whisper Tiny model. No equal-spaced/fabricated timestamps are used.
- Actual multilingual MiniLM inference: three finite normalized **384-dimensional vectors** in worker smoke tests. The full editor also generated a real highlight candidate from the recognized speech and downloaded a matching SRT.
- Actual UI model workflow via `scripts/verify-editor-ai.mjs`: import, language selection, transcription, semantic ranking, selecting the candidate and caption download. No page errors or non-GET/HEAD requests were observed. The Desert Ant consent box remained unchecked.
- Actual scene scan found the boundary at **4.0 seconds** in a synthetic red/blue WebM, without a scene model or fabricated marker.
- Full-editor MP4 test: source selection 1–7 seconds minus a deliberately seeded 3–4-second cut yielded approximately **5 seconds**, H.264 video plus AAC audio. The seeded project tests edit restoration/export, not Uhm inference.
- Media-engine test: two noncontiguous one-second intervals produced **2.000-second**, 1280×720 H.264/AAC outputs. Independently decoded video/audio with native FFmpeg; original audio RMS ≈0.088, test replacement silence RMS 0. This replacement is synthetic PCM to test synchronization, not claimed Clear output.
- Worker cancellation, consent rejection at both API/worker boundaries, and separate private ORT runtime assets.
- `npm audit`: **0 known vulnerabilities** at verification time. Vite/Vitest were updated; Node-only sharp was overridden to a patched version. An audit is not a security guarantee.

## Clear/Uhm runtime follow-up

After the project owner explicitly accepted the Desert Ant license, a production-worker smoke processed the first three seconds of public JFK speech:

- Clear produced 144,000 finite samples at 48 kHz (exactly three seconds). Input RMS was approximately 0.1804 and mastered output RMS 0.0913. This establishes valid nonempty audio and matching timing, not an objective improvement in quality.
- Uhm executed its real ONNX graph and returned an empty filler list on that segment. No fillers were inserted or simulated. Positive filler recall is not established by this fixture.
- Observed one 211-byte POST to `https://platform.desertant.ai/api/v1/ingest`, with top-level fields `app`, `events`, `platform`, `sdk`, and `sentAt`. No media upload request was observed. No failed HTTP requests occurred.
- The runtime emitted expected GPU/NPU-unavailable diagnostics, then completed using CPU WASM.
- Fixed Clear startup: LiteRT resolves its relative WASM against the classic worker URL. A Blob worker caused an invalid relative URL. The classic bootstrap is now served beside the LiteRT assets; no SDK code, licensing behavior or telemetry was modified.

Reproduce only after human acceptance of the linked license:

```sh
npm run prepare:assets
node scripts/verify-desert-ant.mjs --accept-license
```

The explicit flag is never enabled by CI. Each app session still starts with its consent checkbox unchecked.

## Not yet verified

- **Clear enhancement quality and Uhm precision/recall on representative recordings.** The runtime smoke below confirms real inference and output shape, not quality or reliable positive filler detection. Broader labeled recordings and listening tests are still needed.
- SDK reporting across long sessions, other devices, offline operation and cancellation. The short successful inference showed one usage event; this is not a comprehensive telemetry audit.
- Portuguese transcription quality and Portuguese filler recall; the app supports selecting Portuguese, but the recorded speech acceptance test is English.
- Very long, 4K or high-bitrate projects, low-memory devices, mobile browsers, Safari and Firefox. The 200 MB / 20-minute guard is not a measured capacity claim.
- Frame-accurate browser preview of edits. Export applies source intervals through FFmpeg; in-browser skipping is an approximate editorial preview.
- Public hosted deployment, application-source licensing, and commercial redistribution compliance.

## Browser codec caveat

The test Chromium build can preview WebM but omits proprietary H.264/AAC playback. FFmpeg WASM still creates valid MP4s, and native FFmpeg independently decodes them. Consequently, full UI tests use WebM inputs. This is not evidence that every user's browser supports every input codec.

## Reproduce

Install Node 22+, npm, native ffmpeg/ffprobe and Playwright Chromium, then:

```sh
npm ci
npm run build
npm test
node scripts/create-fixtures.mjs
npm run test:e2e
TINYCUT_REAL_MEDIA=1 npm test
node scripts/verify-ai.mjs --models
node scripts/verify-editor-ai.mjs
npm audit
```

The optional model scripts download public open-model weights and a public speech fixture. They never consent to Desert Ant licensing. Model tests are opt-in rather than part of normal CI; deterministic CI remains independent of large model downloads. Browser screenshots and export probes are saved under ignored local test-output directories, not added to the public source repository.
