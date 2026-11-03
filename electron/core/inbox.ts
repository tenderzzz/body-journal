import {watch,existsSync,readdirSync,statSync,readFileSync,type FSWatcher} from 'node:fs';
import path from 'node:path';
import type {HealthStore} from './store';
import type {SyncItem} from '../../src/shared/types';
import {atomicWrite} from './store';
import {readableError} from './validation';

type Entry=SyncItem&{signature:string;retryAt:number};
export class InboxSync {
  private watcher?:FSWatcher;
  private timer?:NodeJS.Timeout;
  private fallback?:NodeJS.Timeout;
  private entries=new Map<string,Entry>();
  private running?:Promise<void>;
  private requested=false;
  private closed=false;
  private directory='';
  private directoryIdentity='';
  constructor(private store:HealthStore,private stateFile:string,private changed:(imported:boolean)=>void){}
  start(){
    this.closed=false;this.directory=this.store.getSettings().inbox;
    try{const state=JSON.parse(readFileSync(this.stateFile,'utf8'));if(state.directory===this.directory)for(const entry of state.entries)this.entries.set(entry.file,entry);}catch{}
    this.attach();this.request();
    this.fallback=setInterval(()=>{this.attach();this.request();},15*60*1000);this.fallback.unref();
  }
  private attach(){
    if(!existsSync(this.directory)){this.watcher?.close();this.watcher=undefined;this.directoryIdentity='';return;}
    const info=statSync(this.directory),identity=`${info.dev}:${info.ino}`;
    if(this.watcher&&identity===this.directoryIdentity)return;
    this.watcher?.close();this.watcher=undefined;this.directoryIdentity=identity;
    try{
      this.watcher=watch(this.directory,{recursive:true},(_event,name)=>{
        const relative=String(name??''),file=relative.endsWith('.json')?relative:path.join(path.dirname(relative),'record.json');
        const entry=this.entries.get(file);if(entry)entry.signature='';
        for(const entry of this.entries.values())if(entry.state==='waiting')entry.retryAt=0;
        this.request();
      });
      this.watcher.on('error',()=>{this.watcher?.close();this.watcher=undefined;this.request();});
    }catch{/* Periodic discovery and manual retry remain available if the folder is temporarily offline. */}
  }
  request(delay=500){
    if(this.closed)return;
    this.requested=true;if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=undefined;void this.scan();},delay);this.timer.unref();
  }
  async scan(){
    if(this.closed)return;
    if(this.running){this.requested=true;return this.running;}
    this.requested=false;this.running=this.process();
    try{await this.running;}finally{this.running=undefined;if(this.requested)this.request();}
  }
  private async process(){
    let imported=0;
    try{
      this.attach();
      if(!existsSync(this.directory))throw new Error('尚未找到手机收件箱，请建立或选择文件夹');
      const files:string[]=[];
      for(const entry of readdirSync(this.directory,{withFileTypes:true})){
        if(entry.isFile()&&entry.name.endsWith('.json'))files.push(entry.name);
        if(entry.isDirectory()&&existsSync(path.join(this.directory,entry.name,'record.json')))files.push(path.join(entry.name,'record.json'));
      }
      const present=new Set(files);
      for(const [file] of this.entries)if(!present.has(file))this.entries.delete(file);
      for(const file of files){
        if(this.closed)break;
        const full=path.join(this.directory,file);
        let info;try{info=statSync(full);}catch{continue;}
        const signature=`${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const old=this.entries.get(file);
        if(old?.signature===signature&&(old.state==='imported'||old.state==='failed'||old.retryAt>Date.now()))continue;
        const now=new Date().toISOString(),attempts=(old?.signature===signature?old.attempts:0)+1;
        try{
          const result=this.store.importInboxFile(full);
          if(!result.duplicate)imported++;
          this.entries.set(file,{file,state:'imported',attempts,lastAttempt:now,signature,retryAt:0});
        }catch(error){
          const message=readableError(error),waiting=error instanceof SyntaxError||/尚未同步|ENOENT|未找到图片|图片附件/.test(message);
          const retryAt=waiting?Date.now()+Math.min(300000,2000*2**Math.min(attempts-1,8)):0;
          this.entries.set(file,{file,state:waiting?'waiting':'failed',attempts,lastAttempt:now,error:message,signature,retryAt,nextAttempt:waiting?new Date(retryAt).toISOString():undefined});
        }
        // Large inboxes yield to IPC and rendering between files.
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      atomicWrite(this.stateFile,JSON.stringify({directory:this.directory,entries:[...this.entries.values()]}));
      this.publish(imported);
      const retry=[...this.entries.values()].filter(e=>e.state==='waiting').map(e=>e.retryAt);
      if(retry.length)this.request(Math.max(500,Math.min(...retry)-Date.now()));
    }catch(error){
      this.store.syncState={imported:0,pending:0,errors:[readableError(error)],at:new Date().toISOString(),items:[]};
      this.changed(false);
    }
  }
  private publish(imported:number){
    const entries=[...this.entries.values()],pending=entries.filter(e=>e.state==='waiting'),failed=entries.filter(e=>e.state==='failed');
    const items=[...pending,...failed,...entries.filter(e=>e.state==='imported').sort((a,b)=>b.lastAttempt.localeCompare(a.lastAttempt))].slice(0,30);
    this.store.syncState={imported,pending:pending.length,errors:failed.slice(0,20).map(e=>`${e.file} · ${e.error}`),at:new Date().toISOString(),items};
    this.changed(imported>0);
  }
  retry(){for(const entry of this.entries.values())if(entry.state!=='imported'){entry.signature='';entry.retryAt=0;}this.request(0);}
  async stop(){this.closed=true;this.watcher?.close();this.watcher=undefined;if(this.timer)clearTimeout(this.timer);if(this.fallback)clearInterval(this.fallback);await this.running;}
}
