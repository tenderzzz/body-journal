import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import path from 'node:path';

export type Shortcut={WFWorkflowActions:{WFWorkflowActionIdentifier:string;WFWorkflowActionParameters:Record<string,any>}[];WFWorkflowImportQuestions:{ActionIndex:number;ParameterKey:string}[]};

// Offline data-flow replay, not an implementation of Apple's runtime. Keep input
// parameter names independent of the generator: Match Text takes `text`, while
// Base64, Set Name and Save File take `WFInput`. Native action signatures:
// https://github.com/EachSheep/ShortcutsBench/blob/master/data/all_api2parasummary.json
type ReplayInput={
  capturedAt:string;
  inbox:string;
  answer:(type:string,index:number)=>unknown;
  menu?:string;
  incoming?:Buffer[];
  album?:Buffer[];
  camera?:Buffer;
  emptyTextIsPresent?:boolean;
  onMessage?:(message:string)=>void;
};

export function replaySteps(shortcut:Shortcut,{date,count,capturedAt,inbox,onMessage}:{date:string;count:number|string;capturedAt:string;inbox:string;onMessage?:(message:string)=>void}){
  return replayShortcut(shortcut,{capturedAt,inbox,onMessage,answer:(type,index)=>{
    assert.ok(index<2,'unexpected additional prompt');
    assert.equal(type,index===0?'Date':'Number');
    return type==='Date'?date:count;
  }});
}

export function replayShortcut(shortcut:Shortcut,input:ReplayInput){
  const {capturedAt,inbox,onMessage}=input;
  const workflow=structuredClone(shortcut),actions=workflow.WFWorkflowActions;
  const variables=new Map<string,any>(),outputs=new Map<string,any>();
  const prompts:string[]=[],messages:string[]=[],files:string[]=[];
  let stopped=false;
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
    if(value.Type==='ExtensionInput')return input.incoming??[];
    if(value.Type==='Variable'){assert.ok(variables.has(value.VariableName),'unset variable '+value.VariableName);return variables.get(value.VariableName);}
    if(value.Type==='ActionOutput'){assert.ok(outputs.has(value.OutputUUID),'unavailable action output '+value.OutputUUID);return outputs.get(value.OutputUUID);}
    throw Error('Unsupported shortcut value');
  }
  const hasValue=(value:any)=>Array.isArray(value)?value.length>0:value!==undefined&&value!==null&&(input.emptyTextIsPresent||value!=='');
  function execute(start:number,end:number){
    const branches:{group:string;parent:boolean;matches?:boolean;choice?:string;active:boolean}[]=[];
    let last:any;
    for(let i=start;i<end&&!stopped;i++){
      const action=actions[i],name=action.WFWorkflowActionIdentifier.replace('is.workflow.actions.',''),p=action.WFWorkflowActionParameters;
      const active=branches.every(branch=>branch.active);
      if(name==='conditional'||name==='choosefrommenu'){
        if(p.WFControlFlowMode===0){
          if(name==='conditional'){
            const condition=p.WFConditions.Value.WFActionParameterFilterTemplates[0];assert.equal(condition.WFCondition,100);
            const matches=active&&hasValue(resolve(condition.WFInput.Variable));
            branches.push({group:p.GroupingIdentifier,parent:active,matches,active:matches});
          }else{
            if(active)assert.ok(p.WFMenuItems.includes(input.menu),'unknown menu selection');
            branches.push({group:p.GroupingIdentifier,parent:active,choice:input.menu,active:false});
          }
        }else{
          const branch=branches.at(-1)!;assert.equal(branch.group,p.GroupingIdentifier);
          if(p.WFControlFlowMode===1)branch.active=branch.parent&&(name==='conditional'?!branch.matches:branch.choice===p.WFMenuItemTitle);
          else{assert.equal(p.WFControlFlowMode,2);branches.pop();}
        }
        continue;
      }
      if(name==='repeat.each'){
        assert.equal(p.WFControlFlowMode,0);
        const stop=actions.findIndex((candidate,j)=>j>i&&candidate.WFWorkflowActionParameters.GroupingIdentifier===p.GroupingIdentifier&&candidate.WFWorkflowActionParameters.WFControlFlowMode===2);
        assert.ok(stop>i&&stop<end,'Repeat with Each is missing End Repeat');
        if(active){
          const items=resolve(p.WFInput);assert.ok(Array.isArray(items));
          const results=[];
          for(const [index,item] of items.entries()){
            variables.set('Repeat Item',item);variables.set('Repeat Index',index+1);
            results.push(execute(i+1,stop));
            if(stopped)break;
          }
          outputs.set(actions[stop].WFWorkflowActionParameters.UUID,results);
          last=results;
        }
        i=stop;
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
          result=input.answer(p.WFInputType,prompts.length);
          prompts.push(p.WFInputType);
          break;
        case 'selectphoto':
          assert.equal(p.WFSelectMultiplePhotos,true);
          result=input.album??[];
          break;
        case 'takephoto':
          assert.equal(p.WFCameraCaptureCount,1);
          result=input.camera?[input.camera]:[];
          break;
        case 'count':{
          assert.equal(p.WFCountType,'Items');
          const items=resolve(p.Input);assert.ok(Array.isArray(items),'Count requires a bound list');
          result=items.length;break;
        }
        case 'image.resize':
          assert.equal(p.WFImageResizeKey,'Longest Edge');
          assert.ok(p.WFImageResizeLength>0&&p.WFImageResizeLength<=2000);
          result=resolve(p.WFImage);assert.ok(Buffer.isBuffer(result));break;
        case 'image.convert':
          assert.equal(p.WFImageFormat,'JPEG');assert.equal(p.WFImagePreserveMetadata,false);
          result=resolve(p.WFInput);assert.ok(Buffer.isBuffer(result));break;
        case 'text.combine':{
          const parts=resolve(p.text);assert.ok(Array.isArray(parts),'Combine Text requires a bound list');
          assert.equal(p.WFTextSeparator,'Custom');
          result=parts.join(p.WFTextCustomSeparator);break;
        }
        case 'text.match':
          assert.ok('text' in p,'Match Text requires its text input; WFInput does not bind this field');
          result=String(resolve(p.text)).match(new RegExp(String(resolve(p.WFMatchTextPattern)),'g'))??[];break;
        case 'base64encode':{
          assert.equal(p.WFEncodeMode,'Encode');assert.equal(p.WFBase64LineBreakMode,'None');
          const value=resolve(p.WFInput);
          result=(Buffer.isBuffer(value)?value:Buffer.from(String(value),'utf8')).toString('base64');break;
        }
        case 'setitemname':result={name:String(resolve(p.WFName)),contents:String(resolve(p.WFInput))};break;
        case 'documentpicker.save':{
          assert.equal(p.WFAskWhereToSave,false);assert.equal(p.WFSaveFileOverwrite,false);
          const item=resolve(p.WFInput),filename=String(resolve(p.WFFileDestinationPath));
          assert.equal(filename,item.name);assert.equal(path.basename(filename),filename);
          result=path.join(p.WFFolder,filename);writeFileSync(result,item.contents,{flag:'wx'});files.push(result);break;
        }
        case 'showresult':result=String(resolve(p.Text));messages.push(result);onMessage?.(result);break;
        case 'exit':stopped=true;return;
        default:throw Error('Unsupported shortcut action '+name);
      }
      outputs.set(p.UUID,result);
      last=result;
    }
    assert.ok(stopped||branches.length===0);
    return last;
  }
  execute(0,actions.length);
  return {prompts,messages,files};
}
