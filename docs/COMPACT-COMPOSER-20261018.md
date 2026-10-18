# Compact input strip — 2026-10-18

Follow-up to `ba8fced`: the 85px filled composer still looked oversized. This
revision changes the structure instead of merely reducing text-area padding.

- Attachment control, text input and send/stop actions share one input strip.
- The input strip is 48 CSS px high with a single 40px text row, 12px corners and
  no resting drop shadow. Text still expands up to 200px and shrinks after deletion.
- Model, effort, execution permission and project/environment controls sit in a
  single footer outside the filled input surface. The previous separate caption
  row is merged into that footer. The full strip plus footer measures 81.59px in
  all four checked layouts; 48px is not a claim about the complete controls area.
- At narrow widths, keyboard hints hide while model and permission controls remain
  available. Additional active-task or goal controls can wrap as needed.
- Paste/drop, attachments, send, steer, queue, stop, goal saving and environment
  selection retain their existing handlers. No execution policy or routing change.

Verification:

- `npm run build`: passed.
- `npm test -- --maxWorkers=4`: 36 files / 324 tests passed. Local log:
  `qa-output/compact-composer-tests.log`.
- `scripts/qa/agent-ui.cjs`: passed send/steer/queue/stop, attachments, model/effort,
  settings, import, three languages and other existing interaction checks with
  synthetic IPC. The final style-only select-width correction was additionally
  covered by the visual and native checks below.
- `scripts/qa/workspace-visual.cjs`: dark/light, zh-CN/en/zh-TW, 900/1100/1600px;
  verifies strip height <=50px, complete controls height <=86px, send beside the
  input, model controls below it, multiline growth/shrink, width reflow and import
  disclosure behavior. All four layouts measured 48px / 81.59px, no horizontal
  overflow, no renderer errors. Dark/light Chinese and narrow English screenshots
  were visually reviewed.
- `scripts/qa/scroll-native.cjs`: real development Electron, isolated synthetic
  history, zero accounts and zero model requests; three languages, resize, zoom,
  composer growth/shrink, reading position, follow-latest, inspector and image
  layout checks passed without renderer errors.

Generated screenshots/reports remain in ignored `qa-output/`. The visual script
regenerates `workspace-*.png` and `workspace-visual-report.json`; these now show
this revision, superseding the previous local 85px screenshots.

No package build, installed-client replacement, real-profile access or credential
operation was performed. The installed v0.6.14 client still displays its old UI.
The user's earlier restriction on repackaging and the paused long-term Goal remain
in effect. Live-model behavior and actual task artifacts were not revalidated.
