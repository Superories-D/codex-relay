# Compact model and effort controls

The composer uses a compact effort panel above the text input. Model selection
opens a separate list with a back button, selected state and an explicit default
row. The list comes from the account's CLI catalog; fixture names in QA do not
define product availability. The panel uses the actual available effort steps,
falls back to a new model's default when needed and supports reset.

Changing effort preserves an empty/default model selection instead of turning it
into a pinned model. Arrow keys open the panel; the native range supports
arrows, Home and End and exposes translated `aria-valuetext`. This follows the
[W3C slider pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/).
List arrows/Home/End move focus. Escape returns from the list to effort controls,
then closes and restores trigger focus. Arriving catalog data restores list
focus when loading replaced the active item.

A failed catalog read can occur while automatic CLI setup is still preparing.
Opening the panel retries a previous error once. Errors while the panel remains
open do not trigger an uncontrolled retry loop; an explicit reload is available.
Healthy catalogs stay cached for that account.

Validation uses the production renderer and controlled IPC, with zero model
turns. `scripts/qa/workspace-visual.cjs` covers seven viewport/theme/language
combinations, 150% scale, long titles, multiline draft sizing, nested navigation,
unsupported effort fallback and preserving default selection after effort edits.
`scripts/qa/model-picker-recovery.cjs` covers startup errors, bounded retries,
delayed responses, keyboard entry, focus restoration and healthy caching.
These browser checks do not claim assistive-technology device acceptance or
prove remote provider availability. Native packaged startup is checked separately.
