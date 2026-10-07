'use strict';
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {StartupController}=require('./controller.cjs');

class NativeBridge {
  constructor(app,stopFile,{spawnProcess=spawn}={}) {
    this.nextId=0;this.pending=new Map();this.closed=false;
    const shell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    this.child=spawnProcess(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-bridge.ps1'),'-AppExe',app,'-StopFile',stopFile,'-ParentId',String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.lines=readline.createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{
      try {
        const reply=JSON.parse(line),entry=this.pending.get(reply.id);
        if(!entry)throw Error('Unexpected startup bridge response');
        this.pending.delete(reply.id);clearTimeout(entry.timer);
        if(reply.error)entry.reject(Error(reply.error));else entry.resolve(reply.result);
      } catch(error){this.fail(error);}
    });
    this.child.stderr.on('data',()=>{}); // Never print native command lines or personal paths.
    this.child.stdin.on('error',error=>this.fail(error));
    this.child.once('error',error=>this.fail(error));
    this.child.once('exit',()=>this.fail(Error('Native startup helper exited')));
  }
  fail(error) {
    this.closed=true;
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(error);}
    this.pending.clear();
  }
  call(action,fields={}) {
    if(this.closed)return Promise.reject(Error('Native startup helper unavailable'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.fail(Error('Native startup helper timeout'));this.child.stdin.end();},35000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,action,...fields})+'\n');
    });
  }
  close() {this.fail(Error('Startup watcher stopped'));this.child.stdin.end();this.lines.close();}
}
function portInUse() {
  return new Promise(resolve=>{
    const socket=net.createConnection({host:'127.0.0.1',port:39222});
    const done=value=>{socket.destroy();resolve(value);};
    socket.once('connect',()=>done(true));socket.once('error',error=>done(error.code!=='ECONNREFUSED'));
    socket.setTimeout(350,()=>done(true));
  });
}
function readReceipt(file) {
  let state={};try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!Number.isFinite(state.lastAttemptAt??0)||(state.lastAttemptAt??0)<0)throw Error('Invalid startup receipt');
  return state;
}
function writeReceipt(file,state,{rename=fs.renameSync,wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}) {
  const temp=file+'.tmp-'+require('node:crypto').randomUUID();const fd=fs.openSync(temp,'w',0o600);
  // PowerShell status polling and antivirus can briefly hold a Windows handle
  // without FILE_SHARE_DELETE. Preserve atomic receipts; retry only sharing
  // failures, and never continue to a quit request without durable state.
  try {
    try{fs.writeFileSync(fd,JSON.stringify(state,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    for(let attempt=0;;attempt++) {
      try {rename(temp,file);break;}
      catch(error) {if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=12)throw error;wait(25);}
    }
  } finally {fs.rmSync(temp,{force:true});}
}
async function main() {
  const root=path.dirname(__dirname),receipt=path.join(__dirname,'state.json');
  const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
  const stopFile=process.env.CODEX_BADGE_STOP_FILE||path.join(root,'stop.request');
  let state=readReceipt(receipt),stopped=false,timer;
  const bridge=new NativeBridge(config.AppExe,stopFile);
  const adapter={
    snapshot:()=>bridge.call('snapshot'),portInUse,
    quit:(app,stamp)=>bridge.call('quit',{pid:app.pid,key:app.key,stamp}),
    launch:async(stamp,foreground)=>await portInUse()?{launched:false}:bridge.call('launch',{stamp,foreground}),
    show:(app,stamp,foreground)=>bridge.call('show',{pid:app.pid,key:app.key,stamp,foreground}),
    async record(event,details={}) {
      const {message,reason,errorCode,processCount,rebootReason,shown,ageMs,inputIdleMs,frontmostPid,...previous}=state;
      state={...previous,...details,event,nativePid:bridge.child.pid,updatedAt:Date.now()};
      writeReceipt(receipt,state);
      console.log(new Date().toISOString(),event);
    }
  };
  const controller=new StartupController(adapter,{lastAttemptAt:state.lastAttemptAt||0});
  function shutdown(code=0){
    if(stopped)return;stopped=true;controller.stop();clearTimeout(timer);clearInterval(stopTimer);bridge.close();
    // Only terminate our own helper if its bounded native cancellation does not finish.
    const deadline=setTimeout(()=>{bridge.child.kill();process.exit(code);},12000);deadline.unref();
    bridge.child.once('exit',()=>process.exit(code));
    process.exitCode=code;
  }
  const stopTimer=setInterval(()=>{if(fs.existsSync(stopFile))shutdown();},200);
  async function tick(){
    if(stopped)return;
    await controller.tick();
    if(bridge.closed)return shutdown(1);
    if(!stopped)timer=setTimeout(tick,controller.pendingLaunch?200:1000);
  }
  process.once('SIGTERM',()=>shutdown());process.once('SIGINT',()=>shutdown());
  await tick();
}
module.exports={NativeBridge,portInUse,readReceipt,writeReceipt};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
