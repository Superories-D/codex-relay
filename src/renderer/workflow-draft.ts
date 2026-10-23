export interface WorkflowDraft {requestId:string;title:string;directory:string;model:string;steps:{id:string;text:string}[];submitted:boolean}
export function parseWorkflowDraft(text:string|null):WorkflowDraft|undefined {
  try {
    if(!text || text.length>1300000)return;
    const d=JSON.parse(text),uuid=/^[a-f0-9]{8}-[a-f0-9-]{27}$/i;
    if(!d || typeof d.requestId!=="string" || !uuid.test(d.requestId)||typeof d.title!=="string"||d.title.length>120||typeof d.directory!=="string"||typeof d.model!=="string"||d.model.length>200||!Array.isArray(d.steps)||d.steps.length<2||d.steps.length>12||d.steps.some((s:any)=>!s||typeof s.id!=="string"||!uuid.test(s.id)||typeof s.text!=="string"||s.text.length>100000)||new Set(d.steps.map((s:any)=>s.id)).size!==d.steps.length)return;
    return {...d,submitted:d.submitted===true};
  }catch{return;}
}
