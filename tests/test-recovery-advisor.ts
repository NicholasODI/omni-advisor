import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import extension from '../index.ts';
const gatePath=fileURLToPath(new URL('../logs/omni-advisor-gates.json',import.meta.url));
const logDir=fileURLToPath(new URL('../logs',import.meta.url));
const hadDir=existsSync(logDir),old=existsSync(gatePath)?readFileSync(gatePath):undefined;
const hooks:any={},tools:any={},commands:any={};
const schema:any=new Proxy(()=>schema,{get:()=>schema,apply:()=>schema});
extension({zod:schema,on:(n:string,f:any)=>hooks[n]=f,registerTool:(t:any)=>tools[t.name]=t,registerCommand:(n:string,c:any)=>commands[n]=c} as any);
let auth:'unavailable'|'timeout'='unavailable';let authCalls=0;
const ctx:any={sessionManager:{getSessionFile:()=>'/synthetic/advisor-recovery'},ui:{notify:()=>{}},modelRegistry:{
  find:()=>({provider:'synthetic',id:'model'}),getApiKeyAndHeaders:async()=>{authCalls++;if(auth==='timeout')throw new DOMException('Synthetic timeout','TimeoutError');return {ok:false};},getAvailable:()=>[]}};
const episode=async(label:string)=>{
  for(let i=0;i<3;i++)await hooks.tool_result({toolName:'bash',toolCallId:`${label}-${i}`,input:{command:`synthetic-check ${label}`},isError:true,content:[{type:'text',text:'AssertionError: invariant differs'}]},ctx);
  return (await tools.advisor_recovery.execute('',{},undefined,undefined,ctx)).details.recovery.episodes.at(-1).id;
};
const ask=async(id:string,objective='Review abstract recovery',signal?:AbortSignal)=>tools.ask_advisor.execute('',{objective,questions:'One next action and stopping condition?',recoveryEpisode:id},signal,undefined,ctx);
try {
  await commands['omni-advisor'].handler('on',ctx);
  await commands['omni-advisor'].handler('source omp',ctx);
  await commands['omni-advisor'].handler('model synthetic/model',ctx);
  let id=await episode('privacy');assert.match((await ask(id,'password=SYNTHETIC')).content[0].text,/Privacy check/);assert.match((await ask(id)).content[0].text,/already requested/);assert.equal(authCalls,0);
  id=await episode('cancelled');const cancelled=new AbortController();cancelled.abort();assert.match((await ask(id,undefined,cancelled.signal)).content[0].text,/cancelled/);assert.match((await ask(id)).content[0].text,/already requested/);assert.equal(authCalls,0);
  auth='timeout';id=await episode('timeout');assert.match((await ask(id)).content[0].text,/failed/);assert.match((await ask(id)).content[0].text,/already requested/);assert.equal(authCalls,1);
  auth='unavailable';id=await episode('unavailable');assert.match((await ask(id)).content[0].text,/authenticate/);assert.match((await ask(id)).content[0].text,/already requested/);assert.equal(authCalls,2);
  let menu=0;
  ctx.ui.select=async(_t:string,options:string[])=>options[menu++===0?6:10];
  ctx.ui.input=async(title:string)=>title.startsWith('Maximum')?'1':'120';
  await commands['omni-advisor'].handler('settings',ctx);
  id=await episode('budget');assert.equal((await ask(id)).details.status,'budget');assert.match((await ask(id)).content[0].text,/already requested/);assert.equal(authCalls,2);
} finally {
  if(old)writeFileSync(gatePath,old);else if(existsSync(gatePath))unlinkSync(gatePath);
  if(!hadDir)try{rmdirSync(logDir);}catch{}
}
console.log('Recovery advisor regressions passed: privacy rejection, cancellation, simulated authentication timeout/unavailability, budget exhaustion, and no repeated escalation.');
