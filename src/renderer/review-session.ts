import { reviewDiff } from "../shared/review-diff";
import { gitStaged, gitUnstaged, type GitChange } from "../shared/git";

export type ReviewMark = { key: string; revision: string; fingerprint: string };
export type ReviewSession = { marks: ReviewMark[]; notes: Record<string, string> };
export const reviewKey = (path: string, staged: boolean) => JSON.stringify([path, staged]);
export const reviewStorageKey = (root: string) => `relay.reviewSession.v1:${root}`;
export const reviewSides = (file: GitChange) => [
  ...(gitStaged(file) ? [true] : []),
  ...(gitUnstaged(file) ? [false] : []),
];
export function fileReviewed(file: GitChange, verified: ReadonlySet<string>) {
  const sides = reviewSides(file);
  return sides.length > 0 && sides.every(staged => verified.has(reviewKey(file.path, staged)));
}
export async function diffFingerprint(diff: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(diff));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}
export function readReviewSession(raw: string | null): ReviewSession {
  try {
    const value = JSON.parse(raw || "{}");
    return {
      marks: Array.isArray(value.marks) ? value.marks.filter((m: any) =>
        m && typeof m.key === "string" && m.key.length < 4096 && typeof m.revision === "string" && /^[a-f0-9]{64}$/.test(m.fingerprint),
      ).slice(-500) : [],
      notes: value.notes && typeof value.notes === "object" && !Array.isArray(value.notes)
        ? Object.fromEntries(Object.entries(value.notes).filter(([key, note]) => key.length < 4096 && typeof note === "string").slice(-500).map(([key, note]) => [key, (note as string).slice(0, 4000)])) : {},
    };
  } catch { return { marks: [], notes: {} }; }
}
export function updateReviewMark(session: ReviewSession, mark: ReviewMark, reviewed: boolean): ReviewSession {
  return { ...session, marks: [...session.marks.filter(item => item.key !== mark.key), ...(reviewed ? [mark] : [])].slice(-500) };
}
export function nextReviewFile(files: GitChange[], selected: string, verified: ReadonlySet<string>, onlyUnreviewed = false): GitChange | undefined {
  const index = files.findIndex(file => file.path === selected);
  return [...files.slice(index + 1), ...files.slice(0, Math.max(index, 0))]
    .find(file => !onlyUnreviewed || !fileReviewed(file, verified));
}

export function reviewableDiff(diff: string, file: GitChange) {
  if (!diff || diff.includes("\uFFFD")) return false;
  if (file.index === "?" && file.worktree === "?") return diff.split("\n").every(line => line.startsWith("+"));
  return reviewDiff(diff).hunks.length > 0;
}
export function reviewNote(session: ReviewSession, path: string) {
  return Object.hasOwn(session.notes, path) && typeof session.notes[path] === "string" ? session.notes[path] : "";
}

export async function verifyReviewSession(
  session: ReviewSession,
  state: {revision: string; files: GitChange[]},
  readDiff: (path: string, staged: boolean) => Promise<string>,
  active: () => boolean = () => true,
): Promise<{verified: Set<string>; stale: Set<string>}> {
  const verified = new Set<string>();
  const stale = new Set(session.marks.filter(mark => mark.revision !== state.revision).map(mark => mark.key));
  const candidates = state.files.flatMap(file => reviewSides(file).map(staged => ({file, staged, key: reviewKey(file.path, staged)})))
    .filter(item => session.marks.some(mark => mark.key === item.key && mark.revision === state.revision));
  for (let offset = 0; active() && offset < candidates.length; offset += 4) {
    await Promise.all(candidates.slice(offset, offset + 4).map(async item => {
      try {
        const diff = await readDiff(item.file.path, item.staged);
        const hash = await diffFingerprint(diff);
        if (reviewableDiff(diff, item.file) && session.marks.some(mark => mark.key === item.key && mark.fingerprint === hash)) verified.add(item.key);
        else stale.add(item.key);
      } catch { /* A failed read supplies no positive review evidence. */ }
    }));
  }
  return {verified, stale};
}
export type ReviewReportLabels = {title: string; scope: string; project: string; branch: string; revision: string; captured: string; summary: string; staged: string; working: string; reviewed: string; pending: string; notes: string};
function code(value: string) {
  const text = value.replace(/[\r\n]/g, " ↵ ");
  const fence = "`".repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length)) + 1);
  return `${fence} ${text} ${fence}`;
}
function fenced(value: string) {
  const fence = "`".repeat(Math.max(2, ...Array.from(value.matchAll(/`+/g), match => match[0].length)) + 1);
  return `${fence}text\n${value}\n${fence}`;
}
export function reviewReport(input: {
  state: {root: string; branch: string; revision: string; files: GitChange[]};
  session: ReviewSession; verified: ReadonlySet<string>; capturedAt: string; labels: ReviewReportLabels;
}): string {
  const {state, session, verified, capturedAt, labels} = input;
  const lines = [`# ${labels.title}`, "", labels.scope, "", `- ${labels.project}: ${code(state.root)}`, `- ${labels.branch}: ${code(state.branch)}`, `- ${labels.revision}: ${code(state.revision)}`, `- ${labels.captured}: ${code(capturedAt)}`, "", `## ${labels.summary}`, ""];
  for (const file of state.files) {
    lines.push(`- [${fileReviewed(file, verified) ? "x" : " "}] ${code(file.path)}`);
    for (const staged of reviewSides(file)) {
      const key = reviewKey(file.path, staged), mark = session.marks.find(mark => mark.key === key && mark.revision === state.revision);
      const valid = verified.has(key) && !!mark;
      lines.push(`  - ${staged ? labels.staged : labels.working}: ${valid ? labels.reviewed : labels.pending}${valid ? ` · SHA-256 ${code(mark.fingerprint)}` : ""}`);
    }
    const note = reviewNote(session, file.path);
    if (note.trim()) lines.push("", `### ${labels.notes}: ${code(file.path)}`, "", fenced(note), "");
  }
  return `${lines.join("\n")}\n`;
}
