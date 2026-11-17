import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import path from 'node:path';

export type Shortcut={WFWorkflowActions:{WFWorkflowActionIdentifier:string;WFWorkflowActionParameters:Record<string,any>}[];WFWorkflowImportQuestions:{ActionIndex:number;ParameterKey:string}[]};

// Offline data-flow replay, not an implementation of Apple's runtime. Keep input
// parameter names independent of the generator: Match Text takes `text`, while
// Base64, Set Name and Save File take `WFInput`. Native action signatures:
// https://github.com/EachSheep/ShortcutsBench/blob/master/data/all_api2parasummary.json
export function replaySteps(shortcut:Shortcut,{date,count,capturedAt,inbox,onMessage}:{date:string;count:number|string;capturedAt:string;inbox:string;onMessage?:(message:string)=>void}){
  const workflow=structuredClone(shortcut),variables=new Map<string,any>(),outputs=new Map<string,any>();
  const prompts:string[]=[],messages:string[]=[],files:string[]=[],branches:{group:string;parent:boolean;matches:boolean;active:boolean}[]=[];
  for(const question of workflow.WFWorkflowImportQuestions){
    assert.equal(question.ParameterKey,'WFFolder');
    assert.equal(workflow.WFWorkflowActions[question.ActionIndex].WFWorkflowActionIdentifier,'is.workflow.actions.documentpicker.save');
    workflow.WFWorkflowActions[question.ActionIndex].WFWorkflowActionParameters.WFFolder=inbox;
  }
  function resolve(value:any):any{
    assert.notEqual(value,undefined,'shortcut input is not connected');
    if(value===null||typeof value!=='object')return value;
    if(value.WFSerializationType==='WFTextTokenAttachment')return resolve(value.Value);
    if(value.WFSerializationType==='WFTextTokenString'){
      let result=value.Value.string as string;
      const ranges=Object.entries(value.Value.attachmentsByRange).map(([range,token])=>({range:range.match(/^\{(\d+), (\d+)\}$/)!,token}));
      for(const {range,token} of ranges.sort((a,b)=>Number(b.range[1])-Number(a.range[1]))){
        const start=Number(range[1]),length=Number(range[2]);result=result.slice(0,start)+String(resolve(token))+result.slice(start+length);
      }
      return result;
    }
    if(value.Type==='Variable'){assert.ok(variables.has(value.VariableName),'unset variable '+value.VariableName);return variables.get(value.VariableName);}
    if(value.Type==='ActionOutput'){assert.ok(outputs.has(value.OutputUUID),'unavailable action output '+value.OutputUUID);return outputs.get(value.OutputUUID);}
    throw Error('Unsupported shortcut value');
  }
  const hasValue=(value:any)=>Array.isArray(value)?value.length>0:value!==undefined&&value!==null&&value!=='';
  for(const action of workflow.WFWorkflowActions){
    const name=action.WFWorkflowActionIdentifier.replace('is.workflow.actions.',''),p=action.WFWorkflowActionParameters;
    const active=branches.every(branch=>branch.active);
    if(name==='conditional'){
      if(p.WFControlFlowMode===0){
        const condition=p.WFConditions.Value.WFActionParameterFilterTemplates[0];assert.equal(condition.WFCondition,100);
        const matches=active&&hasValue(resolve(condition.WFInput.Variable));
        branches.push({group:p.GroupingIdentifier,parent:active,matches,active:matches});
      }else{
        const branch=branches.at(-1)!;assert.equal(branch.group,p.GroupingIdentifier);
        if(p.WFControlFlowMode===1)branch.active=branch.parent&&!branch.matches;
        else{assert.equal(p.WFControlFlowMode,2);branches.pop();}
      }
      continue;
    }
    if(!active)continue;
    let result:any;
    switch(name){
      case 'comment':continue;
      case 'date':assert.equal(p.WFDateActionMode,'Current Date');result=capturedAt;break;
      case 'format.date':{
        const input=String(resolve(p.WFDate));
        if(p.WFDateFormat==='yyyy-MM-dd')result=input.slice(0,10);
        else if(p.WFDateFormat==='yyyyMMddHHmmssSSS')result=input.slice(0,19).replace(/\D/g,'')+'000';
        else{assert.equal(p.WFDateFormat,"yyyy-MM-dd'T'HH:mm:ssXXX");result=input;}
        break;
      }
      case 'number.random':result=1234567;break;
      case 'gettext':result=resolve(p.WFTextActionText);break;
      case 'setvariable':variables.set(p.WFVariableName,resolve(p.WFInput));break;
      case 'ask':
        prompts.push(p.WFInputType);
        assert.ok(prompts.length<=2,'unexpected additional prompt');
        assert.equal(p.WFInputType,prompts.length===1?'Date':'Number');
        result=p.WFInputType==='Date'?date:count;break;
      case 'text.match':
        assert.ok('text' in p,'Match Text requires its text input; WFInput does not bind this field');
        result=String(resolve(p.text)).match(new RegExp(String(resolve(p.WFMatchTextPattern)),'g'))??[];break;
      case 'base64encode':assert.equal(p.WFEncodeMode,'Encode');result=Buffer.from(String(resolve(p.WFInput)),'utf8').toString('base64');break;
      case 'setitemname':result={name:String(resolve(p.WFName)),contents:String(resolve(p.WFInput))};break;
      case 'documentpicker.save':{
        assert.equal(p.WFAskWhereToSave,false);assert.equal(p.WFSaveFileOverwrite,false);
        const item=resolve(p.WFInput),filename=String(resolve(p.WFFileDestinationPath));
        assert.equal(filename,item.name);assert.equal(path.basename(filename),filename);
        result=path.join(p.WFFolder,filename);writeFileSync(result,item.contents,{flag:'wx'});files.push(result);break;
      }
      case 'showresult':result=String(resolve(p.Text));messages.push(result);onMessage?.(result);break;
      case 'exit':return {prompts,messages,files};
      default:throw Error('Unsupported shortcut action '+name);
    }
    outputs.set(p.UUID,result);
  }
  assert.equal(branches.length,0);
  return {prompts,messages,files};
}
