import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import ts from 'typescript';
import { HealthStore } from '../electron/core/store';
import { FoodCatalog } from '../electron/core/nutrition';
import { computeStats } from '../src/shared/stats';

type Bridge = {invoke(action:string,payload?:unknown):Promise<any>};
function loadBridge(dispatch:(action:string,payload: any)=>unknown):Bridge {
  const code=buildSync({entryPoints:['electron/preload.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],write:false}).outputFiles[0].text;
  let bridge:Bridge|undefined;
  runInNewContext(code,{require:(module:string)=>{
    assert.equal(module,'electron');
    return {
      contextBridge:{exposeInMainWorld:(name:string,value:Bridge)=>{assert.equal(name,'health');bridge=value;}},
      ipcRenderer:{invoke:async(channel:string,action:string,payload:unknown)=>{
        assert.equal(channel,'health:invoke');
        try{return {ok:true,value:await dispatch(action,payload)};}
        catch(error){return {ok:false,error:(error as Error).message};}
      }},
    };
  }});
  assert.ok(bridge);
  return bridge;
}

test('desktop bridge forwards every implemented action and rejects unknown actions',async()=>{
  const main=ts.createSourceFile('main.ts',readFileSync('electron/main.ts','utf8'),ts.ScriptTarget.Latest,true);
  const actions:string[]=[];
  const walk=(node:ts.Node)=>{
    if(ts.isSwitchStatement(node)&&node.expression.getText(main)==='action'){
      for(const clause of node.caseBlock.clauses)if(ts.isCaseClause(clause)&&ts.isStringLiteral(clause.expression))actions.push(clause.expression.text);
    }
    ts.forEachChild(node,walk);
  };
  walk(main);
  assert.ok(actions.includes('exercise:reclassifyMany'));
  const seen:string[]=[];
  const bridge=loadBridge(action=>{seen.push(action);return action;});
  for(const action of actions)assert.equal(await bridge.invoke(action),action,`${action} must reach the main process`);
  assert.deepEqual(seen,actions);
  await assert.rejects(bridge.invoke('arbitrary:execute'),/不支持的操作/);
  assert.deepEqual(seen,actions);
});

test('classification through the desktop bridge persists and returns save errors',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-bridge-'));
  let store=new HealthStore(root,new FoodCatalog([]),path.join(root,'inbox'),false);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const record=store.importEnvelope({version:1,id:'bridge-training',kind:'training',text:'胸：\n上斜哑铃 单手 17.5kg 3x12',occurredAt:'2026-10-22T19:00:00+08:00',timezone:'Asia/Shanghai'}).record;
  const bridge=loadBridge((action,payload)=>{
    if(action==='exercise:reclassifyMany')return store.reclassifyExercises(payload.changes);
    if(action==='exercise:reclassify')return store.reclassifyExercise(payload.raw,payload.name);
    throw new Error('unexpected action');
  });
  const payload={changes:[{raw:'上斜哑铃',name:'哑铃上斜'}]};
  assert.equal((await bridge.invoke('exercise:reclassifyMany',payload)).updatedRecords,1);
  assert.equal(store.record(record.id).analysis!.sets![0].exercise,'哑铃上斜');
  assert.ok(computeStats(store.records()).exercises['哑铃上斜']);
  await assert.rejects(bridge.invoke('exercise:reclassifyMany',{changes:[{raw:'上斜哑铃',name:'卧推（单手）'}]}),/未保存|尚未保存|不要|括号/);
  assert.equal(store.record(record.id).analysis!.sets![0].exercise,'哑铃上斜');
  store.close();
  store=new HealthStore(root,new FoodCatalog([]),path.join(root,'inbox'),false);
  assert.equal(store.record(record.id).analysis!.sets![0].exercise,'哑铃上斜');
  await bridge.invoke('exercise:reclassify',{raw:'上斜哑铃',name:'上斜哑铃卧推'});
  assert.equal(store.record(record.id).analysis!.sets![0].exercise,'上斜哑铃卧推');
});
