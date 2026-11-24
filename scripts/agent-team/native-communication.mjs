import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { RpcChannel } from './rpc.mjs';
import { hash, readJson, writeJson, safeDirectory, validateConfig, memberDisplayName } from './core.mjs';
import { HANDOFF_FILE, standaloneLaunch } from './handoff.mjs';

export const COMMUNICATION_FILE='native-communication.json';
export const COMMUNICATION_REVISION='native-communication-1';
const samePath=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

// A short-lived client of Codex's own shared daemon. Never create a team server,
// change endpoints, install/update a daemon, or kill its process.
export class NativeMaintenanceClient extends RpcChannel {
  constructor(executable,{timeoutMs=15000}={}){
    super({timeoutMs});
    if(Number(process.versions.node.split('.')[0])<24)throw Error('NATIVE_COMMUNICATION_REQUIRES_NODE_24');
    this.child=spawn(executable,['app-server','proxy'],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    this.child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk.toString('utf8')).slice(-4096);});
    this.child.on('error',error=>this.fail(error));
    this.child.stdin.on('error',error=>this.fail(error));
    this.child.on('close',(code,signal)=>{this.closed=true;this.fail(Error(`NATIVE_PROXY_CLOSED code=${code} signal=${signal}`));});
    // Never answer a model tool/approval request on another client's behalf.
    this.on('request',()=>this.fail(Error('NATIVE_MAINTENANCE_UNEXPECTED_SERVER_REQUEST')));
    this.on('fault',()=>{});
    // proxy carries raw bytes to the official Unix socket. That socket requires
    // WebSocket, NOT JSONL. Use Node's WebSocket implementation, with its HTTP
    // upgrade routed solely through our child pipes. No TCP listener/fallback.
    let dispatched=false;
    const dispatcher={dispatch:(options,handler)=>{
      if(dispatched){handler.onError(Error('NATIVE_PROXY_RECONNECT_FORBIDDEN'));return false;}
      dispatched=true;
      const stream=Duplex.from({readable:this.child.stdout,writable:this.child.stdin});
      const agent=new http.Agent();agent.createConnection=()=>stream;
      const request=http.request({host:'localhost',path:'/',method:'GET',agent,
        headers:{...options.headers,Connection:'Upgrade',Upgrade:'websocket'}});
      handler.onConnect(()=>request.destroy());
      stream.on('error',e=>handler.onError(e));
      request.once('error',e=>handler.onError(e));
      request.once('response',res=>{res.resume();handler.onError(Error(`NATIVE_PROXY_HTTP_${res.statusCode}`));request.destroy();});
      request.once('upgrade',(res,socket,head)=>{if(head.length)socket.unshift(head);handler.onUpgrade(res.statusCode,res.rawHeaders,socket);});
      request.end();return true;
    }};
    this.socket=new WebSocket('ws://localhost/',{dispatcher});
    this.connected=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('NATIVE_PROXY_WEBSOCKET_TIMEOUT')),timeoutMs);
      this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('NATIVE_PROXY_WEBSOCKET_ERROR'));},{once:true});
    });
    this.socket.addEventListener('message',e=>{
      if(typeof e.data!=='string'||Buffer.byteLength(e.data)>this.maxLineBytes){this.fail(Error('NATIVE_PROXY_MESSAGE_LIMIT'));this.socket.close();return;}
      this.consume(Buffer.from(e.data+'\n'));
    });
    this.socket.addEventListener('error',()=>this.fail(Error('NATIVE_PROXY_WEBSOCKET_ERROR')));
    this.socket.addEventListener('close',()=>{if(!this.closing)this.fail(Error('NATIVE_PROXY_WEBSOCKET_CLOSED'));});
  }
  async initialize(){await this.connected;return super.initialize();}
  write(value){if(this.closed||this.failed)throw this.failed||Error('NATIVE_PROXY_CLOSED');this.socket.send(JSON.stringify(value));}
  async close(){this.closing=true;this.socket?.close();await super.close();}
}
