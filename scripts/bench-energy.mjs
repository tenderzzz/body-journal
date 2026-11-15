import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HealthStore} from '../electron/core/store.ts';
import {FoodCatalog} from '../electron/core/nutrition.ts';

const now = new Date('2026-11-12T06:00:00Z');
const samples = 5;
for (const size of [1000, 10000]) {
  const root = mkdtempSync(path.join(tmpdir(), 'energy-benchmark-'));
  const store = new HealthStore(root, new FoodCatalog([]), root + '/inbox', false);
  try {
    const profile = store.energy.saveProfile({effectiveDate:'2025-01-01',age:30,heightCm:175,sex:'male',activity:'seated',strengthMinutes:{low:40,high:60},strengthPerWeek:3,runMinutes:20,runPerWeek:1,runPace:360,generalAdult:true}, now);
    // Stable identifiers make the output digest comparable across revisions.
    store.db.prepare('UPDATE energy_profiles SET id=?, doc=?').run('synthetic-profile', JSON.stringify({...profile,id:'synthetic-profile'}));
    const put = store.db.prepare('INSERT INTO records(id, doc, fingerprint) VALUES(?,?,?)');
    store.db.exec('BEGIN');
    for (let i=0;i<size;i++) {
      const at = new Date(+now - (i % 365)*86400000 - (i%24)*3600000).toISOString();
      const body = i%11===0 ? {weightKg:70+i%7} : null;
      const record = {id:'record-'+i,kind:body?'body':'note',occurredAt:at,timezone:'Asia/Shanghai',text:'合成记录 '+i,body,attachments:[],analysis:null,status:'ready',revision:1,createdAt:at,updatedAt:at,deleted:i%101===0,source:'benchmark'};
      put.run(record.id,JSON.stringify(record),record.id);
    }
    store.db.exec('COMMIT');
    const original = store.records.bind(store);
    let reads=0;
    store.records=(...args)=>{reads++;return original(...args);};
    for (const days of [7,30]) {
      const warmup=store.energy.view({days},now);
      const digest=createHash('sha256').update(JSON.stringify(warmup)).digest('hex');
      const durations=[];
      for(let i=0;i<samples;i++){
        reads=0;
        const start=performance.now();
        store.energy.view({days},now);
        durations.push(performance.now()-start);
      }
      durations.sort((a,b)=>a-b);
      console.log(JSON.stringify({size,days,reads,samples,medianMs:Math.round(durations[2]),p95Ms:Math.round(durations[4]),digest}));
    }
  } finally {
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
}
