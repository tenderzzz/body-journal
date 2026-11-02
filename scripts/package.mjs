import packager from '@electron/packager';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,copyFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyResources,RESOURCE_FILES} from './package-resources.mjs';
import {tmpdir} from 'node:os';
if(Number(process.versions.node.split('.')[0])!==24)throw new Error('本地打包请使用 Node 24，与发布验证环境一致。');
const staging=mkdtempSync(path.join(tmpdir(),'bodyjournal-package-'));
const source=path.join(staging,'source'),resources=path.join(staging,'resources');
mkdirSync(source);mkdirSync(resources);
const original=JSON.parse(readFileSync('package.json','utf8'));
writeFileSync(path.join(source,'package.json'),JSON.stringify({...original,dependencies:{},devDependencies:{},scripts:{}},null,2));
for(const file of ['dist','dist-electron','LICENSE'])cpSync(file,path.join(source,file),{recursive:true});
const manifest={};
for(const file of RESOURCE_FILES){
  const bytes=readFileSync(file);
  if(file.startsWith('shortcuts/unsigned/')){
    const reviewed=execFileSync('git',['show',`HEAD:${file}`]);
    if(!bytes.equals(reviewed))throw new Error(`快捷指令源文件与已审阅版本不同，请先审阅并提交 ${file}`);
  }
  const dest=path.join(resources,file);mkdirSync(path.dirname(dest),{recursive:true});copyFileSync(file,dest);
  manifest[file]=createHash('sha256').update(bytes).digest('hex');
}
writeFileSync(path.join(resources,'resources-manifest.json'),JSON.stringify(manifest,null,2));
try{
  const paths=await packager({dir:source,out:path.join(staging,'build'),name:'身体手记',executableName:'BodyJournal',appBundleId:'local.bodyjournal.personal',platform:'darwin',arch:'arm64',overwrite:true,asar:true,icon:path.resolve('assets/icon.icns'),prune:false,electronVersion:original.devDependencies.electron,extraResource:['shortcuts','docs','data','assets','resources-manifest.json'].map(p=>path.join(resources,p)),osxSign:false});
  mkdirSync('release',{recursive:true});
  for(const output of paths){
    const bundle=path.join(output,'身体手记.app');verifyResources(bundle);
    execFileSync('codesign',['--force','--deep','--sign','-',bundle],{stdio:'inherit'});
    execFileSync('codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
    const zip='release/身体手记-mac-arm64.zip';
    execFileSync('ditto',['-c','-k','--keepParent',bundle,zip],{stdio:'inherit'});
    const extracted=path.join(staging,'extracted');execFileSync('ditto',['-x','-k',zip,extracted]);
    verifyResources(path.join(extracted,'身体手记.app'));
    writeFileSync('release/SHA256SUMS.txt',execFileSync('shasum',['-a','256',zip],{encoding:'utf8'}));
    writeFileSync('release/build.json',JSON.stringify({bundle,extractedBundle:path.join(extracted,'身体手记.app'),at:new Date().toISOString(),version:original.version,node:process.version},null,2));
  }
  console.log('v'+original.version+' 已打包，白名单、归档资源和签名校验通过。');
}finally{
  // Keep the built app for the packaged desktop verification.
  rmSync(source,{recursive:true,force:true});rmSync(resources,{recursive:true,force:true});
}
