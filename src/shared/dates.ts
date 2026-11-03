export type DayBasis = 'journal' | 'calendar';
export const DAY_POLICY_VERSION = 'journal-04-steps-00-v1';
const formatters = new Map<string, Intl.DateTimeFormat>();

export function dateParts(iso: string, zone = 'Asia/Shanghai') {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    if (formatters.size >= 32) formatters.clear();
    formatters.set(zone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
}

export function addCalendarDays(day: string, offset: number) {
  return new Date(Date.parse(day + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}

export function calendarDay(iso: string, zone = 'Asia/Shanghai') {
  const p = dateParts(iso, zone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function journalDay(iso: string, zone = 'Asia/Shanghai') {
  const p = dateParts(iso, zone);
  const day = `${p.year}-${p.month}-${p.day}`;
  return Number(p.hour) < 4 ? addCalendarDays(day, -1) : day;
}

export function atTime(day: string, hour: number, minute: number, zone: string): string | null {
  const target = Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  if (!Number.isFinite(target) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  let value = target;
  for (let i = 0; i < 4; i++) {
    const p = dateParts(new Date(value).toISOString(), zone);
    const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const difference = target - shown;
    if (!difference) return new Date(value).toISOString();
    value += difference;
  }
  return null;
}

export function dayBounds(from: string, to: string, zone: string, basis: DayBasis = 'journal') {
  const hour = basis === 'journal' ? 4 : 0;
  const start = atTime(from, hour, 0, zone);
  const until = atTime(addCalendarDays(to, 1), hour, 0, zone);
  if (!start || !until) throw new Error('无法确定日期边界，请确认时区');
  return { from: Date.parse(start), until: Date.parse(until) };
}

export function nextDayBoundary(now: Date, zone: string) {
  const iso = now.toISOString();
  const candidates = [
    dayBounds(calendarDay(iso, zone), calendarDay(iso, zone), zone, 'calendar').until,
    dayBounds(journalDay(iso, zone), journalDay(iso, zone), zone).until,
  ];
  return Math.min(...candidates.filter(value => value > +now));
}

export function clockIn(text:string,allowBare=false) {
  const match=/(?:(凌晨|上午|下午|晚上|中午)\s*)?(\d{1,2})(?:[:：](\d{2})|点(?:(\d{1,2})分?)?)/.exec(text)
    ??/(?:(凌晨|上午|下午|晚上|中午)\s*)?([零一二两三四五六七八九十]{1,3})点/.exec(text);
  if(!match)return;
  if(allowBare&&text.slice(0,match.index).replace(/^[T，,：:\s]+/,'').length)return;
  if(!allowBare&&!match[1]&&!/[:：]/.test(match[0])&&!/(?:今天|昨天|前天|日|号)(?:的|\s)*$/.test(text.slice(0,match.index)))return;
  const chinese=(value:string)=>{const digits='零一二三四五六七八九';if(value==='两')return 2;if(value.includes('十')){const [tens,ones]=value.split('十');return (tens?digits.indexOf(tens):1)*10+(ones?digits.indexOf(ones):0);}return digits.indexOf(value);};
  let hour=/^\d+$/.test(match[2])?Number(match[2]):chinese(match[2]);
  if(/下午|晚上|中午/.test(match[1]??'')&&hour<12)hour+=12;
  const minute=Number(match[3]??match[4]??0);
  if(hour<0||hour>23||minute>59)return;
  return {hour,minute,precision:match[3]||match[4]?'minute' as const:'hour' as const,text:match[0]};
}
