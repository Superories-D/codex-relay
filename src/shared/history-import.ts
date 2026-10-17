export interface ImportProgress {
  id: string;
  phase:
    | "idle"
    | "scanning"
    | "importing"
    | "cancelling"
    | "completed"
    | "cancelled"
    | "failed"
    | "interrupted";
  startedAt?: number;
  finishedAt?: number;
  scanned: number;
  total: number;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  projects: number;
  missingProjects: number;
  readOnly: number;
  current: string;
  roots: string[];
  warnings: string[];
  failures: { title: string; message: string }[];
}
export const importRunning = (phase: ImportProgress["phase"]) =>
  ["scanning", "importing", "cancelling"].includes(phase);
export const emptyImportProgress = (): ImportProgress => ({
  id: "",
  phase: "idle",
  scanned: 0,
  total: 0,
  processed: 0,
  imported: 0,
  skipped: 0,
  failed: 0,
  projects: 0,
  missingProjects: 0,
  readOnly: 0,
  current: "",
  roots: [],
  warnings: [],
  failures: [],
});
