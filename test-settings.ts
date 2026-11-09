import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSettings, editProvider, type SettingsState } from './settingsMenu.ts';
import { saveSettings } from './settingsStorage.ts';
import { advisorBlock, toolResponseFrame } from './cloudAdvisor.ts';
import { executionInstructions } from './executionMode.ts';
let state: SettingsState = {enabled:false,enforced:false,mode:'local-led',source:'config',model:'a/b',timeout:120000};
let round=0, saves=0;
const ui = {
  async select(title:string,options:string[]) {
    if (title.startsWith('Workflow')) return options[2];
    if (title.startsWith('Advisor source')) return options[0];
    if (title.startsWith('OMP advisor')) return options[0];
    return options[[1,3,4,6,7,8][round++]];
  },
  async input(title:string) { return title.startsWith('Maximum consultations') ? '5' : '60'; },
  notify() {},
};
await openSettings(ui,()=>state,{change:p=>state={...state,...p},ompModels:()=>['provider/vendor/model'],provider:async()=>{},save:()=>{saves++;}});
assert.equal(state.mode,'cloud-led'); assert.equal(state.source,'omp'); assert.equal(state.model,'provider/vendor/model'); assert.equal(state.limit,5); assert.equal(state.timeout,60000); assert.equal(saves,1);
const before={...state};
await openSettings({...ui,select:async()=>undefined},()=>state,{change:()=>{throw Error('cancel mutated');},ompModels:()=>[],provider:async()=>{},save:()=>{throw Error('cancel saved');}});
assert.deepEqual(state,before);
let inputs=['router','https://openrouter.ai/api/v1','ADVISOR_KEY','4096'];
const provider=await editProvider({notify(){},input:async()=>inputs.shift(),select:async(_t,o)=>o[0]}, {},'');
assert.equal(provider?.provider.apiKeyEnv,'ADVISOR_KEY'); assert.equal(provider?.provider.api,'openai');
inputs=['bad','https://user:password@example.com'];
assert.equal(await editProvider({notify(){},input:async()=>inputs.shift(),select:async(_t,o)=>o[0]}, {},''),undefined);
const dir=mkdtempSync(join(tmpdir(),'advisor-settings-'));
try {
  const path=join(dir,'config.json');
  writeFileSync(path,JSON.stringify({unrelated:'keep',maxConsultationsPerSession:3,providers:{old:{baseUrl:'https://old.example'}}}));
  saveSettings(path,{executionMode:'cloud-led',maxConsultationsPerSession:undefined,providers:{router:provider!.provider}});
  const saved=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(saved.unrelated,'keep'); assert.equal(saved.maxConsultationsPerSession,undefined); assert.ok(saved.providers.old); assert.ok(saved.providers.router);
  writeFileSync(path,'invalid'); assert.throws(()=>saveSettings(path,{})); assert.equal(readFileSync(path,'utf8'),'invalid');
} finally {rmSync(dir,{recursive:true,force:true});}
assert.match(advisorBlock(undefined,'cloud-led'),/next meaningful execution batch/);
assert.match(executionInstructions('cloud-led'),/Acceptance criteria remain binding/);
assert.equal(executionInstructions('local-led'),'');
assert.match(toolResponseFrame('Plan','cloud-led'),/After this batch/);
assert.doesNotMatch(advisorBlock(),/Cloud-led mode/);
console.log('Settings/mode tests passed: menu navigation, OMP selection, limits, cancellation, provider validation, atomic persistence, adaptive batch prompts.');
