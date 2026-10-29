# Round 1 — Windows workspace home and keyboard navigation

The new-chat page now exposes outstanding approvals and interrupted tasks, current work, recent conversations and project choices. Selecting a starter appends to an existing draft and focuses the composer; it does not send a task. Project selection persists independently of the conversation.

The Windows title bar now provides a discoverable search and command entry. Ctrl+K opens a native modal with chat/project search, actions, arrow-key selection and Enter activation. Prefix `>` searches commands only. Focus returns to the previous control when closed. Ctrl+Shift+F toggles persistent focus mode; the sidebar and auxiliary panels are hidden while their state is retained.

Home cards use the existing light/dark theme and configured accent, with a clearer hierarchy and compact layouts when the content area narrows. The command palette and new strings support Simplified/Traditional Chinese, English and Japanese through the existing localization system.

Validation: TypeScript and renderer/server build; home selection tests cover approval-blocked running jobs, automatic recovery, archived/imported records and Windows paths. Browser validation evidence for the integrated three-round workflow is recorded in WINDOWS-WORKSPACE-3.md.
