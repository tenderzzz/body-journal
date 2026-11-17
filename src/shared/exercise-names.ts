// Match known names rather than edit distance: a modifier such as 前蹲、哑铃、
// 史密斯 or 单腿 must not disappear because two strings look similar.
const groups:Record<string,readonly string[]>={
 深蹲:['深蹲','杠铃深蹲','后蹲','杠铃后蹲','背蹲','杠铃背蹲'],
 史密斯深蹲:['史密斯深蹲','史密斯机深蹲'],
 哑铃深蹲:['哑铃深蹲'],壶铃深蹲:['壶铃深蹲'],自重深蹲:['自重深蹲','徒手深蹲'],
 杠铃前蹲:['杠铃前蹲','杠铃前置深蹲','前置杠铃深蹲'],
 杠铃平板卧推:['卧推','杠铃卧推','平板卧推','平板杠铃卧推','杠铃平板卧推'],
 上斜哑铃卧推:['上斜哑铃','哑铃上斜','上斜哑铃卧推','哑铃上斜卧推'],
 下斜哑铃卧推:['下斜哑铃卧推','哑铃下斜卧推'],
 俯身杠铃划船:['俯身杠铃划船','杠铃俯身划船'],
 俯身哑铃划船:['俯身哑铃划船','哑铃俯身划船'],
 杠铃弯举:['杠铃弯举','杠铃二头弯举','杠铃肱二头肌弯举'],
 哑铃弯举:['哑铃弯举','哑铃二头弯举','哑铃肱二头肌弯举'],
 哑铃锤式弯举:['哑铃锤式弯举','锤式哑铃弯举','哑铃锤式二头弯举'],
 绳索三头下压:['绳索下压','绳索三头下压','绳索三头肌下压','三头绳索下压','绳索肱三头肌下压'],
 高位下拉:['高位下拉','器械高位下拉'],
 腿屈伸:['腿屈伸','器械腿屈伸'],
 俯卧腿弯举:['俯卧腿弯举','俯卧屈腿','器械俯卧腿弯举','俯卧器械腿弯举'],
};

export function exerciseNameKey(input:string){
 return input.normalize('NFKC').trim().replace(/槓/g,'杠').replace(/鈴/g,'铃').replace(/啞/g,'哑')
  .replace(/(\p{Script=Han})[\s·•]+(?=\p{Script=Han})/gu,'$1');
}
const names=new Map(Object.entries(groups).flatMap(([name,variants])=>variants.map(raw=>[exerciseNameKey(raw),name] as const)));
export function commonExerciseName(input:string){return names.get(exerciseNameKey(input));}
export function exerciseRuleName(input:string){return commonExerciseName(input)??exerciseNameKey(input);}
