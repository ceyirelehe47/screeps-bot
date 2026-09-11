'use strict';
// 一次性只读运行侧确认：订阅本轮账号 console/cpu 频道 60 秒，证明恢复后代码仍在执行。
// 不注入表达式、不写 Memory、不触发任何写操作；token 仅经环境内文件路径加载。
const C=require('D:/code/screeps/incoming/compat-online-tooling-r1/treasury-compat-online-tooling-remediation-I/tools/common.cjs');
const secret=C.loadSecret(process.argv[process.argv.length-1]);
const s=C.loadSession&&null; // no session use
if(typeof WebSocket!=='function'){console.error('NODE_22_WEBSOCKET_REQUIRED');process.exit(1);}
const userId='634fe406347a7b69b28aeccb';
const began=Date.now();let cpu=0,consoleFrames=0,samples=[];
const ws=new WebSocket('wss://screeps.com/socket/websocket');
const done=()=>{console.log(JSON.stringify({status:'RUNTIME_CONFIRMATION_SAMPLE',seconds:(Date.now()-began)/1000,cpuFrames:cpu,consoleFrames:consoleFrames,cpuSample:samples.slice(0,5)}));process.exit(0);};
const timer=setTimeout(done,60000);
ws.addEventListener('open',()=>ws.send('auth '+secret.token));
ws.addEventListener('message',ev=>{
  const text=typeof ev.data==='string'?ev.data:Buffer.from(ev.data).toString('utf8');
  if(text==='auth ok'||text.startsWith('auth ok ')){ws.send('subscribe user:'+userId+'/cpu');ws.send('subscribe user:'+userId+'/console');return;}
  if(text.startsWith('auth ')){console.error('AUTH_FAILED');clearTimeout(timer);process.exit(1);return;}
  try{const x=JSON.parse(text);
    if(Array.isArray(x)&&x[0]==='user:'+userId+'/cpu'&&x[1]&&typeof x[1].cpu==='number'){cpu++;samples.push({cpu:x[1].cpu,t:Date.now()-began});}
    else if(Array.isArray(x)&&x[0]==='user:'+userId+'/console'){consoleFrames++;const tag=(x[1]?.messages?.log||[]).join(' ').slice(0,120);if(tag)console.log('console:',secret.redact(tag));}
  }catch{}
});
ws.addEventListener('error',()=>{console.error('SOCKET_ERROR');clearTimeout(timer);process.exit(1);});
