function isMainWindow(target) {
  try {
    const u=new URL(target?.url || '');
    return u.protocol==='app:' && u.hostname==='-' && u.pathname==='/index.html' && !/overlay/i.test(decodeURIComponent(u.search+u.hash));
  } catch {return false;}
}
function buildBootstrapScript() {
  const monitor = `(${installThreadPerformanceMonitor.toString()})(${createThreadPerformanceTracker.toString()})`;
  return [`(${installThreadMetricsAccountScope.toString()})()`, monitor, ...[installUsageBadge,installProjectColors,installProjectSizes,installThreadTokens,installThreadMetrics].map(fn=>`(${fn.toString()})()`)].join(';\n');
}
class CdpSession {
  constructor(target) {this.target=target;this.pending=new Map();this.serial=0;this.socket=null;}
  async connect() {
    const u=new URL(this.target.webSocketDebuggerUrl);
    if(u.protocol!=='ws:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname)) throw new Error('CDP must use loopback');
    const ws=new WebSocket(u);this.socket=ws;
    ws.addEventListener('message',event=>{
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      const p=this.pending.get(msg?.id);if(!p)return;
      this.pending.delete(msg.id);clearTimeout(p.timer);
      msg.error || msg.result?.exceptionDetails ? p.reject(new Error('CDP evaluation failed')) : p.resolve(msg.result);
    });
    ws.addEventListener('close',()=>this.rejectPending());
    ws.addEventListener('error',()=>this.rejectPending());
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{ws.close();reject(new Error('CDP handshake timed out'));},4000);
      const finish=fn=>{clearTimeout(timer);fn();};
      ws.addEventListener('open',()=>finish(resolve),{once:true});
      ws.addEventListener('error',()=>finish(()=>reject(new Error('CDP unavailable'))),{once:true});
      ws.addEventListener('close',()=>finish(()=>reject(new Error('CDP closed'))),{once:true});
    });
    await this.request('Runtime.enable');
  }
  request(method,params={}) {
    if(this.socket?.readyState!==WebSocket.OPEN)return Promise.reject(new Error('CDP disconnected'));
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP request timed out'));},5000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.socket.send(JSON.stringify({id,method,params}));}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }
  evaluate(expression){return this.request('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});}
  rejectPending(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP disconnected'));}this.pending.clear();}
  close(){this.rejectPending();this.socket?.close();this.socket=null;}
}
class RendererInjector {
  constructor({port}){this.port=port;this.sessions=new Map();this.currentValue=null;this.scanning=false;this.stopped=false;}
  async scan(){
    if(this.scanning||this.stopped)return;
    this.scanning=true;
    try{
      const res=await fetch(`http://127.0.0.1:${this.port}/json/list`,{signal:AbortSignal.timeout(3000)});
      if(!res.ok)throw new Error('CDP unavailable');
      const pages=(await res.json()).filter(t=>t.type==='page'&&isMainWindow(t)&&typeof t.webSocketDebuggerUrl==='string');
      const live=new Set(pages.map(t=>t.id));
      for(const[id,s]of this.sessions)if(!live.has(id)){s.close();this.sessions.delete(id);}
      await Promise.all(pages.map(async t=>{
        const existing=this.sessions.get(t.id), session=existing || new CdpSession(t);
        try{
          if(!existing)await session.connect();
          await session.evaluate(buildBootstrapScript());
          if(this.currentValue)await session.evaluate(`window.__codexUsageBadge?.update(${JSON.stringify(this.currentValue)})`);
          if(this.stopped){session.close();return;}
          this.sessions.set(t.id,session);
        }catch{session.close();this.sessions.delete(t.id);}
      }));
    }finally{this.scanning=false;}
  }
  async update(value){
    this.currentValue=value;
    await Promise.all([...this.sessions].map(async([id,s])=>{
      try{await s.evaluate(`window.__codexUsageBadge?.update(${JSON.stringify(value)})`);}catch{s.close();this.sessions.delete(id);}
    }));
  }
  stop(){this.stopped=true;for(const s of this.sessions.values())s.close();this.sessions.clear();}
}
