/** Conservative formatting equivalence; numeric and negation punctuation matters. */
export function sameMealDescription(a:string,b:string):boolean {
 const first=a.normalize('NFKC').trim(),second=b.normalize('NFKC').trim();
 if(first===second)return true;
 if(/[不没勿别未无]/.test(first+second))return false;
 const key=(text:string)=>text.replace(/(?<=\p{L}),(?=\p{L})/gu,'');
 return key(first)===key(second);
}
