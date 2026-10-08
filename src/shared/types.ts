import type { TimeEntry, Project, Client, Tag, InvoiceRow, Report, InvoiceDraft } from '../domain/index.ts';
export const APP_NAME = 'TimeLog';
export interface Settings {theme:'light'|'dark'|'system';weekStart:0|1;timeFormat:'12h'|'24h';dailyGoal:number;weeklyGoal:number;workMinutes:number;shortBreak:number;longBreak:number;cycles:number;shortcut:string;senderName:string;senderAddress:string;senderEmail:string;paymentDetails:string;invoicePrefix:string;timeline:boolean;}
export interface Pomo {active:boolean;phase:'work'|'short-break'|'long-break';paused:boolean;awaiting:boolean;alarming:boolean;remaining:number;deadline:number;cycle:number;entryId:string|null;projectId:string|null;tagIds:string[];note:string;}
export interface Entry extends TimeEntry {tagIds:string[]}
export interface Snapshot {entries:Entry[];projects:Project[];clients:Client[];tags:Tag[];invoices:InvoiceRow[];settings:Settings;pomo:Pomo;now:number;notice:string|null;shortcutError:string|null;}
export type Reply<T> = {ok:true;value:T}|{ok:false;error:string};
export interface Api {
 state: {get:()=>Promise<Reply<Snapshot>>;onChange:(fn:(s:Snapshot)=>void)=>()=>void};
 entries:{save:(input:any)=>Promise<Reply<Entry>>;delete:(id:string)=>Promise<Reply<void>>};
 timer:{start:(input:any)=>Promise<Reply<Entry>>;stop:()=>Promise<Reply<void>>};
 projects:{save:(input:any)=>Promise<Reply<Project>>;remove:(id:string,archive?:boolean)=>Promise<Reply<void>>;restore:(id:string)=>Promise<Reply<void>>};
 clients:{save:(input:any)=>Promise<Reply<Client>>;remove:(id:string,archiveProjects?:boolean)=>Promise<Reply<void>>;restore:(id:string)=>Promise<Reply<void>>};
 tags:{save:(input:any)=>Promise<Reply<Tag>>;delete:(id:string)=>Promise<Reply<void>>};
 reports:{get:(period:{startMs:number;endMs:number},days:{startMs:number;endMs:number}[])=>Promise<Reply<Report>>};
 invoice:{preview:(input:any)=>Promise<Reply<InvoiceDraft>>;create:(input:any)=>Promise<Reply<InvoiceRow>>;savePdf:(id:string)=>Promise<Reply<boolean>>};
 pomodoro:{start:(input:any)=>Promise<Reply<void>>;pause:()=>Promise<Reply<void>>;resume:()=>Promise<Reply<void>>;dismiss:()=>Promise<Reply<void>>;skip:()=>Promise<Reply<void>>;stop:()=>Promise<Reply<void>>;show:()=>Promise<Reply<void>>};
 settings:{save:(input:Partial<Settings>)=>Promise<Reply<void>>;clearNotice:()=>Promise<Reply<void>>;testNotification:()=>Promise<Reply<void>>};
 data:{export:()=>Promise<Reply<boolean>>;import:()=>Promise<Reply<boolean>>;open:()=>Promise<Reply<void>>};
}
declare global {interface Window {api:Api}}

