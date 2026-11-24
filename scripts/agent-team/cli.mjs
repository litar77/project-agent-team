import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {safeDirectory} from './core.mjs';
const print=x=>process.stdout.write(JSON.stringify(x,null,2)+'\n');
async function main(args){
  const command=args.shift();const get=(key,fallback)=>{const i=args.indexOf(`--${key}`);return i<0?fallback:args[i+1];};
  if(command==='runtime-confirm'){
    const {askYesNo}=await import('./native.mjs');
    if(!await askYesNo('采用并记住上述已核验的本机环境？下次无需填写长路径'))process.exitCode=2;
    return;
  }
  if(command==='runtime-fingerprint'){
    const digest=file=>{
      file=safeDirectory(file);const stat=fs.statSync(file);
      if(!stat.isFile()||stat.size>512*1024*1024||!path.isAbsolute(file))throw Error('INVALID_RUNTIME_FILE');
      const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024);
      try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}
      return h.digest('hex');
    };
    print({nodeSha256:digest(process.execPath),codexSha256:digest(get('codex'))});return;
  }
  if(command==='native'){
    const {openNative}=await import('./native.mjs');
    await openNative(path.resolve(get('config')),get('member'),{windowTicket:get('window-ticket')});
    return;
  }
  throw Error('UNKNOWN_COMMAND');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
