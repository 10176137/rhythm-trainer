# Rhythm Trainer — Frontend Workbench 0.6.0

React + TypeScript + Vite practice workspace, wired to the **local Rust engine service**. All rhythm scoring, replay reports and coaching analysis come from the Rust core through the engine service; the page never scores anything itself (see `docs/DESIGN.md`).

## Included

- Practice-mode registry: rhythm, score following, hands, loop, free play.
- Shared practice workspace with 72 BPM / both hands / real-time feedback defaults.
- **Engine bridge** (`src/services/engineBridge.ts`) + shared protocol DTOs (`src/types/engine.ts`).
- **Centralized session state machine** (`src/features/practice/usePracticeSession.ts`): idle → countdown → running ↔ paused → processing → completed. Pause/resume shifts remaining targets (mirroring the core), so paused time never becomes a timing error.
- **Absolute-timeline metronome** (`src/features/practice/metronome.ts`): Web Audio clicks scheduled from the target schedule, cancelled on pause and re-anchored on resume.
- Final **report panel** with engine replay statistics, trustworthiness badge, evidence-based diagnostics and one exercise prescription.
- **Practice history** (练习记录): every finished session is persisted by the engine service (atomic JSON in `%APPDATA%/rhythm-trainer-frontend/`) and browsable in-app with the full replay report.
- **Named MusicXML library** (乐谱库): imported `.musicxml` files are stored by the engine under `%APPDATA%/rhythm-trainer-frontend/scores/` as `scores/<id>.musicxml` + `.meta.json`; the settings panel can load by name and rename, replace or delete entries. Raw XML is shared by every browser/device using the same engine; parsing still happens in the browser.
- **Ability profile** (能力画像): per-mode mastery state from the Rust `StudentModel` (evidence-gated: untrusted or too-short sessions never count), plus a recent MAE trend chart. States are tentative learning decisions, not certifications.
- Pitch checking is a separate hint dimension — it never modifies rhythm grades.
- **Node MIDI Adapter** (`@julusian/midi`) is the production device path: server-side enumeration/open/close, `sourceSeq`, Node monotonic capture time, connection generation, bounded queue, hotplug polling, a live input monitor, and a per-Take JSONL Trace + manifest. `src/features/midi/midiAdapter.ts` is retained only as a legacy/dev browser adapter and is no longer used by the UI.
- Device panel: server-provided input list, refresh/select/connect/disconnect, input health, Note On/Off/pitch/velocity/seq/time monitor, and distinct backend/open error states.
- Simulated keyboard for development; it is disabled while a physical device is connected so a Take has one input source.
- **Mode → ScoringConfig resolution** (`server/mode-config.mjs`, versioned `mode-config-1.0.0`): each mode carries its own judgment-profile default, duration policy, pitch-hint and diagnosis scope; not-applicable knobs are rejected loudly instead of silently ignored; every Take's report embeds the effective config snapshot + config/core algorithm versions.
- **MusicXML / Score Engine v1.0** (`src/score-engine/`): independent browser-side semantic importer (`ScoreDocument`, `RationalBeat`, `ImportReport`, stable IDs/SHA-256), PlaybackPlanner/TempoMap (range, loop, occurrences, onset groups, tie continuation suppression), strict-support gating, and an OSMD 2.2.1 `ScoreViewAdapter` mapping spike. Unsupported repeat/ending, tempo curves, grace/cue, microtones and invalid notation are warned or blocked from strict scoring; this is **not** full MusicXML support. See `docs/MUSICXML_SCORE_ENGINE_IMPLEMENTATION.md`.
- **Follow-me waiting practice** (`跟手等待`, default): the score cursor never advances on a timer; it waits for the current target's full pitch set and advances only after the user plays it. Wrong pitches/extra notes are recorded without moving the cursor; per-target “standard” compares pitch/order, chord spread and the interval between consecutive correct onsets against the notated durations at the chosen BPM. This is deliberately **not** a fixed-clock strict score; switch `练习推进` to `固定时间` for the Rust strict timeline.
- **Reference Playback P0** (`src/features/playback/*`, `reference-playback-plan.ts`): the system duet now consumes the same hand-filtered `PlaybackPlan` as scoring, validates its target count/time against the engine, and schedules a local synthesized piano on the shared AudioContext with a look-ahead window. Note-off times come from each occurrence's own written duration (a short bass note no longer inherits a sustained chord's duration). It publishes a `PlaybackSnapshot` (run id, status/health, position, clock id/quality, current score events), emits `reference_playback.*` diagnostics for prepare/start/pause/resume/stop/complete, all-notes-off, underrun and clock suspension, and pauses the Take when the audio clock is lost. Audio-only hand mute, repeats and a sampled piano remain future work; the engine still owns scoring.
- **A1 score library and reader** (`/scores`, `/reader`): the library lists persisted `.musicxml` entries with a bounded ImportReport summary (`READY` / warnings / restricted / failed / unverified / stale / missing), supports search, rename, delete, refresh and an import preview with grouped issues. A1 accepts `.musicxml` only (`.mxl` is rejected); failed imports never overwrite an existing same-name score. The reader uses OSMD display-only, defaults to fit-width with no horizontal scroll, supports reading zoom, cleans up on score switch, and only enables “开始练习” when the current ImportReport allows strict practice and the notes are supported. Old library records are revalidated when opened and their status is backfilled.
- **A2 device readiness and practice guard**: `/device` reuses the Node MIDI bridge for connection status, device selection, live Note On/Off and held-note warnings without creating a Take. The existing settings panel now exposes an effective-config summary, a default three-second count-in, single-pass loop limitation, Continue/new-round semantics and an explicit uncalibrated audio-output notice; unsaved drafts cannot start a round. Active/paused/preparing practice now requires “stay / finish and leave”, waits for the existing stop/finalize report, blocks navigation when the report could not be persisted, warns on browser unload, and guards browser back. The practice summary remains the real onset/duration/diagnostic data only; no pitch/overall/measure diagnosis is implied.
- **B1 full scoring chain (P08)**: the frontend derives per-note `scoreEvents` from the **same hand-filtered `PlaybackPlan` occurrences** that produce practice atoms and reference playback, then sends them with `start`. After the Take stops, the engine service builds performed notes from Rust key-lifecycle observations, filters count-in input, shifts target onsets across pause intervals, and calls the existing **Rust `score_performance` (`scoring_v1`)** through the new NAPI `scorePerformance` export. The returned report contains per-note event results, pitch/onset/rhythm/duration/continuity, measure rollups, confidence, diagnostics and practice ranges. `AVAILABLE` / `DEGRADED` / `INSUFFICIENT_DATA` / `UNAVAILABLE` / `INVALID` are explicit: low-confidence evidence is **数据不足**, not a zero; Overall is withheld when degraded or renormalized; free/legacy/old records show 完整评分不可用 instead of a fabricated score. The report is persisted with the Take config snapshot and algorithm/config versions, rendered by `FullScoreReport` in both the live report and history, and covered by Rust, NAPI, server-selftest, React-render and browser checks. This is post-Take scoring, not live scoring. A real `MEDELI SP-A500` was later connected and its Note On/Off stream (76 events, healthy, no queue drops) was received by the Node adapter; a full hardware Take/scoring run is still pending.
- **B2 teaching prescriptions and targeted retry (P09)**: `teachingPrescription.ts` is a pure rule selector over the existing Rust report, event results, measure rollups, practice ranges and duration assessments; it does not recompute scoring. It only emits executable prescriptions for `AVAILABLE` evidence with a concrete measure, blocks global-only rhythm/offset diagnostics, unmeasured `EXTRA`, `AMBIGUOUS` pairings and unknown/missing-release duration data, and marks “no evidence” instead of inventing a task. P09 is rendered inside the P08 report (live and history) with evidence, recommended measure/BPM/hand/mode, editable BPM/hand, one selected single-range task, and an explicitly labelled user-selected manual range. Confirming arms a new targeted task and returns to the practice room; pressing `开始练习` creates the new PracticeSession/Take through the existing launch chain with loop range, source report/Take/prescription references and the score fingerprint; the server validates the immutable source record, rejects duplicates/failed initialization, and persists the source fields. Retry reports load a comparison computed by the server only when both reports are `AVAILABLE`, share the score fingerprint and scoring versions, and show limitations for BPM/hand/mode/range differences; no fake progress is shown when either report is not comparable. loop remains a single pass over the selected range. The B2 audit is `B2_TEACHING_AUDIT.md`. Real-device Note On/Off was verified through the Node adapter; a real hardware `AVAILABLE` Take (`s-1792769578764-7`, 4/4, Overall 83.97, MAE 46.1 ms) and the real P09 prescription from `s-1792767914539-5` are recorded in `B2_1_HARDWARE_ACCEPTANCE_REPORT.md`. A successful hardware P09 retry comparison, controlled-error Take and physical disconnect/old-epoch boundaries remain pending.
- **Mode integration**: the sidebar exposes three base modes (rhythm, score, free). Hand selection is the integrated hand-practice setting (`练习手 / 分手练习`), and score practice has a `只练所选小节（loop）` switch with a range. Internally these map to the existing engine modes (`hands` / `loop`) so scoring config, history and comparison semantics remain compatible; no separate mode cards are needed.
- **Saved Take templates**: `/api/take-templates` supports list/create/read/update/delete of reusable practice setups (score fingerprint, mode, BPM, hand, loop range, judgment/duration/advance settings). In settings, choose and apply a saved Take; starting practice creates a new Session/Take linked by `takeTemplateId`/`takeTemplateName`, and history shows the association. The template is not a performance record and is never overwritten; `/workbench?takeTemplate=<id>` applies one automatically on load (used for tablet/alternate-device setup), then removes the query. Cross-device continuation of an active Take remains a separate future capability.
- **Score-reading assist v2** (`src/features/score/*`, `ScoreViewer`): All scores render through a **professional OSMD 2.2.1 / Bravura engraver** (proper noteheads, stems, beams, rests, ties and ledger lines; active target highlighted; click for details). The old hand-drawn SVG score has been removed. Timeline practice starts the engine immediately and counts down to the **backend-authoritative first-note time** (`started.firstTargetAtMs`, a default 3-second preparation plus any leading rest); the preparation is converted to the current tempo's beats (2 at 40 BPM, 4 at 80 BPM, 6 at 120 BPM), and the overlay clears exactly when the first note is due. Follow/free practice use a separate 3-second preparation layer. Follow is signal-driven: it scrolls only after the current target is played correctly (or follow is re-enabled); time advances, misses and manual scrolling never yank the page back. A **system duet** toolbar option (on by default) runs the Reference Playback controller on the fixed timeline (turning it on switches from follow to fixed-time): it plays the shared target plan with per-voice durations, count-in, pause/resume/all-notes-off and a playback snapshot, and marks system-played notes red as they sound. Colors: red = system-played, blue = your correct hits, green = current expected target (user-paced even on the fixed clock: it stays until you play it). A separate **system music** toggle mutes/unmutes the system sound; the red visual part keeps advancing when muted. Your input is still judged independently. The professional score uses a fixed ~1510px natural width and is never compressed: narrow cards scroll horizontally, wide windows show the full page centered. During practice the pane scrolls vertically to the current system; the follow toggle is in the score toolbar. The last library score is remembered in `rhythm-trainer.active-score.v1` and restored after a refresh. Note-name and line/space hints are opt-in from `练习设置`; selected-note details and the C2–B5 virtual keyboard appear on click. A **limited browser-side MusicXML importer** handles simple single/grand-staff scores (G2/F4 clefs, notes/rests/chords/backup, accidentals, ledger lines); it is not a full MusicXML parser. The built-in `谱表外示例` demonstrates notes above/below the five lines.

## Run locally

Requirements: Node.js 20+, and the Rust core native addon built once.

```bash
# 1) Build the native addon (first time only)
cd ../rhythm-trainer-core-v0.2/bindings/node
npm install && npm run build

# 2) Frontend deps + engine service
cd ../../../rhythm-trainer-frontend
npm install
npm run server          # engine service on http://127.0.0.1:8788 (loopback only)
```

Development (hot reload, Vite proxies /ws to the engine service):

```bash
npm run dev             # open the URL Vite prints (http://127.0.0.1:5173)
```

LAN access (iPad / practice-room tablet): the Vite dev server binds all interfaces, so it also prints a `Network` URL like `http://<your-LAN-IP>:5173`. To expose the engine service itself, start it with `HOST=0.0.0.0 npm run server`. First time from another device, allow Node.js through the Windows firewall prompt (or add an inbound rule for ports 5173/8788). Both addresses serve the same workbench; scoring stays on the machine that runs the engine service.

Production-like (the engine service serves the built page):

```bash
npm run build
# with npm run server already running, open http://127.0.0.1:8788
```

MIDI probe (no scoring, no history; use it before the app):

```bash
npm run midi:probe                          # list input ports
npm run midi:probe -- --device node-midi:0  # open by id
npm run midi:probe -- --device 0            # open by list index
npm run midi:probe -- --device "MEDELI SP-A500" --json
```

The probe prints platform, Node version, MIDI backend/version, port names, and then `seq/timestamp/generation/type/channel/note/velocity/raw bytes` for each message. It does not start a session or write practice data.

Server MIDI API:

```text
GET  /api/midi/devices   # normalized input list + adapter status
GET  /api/midi/status    # connection/health/queue counters
GET  /api/midi/trace     # bounded raw+normalized Node trace (JSON)
GET  /api/traces/:id     # persisted per-Take trace (manifest + JSONL events)
GET  /api/journals/:id   # persisted per-Take journal (ordered lifecycle events)
GET  /api/sessions/:id/replay  # deterministic replay of the Take trace through the Rust core
GET  /api/scores         # named MusicXML library (metadata only)
POST /api/scores         # create { name, fileName, xml }
GET  /api/scores/:id     # metadata + raw xml
PUT  /api/scores/:id     # rename and/or replace { name?, fileName?, xml? }
DELETE /api/scores/:id   # remove the entry and its raw XML
WS   /ws                 # midi-refresh / midi-connect / midi-disconnect,
                         # midi-status / midi-devices / midi-event / diagnostic,
                         # clock-ping/pong/sample for Node→browser time mapping
```

Engine service self test (spawns its own server instance on a scratch port + throwaway data dir, never touches your data):

```bash
npm run selftest        # 155 assertions; exits non-zero on failure
npm test                # 175 vitest assertions (score-engine, prescriptions, scoring report, OSMD, library, UI fixtures)
```

## Try it

1. Keep the default `乐谱跟练`, `72 BPM`, `双手`, `标准判定`, `实时反馈`.
2. Click `开始练习` — the engine starts immediately; the overlay uses a default 3-second preparation (converted to beats at the current tempo) and ends exactly at the first note, including any leading rest.
3. The default `练习推进` is `跟手等待`: the cursor stays on the current target until you play the full target pitch set, and wrong notes are recorded without advancing. `固定时间` switches back to the automatic Rust timeline. Open `练习设置` to enable `音名提示` / `线间提示`; click any note for details.
4. In `练习设置 → 乐谱来源`, use `导入 MusicXML` for a simple score, `谱表外示例` for above/below-staff notes, or `恢复默认乐谱` for the 4-bar practice score. A successful import is also saved to `乐谱库` under the file name; the library row can load it by name, rename it, replace its XML, or delete it.
5. In the device panel, select `MEDELI SP-A500` and click `连接`; play the highlighted notes. The virtual keys remain available only while no physical device is connected.
6. Watch live grades (最近判定), engine progress and pitch hints (pitch mismatches are shown but never counted as rhythm errors).
7. Pause mid-session and resume — remaining targets shift; the paused time does not appear as timing error.
8. 点击“结束” (or the take is finalized on disconnect) → deterministic replay report + coaching analysis. The fixed-time take does not auto-finalize after the last target.

## Project map

```text
src/
├── App.tsx                          # Workbench UI; session actions via usePracticeSession
├── config/modeRegistry.ts           # Mode capability metadata
├── core/sampleScore.ts              # Legacy display fixture/model (written pitch, no screen coords)
├── score-engine/
│   ├── domain/{rational,types}.ts   # Exact beats + semantic DTOs
│   ├── import/musicxml-importer.ts  # Pure MusicXML partwise importer + ImportReport
│   ├── playback/{playback-planner,tempo-map}.ts
│   ├── playback/score-events.ts     # Same PlaybackPlan → per-note scoring events
│   ├── view/score-view-adapter.ts   # OSMD 2.2.1 public-object mapping
│   ├── legacy-bridge.ts             # Semantic doc → existing SVG view model
│   └── test/fixtures/               # 12 semantic fixtures + golden JSON
├── components/ScoreViewer.tsx       # SVG grand staff, hint overlays, selection inspector
├── components/KeyboardReference.tsx # Mini piano key reference for the selected note
├── components/ReportPanel.tsx       # Engine replay report + coaching output
├── components/FullScoreReport.tsx   # Rust scoring_v1: metrics, measures, event results, statuses
├── components/TargetedPracticePanel.tsx # P09 prescriptions, editable config, retry creation
├── components/HistoryView.tsx       # Practice history (persisted sessions, expandable)
├── components/ProfileView.tsx       # Ability profile (mastery states + MAE trend)
├── features/score/
│   ├── staffMapping.ts              # Pitch → staff line/space/ledger mapping
│   ├── scoreLayout.ts               # Pure note/bar geometry (independent of display hints)
│   ├── practicePlan.ts              # Notes → engine target groups (no display parameters)
│   ├── scoreHints.ts                # Hint defaults + localStorage overrides
│   ├── musicXmlParser.ts            # Limited browser-side MusicXML importer
│   ├── practiceScore.ts             # Parsed 4-bar C-major default practice score
│   ├── previewTone.ts               # Speaker-preview oscillator
│   └── fixtures/…musicxml           # 4-bar practice, 2-bar fixture, ledger demo
├── features/midi/midiAdapter.ts     # LEGACY browser Web MIDI adapter (not used by the UI)
├── services/deviceBridge.ts         # Node MIDI device list/status/event client
├── features/practice/
│   ├── usePracticeSession.ts        # Session state machine (single owner of status)
│   ├── teachingPrescription.ts      # Pure evidence-gated B2 prescription selector
│   └── metronome.ts                 # Absolute-timeline Web Audio scheduling
├── services/engineBridge.ts         # WebSocket client for the engine service
├── types/practice.ts                # UI domain types
├── types/engine.ts                  # Engine WS protocol DTOs
└── styles.css                       # Responsive visual design
server/
├── engine-server.mjs                # Local Node service hosting the Rust core + MIDI API
├── midi/
│   ├── adapter.mjs                  # Node MIDI Adapter (lifecycle, queue, generation)
│   ├── julusian-backend.mjs         # @julusian/midi isolation
│   ├── codec.mjs                    # note/CC labels (never scoring)
│   ├── clock-map.mjs                # Node↔browser monotonic clock mapping
│   ├── probe.mjs                    # npm run midi:probe
│   └── *.test.mjs                   # adapter/clock unit tests
└── selftest.mjs                     # Scripted end-to-end assertions
docs/DESIGN.md                       # Frontend design rationale and boundaries
docs/score-reading-assist.md         # v2 score-reading implementation + acceptance record
docs/MUSICXML_SCORE_ENGINE_IMPLEMENTATION.md # Audit, data flow, fixtures, test log, limits
docs/osmd-mapping-spike.json         # Actual OSMD 2.2.1 mapping spike results
docs/visual-checks/                  # Note-name on/off + out-of-staff visual inspection screenshots
```

## Architecture decisions

### 1. One scoring authority

The engine service wraps the Rust core (`NativeSession`, `buildSchedule`, `analyzeTiming`) and is the only place that judges events. `ScoreTargetEvent`-style normalized targets are built server-side from atoms the workspace sends; the browser only renders results. Do not reintroduce scoring in React.

### 2. Session state is centralized

`usePracticeSession` owns the status machine and all engine I/O. Buttons call guarded actions (`begin/pause/resume/finish/reset`); components never patch status booleans directly. Illegal combinations like running+paused cannot be expressed.

### 3. Time comes from one anchored clock

The page anchors a session origin at `performance.now()` when the engine confirms start. Node MIDI is captured on the server's monotonic `performance.now()`; a 10-sample four-timestamp handshake maps it into the browser performance timeline before subtracting the session origin. WebSocket arrival time, React render time and `Date.now()` never become scoring time. Clock quality/uncertainty is exposed in the report's `captureDiagnostics.node`; device-latency calibration remains a separate, measured subsystem.

### 4. Pitch is not rhythm

Wrong pitches at the right time still match rhythm targets (the core matches onsets); the UI shows a separate pitch hint. Reports keep both dimensions apart, per the product requirement that one must not overwrite the other.

### 5. Score semantics: independent engine + clean display

`src/score-engine/` now owns parsing, exact beats, tie/chord/cursor semantics and playback planning; `musicXmlParser.ts` is only a compatibility bridge into the existing SVG view model. `scoreLayout.ts`/`staffMapping.ts` derive display geometry, and the clean presentation keeps labels off by default, draws a green current-beat pill and grays upcoming notes. Hints are display-only and never enter `PracticeConfig` or the start payload. The importer is still a **limited MusicXML subset**; unsupported repeats/tempo curves/grace/cue/microtones block strict scoring rather than being silently linearized. OSMD 2.2.1 is installed and a real mapping spike exists, but the production React view remains the custom SVG (OSMD UI integration is outstanding). See `docs/MUSICXML_SCORE_ENGINE_IMPLEMENTATION.md` and `docs/score-reading-assist.md`.

## Next increments

1. OSMD production React view: replace or optionally wrap the custom SVG with OSMD 2.2.1, add pitch-name/line-space/hand-label/error overlays and zoom; the current adapter/spike only proves source-to-graphical mapping.
2. Add the planned `POST /api/scores/import` boundary if server-side import is desired. The start/report protocol already carries `scoreFingerprint`, `playbackPlanId` and ImportReport status for traceability.
3. Full MusicXML semantics: complex repeats/endings/D.C./D.S./Coda expansion, all tuplets, grace policy, transposing instruments, multi-part hand mapping.
4. SP-A500 Node-path hardware checklist: Note On/Off, velocity, repeated notes, chords, hotplug, duplicate-listener and a minimal real Take (currently software/mock verified; key events NOT RUN in this environment).
5. Diagnostic bundle export, replay UI, log rotation; per-Take Journal/Trace persistence and deterministic replay API are implemented.
6. Deterministic replay of archived raw traces and cross-session comparison.
7. Mode strategies per `modeRegistry` (loop auto-tempo, hands-separate transfer tests).
8. Device-latency calibration as a separate measured subsystem.
