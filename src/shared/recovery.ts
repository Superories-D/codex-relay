export interface RecoveryPlanEntry {
  id:string;title:string;status:"scoped"|"global";reason:string;checkedAt?:number;processes?:number;
  accounts:{id:string;label:string}[];projects:string[];affected:string[];
  intent?:"pause"|"cancel";nextAt?:number;attempt?:number;nonce?:string;
}
export interface RecoveryPlan {id:string;at:number;entries:RecoveryPlanEntry[]}
