import initSqlJs, {type Database, type SqlJsStatic} from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as D from '../domain/index.ts';
import type {Entry,Snapshot,Settings,Pomo} from '../shared/types.ts';

export const defaults:Settings={theme:'system',weekStart:1,timeFormat:'24h',dailyGoal:8,weeklyGoal:40,workMinutes:25,shortBreak:5,longBreak:15,cycles:4,shortcut:'Control+Alt+T',senderName:'',senderAddress:'',senderEmail:'',paymentDetails:'',invoicePrefix:'INV-',timeline:true};
export const emptyPomo:Pomo={active:false,phase:'work',paused:false,awaiting:false,alarming:false,remaining:0,deadline:0,cycle:1,entryId:null,projectId:null,tagIds:[],note:''};
export function unwrap<T>(r:D.Result<T>):T {if(!r.ok){let msg=r.error.message;if(r.error.conflict){const c=r.error.conflict;msg+=` ${new Date(c.startAt).toLocaleString()} – ${new Date(c.effectiveEndMs).toLocaleString()}.`;}throw new Error(msg);}return r.value;}
function checkEntryDate(value:number){const date=new Date(value);if(!Number.isSafeInteger(value)||!Number.isFinite(date.getTime())||date.getFullYear()<1900||date.getFullYear()>2100)throw new Error('Choose a date between 1900 and 2100.');}
export class Store {
 db!:Database;SQL!:SqlJsStatic;file:string;notice:string|null=null;shortcutError:string|null=null;
 constructor(public folder:string){this.file=path.join(folder,'timelog.sqlite');}
 async open(wasm:string){
  fs.mkdirSync(this.folder,{recursive:true});this.SQL=await initSqlJs({locateFile:()=>wasm});
  let recovered=false;
  if(fs.existsSync(this.file)){
   try{this.db=this.load(fs.readFileSync(this.file));}catch{
    const backup=this.file+'.bak';if(!fs.existsSync(backup))throw new Error('The database is damaged and no recovery copy exists. Your files have been kept.');
    this.db=this.load(fs.readFileSync(backup));fs.copyFileSync(this.file,this.file+'.damaged-'+Date.now());recovered=true;
   }
  }else this.db=new this.SQL.Database();
  this.db.run('PRAGMA foreign_keys=ON');
  const exists=this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").length>0;
  const versions=exists?this.rows('SELECT version FROM schema_migrations').map(r=>r.version):[];
  if(versions.some(v=>v>2))throw new Error('This database belongs to a newer TimeLog version.');
  for(const filename of fs.readdirSync(path.join(__dirname,'migrations')).sort()){
   const version=Number(filename.slice(0,3));if(versions.includes(version))continue;
   this.db.run('BEGIN');try{this.db.run(fs.readFileSync(path.join(__dirname,'migrations',filename),'utf8'));this.db.run('INSERT INTO schema_migrations VALUES(?,?)',[version,Date.now()]);this.db.run('COMMIT');}catch(e){this.db.run('ROLLBACK');throw e;}
  }
  this.validate();this.flush();if(recovered)this.notice='TimeLog restored your last recovery copy. The damaged file was kept in the data folder.';
 }
 load(bytes:Uint8Array){const db=new this.SQL.Database(bytes);db.run('PRAGMA foreign_keys=ON');const result=db.exec('PRAGMA integrity_check');if(result[0]?.values[0]?.[0]!=='ok'){db.close();throw new Error('Database integrity check failed.');}return db;}
 rows(sql:string,args:any[]=[]):any[]{const statement=this.db.prepare(sql);try{statement.bind(args);const result=[];while(statement.step())result.push(statement.getAsObject());return result;}finally{statement.free();}}
 write(sql:string,args:any[]=[]){this.db.run(sql,args);}
 transaction<T>(fn:()=>T):T{
  const old=this.db.export();this.db.run('PRAGMA foreign_keys=ON');this.db.run('BEGIN');try{const value=fn();this.db.run('COMMIT');this.flush();return value;}catch(e){try{this.db.run('ROLLBACK');}catch{}this.db.close();this.db=new this.SQL.Database(old);this.db.run('PRAGMA foreign_keys=ON');throw e;}
 }
 flush(){
  const temp=this.file+'.tmp';const bytes=this.db.export();this.db.run('PRAGMA foreign_keys=ON');const fd=fs.openSync(temp,'w');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(fs.existsSync(this.file))fs.copyFileSync(this.file,this.file+'.bak');fs.renameSync(temp,this.file);
 }
 settings():Settings{const values=this.rows('SELECT key,value FROM settings');const s={...defaults};for(const r of values){if(r.key in defaults)(s as any)[r.key]=JSON.parse(r.value);}return s;}
 pomo():Pomo {const r=this.rows("SELECT value FROM settings WHERE key='pomodoroState'")[0];return {...emptyPomo,...(r?JSON.parse(r.value):{})};}
 putPomo(p:Pomo){this.write("INSERT INTO settings(key,value) VALUES('pomodoroState',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(p)]);}
 saveSettings(input:any){const s={...this.settings(),...input};if(!['light','dark','system'].includes(s.theme)||![0,1].includes(s.weekStart)||!['12h','24h'].includes(s.timeFormat)||typeof s.timeline!=='boolean')throw new Error('Invalid general setting.');
  for(const k of ['dailyGoal','weeklyGoal'] as const)if(!Number.isFinite(s[k])||s[k]<0||s[k]>168)throw new Error('Goals must be between 0 and 168 hours.');
  for(const k of ['workMinutes','shortBreak','longBreak'] as const)if(!Number.isInteger(s[k])||s[k]<1||s[k]>1440)throw new Error('Pomodoro phases must be 1–1440 whole minutes.');
  if(!Number.isInteger(s.cycles)||s.cycles<1||s.cycles>20)throw new Error('Cycles must be between 1 and 20.');
  unwrap(D.normalizeInvoicePrefix(s.invoicePrefix));for(const k of ['senderName','senderAddress','senderEmail','paymentDetails','shortcut'] as const)if(typeof s[k]!=='string'||s[k].length>2000)throw new Error('Invalid settings text.');
  unwrap(D.validateEmail(s.senderEmail));if(s.shortcut.length>100)throw new Error('Shortcut is too long.');
  this.transaction(()=>{for(const key of Object.keys(defaults))this.write('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,JSON.stringify((s as any)[key])]);});
 }
 projects():D.Project[]{return this.rows('SELECT * FROM projects ORDER BY archived,name COLLATE NOCASE').map(r=>({id:r.id,name:r.name,clientId:r.client_id,hourlyRateMinor:r.hourly_rate_minor,currency:r.currency,archived:!!r.archived,createdAt:r.created_at}));}
 clients():D.Client[]{return this.rows('SELECT * FROM clients ORDER BY archived,name COLLATE NOCASE').map(r=>({id:r.id,name:r.name,email:r.email,address:r.address,currency:r.currency,archived:!!r.archived,createdAt:r.created_at}));}
 tags():D.Tag[]{return this.rows('SELECT * FROM tags ORDER BY name COLLATE NOCASE');}
 entries():Entry[]{const links=this.rows('SELECT * FROM entry_tags');return this.rows('SELECT * FROM time_entries ORDER BY start_at DESC').map(r=>({id:r.id,projectId:r.project_id,startAt:r.start_at,endAt:r.end_at,note:r.note,billable:!!r.billable,hourlyRateMinor:r.hourly_rate_minor,currency:r.currency,tagIds:links.filter(l=>l.entry_id===r.id).map(l=>l.tag_id)}));}
 invoices():D.InvoiceRow[]{return this.rows('SELECT * FROM invoices ORDER BY sequence_number DESC');}
 snapshot():Snapshot{return {entries:this.entries(),projects:this.projects(),clients:this.clients(),tags:this.tags(),invoices:this.invoices(),settings:this.settings(),pomo:this.pomo(),now:Date.now(),notice:this.notice,shortcutError:this.shortcutError};}
 context(){return {entries:this.entries(),nowMs:Date.now(),projectNames:Object.fromEntries(this.projects().map(p=>[p.id,p.name]))};}
 project(id:string|null){if(id===null||id===undefined)return null;unwrap(D.validateId(id));const p=this.projects().find(p=>p.id===id);if(!p)throw new Error('Project not found.');return p;}
 getEntry(id:string){unwrap(D.validateId(id));const e=this.entries().find(e=>e.id===id);if(!e)throw new Error('Entry not found.');return e;}
 checkTags(tagIds:unknown):string[]{if(!Array.isArray(tagIds))throw new Error('Tags must be a list.');const available=this.tags();for(const id of tagIds){unwrap(D.validateId(id));if(!available.some(t=>t.id===id))throw new Error('Tag not found.');}return [...new Set(tagIds)];}
 putEntry(e:D.TimeEntry,tagIds:string[]){this.write('INSERT INTO time_entries VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,start_at=excluded.start_at,end_at=excluded.end_at,note=excluded.note,billable=excluded.billable,hourly_rate_minor=excluded.hourly_rate_minor,currency=excluded.currency',[e.id,e.projectId,e.startAt,e.endAt,e.note,e.billable?1:0,e.hourlyRateMinor,e.currency]);this.write('DELETE FROM entry_tags WHERE entry_id=?',[e.id]);for(const id of tagIds)this.write('INSERT INTO entry_tags VALUES(?,?)',[e.id,id]);}
 saveEntry(input:any):Entry{
  checkEntryDate(input.startAt);if(input.endAt!==null)checkEntryDate(input.endAt);
  const ctx=this.context();const existing=input.id?this.getEntry(input.id):null;const project=this.project(input.projectId??null);if(project?.archived&&existing?.projectId!==project.id)throw new Error('Choose an active project.');
  const tagIds=this.checkTags(input.tagIds??[]);let result:D.TimeEntry;
  if(existing)result=unwrap(D.prepareEntryEdit(existing,{startAt:input.startAt,endAt:input.endAt,project,note:input.note,billable:input.billable,...(input.rateSnapshot?{rateSnapshot:input.rateSnapshot}:{})},ctx));
  else result=unwrap(D.prepareManualEntry({id:randomUUID(),project,startAt:input.startAt,endAt:input.endAt,note:input.note,billable:input.billable},ctx));
  this.transaction(()=>this.putEntry(result,tagIds));return {...result,tagIds};
 }
 startTimer(input:any):Entry{checkEntryDate(input.startAt??Date.now());const project=this.project(input.projectId??null);if(project?.archived)throw new Error('Choose an active project.');const tagIds=this.checkTags(input.tagIds??[]);const r=unwrap(D.prepareTimerStart({id:randomUUID(),project,note:input.note??'',billable:input.billable??true,startAt:input.startAt},this.context()));this.transaction(()=>this.putEntry(r.entry,tagIds));return {...r.entry,tagIds};}
 stopTimer(stopAt?:number){const running=this.entries().find(e=>e.endAt===null);if(!running)return;const result=unwrap(D.stopTimer(running,this.context(),stopAt));this.transaction(()=>{if(result.kind==='delete-entry')this.write('DELETE FROM time_entries WHERE id=?',[running.id]);else this.putEntry(result.entry,running.tagIds);});}
 saveProject(i:any){const old=this.projects().find(p=>p.id===i.id);if(i.id&&!old)throw new Error('Project not found.');const p=unwrap(old?D.updateProject(old,i):D.prepareProject({...i,id:randomUUID(),createdAt:Date.now()}));if(p.clientId){const client=this.clients().find(c=>c.id===p.clientId);if(!client)throw new Error('Client not found.');if(client.archived&&old?.clientId!==client.id)throw new Error('Choose an active client.');}this.transaction(()=>this.write('INSERT INTO projects VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,client_id=excluded.client_id,hourly_rate_minor=excluded.hourly_rate_minor,currency=excluded.currency',[p.id,p.name,p.clientId,p.hourlyRateMinor,p.currency,p.archived?1:0,p.createdAt]));return p;}
 saveClient(i:any){const old=this.clients().find(c=>c.id===i.id);if(i.id&&!old)throw new Error('Client not found.');const c=unwrap(old?D.updateClient(old,i):D.prepareClient({...i,id:randomUUID(),createdAt:Date.now()}));this.transaction(()=>this.write('INSERT INTO clients VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,address=excluded.address,currency=excluded.currency',[c.id,c.name,c.email,c.address,c.currency,c.archived?1:0,c.createdAt]));return c;}
 saveTag(i:any){const tags=this.tags();const old=tags.find(t=>t.id===i.id);if(i.id&&!old)throw new Error('Tag not found.');const tag=unwrap(old?D.renameTag(old,i.name,tags):D.prepareTag({id:randomUUID(),name:i.name},tags));this.transaction(()=>this.write('INSERT INTO tags VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',[tag.id,tag.name]));return tag;}
 report(period:D.Period,days:D.Period[]=[]){return unwrap(D.buildReport({period,days,entries:this.entries(),projects:this.projects(),tags:this.tags(),nowMs:Date.now()}));}
 invoiceDraft(i:any){const c=this.clients().find(c=>c.id===i.clientId);if(!c)throw new Error('Choose a client.');const s=this.settings();return unwrap(D.prepareInvoiceDraft({client:c,sender:{name:s.senderName,address:s.senderAddress,email:s.senderEmail,paymentDetails:s.paymentDetails},period:i.period,currency:i.currency||undefined,entries:this.entries(),projects:this.projects()}));}
 invoiceSequence(){const saved=this.rows("SELECT value FROM settings WHERE key='invoiceSequence'")[0];const counter=saved?JSON.parse(saved.value):0;if(!Number.isSafeInteger(counter)||counter<0)throw new Error('Invalid invoice counter in backup.');return Math.max(counter,this.rows('SELECT MAX(sequence_number) AS n FROM invoices')[0].n??0);}
 keepInvoiceSequence(counter:number){this.write("INSERT INTO settings(key,value) VALUES('invoiceSequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(Math.max(counter,this.invoiceSequence()))]);}
 createInvoice(i:any){const draft=this.invoiceDraft(i);return this.transaction(()=>{const sequence=unwrap(D.nextInvoiceSequence(this.invoiceSequence()||null));const row=unwrap(D.buildInvoiceRow(draft,{id:randomUUID(),prefix:this.settings().invoicePrefix,sequenceNumber:sequence,issuedAt:Date.now()}));this.write('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[row.id,row.number,row.sequence_number,row.client_id,row.period_start,row.period_end,row.currency,row.total_minor,row.lines_json,row.sender_json,row.client_json,row.issued_at]);this.keepInvoiceSequence(sequence);return row;});}
 validate(){
  if(this.rows('PRAGMA foreign_key_check').length)throw new Error('Backup contains broken references.');
  const entries=this.entries();unwrap(D.validateStoredEntries(entries));const finished=entries.filter(e=>e.endAt!==null).sort((a,b)=>a.startAt-b.startAt);for(let i=1;i<finished.length;i++)if(finished[i].startAt<finished[i-1].endAt!)throw new Error('Backup contains overlapping entries.');
  if(entries.filter(e=>e.endAt===null).length>1)throw new Error('Backup contains more than one running timer.');
  for(const c of this.clients())unwrap(D.prepareClient(c));for(const p of this.projects())unwrap(D.prepareProject(p));for(const t of this.tags())unwrap(D.prepareTag(t,this.tags().filter(x=>x.id!==t.id)));
  for(const row of this.invoices())unwrap(D.readInvoiceSnapshot(row));this.settings();this.invoiceSequence();
 }
}


