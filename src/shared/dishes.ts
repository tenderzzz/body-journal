import type {HealthRecord} from './types';

/** A named dish groups records; it is never a nutrition label or a fixed portion. */
export type DishDefinition={id:string;name:string;aliases?:string[];recordIds?:string[];recordKeys?:Record<string,string>;active?:boolean};
export type DishRecordGroup={id:string;name:string;records:HealthRecord[];definition?:DishDefinition};
export type DishNameInfo={name:string;key:string;hasAdditions:boolean};

const count='(?:\\d+(?:\\.\\d+)?|[一二两三四五六七八九十百千万零〇]+)';
const countUnit='(?:个|只|份|碗|盘|杯|袋|盒|块|片|串)';
const terminalCount=new RegExp(`\\s*${count}\\s*${countUnit}\\s*(?=\\(|$)`,'gu');
const leadingCount=new RegExp(`^${count}\\s*(?:份|碗|盘)\\s*`,'u');
const onlyCount=new RegExp(`^${count}\\s*${countUnit}$`,'u');
const completion=/^(?:已|已经|都|全部|全都)?(?:吃完|喝完|吃光|喝光)(?:了)?$/u;

/** Punctuation separates a merchant and dish but is not itself a product identity. */
export function dishIdentityKey(name:string):string {
 return name.normalize('NFKC').toLowerCase().replace(/[\s，,、。·：:()[\]【】]/gu,'');
}

export function stableDishId(name:string):string {
 let first=2166136261,second=0x9e3779b9;
 for(const char of dishIdentityKey(name)){
  const code=char.codePointAt(0)!;first=Math.imul(first^code,16777619);
  second=Math.imul(second^code,0x85ebca6b);second^=second>>>13;
 }
 return `dish-${(first>>>0).toString(16).padStart(8,'0')}${(second>>>0).toString(16).padStart(8,'0')}`;
}

/** Only remove explicit serving counts/completion, not unknown recipe qualifiers. */
export function dishNameInfo(text:string):DishNameInfo|undefined {
 const first=text.split(/\r?\n/u).map(line=>line.trim()).find(Boolean);
 if(!first||/^(?:补充|更正|纠正)[：:]/u.test(first))return;
 let name=first.normalize('NFKC').replace(/^(?:早餐|午餐|晚餐|夜宵|餐食|记录)\s*[:：]\s*/u,'').trim();
 if(!name||/^(?:和|与).*(?:一样|相同)|^(?:照旧|同上|无补充|无|全部吃完|吃完了|喝完了)$/u.test(name))return;
 // Full recipe/flavor qualifiers remain in the name. In particular, skin/no-skin,
 // different fillings and sauces must not silently share one identity.
 name=name.replace(/\(([^()]*)\)/gu,(whole,inside:string)=>{
  const note=inside.trim();return onlyCount.test(note)||completion.test(note)?'':whole;
 });
 name=name.replace(/[,，]\s*(?:已|已经|都|全部|全都)?(?:吃完|喝完|吃光|喝光)(?:了)?\s*$/u,'');
 name=name.replace(terminalCount,'').replace(leadingCount,'').trim();
 if(!name||name.length>160||/^(?:早餐|午餐|晚餐|夜宵|餐食|今天的饭|这顿|一顿饭)$/u.test(name))return;
 const hasAdditions=/[+➕]|[,，、;；]\s*(?:另|加|搭配|配了|一杯|一份|一个)|(?:另加|外加|再加)/u.test(name);
 return {name,key:dishIdentityKey(name),hasAdditions};
}

export function primaryDishName(text:string):string|undefined {return dishNameInfo(text)?.name;}

/** A record binding is scoped to the named food, not to the record id forever. */
export function dishRecordKey(record:Pick<HealthRecord,'text'>|string):string {
 const text=typeof record==='string'?record:record.text;
 return stableDishId(primaryDishName(text)??text.split(/\r?\n/u).map(line=>line.trim()).find(Boolean)??'');
}

function definitionMatches(input:string|{id?:string;text:string},definitions:readonly DishDefinition[]):DishDefinition[]{
 const id=typeof input==='string'?undefined:input.id;
 const bound=id?definitions.filter(d=>d.recordIds?.includes(id)&&(!d.recordKeys?.[id]||d.recordKeys[id]===dishRecordKey(input))):[];
 if(bound.length)return bound;
 const info=dishNameInfo(typeof input==='string'?input:input.text);if(!info)return [];
 return definitions.filter(d=>[d.name,...(d.aliases??[])].some(alias=>{
  const named=dishNameInfo(alias);return named?.key===info.key;
 }));
}

/** Exact aliases or explicit record bindings only; ambiguous matches stay unresolved. */
export function matchDish(input:string|{id?:string;text:string},definitions:readonly DishDefinition[]):DishDefinition|undefined {
 const matches=definitionMatches(input,definitions);return matches.length===1?matches[0]:undefined;
}

function namedPreparedFood(info:DishNameInfo):boolean {
 if(info.hasAdditions||info.name.length<3||/今天|昨天|这次|吃了|吃的|我吃|点了|应该|大概|不知道|一些/u.test(info.name))return false;
 const simpleName=info.name.replace(/\s*\d+(?:\.\d+)?\s*(?:g|kg|克|千克|ml|毫升)\s*$/iu,'');
 if(/^(?:白|糙|杂粮)?米饭(?:\(熟\))?$|^(?:水煮|煮)?(?:鸡蛋|溏心蛋)$|^(?:蛋白粉|乳清蛋白粉|牛奶|黑咖啡|冰美式|香蕉)$/u.test(simpleName))return false;
 return /包|饺|云吞|馄饨|面|饭|碗|汉堡|沙拉|轻食|贝果|可颂|卷|三明治|便当|套餐|披萨|粥|寿司|烩|汤|饼|咖喱|排|焖|焗|烤/u.test(info.name);
}

/** Each group retains every original record and its own portion/nutrition estimate. */
export function groupDishRecords(records:readonly HealthRecord[],definitions:readonly DishDefinition[]=[]):DishRecordGroup[]{
 const groups=new Map<string,DishRecordGroup>();
 for(const record of records){
  if(record.deleted||record.kind!=='meal')continue;
  const matches=definitionMatches(record,definitions);if(matches.length>1)continue;
  const definition=matches[0],info=dishNameInfo(record.text);
  if(!definition&&(!info||!namedPreparedFood(info)))continue;
  const id=definition?.id??stableDishId(info!.name),name=definition?.name??info!.name;
  const group=groups.get(id)??{id,name,records:[],...(definition?{definition}:{})};
  group.records.push(record);groups.set(id,group);
 }
 return [...groups.values()].map(group=>({...group,records:[...group.records].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt))}));
}
