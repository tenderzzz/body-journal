/** Accept a first-person occurrence, including one following an independent quoted sentence. */
export function isPersonalEvidence(source:string,quote:string){
  if(!quote)return false;
  for(let at=source.indexOf(quote);at>=0;at=source.indexOf(quote,at+quote.length)){
    const before=source.slice(0,at).split(/[。！？!?；;]/).at(-1)??'';
    const context=before+quote;
    if(!/(?:教练|别人|朋友|同学|他|她)(?:对我)?(?:说|建议|写道)|(?:截图|OCR|引用|转述|原文示例)(?:里|中|上)?(?:写着|写道|显示|文字)?[：:「“]/i.test(context))return true;
  }
  return false;
}
