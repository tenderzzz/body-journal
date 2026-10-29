import test from 'node:test';
import assert from 'node:assert/strict';
import {readOpenAI,readDeepSeek} from '../electron/ai/transport';

const text='合成完整回答';
const openAI=[{type:'response.output_text.delta',delta:text},{type:'response.completed',response:{usage:{input_tokens:7,output_tokens:4}}}];
const deepSeek=[{choices:[{delta:{content:text},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:7,completion_tokens:4}},'[DONE]'];
function encoded(events:unknown[]){return new TextEncoder().encode(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''));}
function openResponse(events:unknown[],cleanup:'pending'|'reject'='pending'){
 let controller!:ReadableStreamDefaultController<Uint8Array>,cancelled=0;
 const stream=new ReadableStream<Uint8Array>({start(c){controller=c;c.enqueue(encoded(events));},cancel(){cancelled++;return cleanup==='pending'?new Promise<void>(()=>{}):Promise.reject(new Error('synthetic cleanup error'));}});
 return {response:new Response(stream),stream,cancelled:()=>cancelled,close(){try{controller.close();}catch{}}};
}
async function bounded<T>(promise:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('reader waited for connection closure after terminal event')),100);})]);}finally{clearTimeout(timer);}}

for(const [name,read,events] of [['OpenAI',readOpenAI,openAI],['DeepSeek',readDeepSeek,deepSeek]] as const){
 test(`${name} completes at its terminal event and cancels an open body without awaiting cleanup`,async()=>{
  const source=openResponse([...events,'intentionally invalid bytes after terminal']);
  try{const result=await bounded(read(source.response,()=>{}));assert.deepEqual(result,{text,input:7,output:4});assert.equal(source.cancelled(),1);assert.equal(source.stream.locked,false);}finally{source.close();}
 });
 test(`${name} cleanup rejection does not discard a completed answer`,async()=>{
  const source=openResponse(events,'reject');
  try{assert.equal((await bounded(read(source.response,()=>{}))).text,text);assert.equal(source.cancelled(),1);assert.equal(source.stream.locked,false);await new Promise(resolve=>setTimeout(resolve,0));}finally{source.close();}
 });
}

test('a DeepSeek DONE marker cannot make missing finish or missing usage valid',async()=>{
 for(const events of [[{choices:[{delta:{content:text},finish_reason:null}]},'[DONE]'],[{choices:[{delta:{content:text},finish_reason:'stop'}]},'[DONE]']]){
  const source=openResponse(events);try{await assert.rejects(()=>bounded(readDeepSeek(source.response,()=>{})),/中断|完整用量/);assert.equal(source.cancelled(),1);assert.equal(source.stream.locked,false);}finally{source.close();}
 }
});

test('closed streams without terminal evidence remain incomplete for both providers',async()=>{
 await assert.rejects(()=>readOpenAI(new Response(encoded([{type:'response.output_text.delta',delta:text}])),()=>{}),/中断/);
 await assert.rejects(()=>readDeepSeek(new Response(encoded(deepSeek.slice(0,-1))),()=>{}),/中断/);
});
