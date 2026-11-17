import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {InboxSync} from '../electron/core/inbox';
import {replaySteps,type Shortcut} from './fixtures/shortcut-replay';

const shortcut=()=>JSON.parse(readFileSync(new URL('../shortcuts/unsigned/身体手记·记步数.json',import.meta.url),'utf8')) as Shortcut;
const capturedAt='2026-10-27T02:00:00+08:00';
function setup(t:test.TestContext){
  const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-shortcut-replay-')),inbox=path.join(root,'inbox');mkdirSync(inbox);
  t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,inbox};
}

test('step shortcut captures the number once and uses named values to determine coverage without another menu',()=>{
  const workflow=JSON.parse(readFileSync(new URL('../shortcuts/unsigned/身体手记·记步数.json',import.meta.url),'utf8'));
  const actions=workflow.WFWorkflowActions as {WFWorkflowActionIdentifier:string;WFWorkflowActionParameters:Record<string,any>}[];
  const asks=actions.filter(a=>a.WFWorkflowActionIdentifier==='is.workflow.actions.ask');
  assert.deepEqual(asks.map(a=>a.WFWorkflowActionParameters.WFInputType),['Date','Number']);
  const numberId=asks[1].WFWorkflowActionParameters.UUID;
  const numberConsumers=actions.filter(a=>a.WFWorkflowActionParameters.UUID!==numberId&&JSON.stringify(a.WFWorkflowActionParameters).includes(numberId));
  assert.equal(numberConsumers.length,1);assert.equal(numberConsumers[0].WFWorkflowActionIdentifier,'is.workflow.actions.setvariable');
  assert.equal(numberConsumers[0].WFWorkflowActionParameters.WFVariableName,'步数');
  assert.equal(actions.filter(a=>a.WFWorkflowActionIdentifier==='is.workflow.actions.choosefrommenu').length,0);
  const patterns=actions.filter(a=>a.WFWorkflowActionIdentifier==='is.workflow.actions.text.match');
  assert.equal(patterns[0].WFWorkflowActionParameters.text.Value.attachmentsByRange['{0, 1}'].VariableName,'步数');
  assert.equal(patterns[1].WFWorkflowActionParameters.text.Value.attachmentsByRange['{0, 1}'].VariableName,'步数日期');
  assert.equal(patterns[1].WFWorkflowActionParameters.WFMatchTextPattern.Value.string,'^\ufffc$');
  const labels=actions.map(a=>a.WFWorkflowActionParameters.WFTextActionText);
  assert.ok(labels.includes('全天步数：'));assert.ok(labels.includes('截至目前步数：'));
  const save=actions[workflow.WFWorkflowImportQuestions[0].ActionIndex];
  assert.equal(save.WFWorkflowActionIdentifier,'is.workflow.actions.documentpicker.save');
  assert.equal(save.WFWorkflowActionParameters.WFAskWhereToSave,false);
});

test('the old Match Text parameter leaves a required input unbound after the two intended prompts',t=>{
  const {inbox}=setup(t),workflow=shortcut();
  for(const action of workflow.WFWorkflowActions)if(action.WFWorkflowActionIdentifier==='is.workflow.actions.text.match'){
    const p=action.WFWorkflowActionParameters;p.WFInput=p.text;delete p.text;
  }
  assert.throws(()=>replaySteps(workflow,{date:'2026-10-26',count:8900,capturedAt,inbox}),/Match Text requires its text input/);
});

for(const sample of [
  {date:'2026-10-27',input:6240,steps:6240,coverage:'partial'},
  {date:'2026-10-26',input:'8,900',steps:8900,coverage:'full'},
  {date:'2026-10-26',input:0,steps:0,coverage:'full'},
  {date:'2026-10-26',input:100000,steps:100000,coverage:'full'}
])test('generated shortcut saves and imports '+sample.input+' steps for '+sample.date,async t=>{
  const {root,inbox}=setup(t),result=replaySteps(shortcut(),{date:sample.date,count:sample.input,capturedAt,inbox});
  assert.deepEqual(result.prompts,['Date','Number']);assert.equal(result.files.length,1);assert.match(result.messages.at(-1)!,/已保存/);
  const envelope=JSON.parse(readFileSync(result.files[0],'utf8'));
  assert.equal(envelope.dateLocked,true);assert.equal(envelope.occurredAt,sample.date+'T12:00:00+08:00');
  assert.equal(path.basename(result.files[0]),envelope.id+'.health.json');
  const store=new HealthStore(root,new FoodCatalog([]),inbox,false),sync=new InboxSync(store,path.join(root,'sync.json'),()=>{});
  try{
    sync.start();
    await sync.scan();assert.equal(store.syncState.imported,1);assert.deepEqual(store.syncState.errors,[]);
    const records=store.records();assert.equal(records.length,1);assert.equal(records[0].status,'ready');assert.equal(records[0].analysisPending,false);
    assert.deepEqual(records[0].analysis?.dailyActivity,{reportDate:sample.date,steps:sample.steps,scope:'all',coverage:sample.coverage,asOf:capturedAt,sourceApp:'手动记录'});
    const overview=store.energy.overview(new Date(capturedAt));assert.equal(overview.stepDate,'2026-10-27');
    const day=overview.steps.find(day=>day.date===sample.date)!;assert.equal(day.count,sample.steps);assert.equal(day.coverage,sample.coverage);
    await sync.scan();assert.equal(store.syncState.imported,0);assert.equal(store.records().length,1);
  }finally{await sync.stop();store.close();}
});

for(const count of [-1,100001,1.5,'abc'])test('invalid shortcut steps '+count+' do not save a file',t=>{
  const {inbox}=setup(t),result=replaySteps(shortcut(),{date:'2026-10-26',count,capturedAt,inbox});
  assert.deepEqual(result.prompts,['Date','Number']);assert.deepEqual(result.files,[]);assert.ok(result.messages.every(message=>!message.includes('已保存')));
});

test('an unavailable destination fails before the shortcut can show saved',t=>{
  const {inbox}=setup(t),messages:string[]=[];
  assert.throws(()=>replaySteps(shortcut(),{date:'2026-10-26',count:8900,capturedAt,inbox:path.join(inbox,'missing'),onMessage:message=>messages.push(message)}),/ENOENT/);
  assert.ok(messages.every(message=>!message.includes('已保存')));
});
