/** Await the evaluated result before deciding whether an async browser check passed. */
async function waitForBrowser(page,predicate,arg,options={}) {
  const timeout=options.timeout??30000,interval=options.interval??100;
  if(!Number.isFinite(timeout)||timeout<=0||!Number.isFinite(interval)||interval<=0)throw Error('Browser wait requires positive timeout and interval');
  const deadline=Date.now()+timeout,failure=Error(options.message||'Browser condition did not become true before its deadline');
  for(;;) {
    const remaining=deadline-Date.now();if(remaining<=0)throw failure;
    let timer;
    try {
      const value=await Promise.race([page.evaluate(predicate,arg),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure),remaining);})]);
      if(value)return value;
    }finally{clearTimeout(timer);}
    const rest=deadline-Date.now();if(rest<=0)throw failure;
    await new Promise(resolve=>setTimeout(resolve,Math.min(interval,rest)));
  }
}
module.exports={waitForBrowser};
