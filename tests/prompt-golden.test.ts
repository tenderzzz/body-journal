import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {analysisInstructions} from '../electron/ai/prompts/analysis';
import {chatInstructions} from '../electron/ai/prompts/chat';
import {CURRENT_PROMPT,type PromptVersion} from '../electron/ai/prompts/version';
import {cases} from './fixtures/prompt-golden';
import {runGoldenCase,scoreGolden} from './fixtures/prompt-runner';

const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
for(const [version,file] of [['journal-1','prompt-baselines'],['journal-2','journal-2'],[CURRENT_PROMPT,CURRENT_PROMPT]] as const){
  test('final instructions match their published snapshots '+version,()=>{
    const expected=JSON.parse(readFileSync(new URL('./fixtures/'+file+'.json',import.meta.url),'utf8'));
    const hashes:Record<string,string>={};
    for(const kind of ['meal','training','note','body'] as const)hashes[kind]=digest(analysisInstructions(kind,'合成教练指令',version as PromptVersion));
    for(const historical of [false,true])for(const energy of [false,true])hashes['chat-'+historical+'-'+energy]=digest(chatInstructions('合成教练指令',historical,energy,version));
    assert.deepEqual(hashes,expected);
  });
}
test('synthetic prompt replays retain main results, field values and only evidenced memories',async()=>{
  assert.equal(new Set(cases.map(c=>c.id)).size,24);
  const rows=[];
  for(const [i,c] of cases.entries())rows.push(await runGoldenCase(c,{provider:i%2?'chatgpt':'deepseek',model:'synthetic-model',version:CURRENT_PROMPT}));
  const groups=scoreGolden(rows);
  assert.equal(groups.length,4);
  for(const group of groups){assert.equal(rows.filter(r=>r.group===group.group).length,6);assert.deepEqual(group.failures,[]);}
});
