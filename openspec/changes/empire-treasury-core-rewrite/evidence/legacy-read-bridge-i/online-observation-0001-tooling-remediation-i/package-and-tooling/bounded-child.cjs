'use strict';
const {spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
/** Child is a single Node restore worker, no shell and no descendant processes.
 * Parent returns even if OS termination cannot be confirmed; it never calls that success. */
function runBounded(command,args,{timeoutMs=45000,killGraceMs=2000,maxOutputBytes=65536,redact=x=>x,spawnFn=spawn}={}) {
  return new Promise(resolve=>{
    const started=performance.now();let child,done=false,timedOut=false,killRequested=false,timer,killTimer;
    let stdout='',stderr='',bytes=0;
    const end=(code,closed)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(killTimer);
      const result={code,childClosed:closed,timedOut,killRequested,elapsedMs:performance.now()-started,
        stdout:redact(stdout),stderr:redact(stderr)};
      if(child){child.stdout?.destroy();child.stderr?.destroy();if(!closed)child.unref();}
      resolve(result);
    };
    function terminate(){
      if(done||killRequested)return;killRequested=true;
      try{child.kill('SIGKILL');}catch{}
      killTimer=setTimeout(()=>end(null,false),killGraceMs);
    }
    try {
      child=spawnFn(command,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
      for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',b=>{
        bytes+=b.length;if(bytes>maxOutputBytes){timedOut=true;terminate();return;}
        if(key==='stdout')stdout+=b.toString('utf8');else stderr+=b.toString('utf8');
      });
      child.once('error',()=>end(null,true));child.once('close',code=>end(code,true));
      timer=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
    }catch{end(null,false);}
  });
}
module.exports={runBounded};
