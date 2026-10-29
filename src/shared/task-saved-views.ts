import { z } from "zod";
export const savedTaskViewKey = "relay.taskSavedViews.v1";
const criteriaSchema = z.object({
  query: z.string().max(500), project: z.string().max(4096),
  filter: z.enum(["all", "active", "attention", "recovering", "paused", "completed"]),
  sort: z.enum(["priority", "recent", "oldest"]), layout: z.enum(["list", "board"]),
}).strict();
export const savedTaskViewSchema = criteriaSchema.extend({id:z.string().uuid(),name:z.string().trim().min(1).max(60)}).strict();
export type SavedTaskCriteria = z.infer<typeof criteriaSchema>;
export type SavedTaskView = z.infer<typeof savedTaskViewSchema>;
export function loadSavedTaskViews(raw: string | null): {views: SavedTaskView[]; invalid: boolean} {
  if (!raw) return {views:[], invalid:false};
  try {
    const parsed=z.array(savedTaskViewSchema).max(20).parse(JSON.parse(raw));
    if(new Set(parsed.map(v=>v.id)).size!==parsed.length || new Set(parsed.map(v=>v.name.toLocaleLowerCase())).size!==parsed.length)throw Error();
    return {views:parsed,invalid:false};
  } catch { return {views:[],invalid:true}; }
}
export function writeSavedTaskView(views: SavedTaskView[], input: SavedTaskView) {
  const value=savedTaskViewSchema.parse(input);
  if(views.some(v=>v.id!==value.id&&v.name.toLocaleLowerCase()===value.name.toLocaleLowerCase()))throw Error("已有同名视图，请使用其他名称");
  if(!views.some(v=>v.id===value.id)&&views.length>=20)throw Error("最多保存 20 个任务视图");
  return [...views.filter(v=>v.id!==value.id),value];
}
export function sameTaskCriteria(a:SavedTaskCriteria,b:SavedTaskCriteria) {
  return a.query===b.query&&a.project===b.project&&a.filter===b.filter&&a.sort===b.sort&&a.layout===b.layout;
}
