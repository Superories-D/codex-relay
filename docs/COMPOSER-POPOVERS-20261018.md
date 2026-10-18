# Composer popovers and draft attachments

Follow-up to the user's v0.6.15 screenshots:

- Model panel now uses a 300px surface, 16px slider thumb and compact labels.
  Placement tracks the input strip, viewport and resize; panels stay above the
  input instead of covering it. Width and height are bounded by the viewport.
- Execution permissions use a themed menu with checked state, arrow/Home/End
  navigation, Escape focus restoration and outside dismissal. Opening focus waits
  until placement is visible. Existing permission values, native permission
  inheritance and running/family restrictions are preserved.
- Image attachments use the existing authorized thumbnail/viewer path. Filenames
  and a separate labeled removal button stay visible; ordinary files use icons.
  Attachments wrap in a bounded area above the input.

Validation: build passed, 36 files / 324 tests passed, synthetic main UI regression
passed. Five visual fixtures cover dark/light, three languages, widths 900–1600px
and 150% display scale; model/permission popovers remain above the input and within
the viewport, keyboard selection and focus restoration pass. The input remains
48px. Real Electron with an isolated profile passed native text/file/image paste,
thumbnail decoding, draft image viewer opening/closing, file drop and reduced
motion. Its clipboard snapshot is restored on exit. Zero model requests.

Local ignored evidence: `workspace-visual-report.json`, `popover-model-*.png`,
`popover-permission-*.png`, `composer-native-report.json`, `composer-native.png`,
`agent-ui-report.json`, `composer-popovers-tests.log` under `qa-output/`.

This is source validation after v0.6.15. The delivered v0.6.15 artifacts have not
been overwritten. Multi-task concurrency requested next is separate backend work
and is not established by these UI checks.
