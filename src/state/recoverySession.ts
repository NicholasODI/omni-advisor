import { RECOVERY_ENTRY, RecoveryController } from '../workflow/recovery.ts';
interface Session { getSessionFile?(): string; getBranch?(): any[]; }
/** Session-owned custom entries; no shared filesystem protocol or project memory. */
export class RecoverySessions {
  private controllers = new Map<string, RecoveryController>();
  private durable = new Set<string>();
  private append?: (type: string, data: unknown) => void;
  private saved = new Map<string,string>();
  constructor(append?: (type: string, data: unknown) => void) {this.append=append;}
  get(key: string, session: Session): RecoveryController {
    if(!this.controllers.has(key)) this.restore(key,session);
    return this.controllers.get(key)!;
  }
  restore(key: string, session: Session): void {
    const controller=new RecoveryController();
    this.durable.delete(key);
    try {
      const entries=session.getBranch?.() ?? [];
      for(let i=entries.length-1;i>=0;i--) {
        const e=entries[i];
        if(e.type==='custom' && e.customType===RECOVERY_ENTRY) {if(controller.restore(e.data))this.durable.add(key);break;}
      }
    } catch { /* unavailable history: isolated fresh state, never borrow another session */ }
    this.controllers.set(key,controller);
    this.saved.delete(key);
  }
  save(key: string): boolean {
    try {
      if(!this.append || key==='unknown' || key.startsWith('ephemeral:'))return false;
      const snapshot=this.controllers.get(key)!.snapshot(), encoded=JSON.stringify(snapshot);
      if(this.saved.get(key)===encoded)return this.durable.has(key);
      this.append(RECOVERY_ENTRY,snapshot);this.saved.set(key,encoded);this.durable.add(key);return true;
    } catch {this.durable.delete(key);return false;}
  }
  persistence(key: string): string {if(key==='unknown'||key.startsWith('ephemeral:'))return 'no stable session identity; memory only';return this.append ? this.durable.has(key) ? 'session entry saved' : 'not yet saved or write failed' : 'host appendEntry unavailable; memory only';}
  forget(key: string): void {this.controllers.delete(key);this.durable.delete(key);this.saved.delete(key);}
}
