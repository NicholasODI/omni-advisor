import { createHash } from 'node:crypto';
const fingerprint=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,24);
export interface LogicalCheck { key:string; kind:'build'|'test'|'lint'|'typecheck'|'cleanup'; filtered:boolean; }
/** Recognize bounded common runner forms, not arbitrary shell semantics. */
export function logicalChecks(command: unknown, cwd: unknown=''): LogicalCheck[] {
  if(typeof command!=='string'||command.length>16000)return [];
  const matches:LogicalCheck[]=[];
  const runner=/\b(?:(pnpm|npm|yarn|bun)\s+(?:(?:-s|--silent)\s+)?(?:run\s+)?(build|typecheck|lint|test(?::[\w-]+)?)|(?:pnpm\s+exec\s+)?(next)\s+(build)|(?:python(?:3|\.exe)?\s+-m\s+)?(pytest)|(?:pnpm\s+exec\s+)?(vitest|playwright)\s+(run|test))\b/g;
  let match:RegExpExecArray|null;
  while((match=runner.exec(command))!==null){
    // Avoid quoted source/documentation inside echo, node -e, or eval strings.
    const prefix=command.slice(0,match.index);
    const segment=prefix.split(/&&|;|\n/).at(-1)??'';
    if(/\b(?:echo|printf|node\s+-e|bun\s+-e)\b/.test(segment))continue;
    const tail=command.slice(runner.lastIndex).split(/[|;&\n]/,1)[0];
    if(/\s--(?:help|version)\b/.test(tail))continue;
    const script=match[2]??match[4]??(match[5]?'pytest':`${match[6]}:${match[7]}`);
    const kind=script==='build'?'build':script==='typecheck'?'typecheck':script==='lint'?'lint':'test';
    // Preserve a simple leading cd scope so baseline-worktree checks are distinct.
    const cds=[...prefix.matchAll(/(?:^|&&|;)\s*cd\s+["']?([\w./\\:-]+)["']?\s*(?:&&|;)/g)].map(m=>m[1]);
    // Relevant target arguments remain distinct; output redirection/wrappers do not.
    const args=kind==='test'?tail.replace(/\s+\d?>[\s\S]*/,'').replace(/["']/g,'').replace(/\s+/g,' ').trim():'';
    const scope=String(cwd??'').replace(/\\/g,'/')+':'+cds.join('/');
    matches.push({key:fingerprint(`check:${scope}:${script}:${args}`),kind,filtered:/\|\s*(?:tail|head|grep|sed|tee)\b|\d?>/.test(command)});
  }
  if(!matches.length) for(const cleanup of command.matchAll(/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+([^|&;\n]+)/g)) {
    const targets=cleanup[1].replace(/\s+\d?>[\s\S]*/,'').replace(/["']/g,'').trim().split(/\s+/);
    if(targets.length&&targets.every(t=>/^[\w./\\:-]+$/.test(t)&&!t.startsWith('-')))matches.push({key:fingerprint(`cleanup:${String(cwd??'')}:${targets.sort().join('|')}`),kind:'cleanup',filtered:/\||>/.test(command)});
  }
  return [...new Map(matches.map(m=>[m.key,m])).values()].slice(0,8);
}
