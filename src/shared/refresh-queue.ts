/** Coalesce polling reads; invalidate old responses after a known state change. */
export class RefreshQueue<T> {
  private active=false;
  private closed=false;
  private queued=false;
  private generation=0;
  private activeGeneration=0;
  private controller?:AbortController;
  constructor(private load:(signal:AbortSignal)=>Promise<T>,private value:(value:T)=>void,private error:(error:unknown)=>void,private busy?:(busy:boolean)=>void) {}
  refresh() {
    if(this.closed)return;
    if(this.active){if(this.activeGeneration!==this.generation)this.queued=true;return;}
    void this.execute().catch(()=>{});
  }
  invalidate() {this.generation++;this.refresh();}
  dispose() {this.closed=true;this.queued=false;this.controller?.abort();}
  private async execute() {
    this.active=true;this.queued=false;this.activeGeneration=this.generation;
    const generation=this.generation;
    const controller=new AbortController();this.controller=controller;
    try {
      this.busy?.(true);
      const result=await this.load(controller.signal);
      if(!this.closed&&generation===this.generation)this.value(result);
    }catch(error){if(!this.closed&&generation===this.generation)this.error(error);}
    finally {
      this.active=false;
      if(this.controller===controller)this.controller=undefined;
      if(!this.closed){if(this.queued)this.refresh();else this.busy?.(false);}
    }
  }
}
