import {listPackage,extractFile} from '@electron/asar';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const RESOURCE_FILES=[
  'assets/icon.icns','assets/connection-test.png','data/foods.json','data/README.md',
  'docs/使用说明.html','shortcuts/开始安装.md',
  ...['记一餐','记训练','记身体','随手记'].flatMap(name=>['json','shortcut'].map(ext=>`shortcuts/unsigned/身体手记·${name}.${ext}`)),
];
function files(dir,prefix=''){
  return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);
}
export function verifyResources(bundle){
  const root=path.join(bundle,'Contents/Resources');
  const manifest=JSON.parse(readFileSync(path.join(root,'resources-manifest.json'),'utf8'));
  if(JSON.stringify(Object.keys(manifest).sort())!==JSON.stringify([...RESOURCE_FILES].sort()))throw new Error('发布资源清单与白名单不一致');
  const actual=['assets','data','docs','shortcuts'].flatMap(dir=>files(path.join(root,dir),dir+'/'));
  if(JSON.stringify(actual.sort())!==JSON.stringify([...RESOURCE_FILES].sort()))throw new Error('发布资源包含白名单之外的文件');
  for(const file of actual){
    const sha=createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex');
    if(sha!==manifest[file])throw new Error('发布资源校验失败 '+file);
  }
  const archive=path.join(root,'app.asar');
  const entries=listPackage(archive).filter(file=>!['/dist','/dist/assets','/dist-electron'].includes(file));
  if(entries.some(file=>!/^\/(package\.json|LICENSE|dist\/[^.].*|dist-electron\/(main|preload)\.cjs)$/.test(file)))throw new Error('app.asar 包含未声明的资源');
  const pkg=JSON.parse(extractFile(archive,'package.json').toString());
  if(Object.keys(pkg.dependencies??{}).length)throw new Error('发布资源依赖未收敛');
}
