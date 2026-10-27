"""Generate portable, reviewable Apple Shortcuts. Sign with `shortcuts sign` on macOS.

Text is base64 encoded before JSON interpolation, so quotes/newlines never break
the envelope. No server, API key, AI call or computer connection is needed.
The only installation question is the destination iCloud folder.
"""
from pathlib import Path
import plistlib
import json
import uuid
import argparse

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--only',choices=['meal','training','body','note'],help='仅重新生成指定入口，保留其他快捷指令文件')
selected=parser.parse_args().only

root=Path(__file__).resolve().parents[1]/'shortcuts'
(root/'unsigned').mkdir(parents=True,exist_ok=True)
PREFIX='is.workflow.actions.'
def uid(): return str(uuid.uuid4()).upper()
def variable(name): return {'Type':'Variable','VariableName':name}
def attachment(value): return {'Value':value,'WFSerializationType':'WFTextTokenAttachment'}
def text(*parts):
    value='';ranges={}
    for p in parts:
        if isinstance(p,str): value+=p
        else:
            offset=len(value.encode('utf-16-le'))//2
            ranges['{%d, 1}'%offset]=p;value+='\ufffc'
    return {'Value':{'string':value,'attachmentsByRange':ranges},'WFSerializationType':'WFTextTokenString'} if ranges else value

class Workflow:
    def __init__(self,name,kind): self.name=name;self.kind=kind;self.actions=[]
    def add(self,identifier,**params):
        action_id=uid();params.setdefault('UUID',action_id)
        self.actions.append({'WFWorkflowActionIdentifier':PREFIX+identifier,'WFWorkflowActionParameters':params})
        return {'Type':'ActionOutput','OutputUUID':action_id,'OutputName':identifier}
    def set(self,name,source): self.add('setvariable',WFVariableName=name,WFInput=attachment(source))
    def ask(self,prompt,number=False,default=None):
        params={'WFAskActionPrompt':prompt,'WFInputType':'Number' if number else 'Text'}
        if default is not None: params['WFAskActionDefaultAnswer']=text(default)
        return self.add('ask',**params)
    def condition(self,source):
        group=uid();self.add('conditional',WFControlFlowMode=0,GroupingIdentifier=group,WFConditions={'Value':{'WFActionParameterFilterPrefix':1,'WFContentPredicateBoundedDate':False,'WFActionParameterFilterTemplates':[{'WFCondition':100,'WFInput':{'Type':'Variable','Variable':attachment(source)}}]},'WFSerializationType':'WFContentPredicateTableTemplate'});return group
    def otherwise(self,group): self.add('conditional',WFControlFlowMode=1,GroupingIdentifier=group)
    def endif(self,group): return self.add('conditional',WFControlFlowMode=2,GroupingIdentifier=group)
    def menu(self,prompt,items):
        group=uid();self.add('choosefrommenu',WFControlFlowMode=0,GroupingIdentifier=group,WFMenuPrompt=prompt,WFMenuItems=items);return group
    def branch(self,group,title): self.add('choosefrommenu',WFControlFlowMode=1,GroupingIdentifier=group,WFMenuItemTitle=title)
    def endmenu(self,group): self.add('choosefrommenu',WFControlFlowMode=2,GroupingIdentifier=group)
    def encode_text(self,source):
        result=self.add('base64encode',WFInput=attachment(source),WFEncodeMode='Encode',WFBase64LineBreakMode='None');self.set('记录文字',result)
    def image(self,source):
        source=self.add('getitemfromlist',WFInput=attachment(source),WFItemSpecifier='First Item')
        jpeg=self.add('image.convert',WFInput=attachment(source),WFImageFormat='JPEG',WFImageCompressionQuality=0.85,WFImagePreserveMetadata=False)
        encoded=self.add('base64encode',WFInput=attachment(jpeg),WFEncodeMode='Encode',WFBase64LineBreakMode='None');self.set('记录照片',encoded)
    def require_text(self,source):
        group=self.condition(source)
        self.encode_text(source)
        self.otherwise(group)
        self.add('showresult',Text='没有输入内容，记录未保存。')
        self.add('exit')
        self.endif(group)
    def init(self):
        self.add('comment',WFCommentActionText='身体手记 v0.1.4。原始记录保存到你选择的 iCloud 收件箱；不会调用 AI。只有保存文件成功后才提示成功。安装时请选择 iCloud Drive/Shortcuts/BodyJournal/inbox。若失败或取消，不会显示“已保存”。')
        empty=self.add('gettext',WFTextActionText='')
        self.set('记录文字',empty);self.set('记录照片',empty)
        date=self.add('date',WFDateActionMode='Current Date')
        self.set('记录时间',self.add('format.date',WFDate=text(date),WFDateFormatStyle='Custom',WFDateFormat="yyyy-MM-dd'T'HH:mm:ssXXX"))
        valid_time=self.condition(variable('记录时间'))
        self.otherwise(valid_time)
        self.add('showresult',Text='系统没有生成记录时间，未保存。请更新快捷指令后重试。')
        self.add('exit')
        self.endif(valid_time)
        stamp=self.add('format.date',WFDate=text(date),WFDateFormatStyle='Custom',WFDateFormat='yyyyMMddHHmmssSSS')
        rand=self.add('number.random',WFRandomNumberMinimum=1000000,WFRandomNumberMaximum=9999999)
        self.set('记录编号',self.add('gettext',WFTextActionText=text(stamp,'-',rand)))
    def finish(self):
        envelope=self.add('gettext',WFTextActionText=text('{"version":1,"id":"',variable('记录编号'),'","kind":"'+self.kind+'","occurredAt":"',variable('记录时间'),'","timezone":"Asia/Shanghai","textBase64":"',variable('记录文字'),'","imageBase64":"',variable('记录照片'),'"}'))
        named=self.add('setitemname',WFInput=attachment(envelope),WFName=text(variable('记录编号'),'.health.json'),WFDontIncludeFileExtension=False)
        save_index=len(self.actions)
        saved=self.add('documentpicker.save',WFInput=attachment(named),WFAskWhereToSave=False,WFFileDestinationPath=text(variable('记录编号'),'.health.json'),WFSaveFileOverwrite=False)
        group=self.condition(saved)
        self.add('showresult',Text='已保存到手机收件箱。等待 iCloud 同步后，打开 Mac 的身体手记即可查看。')
        self.otherwise(group)
        self.add('showresult',Text='记录未保存。请检查 iCloud 空间、网络和保存位置后重试。')
        self.endif(group)
        workflow={
            'WFWorkflowName':self.name,'WFWorkflowClientVersion':'3036.0.4','WFWorkflowMinimumClientVersion':900,
            'WFWorkflowMinimumClientVersionString':'900','WFWorkflowTypes':['ActionExtension'],
            'WFWorkflowInputContentItemClasses':['WFImageContentItem'] if self.kind=='meal' else ['WFStringContentItem','WFRichTextContentItem','WFImageContentItem'] if self.kind=='training' else ['WFStringContentItem'],
            'WFWorkflowOutputContentItemClasses':[],'WFWorkflowHasOutputFallback':False,
            'WFWorkflowIcon':{'WFWorkflowIconStartColor':4282601983,'WFWorkflowIconGlyphNumber':59511},
            'WFWorkflowImportQuestions':[{'Category':'Parameter','ActionIndex':save_index,'ParameterKey':'WFFolder','Text':'选择保存位置：iCloud Drive → Shortcuts → BodyJournal → inbox。先在 Mac 应用“连接与数据”建立收件箱。'}],
            'WFWorkflowActions':self.actions,
        }
        if selected and selected!=self.kind: return
        (root/'unsigned'/f'{self.name}.shortcut').write_bytes(plistlib.dumps(workflow,fmt=plistlib.FMT_BINARY,sort_keys=False))
        (root/'unsigned'/f'{self.name}.json').write_text(json.dumps(workflow,ensure_ascii=False,indent=2))
        print(self.name,len(self.actions),'actions')

incoming={'Type':'ExtensionInput'}
meal=Workflow('身体手记·记一餐','meal');meal.init()
g=meal.condition(incoming)
meal.image(incoming)
meal.encode_text(meal.ask('补充菜名、大概分量或剩下多少；没有补充可直接确认。',default='无补充'))
meal.otherwise(g)
mode=meal.menu('这餐怎么记？',['拍照记餐','只记文字'])
meal.branch(mode,'拍照记餐')
meal.image(meal.add('takephoto',WFCameraCaptureDevice='Back',WFCameraCaptureShowPreview=True,WFCameraCaptureCount=1))
meal.encode_text(meal.ask('补充菜名、大概分量或剩下多少；没有补充可直接确认。',default='无补充'))
meal.branch(mode,'只记文字')
meal.require_text(meal.ask('这餐吃了什么？写下菜名和大概分量即可，也可以用键盘听写。例：一碗米饭、两块鸡腿、半份青菜。'))
meal.endmenu(mode);meal.endif(g)
meal.finish()

train=Workflow('身体手记·记训练','training');train.init()
g=train.menu('这次记录训练文字，还是 Keep 等应用的截图？',['训练文字','训练截图'])
train.branch(g,'训练文字');train.require_text(train.ask('粘贴训练笔记，可补充感受。重量注明 kg，组和次不清楚也可以先保存。',default=incoming))
train.branch(g,'训练截图')
h=train.condition(incoming);train.set('照片来源',incoming);train.otherwise(h)
train.set('照片来源',train.add('selectphoto',WFSelectMultiplePhotos=False));train.endif(h)
train.image(variable('照片来源'));train.encode_text(train.ask('补充训练感受或截图中没有的信息；没有补充可直接确认。',default='无补充'))
train.endmenu(g);train.finish()

body=Workflow('身体手记·记身体','body');body.init()
g=body.menu('这次记录什么？',['体重','腰围','体重与腰围'])
for label in ['体重','腰围','体重与腰围']:
    body.branch(g,label);parts=[]
    if label in ['体重','体重与腰围']:parts+=['体重 ',body.ask('体重是多少 kg？',number=True),' kg']
    if label in ['腰围','体重与腰围']:parts+=['\n腰围 ',body.ask('腰围是多少 cm？',number=True),' cm']
    body.encode_text(body.add('gettext',WFTextActionText=text(*parts)))
body.endmenu(g);body.finish()

note=Workflow('身体手记·随手记','note');note.init()
note.require_text(note.ask('记下一点睡眠、疲劳、压力或生活安排。可以使用键盘听写。',default=incoming));note.finish()
