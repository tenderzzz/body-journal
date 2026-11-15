import type {HealthRecord} from './types';

/** A named dish groups records; it is never a nutrition label or a fixed portion. */
export type DishDefinition={id:string;name:string;brand?:string;aliases?:string[];recordIds?:string[];recordKeys?:Record<string,string>;active?:boolean};
export type DishRecordGroup={id:string;name:string;records:HealthRecord[];definition?:DishDefinition};
export type DishNameInfo={name:string;key:string;hasAdditions:boolean};

const count='(?:\\d+(?:\\.\\d+)?|[一二两三四五六七八九十百千万零〇]+)';
const countUnit='(?:个|只|份|碗|盘|杯|袋|盒|块|片|串)';
const terminalCount=new RegExp(`\\s*${count}\\s*${countUnit}\\s*(?=\\(|$)`,'gu');
const leadingCount=new RegExp(`^${count}\\s*(?:份|碗|盘)\\s*`,'u');
const onlyCount=new RegExp(`^${count}\\s*${countUnit}$`,'u');
const completion=/^(?:已|已经|都|全部|全都)?(?:吃完|喝完|吃光|喝光)(?:了)?$/u;
const hasDishAdditions=(name:string)=>/[+➕]|[,，、;；]\s*(?:另|加|搭配|配了|一杯|一份|一个)|(?:另加|外加|再加)/u.test(name);
const riceSide=new RegExp(`^(?:(?:另加|外加|再加|另配|加|搭配|配了|配|和)\\s*)?(?:${count}\\s*(?:小|大)?(?:碗|份)\\s*)?(?:白|糙|杂粮)?米饭(?:\\s*(?:吃了|只吃了?|剩下|剩|约|大约).*)?$`,'u');

/** Punctuation separates a merchant and dish but is not itself a product identity. */
export function dishIdentityKey(name:string):string {
 return name.normalize('NFKC').toLowerCase().replace(/[\s，,、。·：:()[\]【】]/gu,'');
}

export function stableDishId(name:string,brand?:string):string {
 let first=2166136261,second=0x9e3779b9;
 const identity=brand?JSON.stringify([dishIdentityKey(brand),dishIdentityKey(name)]):dishIdentityKey(name);
 for(const char of identity){
  const code=char.codePointAt(0)!;first=Math.imul(first^code,16777619);
  second=Math.imul(second^code,0x85ebca6b);second^=second>>>13;
 }
 return `dish-${(first>>>0).toString(16).padStart(8,'0')}${(second>>>0).toString(16).padStart(8,'0')}`;
}

/** Only remove explicit serving counts/completion, not unknown recipe qualifiers. */
function rawDishNameInfo(text:string):DishNameInfo|undefined {
 const first=text.split(/\r?\n/u).map(line=>line.trim()).find(Boolean);
 if(!first||/^(?:补充|更正|纠正)[：:]/u.test(first))return;
 let name=first.normalize('NFKC').replace(/^(?:早餐|午餐|晚餐|夜宵|餐食|记录)\s*[:：]\s*/u,'').trim();
 name=name.replace(/^(?:(?:今天|今日|这次)(?:的)?\s*)?(?:(?:早餐|早饭|午餐|午饭|晚餐|晚饭|夜宵)(?:是|吃了?|[:：])?\s*)?(?:我(?:又)?吃了?|吃了|点了|依旧(?:是)?|还是|又是)\s*/u,'').trim();
 if(!name||/^(?:和|与).*(?:一样|相同)|^(?:照旧|同上|无补充|无|全部吃完|吃完了|喝完了)$/u.test(name))return;
 // Full recipe/flavor qualifiers remain in the name. In particular, skin/no-skin,
 // different fillings and sauces must not silently share one identity.
 name=name.replace(/\(([^()]*)\)/gu,(whole,inside:string)=>{
  const note=inside.trim();return onlyCount.test(note)||completion.test(note)?'':whole;
 });
 name=name.replace(/[,，]\s*(?:已|已经|都|全部|全都)?(?:吃完|喝完|吃光|喝光)(?:了)?\s*$/u,'');
 name=name.replace(terminalCount,'').replace(leadingCount,'').trim();
 if(!name||name.length>160||/^(?:早餐|午餐|晚餐|夜宵|餐食|今天的饭|这顿|一顿饭)$/u.test(name))return;
 return {name,key:dishIdentityKey(name),hasAdditions:hasDishAdditions(name)};
}

/** Portion/ingredient prose describes this serving, not a new named recipe. */
export function dishNameInfo(text:string):DishNameInfo|undefined {
 const info=rawDishNameInfo(text);if(!info)return;
 let depth=0,separator=-1;
 for(let i=0;i<info.name.length;i++){
  const char=info.name[i];
  if(char==='('||char==='['||char==='【')depth++;
  else if(char===')'||char===']'||char==='】')depth=Math.max(0,depth-1);
  else if(!depth&&/[,，;；]/u.test(char)){separator=i;break;}
 }
 if(separator<0)return info;
 const name=info.name.slice(0,separator).trim(),tail=info.name.slice(separator+1).trim();
 if(!namedPreparedFood({name,key:dishIdentityKey(name),hasAdditions:hasDishAdditions(name)}))return info;
 const clauses=tail.split(/[,，、;；]/u).map(item=>item.trim()).filter(Boolean);
 const description=/^(?:有|含|包含|里面(?:是|有)?|食材|配菜|辅菜|主食|按(?:称|斤|量|重量)|称重|分量|份量|重量|约\s*\d|大约\s*\d)/u;
 if(!clauses.length||!riceSide.test(clauses[0])&&!description.test(clauses[0]))return info;
 if(/馅|味/u.test(clauses[0]))return info;
 // Keep explicit unrelated extras out of automatic whole-meal grouping. Rice
 // accompanying an already named dish is ordinary serving context.
 const rest=clauses.filter(item=>!riceSide.test(item)).join(',');
 if(hasDishAdditions(','+rest))return info;
 return {name,key:dishIdentityKey(name),hasAdditions:false};
}

export function primaryDishName(text:string):string|undefined {return dishNameInfo(text)?.name;}

/** Literal aliases keep their pre-existing meaning in saved definitions/backups. */
export function dishAliasKey(name:string):string {return rawDishNameInfo(name)?.key??dishIdentityKey(name);}

/** A record binding is scoped to the named food, not to the record id forever. */
export function dishRecordKey(record:Pick<HealthRecord,'text'>|string):string {
 const text=typeof record==='string'?record:record.text;
 // Keep existing binding fingerprints stable as display-name extraction improves.
 return stableDishId(rawDishNameInfo(text)?.name??text.split(/\r?\n/u).map(line=>line.trim()).find(Boolean)??'');
}

function definitionMatches(input:string|{id?:string;text:string},definitions:readonly DishDefinition[]):DishDefinition[]{
 const id=typeof input==='string'?undefined:input.id;
 const bound=id?definitions.filter(d=>d.recordIds?.includes(id)&&(!d.recordKeys?.[id]||d.recordKeys[id]===dishRecordKey(input))):[];
 if(bound.length)return bound;
 const info=dishNameInfo(typeof input==='string'?input:input.text);if(!info)return [];
 // A stated brand disambiguates same-named meals. Without one, equal matches
 // remain ambiguous rather than silently borrowing another merchant's template.
 const mentioned=[...new Set(definitions.flatMap(d=>d.brand?[dishIdentityKey(d.brand)]:[]))].filter(brand=>brand&&info.key.includes(brand));
 const brands=mentioned.filter(brand=>!mentioned.some(other=>other!==brand&&other.includes(brand)));
 if(brands.length>1)return [];
 const candidates=brands.length?definitions.filter(d=>d.brand&&dishIdentityKey(d.brand)===brands[0]):definitions;
 const scored=candidates.map(d=>{
  const names=[d.name,...(d.aliases??[])];
  const branded=d.brand?names.flatMap(name=>[`${d.brand} ${name}`,`${d.brand}的${name}`]):[];
  return {d,score:Math.max(0,...[...names,...branded].map(alias=>dishNameSimilarity(info.name,alias)))};
 });
 // Category wording alone cannot identify a merchant when the dish is shared
 // by multiple explicitly saved brands.
 const equivalent=scored.filter(item=>item.score>=2);
 if(!brands.length&&new Set(equivalent.flatMap(item=>item.d.brand?[dishIdentityKey(item.d.brand)]:[])).size>1)
  return equivalent.map(item=>item.d);
 const best=Math.max(0,...scored.map(item=>item.score));
 return best?scored.filter(item=>item.score===best).map(item=>item.d):[];
}

/** Prefer exact names/bindings; tolerate ordinary phrasing only when unambiguous. */
export function matchDish(input:string|{id?:string;text:string},definitions:readonly DishDefinition[]):DishDefinition|undefined {
 const matches=definitionMatches(input,definitions);return matches.length===1?matches[0]:undefined;
}

function namedPreparedFood(info:DishNameInfo):boolean {
 const main=info.name.replace(/\([^()]*\)/gu,'');
 if(info.hasAdditions||main.length<3||/今天|昨天|这次|吃了|吃的|我吃|点了|应该|大概|不知道|一些/u.test(main))return false;
 const simpleName=info.name.replace(/\s*\d+(?:\.\d+)?\s*(?:g|kg|克|千克|ml|毫升)\s*$/iu,'');
 if(/^(?:白|糙|杂粮)?米饭(?:\(熟\))?$|^(?:水煮|煮)?(?:鸡蛋|溏心蛋)$|^(?:蛋白粉|乳清蛋白粉|牛奶|黑咖啡|冰美式|香蕉)$/u.test(simpleName))return false;
 return /包|饺|云吞|馄饨|面|饭|碗|锅|汉堡|沙拉|轻食|贝果|可颂|卷|三明治|便当|套餐|披萨|粥|寿司|烩|汤|饼|咖喱|排|焖|焗|烤/u.test(info.name);
}

function matchingName(name:string){
 const info=dishNameInfo(name);if(!info)return;
 const normalized=info.name.replace(/馄饨|混沌|抄手/gu,'云吞').replace(/鸡扒/gu,'鸡排').replace(/蟹子/gu,'蟹籽');
 // A trailing category label can describe an already named dish. Keep literal
 // names and persisted binding fingerprints intact, and normalize only matching.
 const core=dishIdentityKey(normalized.replace(/\([^()]*\)/gu,''))
  .replace(/(面|饭|米线|米粉|沙拉|便当|三明治|寿司|披萨|卷|碗|饼)轻食$/u,'$1');
 // Preparation/portion prose can vary. Explicit opposing recipes still matter.
 const qualifiers=[
  /(?:去皮|无皮|没(?:有)?(?:鸡)?皮)/u.test(normalized)?'skinless':/带皮|有鸡皮/u.test(normalized)?'skin':undefined,
  normalized.match(/(?:原味|麻辣(?:味)?|香辣(?:味)?|藤椒(?:味)?|酸菜(?:味)?|番茄(?:味)?|葱香(?:味)?|蒜香(?:味)?|奶油(?:味)?|抹茶(?:味)?|巧克力(?:味)?|咖喱(?:味)?)/u)?.[0].replace(/味$/u,''),
  normalized.match(/(?:\d+|[一二两三四五六七八九十]+)种[^()，,]*/u)?.[0]
 ];
 return {info,core,qualifiers};
}

function editDistance(a:string,b:string):number{
 let row=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+Number(a[i-1]!==b[j-1]));row=next;}return row[b.length];
}

/** A small typo is acceptable; changing a filling, merchant or extra food is not. */
export function dishNameSimilarity(a:string,b:string):number{
 const left=matchingName(a),right=matchingName(b);if(!left||!right)return 0;
 if(left.info.key===right.info.key)return 3;
 if(left.info.hasAdditions||right.info.hasAdditions)return 0;
 if(left.qualifiers.some((q,i)=>q&&right.qualifiers[i]&&q!==right.qualifiers[i]))return 0;
 if(dishIdentityKey(left.info.name.replace(/\([^()]*\)/gu,''))===dishIdentityKey(right.info.name.replace(/\([^()]*\)/gu,'')))return 2.5;
 if(left.core===right.core)return 2;
 const min=Math.min(left.core.length,right.core.length);
 if(min<6||left.core.slice(0,3)!==right.core.slice(0,3))return 0;
 const ingredients=(s:string)=>[...new Set(s.match(/鸡胸|鸡腿|鸡排|鸡|鸭|鹅|牛|猪|羊|鱼|虾|蟹|鲜肉|南瓜|香菇|菌菇|黑椒|奥尔良|芝士|培根/gu)??[])].sort().join('|');
 if(ingredients(left.core)!==ingredients(right.core))return 0;
 const merchant=(s:string)=>s.match(/^.*?(?:餐牌|餐厅|餐馆|食堂|门店|品牌)/u)?.[0];
 if(merchant(left.core)!==merchant(right.core))return 0;
 return editDistance(left.core,right.core)<=Math.min(2,Math.floor(min/6))?1:0;
}

/** Each group retains every original record and its own portion/nutrition estimate. */
export function groupDishRecords(records:readonly HealthRecord[],definitions:readonly DishDefinition[]=[]):DishRecordGroup[]{
 const groups=new Map<string,DishRecordGroup>();
 for(const record of [...records].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id))){
  if(record.deleted||record.kind!=='meal')continue;
  const matches=definitionMatches(record,definitions);if(matches.length>1)continue;
  const definition=matches[0],info=dishNameInfo(record.text);
  if(!definition&&(!info||!namedPreparedFood(info)))continue;
  const similar=!definition?[...groups.values()].filter(g=>!g.definition&&dishNameSimilarity(info!.name,g.name)>0):[];
  const best=similar.length?Math.max(...similar.map(g=>dishNameSimilarity(info!.name,g.name))):0;
  const closest=similar.filter(g=>dishNameSimilarity(info!.name,g.name)===best);
  const existing=closest.length===1?closest[0]:undefined;
  const id=definition?.id??existing?.id??stableDishId(info!.name),name=definition?.name??existing?.name??info!.name;
  const group=groups.get(id)??{id,name,records:[],...(definition?{definition}:{})};
  group.records.push(record);groups.set(id,group);
 }
 return [...groups.values()].map(group=>({...group,records:[...group.records].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt))}));
}
