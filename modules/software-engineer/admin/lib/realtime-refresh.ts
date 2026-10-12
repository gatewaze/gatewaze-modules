/** Bound realtime refreshes, serialize slow requests and retain the final update. */
export function createRealtimeRefresh(load: () => Promise<unknown> | unknown, intervalMs = 2000, doc?: {hidden:boolean;addEventListener(type:string,fn:()=>void):void;removeEventListener(type:string,fn:()=>void):void}) {
  const visible = doc ?? (typeof document !== 'undefined' ? document : undefined);
  let disposed=false, dirty=false, running=false, last=-Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    if(disposed || running || timer || !dirty || visible?.hidden) return;
    const wait=Math.max(0,last+intervalMs-Date.now());
    if(wait) {timer=setTimeout(()=>{timer=undefined;schedule();},wait);return;}
    dirty=false;running=true;last=Date.now();
    Promise.resolve().then(load).catch(()=>{}).finally(()=>{running=false;schedule();});
  }
  const refresh=()=>{dirty=true;schedule();};
  const onVisible=()=>{if(!visible?.hidden)refresh();};
  visible?.addEventListener('visibilitychange',onVisible);
  return {refresh,dispose:()=>{disposed=true;dirty=false;if(timer)clearTimeout(timer);visible?.removeEventListener('visibilitychange',onVisible);}};
}
