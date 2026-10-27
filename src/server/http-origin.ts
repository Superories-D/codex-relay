export function publicHttpOrigin(value?:string){
 if(value===undefined)return undefined;
 let url:URL;try{url=new URL(value);}catch{throw Error("Public HTTP origin must be an HTTPS origin");}
 if(url.protocol!=="https:"||url.username||url.password||url.pathname!=="/"||url.search||url.hash)throw Error("Public HTTP origin must be an HTTPS origin without credentials, path, query or fragment");
 return url.origin;
}
export function permittedRequestHost(host:string|undefined,publicOrigin?:string){
 if(!host)return false;
 return /^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/.test(host)||!!publicOrigin&&host.toLowerCase()===new URL(publicOrigin).host;
}
export function permittedRequestOrigin(host:string,origin:string|undefined,publicOrigin?:string){
 if(origin===undefined)return true;
 return origin===publicOrigin||/^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/.test(host)&&origin===`http://${host}`;
}
