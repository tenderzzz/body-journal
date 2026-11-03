import type {HealthStore} from './store';
import type {DailyEnergyInput,DayMigrationReport} from '../../src/shared/types';
import {calendarDay,journalDay,DAY_POLICY_VERSION} from '../../src/shared/dates';
import {refs,sameRefs,isJournalActivityRecord} from '../../src/shared/energy';
import {episodeFrom,temporalScope,type Episode} from './recall';
import {atTime} from '../../src/shared/dates';
import type {Memory} from '../../src/shared/types';

export function migrateJournalDays(store:HealthStore, legacy:boolean) {
  if(store.getConfig('dayPolicyVersion')===DAY_POLICY_VERSION)return;
  const zone=store.getSettings().timezone, records=store.records();
  const moved=legacy?records.filter(r=>calendarDay(r.occurredAt,zone)!==journalDay(r.occurredAt,zone))
    .map(r=>({id:r.id,from:calendarDay(r.occurredAt,zone),to:journalDay(r.occurredAt,zone)})):[];
  const report:DayMigrationReport={version:DAY_POLICY_VERSION,at:new Date().toISOString(),moved,reviewDays:[]};
  for(const old of store.energy.days()) {
    if(old.dayPolicy===DAY_POLICY_VERSION)continue;
    const day=records.filter(r=>journalDay(r.occurredAt,old.timezone)===old.date);
    const reasons:string[]=[];
    const meals=refs(day.filter(r=>r.kind==='meal'));
    const activity=refs(day.filter(isJournalActivityRecord));
    const priorActivity=old.activitySources.filter(s=>records.some(r=>r.id===s.id&&isJournalActivityRecord(r)));
    if(old.mealComplete&&!sameRefs(old.mealSources,meals))reasons.push('餐食来源在四点换日后发生变化，请核对饮食是否记齐');
    if(old.activityComplete&&!sameRefs(priorActivity,activity))reasons.push('训练来源在四点换日后发生变化，请核对活动是否记齐');
    const next:DailyEnergyInput={...old,dayPolicy:DAY_POLICY_VERSION,reviewReasons:reasons,
      stepSources:old.activitySources.filter(s=>records.some(r=>r.id===s.id&&r.analysis?.dailyActivity)),
      mealComplete:old.mealComplete&&sameRefs(old.mealSources,meals),
      activitySources:activity,activityComplete:old.activityComplete&&sameRefs(priorActivity,activity)};
    store.db.prepare('UPDATE energy_days SET doc=? WHERE id=?').run(JSON.stringify(next),`${old.timezone}:${old.date}`);
    if(reasons.length)report.reviewDays.push({date:old.date,reasons});
  }
  if(legacy){
    for(const row of store.db.prepare('SELECT id,doc FROM memory_episodes').all()){
      const old=JSON.parse(String(row.doc)) as Episode;
      if(!/今天|昨天|前天|本周|这周|上周|本月|这个月|上个月/.test(old.quote))continue;
      const projected=episodeFrom(old.quote,old.recordedAt,zone,{messageId:old.messageId,recordId:old.recordId,recordRevision:old.recordRevision});
      if(projected)store.db.prepare('UPDATE memory_episodes SET doc=? WHERE id=?').run(JSON.stringify({...old,occurredAt:projected.occurredAt,expiresAt:projected.expiresAt}),old.id);
    }
    for(const memory of store.memories()){
      const quote=memory.evidence?.find(e=>e.origin==='user')?.quote;
      if(memory.kind!=='state'||!memory.recordedAt||!quote||!/本周|这周|本月|这个月/.test(quote)||!memory.expiresAt)continue;
      const scope=temporalScope(quote,memory.recordedAt,zone);
      const oldExpiry=atTime(calendarDay(scope.expiresAt,zone),0,0,zone);
      if(memory.expiresAt!==oldExpiry||memory.expiresAt===scope.expiresAt)continue;
      const next:Memory={...memory,expiresAt:scope.expiresAt,revision:(memory.revision??1)+1,updatedAt:report.at,supersedesRevision:memory.revision??1};
      store.db.prepare("INSERT INTO revisions(entity,id,doc,at) VALUES('memory',?,?,?)").run(memory.id,JSON.stringify(memory),report.at);
      store.db.prepare('UPDATE memories SET doc=? WHERE id=?').run(JSON.stringify(next),memory.id);
    }
  }
  store.setConfig('dayMigrationReport',report);
  store.setConfig('dayPolicyVersion',DAY_POLICY_VERSION);
}
