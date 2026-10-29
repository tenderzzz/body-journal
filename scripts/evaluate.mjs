import {readFileSync,statSync} from 'node:fs';
import {tsImport} from 'tsx/esm/api';
const {evaluateDataset}=await tsImport('../src/shared/evaluation.ts',import.meta.url);
const file=process.argv[2];
if(!file){process.stderr.write('用法：npm run evaluate -- /绝对路径/评测数据.json\n');process.exitCode=1;}
else try{
  const info=statSync(file);
  if(!info.isFile()||info.size>10*1024*1024)throw new Error('请选择不超过10 MB的评测文件');
  const report=evaluateDataset(JSON.parse(readFileSync(file,'utf8')));
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
}catch(error){process.stderr.write((error instanceof Error?error.message:'评测失败')+'\n');process.exitCode=1;}
