import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

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
  assert.equal(patterns[0].WFWorkflowActionParameters.WFInput.Value.VariableName,'步数');
  assert.equal(patterns[1].WFWorkflowActionParameters.WFInput.Value.VariableName,'步数日期');
  assert.equal(patterns[1].WFWorkflowActionParameters.WFMatchTextPattern.Value.string,'^\ufffc$');
  const labels=actions.map(a=>a.WFWorkflowActionParameters.WFTextActionText);
  assert.ok(labels.includes('全天步数：'));assert.ok(labels.includes('截至目前步数：'));
  const save=actions[workflow.WFWorkflowImportQuestions[0].ActionIndex];
  assert.equal(save.WFWorkflowActionIdentifier,'is.workflow.actions.documentpicker.save');
  assert.equal(save.WFWorkflowActionParameters.WFAskWhereToSave,false);
});
