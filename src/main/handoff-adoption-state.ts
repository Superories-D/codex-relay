import type {AdoptionFileProof,AdoptionNativeRequest,AdoptionNativeInspection,AdoptionFileState} from "../shared/handoff-adoption";
const bytes=(actual:AdoptionFileProof|null|undefined,expected:AdoptionFileProof|null|undefined)=>!actual&&!expected||!!actual&&!!expected&&actual.bytes===expected.bytes&&actual.sha256===expected.sha256;
const exact=(actual:AdoptionFileProof|null|undefined,expected:AdoptionFileProof|null|undefined)=>bytes(actual,expected)&&(!actual||actual.dev===expected!.dev&&actual.ino===expected!.ino);
const metadata=(actual:AdoptionNativeInspection["targetMetadata"],expected:AdoptionNativeRequest["beforeMetadata"])=>!expected||!!actual&&actual.securitySha256===expected.securitySha256&&actual.attributes===expected.attributes&&actual.links===expected.links&&actual.created===expected.created&&actual.modified===expected.modified&&JSON.stringify(actual.streams)===JSON.stringify(expected.streams);
/** Classification never grants overwrite permission. Recovery must review and bind
 * a fresh transition; the original request and every observed version stay intact. */
export function classifyAdoptionFile(request:AdoptionNativeRequest,view:AdoptionNativeInspection):AdoptionFileState{
  if(request.id!==view.id||request.transactionId!==view.transactionId)return"inconsistent";
  if(view.backup&&(!exact(view.backup,request.before)||!metadata(view.backupMetadata,request.beforeMetadata)))return"retainedEdits";
  if(view.stage&&(!exact(view.stage,request.after)||!metadata(view.stageMetadata,request.afterMetadata)))return"stagingChanged";
  const beforeCopy=bytes(view.beforeCopy,request.before),backup=exact(view.backup,request.before),stage=exact(view.stage,request.after);
  const retainedMetadata=request.metadataSource?.metadata||request.beforeMetadata;
  const expectedAfter=request.afterMetadata?{...request.afterMetadata,...(retainedMetadata?{securitySha256:retainedMetadata.securitySha256,attributes:retainedMetadata.attributes,created:retainedMetadata.created,...(request.restoreMetadata?{modified:retainedMetadata.modified}:{})}:{})}:undefined;
  const createdMetadata=request.creationSecurity&&expectedAfter?{...expectedAfter,securitySha256:view.targetMetadata?.securitySha256||""}:expectedAfter;
  const inherited=!request.creationSecurity||view.targetMetadata?.sddl===request.creationSecurity.sddl;
  if(exact(view.target,request.after)&&inherited&&metadata(view.targetMetadata,createdMetadata)&&backup&&!view.stage&&(!request.before||beforeCopy))return view.applied?"applied":"appliedUnsealed";
  if(exact(view.target,request.before)&&metadata(view.targetMetadata,request.beforeMetadata)&&!view.backup&&stage){
    if(view.applied)return"inconsistent";
    if(!view.prepared)return view.beforeCopy?"partialBackup":"notStarted";
    return !request.before||beforeCopy?"prepared":"inconsistent";
  }
  if(!view.target&&request.before&&backup&&stage&&beforeCopy&&view.prepared&&!view.applied)return"displaced";
  return"userChanged";
}
