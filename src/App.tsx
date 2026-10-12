import React, { useState, useEffect, useMemo, useRef, useCallback, createContext, useContext } from 'react';
import { useDriveSync } from './sync';

/* =========================================================================
   TYPES
   ========================================================================= */
type ActivityType = 'flight' | 'train' | 'hotel' | 'meeting' | 'transfer' | 'personal';
interface Note { id: string; text: string; createdAt: string; }
interface Task { id: string; text: string; done: boolean; }
interface Attachment { id: string; name: string; size: number; }
interface Activity {
  id: string; tripId: string; type: ActivityType; title: string;
  start: string; startTz: string;          // local wall time "YYYY-MM-DDTHH:mm" + IANA zone
  end?: string; endTz?: string;
  city?: string; location?: string;
  details: Record<string, string>;
  contactIds: string[]; notes: Note[]; tasks: Task[]; attachments: Attachment[];
}
interface Trip { id: string; name: string; kind: 'business' | 'private'; countries: string[]; cities: string[]; start: string; end: string; archived: boolean; }
interface Contact { id: string; name: string; company: string; position: string; phone: string; email: string; country: string; city: string; notes: string; }
interface Data { version: number; trips: Trip[]; activities: Activity[]; contacts: Contact[]; sample?: boolean; }
interface Entry { key: string; a: Activity; kind: 'main' | 'arrival' | 'checkout'; date: string; time: string; endTime?: string; ms: number; endMs?: number; }

/* =========================================================================
   UTILITIES – dates & time zones
   ========================================================================= */
const uid = () => Math.random().toString(36).slice(2, 10);
const pad = (n: number) => String(n).padStart(2, '0');
const clone = (x: any) => JSON.parse(JSON.stringify(x));
const LOCALE = 'en-GB';

const tzFmtCache: Record<string, Intl.DateTimeFormat> = {};
function tzParts(tz: string, ms: number) {
  if (!tzFmtCache[tz]) tzFmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p: Record<string, string> = {};
  tzFmtCache[tz].formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return p;
}
function tzOffsetMin(tz: string, ms: number) {
  const p = tzParts(tz, ms);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}
/** Converts a local wall-clock time in a given zone into an absolute UTC timestamp. */
function toUtc(local: string, tz: string): number {
  const guess = Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), +local.slice(11, 13) || 0, +local.slice(14, 16) || 0);
  const first = guess - tzOffsetMin(tz, guess) * 60000;
  return guess - tzOffsetMin(tz, first) * 60000;
}
function gmtLabel(tz: string, local: string) {
  const off = tzOffsetMin(tz, toUtc(local, tz));
  const a = Math.abs(off);
  return `GMT${off >= 0 ? '+' : '−'}${Math.floor(a / 60)}${a % 60 ? ':' + pad(a % 60) : ''}`;
}

const TIMEZONES = [
  { id: 'Europe/Berlin', label: 'Germany (Berlin)', city: 'Germany' },
  { id: 'Asia/Dubai', label: 'UAE (Dubai)', city: 'Dubai' },
  { id: 'Asia/Shanghai', label: 'China (Shanghai)', city: 'China' },
  { id: 'Asia/Hong_Kong', label: 'Hong Kong', city: 'Hong Kong' },
  { id: 'Asia/Singapore', label: 'Singapore', city: 'Singapore' },
  { id: 'Asia/Makassar', label: 'Indonesia (Bali)', city: 'Bali' },
  { id: 'Asia/Tokyo', label: 'Japan (Tokyo)', city: 'Tokyo' },
  { id: 'Asia/Kolkata', label: 'India', city: 'India' },
  { id: 'Europe/Istanbul', label: 'Turkey (Istanbul)', city: 'Istanbul' },
  { id: 'Europe/London', label: 'United Kingdom (London)', city: 'London' },
  { id: 'America/New_York', label: 'US East Coast (New York)', city: 'New York' },
  { id: 'UTC', label: 'UTC', city: 'UTC' },
];
const tzCity = (tz: string) => (TIMEZONES.find(t => t.id === tz) || { city: tz }).city;

const dDate = (s: string) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const fmt = (s: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { ...o, timeZone: 'UTC' }).format(dDate(s));
const addDays = (s: string, n: number) => { const d = dDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((dDate(b).getTime() - dDate(a).getTime()) / 864e5);
const weekdayIdx = (s: string) => (dDate(s).getUTCDay() + 6) % 7; // Monday = 0
const todayStr = () => { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; };
const nowLocal = () => { const n = new Date(); return `${todayStr()}T${pad(n.getHours())}:${pad(n.getMinutes())}`; };
const fmtLong = (s: string) => fmt(s, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = (s: string) => `${fmt(s, { weekday: 'short' })} ${+s.slice(8)} ${fmt(s, { month: 'short' })}`;
const fmtDM = (s: string) => fmt(s, { day: 'numeric', month: 'long' });
function fmtRange(a: string, b: string) {
  const y1 = a.slice(0, 4), y2 = b.slice(0, 4), m1 = a.slice(5, 7), m2 = b.slice(5, 7);
  if (y1 === y2 && m1 === m2) return `${+a.slice(8)}–${+b.slice(8)} ${fmt(a, { month: 'long' })} ${y1}`;
  if (y1 === y2) return `${+a.slice(8)} ${fmt(a, { month: 'short' })} – ${+b.slice(8)} ${fmt(b, { month: 'short' })} ${y1}`;
  return `${fmt(a, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmt(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
function durText(ms: number) {
  const m = Math.round(ms / 60000), h = Math.floor(m / 60), r = m % 60;
  return h ? `${h}h${r ? ' ' + r + 'm' : ''}` : `${r}m`;
}
function relText(e: Entry) {
  const diff = e.ms - Date.now();
  if (diff <= 0) return 'now';
  const days = daysBetween(todayStr(), e.date);
  if (diff < 3600e3) return `in ${Math.max(1, Math.round(diff / 60000))} min`;
  if (days === 0) return `in ${Math.round(diff / 3600e3)} h`;
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}
function nextLabel(e: Entry) {
  if (e.ms <= Date.now()) return 'Happening now' + (e.endMs ? ` · until ${(e.a.end || '').slice(11, 16)}` : '');
  return 'Up next · ' + relText(e);
}
function isoWeek(s: string) {
  const d = dDate(s); d.setUTCDate(d.getUTCDate() + 3 - weekdayIdx(s));
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 864e5 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/* =========================================================================
   DOMAIN
   ========================================================================= */
const TYPE_META: Record<ActivityType, { label: string; icon: string }> = {
  flight: { label: 'Flight', icon: 'plane' },
  train: { label: 'Train', icon: 'train' },
  hotel: { label: 'Hotel', icon: 'bed' },
  meeting: { label: 'Meeting', icon: 'briefcase' },
  transfer: { label: 'Transfer', icon: 'car' },
  personal: { label: 'Personal', icon: 'compass' },
};
type FieldDef = { key: string; label: string; ph?: string; type?: string; wide?: boolean };
const FORM: Record<ActivityType, { title: string; titlePh: string; start: string; end: string; endTz?: boolean; city?: boolean; location?: string; fields: FieldDef[] }> = {
  flight: { title: 'Label', titlePh: 'Generated automatically', start: 'Departure (local time)', end: 'Arrival (local time)', endTz: true, fields: [
    { key: 'airline', label: 'Airline', ph: 'Lufthansa' }, { key: 'flightNo', label: 'Flight number', ph: 'LH 728' },
    { key: 'from', label: 'From airport', ph: 'Frankfurt (FRA)' }, { key: 'to', label: 'To airport', ph: 'Shanghai Pudong (PVG)' },
    { key: 'terminal', label: 'Terminal' }, { key: 'gate', label: 'Gate' }, { key: 'seat', label: 'Seat' }, { key: 'bookingRef', label: 'Booking reference' } ] },
  train: { title: 'Label', titlePh: 'Generated automatically', start: 'Departure (local time)', end: 'Arrival (local time)', endTz: true, fields: [
    { key: 'operator', label: 'Operator', ph: 'Deutsche Bahn' }, { key: 'trainNo', label: 'Train number', ph: 'ICE 599' },
    { key: 'from', label: 'From station', ph: 'Frankfurt (Main) Hbf' }, { key: 'to', label: 'To station', ph: 'Munich Hbf' },
    { key: 'seat', label: 'Coach / seat' }, { key: 'bookingRef', label: 'Booking reference' } ] },
  hotel: { title: 'Hotel name', titlePh: 'e.g. JW Marriott Shanghai', start: 'Check-in', end: 'Check-out', city: true, fields: [
    { key: 'address', label: 'Address', wide: true }, { key: 'phone', label: 'Phone', type: 'tel' },
    { key: 'bookingRef', label: 'Booking number' }, { key: 'room', label: 'Room', wide: true } ] },
  meeting: { title: 'Title', titlePh: 'e.g. Supplier meeting', start: 'Start', end: 'End', city: true, location: 'Location / address', fields: [
    { key: 'company', label: 'Company' }, { key: 'contactPhone', label: 'Phone', type: 'tel' },
    { key: 'contactEmail', label: 'Email', type: 'email' }, { key: 'agenda', label: 'Agenda', type: 'textarea', wide: true } ] },
  transfer: { title: 'Label', titlePh: 'Generated automatically', start: 'Pickup', end: 'Arrival (optional)', city: true, fields: [
    { key: 'mode', label: 'Transport', ph: 'Taxi, driver, shuttle …' }, { key: 'provider', label: 'Driver / provider' },
    { key: 'from', label: 'Pickup location' }, { key: 'to', label: 'Destination' }, { key: 'phone', label: 'Phone', type: 'tel' } ] },
  personal: { title: 'Activity', titlePh: 'e.g. City walk', start: 'Start', end: 'End', city: true, location: 'Location', fields: [
    { key: 'description', label: 'Description', type: 'textarea', wide: true } ] },
};

const place = (s?: string) => (s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
const code = (s?: string) => { const m = (s || '').match(/\(([^)]+)\)\s*$/); return m ? m[1] : place(s); };
function autoTitle(a: Activity) {
  const d = a.details || {};
  if (a.type === 'flight' || a.type === 'train') return `${a.type === 'flight' ? 'Flight' : 'Train'} ${place(d.from) || '…'} → ${place(d.to) || '…'}`;
  if (a.type === 'transfer') return d.to ? `Transfer to ${place(d.to)}` : 'Transfer';
  return TYPE_META[a.type].label;
}

function buildEntries(acts: Activity[]): Entry[] {
  const out: Entry[] = [];
  acts.forEach(a => {
    const ms = toUtc(a.start, a.startTz);
    const endTz = a.endTz || a.startTz;
    const endMs = a.end ? toUtc(a.end, endTz) : undefined;
    const sameDay = !!a.end && a.end.slice(0, 10) === a.start.slice(0, 10);
    out.push({ key: a.id, a, kind: 'main', date: a.start.slice(0, 10), time: a.start.slice(11, 16), endTime: sameDay && a.type !== 'hotel' ? a.end!.slice(11, 16) : undefined, ms, endMs });
    if (a.end && !sameDay && a.type !== 'hotel' && a.type !== 'meeting' && a.type !== 'personal')
      out.push({ key: a.id + ':arr', a, kind: 'arrival', date: a.end.slice(0, 10), time: a.end.slice(11, 16), ms: endMs! });
    if (a.end && a.type === 'hotel')
      out.push({ key: a.id + ':out', a, kind: 'checkout', date: a.end.slice(0, 10), time: a.end.slice(11, 16), ms: endMs! });
  });
  return out.sort((x, y) => x.ms - y.ms || (x.kind === 'checkout' ? -1 : 0) - (y.kind === 'checkout' ? -1 : 0));
}
function findNext(entries: Entry[]) {
  const now = Date.now();
  return entries.find(e => (e.kind === 'main' && e.a.type !== 'hotel' && e.endMs && e.ms <= now && e.endMs > now) || e.ms >= now);
}
const hotelFor = (acts: Activity[], date: string) => acts.find(a => a.type === 'hotel' && a.end && a.start.slice(0, 10) <= date && a.end.slice(0, 10) > date);
function dayCities(acts: Activity[], dayEntries: Entry[], date: string) {
  const list: string[] = [];
  const push = (c?: string) => { if (c && list[list.length - 1] !== c) list.push(c); };
  push(hotelFor(acts, addDays(date, -1))?.city);
  dayEntries.forEach(e => { if (e.kind === 'main' && e.a.type !== 'flight' && e.a.type !== 'train') push(e.a.city); });
  push(hotelFor(acts, date)?.city);
  return list;
}
function tripStatus(t: Trip): 'upcoming' | 'ongoing' | 'completed' {
  const td = todayStr();
  return td < t.start ? 'upcoming' : td > t.end ? 'completed' : 'ongoing';
}
const STATUS = {
  upcoming: { label: 'Upcoming', cls: 'bg-pale text-petrol' },
  ongoing: { label: 'Ongoing', cls: 'bg-cognac/15 text-cognac' },
  completed: { label: 'Completed', cls: 'bg-line text-muted' },
};

interface EntryView { label: string; icon: string; title: string; lines: string[]; route?: boolean; }
function entryView(e: Entry): EntryView {
  const a = e.a, d = a.details || {};
  const icon = TYPE_META[a.type].icon;
  if (e.kind === 'arrival') return { label: 'Arrival', icon: 'landing', title: `Arrival ${place(d.to)}`.trim(), lines: [[d.flightNo || d.trainNo, d.from ? 'from ' + place(d.from) : ''].filter(Boolean).join(' · ')] };
  if (e.kind === 'checkout') return { label: 'Check-out', icon: 'logout', title: a.title, lines: [d.address || ''] };
  switch (a.type) {
    case 'flight': case 'train':
      return { label: TYPE_META[a.type].label, icon, title: a.title, lines: [[d.flightNo || d.trainNo, d.airline || d.operator].filter(Boolean).join(' · ')], route: true };
    case 'hotel': {
      const n = a.end ? daysBetween(a.start.slice(0, 10), a.end.slice(0, 10)) : 0;
      return { label: 'Hotel check-in', icon, title: a.title, lines: [d.address || '', n ? `${plural(n, 'night', 'nights')} · until ${fmtShort(a.end!.slice(0, 10))}` : ''] };
    }
    case 'meeting': return { label: 'Meeting', icon, title: a.title, lines: [d.company || '', a.location || ''] };
    case 'transfer': return { label: 'Transfer', icon, title: a.title, lines: [[d.mode, d.provider].filter(Boolean).join(' · '), d.from && d.to ? `${place(d.from)} → ${place(d.to)}` : ''] };
    default: return { label: 'Personal', icon, title: a.title, lines: [a.location || ''] };
  }
}

/* =========================================================================
   SAMPLE DATA
   ========================================================================= */
function sampleData(): Data {
  const n = (text: string, createdAt = '2026-10-05T09:00'): Note => ({ id: uid(), text, createdAt });
  const t = (text: string, done = false): Task => ({ id: uid(), text, done });
  const f = (name: string, size: number): Attachment => ({ id: uid(), name, size });
  const A = (tripId: string, type: ActivityType, title: string, start: string, startTz: string, end: string | undefined, endTz: string | undefined, extra: Partial<Activity> = {}): Activity =>
    ({ id: uid(), tripId, type, title, start, startTz, end, endTz: endTz || startTz, city: '', location: '', details: {}, contactIds: [], notes: [], tasks: [], attachments: [], ...extra });
  const B = 'Europe/Berlin', SH = 'Asia/Shanghai', DX = 'Asia/Dubai', BA = 'Asia/Makassar';

  const contacts: Contact[] = [
    { id: 'c1', name: 'Zhang Wei', company: 'Shanghai Huaxin Electronics Co., Ltd.', position: 'Sales Director', phone: '+86 21 5888 1234', email: 'zhang.wei@huaxin-electronics.example', country: 'China', city: 'Shanghai', notes: 'Speaks excellent English. Prefers WeChat for short-notice coordination.' },
    { id: 'c2', name: 'Chen Li', company: 'BMS Xiamen Manufacturing', position: 'Plant Manager', phone: '+86 592 6012 345', email: 'chen.li@bms-xiamen.example', country: 'China', city: 'Xiamen', notes: 'Contact for quality and capacity planning.' },
    { id: 'c3', name: 'Huang Jun', company: 'Xiamen Seaport Logistics', position: 'Key Account Manager', phone: '+86 592 5550 188', email: 'huang.jun@xsl-logistics.example', country: 'China', city: 'Xiamen', notes: '' },
    { id: 'c4', name: 'Liu Yang', company: 'Guangzhou Homeware Co.', position: 'Export Manager', phone: '+86 20 8336 7799', email: 'liu.yang@gz-homeware.example', country: 'China', city: 'Guangzhou', notes: 'We met at the Canton Fair 2024.' },
    { id: 'c5', name: 'Omar Al Hashimi', company: 'Al Noor Trading LLC', position: 'Managing Director', phone: '+971 4 123 4567', email: 'omar@alnoor-trading.example', country: 'UAE', city: 'Dubai', notes: 'Prefers morning meetings.' },
    { id: 'c6', name: 'Sarah Becker', company: 'Becker Consulting FZ-LLC', position: 'Founder', phone: '+971 50 765 4321', email: 'sarah@becker-consulting.example', country: 'UAE', city: 'Dubai', notes: '' },
    { id: 'c7', name: 'Thomas Wagner', company: 'Alpenwerk Maschinenbau GmbH', position: 'Head of Purchasing', phone: '+49 89 2190 4410', email: 't.wagner@alpenwerk.example', country: 'Germany', city: 'Munich', notes: '' },
  ];

  const trips: Trip[] = [
    { id: 'muc', name: 'Munich – Client Meetings', kind: 'business', countries: ['Germany'], cities: ['Frankfurt', 'Munich'], start: '2026-10-11', end: '2026-10-13', archived: false },
    { id: 'cn', name: 'China Business Trip – October 2026', kind: 'business', countries: ['China'], cities: ['Shanghai', 'Xiamen', 'Guangzhou'], start: '2026-10-18', end: '2026-10-27', archived: false },
    { id: 'dxb', name: 'Dubai Business Trip – November 2026', kind: 'business', countries: ['UAE'], cities: ['Dubai'], start: '2026-11-15', end: '2026-11-19', archived: false },
    { id: 'bali', name: 'Bali Holiday – December 2026', kind: 'private', countries: ['Indonesia'], cities: ['Denpasar', 'Nusa Dua'], start: '2026-12-19', end: '2026-12-31', archived: false },
    { id: 'ham', name: 'Hamburg – Logistics Workshop', kind: 'business', countries: ['Germany'], cities: ['Hamburg'], start: '2026-09-08', end: '2026-09-09', archived: false },
  ];

  const activities: Activity[] = [
    // Munich
    A('muc', 'train', 'Train Frankfurt → Munich', '2026-10-11T16:54', B, '2026-10-11T20:05', B, { details: { operator: 'Deutsche Bahn', trainNo: 'ICE 599', from: 'Frankfurt (Main) Hbf', to: 'Munich Hbf', seat: 'Coach 23, seat 51', bookingRef: 'QX7K2P' }, attachments: [f('DB_Ticket_ICE599.pdf', 182000)] }),
    A('muc', 'hotel', 'Hotel Bayerischer Hof', '2026-10-11T20:45', B, '2026-10-13T11:00', B, { city: 'Munich', details: { address: 'Promenadeplatz 2–6, 80333 Munich', phone: '+49 89 21200', bookingRef: 'BH-558213', room: 'Superior double room, non-smoking' } }),
    A('muc', 'meeting', 'Annual purchasing review', '2026-10-12T10:00', B, '2026-10-12T12:00', B, { city: 'Munich', location: 'Landsberger Str. 300, Munich', contactIds: ['c7'], details: { company: 'Alpenwerk Maschinenbau GmbH', agenda: 'Framework contract 2027\nPrice adjustment\nQ1 delivery dates' }, tasks: [t('Send quote by Friday')], notes: [n('Propose volume discount from 5,000 units.')] }),
    A('muc', 'meeting', 'Plant tour', '2026-10-12T15:00', B, '2026-10-12T16:30', B, { city: 'Munich', location: 'Alpenwerk, Allach plant', contactIds: ['c7'], details: { company: 'Alpenwerk Maschinenbau GmbH' } }),
    A('muc', 'personal', 'Dinner with Thomas Wagner', '2026-10-12T19:30', B, '2026-10-12T22:00', B, { city: 'Munich', location: 'Schwarzreiter, Maximilianstraße 17', details: { description: 'Table booked under my name.' } }),
    A('muc', 'train', 'Train Munich → Frankfurt', '2026-10-13T13:13', B, '2026-10-13T16:35', B, { details: { operator: 'Deutsche Bahn', trainNo: 'ICE 628', from: 'Munich Hbf', to: 'Frankfurt (Main) Hbf', seat: 'Coach 21, seat 33', bookingRef: 'QX7K2P' } }),

    // China
    A('cn', 'transfer', 'Transfer to the airport', '2026-10-18T11:30', B, undefined, undefined, { city: 'Frankfurt', details: { mode: 'Taxi', provider: 'Taxi Frankfurt', from: 'Home', to: 'Frankfurt Airport, Terminal 1', phone: '+49 69 230001' } }),
    A('cn', 'flight', 'Flight Frankfurt → Shanghai', '2026-10-18T14:40', B, '2026-10-19T08:30', SH, { details: { airline: 'Lufthansa', flightNo: 'LH 728', from: 'Frankfurt (FRA)', to: 'Shanghai Pudong (PVG)', terminal: '1', gate: 'Z25', seat: '4K', bookingRef: 'LH9QX2' }, notes: [n('Do online check-in 23 h before departure.')], attachments: [f('Ticket_LH728.pdf', 241000), f('Boarding_pass_LH728.pdf', 96000)] }),
    A('cn', 'transfer', 'Transfer to the hotel', '2026-10-19T10:00', SH, '2026-10-19T10:50', SH, { city: 'Shanghai', details: { mode: 'Private driver', provider: 'Mr. Li (arranged by Huaxin)', from: 'Pudong Airport (PVG), arrivals hall', to: 'JW Marriott Tomorrow Square', phone: '+86 139 1234 5678' }, notes: [n('Driver waits with a name sign at exit B.')] }),
    A('cn', 'hotel', 'JW Marriott Hotel Shanghai at Tomorrow Square', '2026-10-19T11:00', SH, '2026-10-20T07:15', SH, { city: 'Shanghai', details: { address: '399 Nanjing West Road, Huangpu, Shanghai', phone: '+86 21 5359 4969', bookingRef: 'MAR-77412093', room: 'Deluxe King, Executive Lounge' }, notes: [n('Early check-in confirmed.')], attachments: [f('Hotel_confirmation_JW_Marriott.pdf', 158000)] }),
    A('cn', 'meeting', 'Supplier meeting – Supplier A', '2026-10-19T14:30', SH, '2026-10-19T16:00', SH, { city: 'Shanghai', location: 'Huaxin Showroom, 1888 Century Avenue, Pudong', contactIds: ['c1'], details: { company: 'Shanghai Huaxin Electronics', agenda: 'Pricing for Q1 2027 shipment\nNew product samples\nDelivery times' }, tasks: [t('Request Q1 price list'), t('Reserve samples for the trade fair')], notes: [n('Discuss pricing for next shipment.'), n('Bring product samples.')], attachments: [f('Agenda_Huaxin.pdf', 64000)] }),
    A('cn', 'personal', 'Dinner on the Bund', '2026-10-19T19:00', SH, '2026-10-19T21:00', SH, { city: 'Shanghai', location: 'Lost Heaven, 17 Yan’an East Road', details: { description: 'Table for two booked.' } }),
    A('cn', 'transfer', 'Transfer to Hongqiao Airport', '2026-10-20T07:30', SH, '2026-10-20T08:15', SH, { city: 'Shanghai', details: { mode: 'Taxi', from: 'Hotel', to: 'Hongqiao Airport (SHA), Terminal 2' } }),
    A('cn', 'flight', 'Flight Shanghai → Xiamen', '2026-10-20T09:15', SH, '2026-10-20T11:10', SH, { details: { airline: 'Xiamen Airlines', flightNo: 'MF 8506', from: 'Shanghai Hongqiao (SHA)', to: 'Xiamen Gaoqi (XMN)', terminal: '2', seat: '12A', bookingRef: 'MF3KD8' }, attachments: [f('Ticket_MF8506.pdf', 120000)] }),
    A('cn', 'hotel', 'Conrad Xiamen', '2026-10-20T12:30', SH, '2026-10-22T08:30', SH, { city: 'Xiamen', details: { address: '398 Hubin North Road, Siming, Xiamen', phone: '+86 592 572 8888', bookingRef: 'HH-49283311', room: 'King Deluxe, sea view' } }),
    A('cn', 'meeting', 'Factory visit – BMS Xiamen', '2026-10-20T15:00', SH, '2026-10-20T17:00', SH, { city: 'Xiamen', location: 'BMS Plant 2, Xiang’an Industrial Park', contactIds: ['c2'], details: { company: 'BMS Xiamen Manufacturing', agenda: 'Production walk-through\nQuality assurance\nCapacity planning 2027' }, notes: [n('Bring safety shoes.')] }),
    A('cn', 'meeting', 'Quality audit', '2026-10-21T09:30', SH, '2026-10-21T12:00', SH, { city: 'Xiamen', location: 'BMS Plant 2, meeting room 3', contactIds: ['c2'], details: { company: 'BMS Xiamen Manufacturing' }, tasks: [t('Request audit report')] }),
    A('cn', 'meeting', 'Logistics alignment', '2026-10-21T14:00', SH, '2026-10-21T15:30', SH, { city: 'Xiamen', location: 'Xiamen Seaport Logistics, Haicang', contactIds: ['c3'], details: { company: 'Xiamen Seaport Logistics' }, notes: [n('Ask about lead times from Xiamen port.')] }),
    A('cn', 'train', 'Train Xiamen → Guangzhou', '2026-10-22T10:05', SH, '2026-10-22T13:52', SH, { details: { operator: 'China Railway', trainNo: 'G 1612', from: 'Xiamen North', to: 'Guangzhou South', seat: 'Coach 3, seat 7F (Business)', bookingRef: 'E482190563' }, notes: [n('Keep passport ready for the ticket check.')] }),
    A('cn', 'transfer', 'Transfer to the hotel', '2026-10-22T14:15', SH, '2026-10-22T15:10', SH, { city: 'Guangzhou', details: { mode: 'DiDi', from: 'Guangzhou South station', to: 'The Ritz-Carlton, Guangzhou' } }),
    A('cn', 'hotel', 'The Ritz-Carlton, Guangzhou', '2026-10-22T15:30', SH, '2026-10-26T18:00', SH, { city: 'Guangzhou', details: { address: '3 Xing An Road, Pearl River New City, Tianhe', phone: '+86 20 3813 6888', bookingRef: 'MAR-77413580', room: 'Deluxe Room, river view' }, notes: [n('Late check-out until 18:00 confirmed.')], attachments: [f('Confirmation_RitzCarlton.pdf', 171000)] }),
    A('cn', 'personal', 'Canton Fair – Phase 2', '2026-10-23T09:00', SH, '2026-10-23T17:00', SH, { city: 'Guangzhou', location: 'Canton Fair Complex, Pazhou', details: { description: 'Halls 11–13: homeware & gifts' }, attachments: [f('Canton_Fair_Badge.pdf', 88000)] }),
    A('cn', 'meeting', 'Trade fair meeting', '2026-10-23T10:30', SH, '2026-10-23T11:30', SH, { city: 'Guangzhou', location: 'Canton Fair, booth 11.2 C18', contactIds: ['c4'], details: { company: 'Guangzhou Homeware Co.' } }),
    A('cn', 'meeting', 'Product development & samples', '2026-10-24T10:00', SH, '2026-10-24T12:00', SH, { city: 'Guangzhou', location: 'Guangzhou Homeware showroom, Haizhu', contactIds: ['c4'], details: { company: 'Guangzhou Homeware Co.', agenda: 'Sample approval\nPackaging\nFirst-order timeline' }, tasks: [t('Bring packaging draft', true)] }),
    A('cn', 'personal', 'Shamian Island & tea house', '2026-10-24T15:00', SH, '2026-10-24T18:00', SH, { city: 'Guangzhou', location: 'Shamian Island' }),
    A('cn', 'transfer', 'Transfer to the airport', '2026-10-26T20:30', SH, '2026-10-26T21:20', SH, { city: 'Guangzhou', details: { mode: 'Hotel limousine', provider: 'The Ritz-Carlton', from: 'Hotel', to: 'Baiyun Airport (CAN), Terminal 2', phone: '+86 20 3813 6888' } }),
    A('cn', 'flight', 'Flight Guangzhou → Frankfurt', '2026-10-26T23:55', SH, '2026-10-27T05:55', B, { details: { airline: 'China Southern', flightNo: 'CZ 331', from: 'Guangzhou Baiyun (CAN)', to: 'Frankfurt (FRA)', terminal: '2', seat: '14A', bookingRef: 'CZ8PL4' }, attachments: [f('Ticket_CZ331.pdf', 133000)] }),
    A('cn', 'transfer', 'Transfer home', '2026-10-27T07:00', B, undefined, undefined, { city: 'Frankfurt', details: { mode: 'Taxi', from: 'Frankfurt Airport', to: 'Home' } }),

    // Dubai
    A('dxb', 'flight', 'Flight Frankfurt → Dubai', '2026-11-15T14:40', B, '2026-11-15T23:40', DX, { details: { airline: 'Emirates', flightNo: 'EK 46', from: 'Frankfurt (FRA)', to: 'Dubai (DXB)', terminal: '2', seat: '7A', bookingRef: 'EK4MZT' }, attachments: [f('E-ticket_EK46.pdf', 205000)] }),
    A('dxb', 'transfer', 'Transfer to the hotel', '2026-11-16T00:10', DX, '2026-11-16T00:40', DX, { city: 'Dubai', details: { mode: 'Hotel limousine', provider: 'Address Downtown', from: 'DXB Terminal 3', to: 'Address Downtown' } }),
    A('dxb', 'hotel', 'Address Downtown', '2026-11-16T00:45', DX, '2026-11-19T06:00', DX, { city: 'Dubai', details: { address: 'Sheikh Mohammed bin Rashid Blvd, Downtown Dubai', phone: '+971 4 436 8888', bookingRef: 'ADR-920144', room: 'Deluxe Room, Burj Khalifa view' } }),
    A('dxb', 'meeting', 'Contract negotiation', '2026-11-16T10:00', DX, '2026-11-16T11:30', DX, { city: 'Dubai', location: 'Al Noor Tower, Business Bay', contactIds: ['c5'], details: { company: 'Al Noor Trading LLC', agenda: 'GCC distribution agreement\nTerms\nMarketing budget' }, notes: [n('Confirm meeting one day before.')] }),
    A('dxb', 'meeting', 'Business lunch', '2026-11-16T13:00', DX, '2026-11-16T14:30', DX, { city: 'Dubai', location: 'Zuma, DIFC Gate Village 06', contactIds: ['c6'], details: { company: 'Becker Consulting FZ-LLC' } }),
    A('dxb', 'meeting', 'Warehouse visit Jebel Ali', '2026-11-17T10:00', DX, '2026-11-17T12:00', DX, { city: 'Dubai', location: 'Jebel Ali Free Zone, South', contactIds: ['c5'], details: { company: 'Al Noor Trading LLC' } }),
    A('dxb', 'personal', 'Desert trip', '2026-11-18T15:00', DX, '2026-11-18T21:00', DX, { city: 'Dubai', location: 'Al Marmoom Desert Conservation Reserve' }),
    A('dxb', 'flight', 'Flight Dubai → Frankfurt', '2026-11-19T08:25', DX, '2026-11-19T12:10', B, { details: { airline: 'Emirates', flightNo: 'EK 45', from: 'Dubai (DXB)', to: 'Frankfurt (FRA)', terminal: '3', seat: '7A', bookingRef: 'EK4MZT' } }),

    // Bali
    A('bali', 'flight', 'Flight Frankfurt → Dubai', '2026-12-19T21:55', B, '2026-12-20T06:15', DX, { details: { airline: 'Emirates', flightNo: 'EK 44', from: 'Frankfurt (FRA)', to: 'Dubai (DXB)', seat: '32A', bookingRef: 'EK7BLI' } }),
    A('bali', 'flight', 'Flight Dubai → Denpasar', '2026-12-20T09:25', DX, '2026-12-20T22:45', BA, { details: { airline: 'Emirates', flightNo: 'EK 398', from: 'Dubai (DXB)', to: 'Denpasar (DPS)', seat: '32A', bookingRef: 'EK7BLI' }, attachments: [f('E-ticket_Bali.pdf', 310000)] }),
    A('bali', 'transfer', 'Transfer to Sanur', '2026-12-20T23:30', BA, '2026-12-21T00:10', BA, { city: 'Denpasar', details: { mode: 'Hotel shuttle', from: 'DPS airport', to: 'Hyatt Regency Bali, Sanur' } }),
    A('bali', 'hotel', 'Hyatt Regency Bali', '2026-12-21T00:15', BA, '2026-12-24T11:00', BA, { city: 'Denpasar', details: { address: 'Jl. Danau Tamblingan 89, Sanur, Denpasar', phone: '+62 361 281234', bookingRef: 'HY-662190', room: 'King, garden view' } }),
    A('bali', 'personal', 'Balinese cooking class', '2026-12-22T09:00', BA, '2026-12-22T13:00', BA, { city: 'Denpasar', location: 'Sanur' }),
    A('bali', 'personal', 'Day trip Ubud & rice terraces', '2026-12-23T08:00', BA, '2026-12-23T18:00', BA, { city: 'Ubud', location: 'Tegallalang' }),
    A('bali', 'transfer', 'Transfer to Nusa Dua', '2026-12-24T11:30', BA, '2026-12-24T12:15', BA, { city: 'Denpasar', details: { mode: 'Private driver', from: 'Hyatt Regency Bali', to: 'The Mulia, Nusa Dua' } }),
    A('bali', 'hotel', 'The Mulia, Nusa Dua', '2026-12-24T14:00', BA, '2026-12-30T12:00', BA, { city: 'Nusa Dua', details: { address: 'Jl. Raya Nusa Dua Selatan, Nusa Dua', phone: '+62 361 3027777', bookingRef: 'MUL-38812', room: 'Grandeur Suite, ocean view' } }),
    A('bali', 'personal', 'Christmas Eve dinner', '2026-12-24T19:00', BA, '2026-12-24T22:00', BA, { city: 'Nusa Dua', location: 'The Mulia, Table8' }),
    A('bali', 'personal', 'Uluwatu Temple & Kecak dance', '2026-12-27T16:30', BA, '2026-12-27T20:00', BA, { city: 'Uluwatu', location: 'Pura Luhur Uluwatu' }),
    A('bali', 'flight', 'Flight Denpasar → Dubai', '2026-12-30T21:20', BA, '2026-12-31T02:10', DX, { details: { airline: 'Emirates', flightNo: 'EK 369', from: 'Denpasar (DPS)', to: 'Dubai (DXB)', seat: '30K', bookingRef: 'EK7BLI' } }),
    A('bali', 'flight', 'Flight Dubai → Frankfurt', '2026-12-31T08:25', DX, '2026-12-31T12:10', B, { details: { airline: 'Emirates', flightNo: 'EK 45', from: 'Dubai (DXB)', to: 'Frankfurt (FRA)', seat: '30K', bookingRef: 'EK7BLI' } }),

    // Hamburg (completed)
    A('ham', 'train', 'Train Frankfurt → Hamburg', '2026-09-08T08:54', B, '2026-09-08T12:32', B, { details: { operator: 'Deutsche Bahn', trainNo: 'ICE 578', from: 'Frankfurt (Main) Hbf', to: 'Hamburg Hbf' } }),
    A('ham', 'meeting', 'Port logistics workshop', '2026-09-08T14:00', B, '2026-09-08T17:00', B, { city: 'Hamburg', location: 'HafenCity, Am Sandtorkai 50', details: { company: 'Hanse Logistik GmbH' } }),
    A('ham', 'hotel', 'The Fontenay', '2026-09-08T18:00', B, '2026-09-09T10:00', B, { city: 'Hamburg', details: { address: 'Fontenay 10, 20354 Hamburg' } }),
    A('ham', 'train', 'Train Hamburg → Frankfurt', '2026-09-09T12:01', B, '2026-09-09T15:46', B, { details: { operator: 'Deutsche Bahn', trainNo: 'ICE 577', from: 'Hamburg Hbf', to: 'Frankfurt (Main) Hbf' } }),
  ];
  return { version: 2, trips, activities, contacts, sample: true };
}

/* =========================================================================
   ICONS (Lucide-style, inline)
   ========================================================================= */
const ICONS: Record<string, string> = {
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  landing: '<path d="M2 22h20"/><path d="M3.77 10.77 2 9l2-4.5 1.1.55c.55.28.9.84.9 1.45s.35 1.17.9 1.45L8 8.5l3-6 1.05.53a2 2 0 0 1 1.09 1.52l.72 5.4a2 2 0 0 0 1.09 1.52l4.4 2.2c.42.22.78.55 1.01.96l.6 1.03c.49.88-.06 1.98-1.06 2.1l-1.18.15c-.47.06-.95-.02-1.37-.24L4.29 11.15a2 2 0 0 1-.52-.38Z"/>',
  train: '<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/><path d="m9 15-1-1"/><path d="m15 15 1-1"/><path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/><path d="m8 19-2 3"/><path d="m16 22-2-3"/>',
  bed: '<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>',
  briefcase: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>', down: '<path d="m6 9 6 6 6-6"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
};
function Icon({ name, size = 18, className = '', stroke = 1.75 }: { name: string; size?: number; className?: string; stroke?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={'shrink-0 ' + className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] || '' }} />;
}

/* =========================================================================
   STORE (local persistence for the prototype – replaced by cloud sync later)
   ========================================================================= */
const STORE_KEY = 'mtp:data:v2';
const StoreCtx = createContext<any>(null);
const useStore = () => useContext(StoreCtx);

export function StoreProvider({ children }: { children: any }) {
  const [data, setData] = useState<Data>(() => {
    try { const raw = localStorage.getItem(STORE_KEY); if (raw) return JSON.parse(raw); } catch (e) {}
    return sampleData();
  });
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {} }, [data]);

  const api = useMemo(() => {
    const upsert = (list: any[], item: any) => list.some(x => x.id === item.id) ? list.map(x => x.id === item.id ? item : x) : [...list, item];
    // Any edit turns the sample trips into the user's own data.
    const edit = (f: (d: Data) => Data) => setData(d => { const n = f(d); return n === d ? d : { ...n, sample: false }; });
    return {
      saveTrip: (t: Trip) => edit(d => ({ ...d, trips: upsert(d.trips, t) })),
      deleteTrip: (id: string) => edit(d => ({ ...d, trips: d.trips.filter(t => t.id !== id), activities: d.activities.filter(a => a.tripId !== id) })),
      duplicateTrip: (id: string) => edit(d => {
        const t = d.trips.find(x => x.id === id); if (!t) return d;
        const nid = uid();
        const acts = d.activities.filter(a => a.tripId === id).map(a => ({ ...clone(a), id: uid(), tripId: nid }));
        return { ...d, trips: [...d.trips, { ...t, id: nid, name: t.name + ' (copy)', archived: false }], activities: [...d.activities, ...acts] };
      }),
      setArchived: (id: string, archived: boolean) => edit(d => ({ ...d, trips: d.trips.map(t => t.id === id ? { ...t, archived } : t) })),
      saveActivity: (a: Activity) => edit(d => ({ ...d, activities: upsert(d.activities, a) })),
      updateActivity: (id: string, fn: (a: Activity) => Activity) => edit(d => ({ ...d, activities: d.activities.map(a => a.id === id ? fn(a) : a) })),
      deleteActivity: (id: string) => edit(d => ({ ...d, activities: d.activities.filter(a => a.id !== id) })),
      duplicateActivity: (id: string) => edit(d => {
        const a = d.activities.find(x => x.id === id); if (!a) return d;
        const c = clone(a); c.id = uid(); c.title = a.title + ' (copy)';
        c.notes = c.notes.map((n: Note) => ({ ...n, id: uid() })); c.tasks = c.tasks.map((t: Task) => ({ ...t, id: uid() }));
        return { ...d, activities: [...d.activities, c] };
      }),
      saveContact: (c: Contact) => edit(d => ({ ...d, contacts: upsert(d.contacts, c) })),
      deleteContact: (id: string) => edit(d => ({ ...d, contacts: d.contacts.filter(c => c.id !== id), activities: d.activities.map(a => ({ ...a, contactIds: a.contactIds.filter(x => x !== id) })) })),
      importContacts: (list: Contact[]) => edit(d => ({ ...d, contacts: [...d.contacts, ...list] })),
      reset: () => setData(sampleData()),
    };
  }, []);
  const replaceData = useCallback((d: any) => setData(d), []);
  const sync = useDriveSync(data, replaceData);
  return <StoreCtx.Provider value={{ data, sync, ...api }}>{children}</StoreCtx.Provider>;
}

const UICtx = createContext<any>(null);
const useUI = () => useContext(UICtx);

/* =========================================================================
   ROUTING (hash-based → works on GitHub Pages without server config)
   ========================================================================= */
function parseRoute(h: string) {
  const p = h.replace(/^#\/?/, '').split('/');
  if (p[0] === 'trip' && p[1]) return { page: 'trip', id: p[1], tab: p[2] || 'timeline' };
  if (p[0] === 'calendar') return { page: 'calendar' };
  if (p[0] === 'contacts') return { page: 'contacts' };
  if (p[0] === 'settings') return { page: 'settings' };
  return { page: 'trips' };
}
function useRoute() {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const f = () => { setH(location.hash); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return parseRoute(h);
}
const go = (path: string) => { location.hash = path; };

/* =========================================================================
   GENERIC UI
   ========================================================================= */
let scrollLocks = 0;
function Sheet({ onClose, children, label }: { onClose: () => void; children: any; label: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    scrollLocks++; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', h); scrollLocks--; if (!scrollLocks) document.body.style.overflow = ''; };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-stretch md:justify-end" role="dialog" aria-modal="true" aria-label={label}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px] anim-fade" onClick={onClose} />
      <div className="relative w-full md:w-[540px] max-h-[94vh] md:max-h-none md:h-full bg-cream rounded-t-[28px] md:rounded-none md:rounded-l-[28px] shadow-lift flex flex-col overflow-hidden anim-sheet border-t md:border-t-0 md:border-l border-line">
        {children}
      </div>
    </div>
  );
}
function SheetHead({ title, eyebrow, onClose, children }: { title: string; eyebrow?: any; onClose: () => void; children?: any }) {
  return (
    <div className="relative bg-card border-b border-line px-5 sm:px-7 pt-3 md:pt-7 pb-5">
      <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-line md:hidden" />
      <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 md:top-6 h-9 w-9 grid place-items-center rounded-full text-muted hover:bg-cream hover:text-heading"><Icon name="x" /></button>
      {eyebrow && <div className="pr-10">{eyebrow}</div>}
      <h2 className="font-display text-[23px] leading-tight text-heading pr-10 mt-1">{title}</h2>
      {children}
    </div>
  );
}
function SheetFoot({ children }: { children: any }) {
  return <div className="bg-card border-t border-line px-4 sm:px-6 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] flex flex-wrap gap-2">{children}</div>;
}
function Menu({ items }: { items: { label: string; icon: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: any) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('touchstart', h);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h); };
  }, [open]);
  return (
    <div ref={ref} className="relative" onClick={e => e.stopPropagation()}>
      <button aria-label="More actions" onClick={() => setOpen(o => !o)} className="h-9 w-9 grid place-items-center rounded-full text-muted hover:bg-pale hover:text-heading"><Icon name="more" /></button>
      {open && (
        <div className="absolute right-0 top-10 z-30 w-52 rounded-2xl bg-card shadow-lift border border-line py-1.5 anim-fade">
          {items.map(it => (
            <button key={it.label} onClick={() => { setOpen(false); it.onClick(); }} className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-[14px] text-left hover:bg-pale ${it.danger ? 'text-danger' : 'text-ink'}`}>
              <Icon name={it.icon} size={16} />{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function Segmented({ value, options, onChange }: { value: string; options: { value: string; label: string; icon?: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex rounded-full bg-card border border-line p-1 shadow-soft">
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={`flex items-center gap-1.5 h-9 px-3 sm:px-4 rounded-full text-[13.5px] sm:text-[14px] font-semibold whitespace-nowrap transition ${value === o.value ? 'bg-primary text-white shadow-sm' : 'text-muted hover:text-heading'}`}>
          {o.icon && <Icon name={o.icon} size={15} className="hidden sm:block" />}{o.label}
        </button>
      ))}
    </div>
  );
}
function Field({ label, children, wide = false }: { label: string; children: any; wide?: boolean }) {
  return <label className={`block ${wide ? 'sm:col-span-2' : ''}`}><span className="lbl">{label}</span>{children}</label>;
}
function SectionTitle({ icon, children, action }: { icon: string; children: any; action?: any }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.12em] text-heading"><Icon name={icon} size={15} />{children}</h3>
      {action}
    </div>
  );
}
function Empty({ icon, title, text, action }: { icon: string; title: string; text: string; action?: any }) {
  return (
    <div className="rounded-3xl border border-dashed border-line bg-card/60 px-6 py-12 text-center">
      <div className="mx-auto h-12 w-12 rounded-2xl bg-pale text-petrol grid place-items-center"><Icon name={icon} size={22} /></div>
      <div className="font-display text-xl text-heading mt-4">{title}</div>
      <p className="text-muted mt-1 max-w-sm mx-auto">{text}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();

/* =========================================================================
   TIMELINE
   ========================================================================= */
function EntryCard({ e, highlight, showTrip }: { e: Entry; highlight?: boolean; showTrip?: string }) {
  const ui = useUI();
  const { data } = useStore();
  const v = entryView(e);
  const a = e.a, d = a.details;
  const names = e.kind === 'main' ? a.contactIds.map(id => data.contacts.find((c: Contact) => c.id === id)?.name).filter(Boolean) : [];
  const shift = a.end ? daysBetween(a.start.slice(0, 10), a.end.slice(0, 10)) : 0;
  const sub = highlight ? 'text-white/75' : 'text-muted';
  return (
    <button onClick={() => ui.openActivity(a.id)}
      className={`group w-full text-left rounded-2xl p-4 transition duration-200 ${highlight ? 'bg-petrol-fill text-white shadow-lift ring-1 ring-white/10' : 'bg-pale hover:shadow-soft hover:-translate-y-px'} ${e.kind !== 'main' && !highlight ? 'bg-pale/60' : ''}`}>
      {highlight && (
        <div className="mb-2.5 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#F0C9A3] pulse-dot" />{nextLabel(e)}
        </div>
      )}
      <div className="flex gap-3.5">
        <div className={`h-10 w-10 rounded-xl grid place-items-center shrink-0 ${highlight ? 'bg-white/15 text-white' : 'bg-card text-petrol'}`}><Icon name={v.icon} size={19} /></div>
        <div className="min-w-0 flex-1">
          <div className={`text-[11px] uppercase tracking-[0.13em] font-bold ${highlight ? 'text-white/70' : 'text-petrol'}`}>{v.label}{showTrip ? ` · ${showTrip}` : ''}</div>
          <div className={`font-semibold text-[16px] leading-snug mt-0.5 ${highlight ? '' : 'text-ink'}`}>{v.title}</div>
          {v.lines.filter(Boolean).map((l, i) => <div key={i} className={`text-[13.5px] leading-snug mt-0.5 ${sub}`}>{l}</div>)}
          {v.route && e.kind === 'main' && (
            <div className={`mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-semibold ${highlight ? '' : 'text-petrol'}`}>
              <span><span className="font-bold">{code(d.from)}</span> <span className="tabular-nums">{a.start.slice(11, 16)}</span></span>
              <Icon name="arrow" size={14} className="opacity-60" />
              <span><span className="font-bold">{code(d.to)}</span> <span className="tabular-nums">{a.end ? a.end.slice(11, 16) : '–'}</span>{shift > 0 && <sup className="ml-0.5 text-[10px]">+{shift}</sup>}</span>
              {a.end && <span className={`flex items-center gap-1 text-[12px] font-normal ${sub}`}><Icon name="clock" size={12} />{durText(toUtc(a.end, a.endTz || a.startTz) - e.ms)}</span>}
            </div>
          )}
          {(names.length > 0 || (e.kind === 'main' && (a.notes.length > 0 || a.attachments.length > 0))) && (
            <div className={`mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] ${sub}`}>
              {names.length > 0 && <span className="flex items-center gap-1.5"><Icon name="user" size={13} />{names.join(', ')}</span>}
              {a.notes.length > 0 && <span className="flex items-center gap-1.5" title="Notes"><Icon name="note" size={13} />{a.notes.length}</span>}
              {a.attachments.length > 0 && <span className="flex items-center gap-1.5" title="Documents"><Icon name="clip" size={13} />{a.attachments.length}</span>}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function EntryRow({ e, next, last, showTrip }: { e: Entry; next?: Entry; last?: boolean; showTrip?: string }) {
  const isNext = !!next && next.key === e.key;
  const past = e.ms < Date.now() && !isNext && (!e.endMs || e.endMs < Date.now());
  return (
    <div className={`relative flex gap-2.5 sm:gap-4 ${past ? 'opacity-55' : ''}`}>
      <div className="w-[46px] sm:w-14 shrink-0 text-right pt-[15px]">
        <div className="text-[15px] font-bold tabular-nums text-ink">{e.time}</div>
        {e.endTime && <div className="text-[12.5px] text-muted tabular-nums">{e.endTime}</div>}
      </div>
      <div className="relative w-3 shrink-0 flex justify-center">
        <div className={`absolute top-0 ${last ? 'h-6' : 'bottom-0'} w-px bg-petrol/30`} />
        <div className={`relative mt-[20px] h-3 w-3 rounded-full border-2 ${isNext ? 'border-petrol bg-petrol ring-4 ring-petrol/25' : 'border-petrol bg-cream'}`} />
      </div>
      <div className="flex-1 min-w-0 pb-3"><EntryCard e={e} highlight={isNext} showTrip={showTrip} /></div>
    </div>
  );
}

function DayHeader({ date, index, cities, hotel }: { date: string; index?: number; cities: string[]; hotel?: Activity }) {
  const ui = useUI();
  const isToday = date === todayStr();
  return (
    <div className="mb-4 pb-3 border-b border-cognac/30">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-cognac">{fmt(date, { weekday: 'long' })}</span>
          <span className="font-display text-[23px] leading-none text-cognac">{fmtDM(date)}</span>
          {isToday && <span className="rounded-full bg-cognac text-[#1a120b] text-[11px] font-bold px-2 py-0.5 uppercase tracking-wider">Today</span>}
        </div>
        {index !== undefined && <span className="text-[12px] text-muted font-semibold">Day {index}</span>}
      </div>
      {cities.length > 0 && <div className="mt-1.5 text-[13px] font-bold uppercase tracking-[0.14em] text-heading">{cities.join(' → ')}</div>}
      {hotel && (
        <button onClick={() => ui.openActivity(hotel.id)} className="mt-1.5 block text-left text-[13px] text-muted hover:text-petrol">
          <Icon name="bed" size={14} className="inline -mt-0.5 mr-1.5" />Overnight: <span className="text-ink/85">{hotel.title}</span>
        </button>
      )}
    </div>
  );
}

function Timeline({ trip, acts, entries }: { trip: Trip; acts: Activity[]; entries: Entry[] }) {
  const ui = useUI();
  const next = findNext(entries);
  const byDate: Record<string, Entry[]> = {};
  entries.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  const dates = new Set(Object.keys(byDate));
  if (daysBetween(trip.start, trip.end) <= 60) for (let d = trip.start; d <= trip.end; d = addDays(d, 1)) dates.add(d);
  const sorted = Array.from(dates).sort();

  if (!entries.length) return <Empty icon="list" title="Nothing planned yet" text="Add flights, hotels, meetings and transfers. They appear here in chronological order." action={<button className="btn btn-primary" onClick={() => ui.newActivity(trip.id)}><Icon name="plus" />Add activity</button>} />;

  return (
    <div className="space-y-9">
      {sorted.map((date, i) => {
        const list = byDate[date] || [];
        return (
          <section key={date} className="anim-in" style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}>
            <DayHeader date={date} index={daysBetween(trip.start, date) + 1} cities={dayCities(acts, list, date)} hotel={hotelFor(acts, date)} />
            {list.length ? list.map((e, j) => <EntryRow key={e.key} e={e} next={next} last={j === list.length - 1} />) : (
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-line px-4 py-3.5 text-[14px] text-muted">
                <span>Nothing planned</span>
                <button onClick={() => ui.newActivity(trip.id, date)} className="flex items-center gap-1 text-petrol font-semibold hover:underline"><Icon name="plus" size={15} />Add</button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* =========================================================================
   CALENDAR
   ========================================================================= */
function CalendarView({ entries, initialDate, ranges = [], tripNames }: { entries: Entry[]; initialDate: string; ranges?: Trip[]; tripNames?: Record<string, string> }) {
  const ui = useUI();
  const [view, setView] = useState('month');
  const [cur, setCur] = useState(initialDate);
  const td = todayStr();
  const byDate = useMemo(() => { const m: Record<string, Entry[]> = {}; entries.forEach(e => { (m[e.date] = m[e.date] || []).push(e); }); return m; }, [entries]);
  const next = findNext(entries);

  const move = (dir: number) => {
    if (view === 'month') { const d = dDate(cur.slice(0, 8) + '01'); d.setUTCMonth(d.getUTCMonth() + dir); setCur(d.toISOString().slice(0, 10)); }
    else setCur(addDays(cur, dir * (view === 'week' ? 7 : 1)));
  };
  const weekStart = addDays(cur, -weekdayIdx(cur));
  const title = view === 'month' ? fmt(cur, { month: 'long', year: 'numeric' })
    : view === 'week' ? `Week ${isoWeek(cur)} · ${fmtRange(weekStart, addDays(weekStart, 6))}`
    : fmt(cur, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const inTrip = (d: string) => ranges.find(t => t.start <= d && t.end >= d);
  const openDay = (d: string) => { setCur(d); setView('day'); };

  let body;
  if (view === 'month') {
    const first = cur.slice(0, 8) + '01';
    const start = addDays(first, -weekdayIdx(first));
    let days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
    if (days[35].slice(5, 7) !== first.slice(5, 7)) days = days.slice(0, 35);
    body = (
      <div className="rounded-3xl bg-card shadow-soft overflow-hidden border border-line">
        <div className="grid grid-cols-7">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(w => <div key={w} className="py-2.5 text-center text-[11px] font-bold uppercase tracking-[0.14em] text-cognac">{w}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {days.map(d => {
            const evs = byDate[d] || [];
            const other = d.slice(5, 7) !== first.slice(5, 7);
            const trip = inTrip(d);
            return (
              <div key={d} onClick={() => openDay(d)} className={`relative min-h-[62px] md:min-h-[116px] p-1 md:p-1.5 border-t border-line cursor-pointer transition hover:bg-pale/50 ${weekdayIdx(d) ? 'border-l' : ''} ${other ? 'bg-cream/60' : ''}`}>
                <div className="flex justify-center md:justify-start">
                  <span className={`grid place-items-center h-7 min-w-7 px-1 rounded-full text-[13px] tabular-nums ${d === td ? 'bg-primary text-white font-bold' : evs.length ? 'text-cognac font-bold' : other ? 'text-muted/45' : 'text-ink/80'}`}>{+d.slice(8)}</span>
                </div>
                {trip && <div title={trip.name} className={`absolute left-0 right-0 bottom-0 h-[3px] ${other ? 'bg-cognac/20' : 'bg-cognac/50'}`} />}
                <div className="hidden md:block space-y-1 mt-1">
                  {evs.slice(0, 3).map(e => (
                    <button key={e.key} onClick={ev => { ev.stopPropagation(); ui.openActivity(e.a.id); }} className={`w-full flex items-center gap-1 truncate text-left text-[11.5px] rounded-md px-1.5 py-[3px] transition ${next && next.key === e.key ? 'bg-petrol-fill text-white' : 'bg-pale text-petrol hover:bg-petrol-fill hover:text-white'}`}>
                      <span className="tabular-nums font-bold">{e.time}</span><span className="truncate">{entryView(e).title}</span>
                    </button>
                  ))}
                  {evs.length > 3 && <div className="text-[11px] text-muted px-1.5">+{evs.length - 3} more</div>}
                </div>
                <div className="md:hidden flex flex-wrap justify-center gap-[3px] mt-1">
                  {evs.slice(0, 4).map(e => <span key={e.key} className="h-1.5 w-1.5 rounded-full bg-dot" />)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  } else if (view === 'week') {
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    body = (
      <div className="grid gap-3 md:grid-cols-7">
        {days.map(d => {
          const evs = byDate[d] || [];
          return (
            <div key={d} className={`rounded-2xl bg-card p-3 shadow-soft border ${d === td ? 'border-primary' : 'border-line'} md:min-h-[260px]`}>
              <button onClick={() => openDay(d)} className="flex md:flex-col items-baseline md:items-start gap-2 md:gap-0 mb-2.5 w-full">
                <span className="text-[11px] uppercase tracking-[0.14em] font-bold text-cognac">{fmt(d, { weekday: 'short' })}</span>
                <span className="font-display text-[24px] leading-tight text-cognac">{+d.slice(8)}</span>
                {inTrip(d) && <span className="md:mt-0.5 text-[11px] text-muted truncate max-w-full">{inTrip(d)!.name}</span>}
              </button>
              <div className="space-y-1.5">
                {evs.map(e => (
                  <button key={e.key} onClick={() => ui.openActivity(e.a.id)} className={`w-full text-left rounded-xl px-2.5 py-2 transition ${next && next.key === e.key ? 'bg-petrol-fill text-white' : 'bg-pale hover:bg-petrol/20'}`}>
                    <div className={`flex items-center gap-1.5 text-[11.5px] font-bold tabular-nums ${next && next.key === e.key ? '' : 'text-petrol'}`}><Icon name={entryView(e).icon} size={13} />{e.time}{e.endTime ? '–' + e.endTime : ''}</div>
                    <div className="text-[13px] leading-snug mt-0.5">{entryView(e).title}</div>
                  </button>
                ))}
                {!evs.length && <div className="text-[12.5px] text-muted/70">Free</div>}
              </div>
            </div>
          );
        })}
      </div>
    );
  } else {
    const evs = byDate[cur] || [];
    const trip = inTrip(cur);
    body = (
      <div className="max-w-3xl">
        {trip && <button onClick={() => go(`#/trip/${trip.id}`)} className="mb-4 inline-flex items-center gap-2 rounded-full bg-cognac/12 px-3 py-1.5 text-[13px] text-cognac font-semibold"><Icon name="globe" size={14} />{trip.name}</button>}
        {evs.length ? evs.map((e, j) => <EntryRow key={e.key} e={e} next={next} last={j === evs.length - 1} showTrip={tripNames ? tripNames[e.a.tripId] : undefined} />)
          : <Empty icon="calendar" title="Nothing scheduled" text="There are no activities on this day." />}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={() => move(-1)} aria-label="Previous" className="h-10 w-10 grid place-items-center rounded-full bg-card border border-line text-heading hover:bg-pale"><Icon name="left" /></button>
          <button onClick={() => move(1)} aria-label="Next" className="h-10 w-10 grid place-items-center rounded-full bg-card border border-line text-heading hover:bg-pale"><Icon name="right" /></button>
          <button onClick={() => setCur(td)} className="h-10 px-4 rounded-full bg-card border border-line text-[14px] font-semibold text-heading hover:bg-pale">Today</button>
          <h2 className="font-display text-[20px] text-heading ml-2 truncate">{title}</h2>
        </div>
        <Segmented value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'day', label: 'Day' }]} />
      </div>
      {body}
    </div>
  );
}

/* =========================================================================
   PAGES
   ========================================================================= */
function PageHead({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: any }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
      <div>
        {eyebrow && <div className="text-[12.5px] font-bold uppercase tracking-[0.16em] text-cognac mb-1.5">{eyebrow}</div>}
        <h1 className="font-display text-[32px] sm:text-[38px] leading-[1.08] text-heading">{title}</h1>
      </div>
      {action}
    </div>
  );
}

function TripCard({ trip, count, idx }: { trip: Trip; count: number; idx: number }) {
  const ui = useUI();
  const { duplicateTrip, setArchived, deleteTrip } = useStore();
  const status = tripStatus(trip);
  const days = daysBetween(trip.start, trip.end) + 1;
  return (
    <div onClick={() => go(`#/trip/${trip.id}`)} role="link" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') go(`#/trip/${trip.id}`); }}
      className="anim-in group relative cursor-pointer rounded-3xl bg-card p-5 sm:p-6 shadow-soft border border-line transition duration-200 hover:shadow-lift hover:-translate-y-0.5 hover:border-petrol/40"
      style={{ animationDelay: `${idx * 50}ms` }}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[13.5px] font-bold text-cognac tabular-nums">{fmtRange(trip.start, trip.end)}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${STATUS[status].cls}`}>
              {status === 'ongoing' && <span className="h-1.5 w-1.5 rounded-full bg-cognac pulse-dot" />}{STATUS[status].label}
            </span>
            <span className="rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold bg-cream text-muted">{trip.kind === 'business' ? 'Business' : 'Private'}</span>
            {trip.archived && <span className="rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold bg-line text-muted">Archived</span>}
          </div>
        </div>
        <Menu items={[
          { label: 'Edit', icon: 'pencil', onClick: () => ui.editTrip(trip) },
          { label: 'Duplicate', icon: 'copy', onClick: () => { duplicateTrip(trip.id); ui.toast('Trip duplicated'); } },
          { label: trip.archived ? 'Restore from archive' : 'Archive', icon: 'archive', onClick: () => { setArchived(trip.id, !trip.archived); ui.toast(trip.archived ? 'Trip restored' : 'Trip archived'); } },
          { label: 'Delete', icon: 'trash', danger: true, onClick: () => ui.confirm({ title: 'Delete trip?', text: `“${trip.name}” and all ${plural(count, 'activity', 'activities')} will be permanently deleted.`, ok: 'Delete', onOk: () => { deleteTrip(trip.id); ui.toast('Trip deleted'); } }) },
        ]} />
      </div>
      <h3 className="font-display text-[21px] leading-tight text-heading mt-3">{trip.name}</h3>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-petrol text-[15px] font-semibold">
        {trip.cities.map((c, i) => <React.Fragment key={c + i}>{i > 0 && <Icon name="arrow" size={13} className="opacity-50" />}<span>{c}</span></React.Fragment>)}
      </div>
      <div className="mt-5 pt-4 border-t border-line flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-muted">
        <span className="flex items-center gap-1.5"><Icon name="globe" size={14} />{trip.countries.join(', ')}</span>
        <span className="flex items-center gap-1.5"><Icon name="clock" size={14} />{plural(days, 'day', 'days')}</span>
        <span className="flex items-center gap-1.5"><Icon name="list" size={14} />{plural(count, 'activity', 'activities')}</span>
      </div>
    </div>
  );
}

function NextUp() {
  const { data } = useStore();
  const ui = useUI();
  const live = data.trips.filter((t: Trip) => !t.archived && tripStatus(t) !== 'completed').map((t: Trip) => t.id);
  const entries = buildEntries(data.activities.filter((a: Activity) => live.includes(a.tripId)));
  const e = findNext(entries);
  if (!e) return null;
  const v = entryView(e);
  const trip = data.trips.find((t: Trip) => t.id === e.a.tripId);
  return (
    <button onClick={() => ui.openActivity(e.a.id)} className="anim-in w-full text-left rounded-3xl bg-nav text-white p-5 sm:p-6 shadow-lift mb-10 relative overflow-hidden group border border-white/5">
      <div className="absolute -right-10 -top-10 h-44 w-44 rounded-full border border-white/10" />
      <div className="absolute -right-2 -top-20 h-44 w-44 rounded-full border border-white/5" />
      <div className="relative flex items-center gap-1.5 text-[11.5px] uppercase tracking-[0.18em] text-[#E8BB91] font-bold">
        <span className="h-1.5 w-1.5 rounded-full bg-[#E8BB91] pulse-dot" />{nextLabel(e)}
      </div>
      <div className="relative mt-3 flex items-center gap-4">
        <div className="h-12 w-12 rounded-2xl bg-white/10 grid place-items-center shrink-0"><Icon name={v.icon} size={22} /></div>
        <div className="min-w-0">
          <div className="font-display text-[21px] sm:text-[23px] leading-tight">{v.title}</div>
          <div className="text-white/70 text-[14px] mt-0.5">{fmtShort(e.date)} · {e.time}{e.endTime ? '–' + e.endTime : ''}{e.a.city ? ' · ' + e.a.city : ''} · {trip?.name}</div>
        </div>
        <Icon name="right" className="ml-auto text-white/50 group-hover:text-white hidden sm:block" />
      </div>
    </button>
  );
}

function TripsPage() {
  const { data } = useStore();
  const ui = useUI();
  const [showArchive, setShowArchive] = useState(false);
  const counts: Record<string, number> = {};
  data.activities.forEach((a: Activity) => { counts[a.tripId] = (counts[a.tripId] || 0) + 1; });
  const active = data.trips.filter((t: Trip) => !t.archived);
  const groups = [
    { key: 'ongoing', title: 'Ongoing', list: active.filter((t: Trip) => tripStatus(t) === 'ongoing').sort((a: Trip, b: Trip) => a.start.localeCompare(b.start)) },
    { key: 'upcoming', title: 'Upcoming', list: active.filter((t: Trip) => tripStatus(t) === 'upcoming').sort((a: Trip, b: Trip) => a.start.localeCompare(b.start)) },
    { key: 'completed', title: 'Completed', list: active.filter((t: Trip) => tripStatus(t) === 'completed').sort((a: Trip, b: Trip) => b.end.localeCompare(a.end)) },
  ];
  const archived = data.trips.filter((t: Trip) => t.archived);
  let idx = 0;
  return (
    <div>
      <PageHead eyebrow={fmt(todayStr(), { weekday: 'long', day: 'numeric', month: 'long' })} title="My Trips"
        action={<button className="btn btn-primary" onClick={() => ui.editTrip(null)}><Icon name="plus" />New trip</button>} />
      <NextUp />
      {!data.trips.length && <Empty icon="globe" title="No trips yet" text="Create your first trip, then add flights, hotels and meetings." action={<button className="btn btn-primary" onClick={() => ui.editTrip(null)}><Icon name="plus" />New trip</button>} />}
      <div className="space-y-10">
        {groups.filter(g => g.list.length).map(g => (
          <section key={g.key}>
            <h2 className="text-[12.5px] font-bold uppercase tracking-[0.16em] text-heading mb-4 flex items-center gap-2">{g.title}<span className="text-muted font-semibold">{g.list.length}</span></h2>
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {g.list.map((t: Trip) => <TripCard key={t.id} trip={t} count={counts[t.id] || 0} idx={idx++} />)}
            </div>
          </section>
        ))}
        {archived.length > 0 && (
          <section>
            <button onClick={() => setShowArchive(s => !s)} className="text-[12.5px] font-bold uppercase tracking-[0.16em] text-muted mb-4 flex items-center gap-2 hover:text-heading">
              <Icon name="archive" size={15} />Archive<span className="font-semibold">{archived.length}</span><Icon name="down" size={15} className={`transition ${showArchive ? 'rotate-180' : ''}`} />
            </button>
            {showArchive && <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{archived.map((t: Trip) => <TripCard key={t.id} trip={t} count={counts[t.id] || 0} idx={0} />)}</div>}
          </section>
        )}
      </div>
    </div>
  );
}

function TripPage({ id, tab }: { id: string; tab: string }) {
  const { data, duplicateTrip, setArchived, deleteTrip } = useStore();
  const ui = useUI();
  const acts = useMemo(() => data.activities.filter((a: Activity) => a.tripId === id), [data.activities, id]);
  const entries = useMemo(() => buildEntries(acts), [acts]);
  const trip: Trip | undefined = data.trips.find((t: Trip) => t.id === id);
  if (!trip) return <Empty icon="globe" title="Trip not found" text="This trip no longer exists." action={<button className="btn btn-primary" onClick={() => go('#/trips')}>Back to all trips</button>} />;
  const status = tripStatus(trip);
  const days = daysBetween(trip.start, trip.end) + 1;
  const docs = acts.filter((a: Activity) => a.attachments.length).sort((a: Activity, b: Activity) => toUtc(a.start, a.startTz) - toUtc(b.start, b.startTz));
  const docCount = docs.reduce((s: number, a: Activity) => s + a.attachments.length, 0);
  const td = todayStr();

  return (
    <div>
      <button onClick={() => go('#/trips')} className="mb-5 -ml-1 inline-flex items-center gap-1 text-[14px] font-semibold text-muted hover:text-heading"><Icon name="left" size={16} />All trips</button>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5 mb-2">
            <span className="text-[13.5px] font-bold text-cognac tabular-nums">{fmtRange(trip.start, trip.end)}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${STATUS[status].cls}`}>{status === 'ongoing' && <span className="h-1.5 w-1.5 rounded-full bg-cognac pulse-dot" />}{STATUS[status].label}</span>
          </div>
          <h1 className="font-display text-[28px] sm:text-[38px] leading-[1.1] text-heading">{trip.name}</h1>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-petrol text-[16px] font-semibold">
            {trip.cities.map((c, i) => <React.Fragment key={c + i}>{i > 0 && <Icon name="arrow" size={14} className="opacity-50" />}<span>{c}</span></React.Fragment>)}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13.5px] text-muted">
            <span className="flex items-center gap-1.5"><Icon name="globe" size={14} />{trip.countries.join(', ')}</span>
            <span className="flex items-center gap-1.5"><Icon name="clock" size={14} />{plural(days, 'day', 'days')}</span>
            <span className="flex items-center gap-1.5"><Icon name="list" size={14} />{plural(acts.length, 'activity', 'activities')}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => ui.editTrip(trip)} className="hidden sm:inline-flex btn btn-ghost h-10"><Icon name="pencil" size={16} />Edit</button>
          <Menu items={[
            { label: 'Edit trip', icon: 'pencil', onClick: () => ui.editTrip(trip) },
            { label: 'Duplicate', icon: 'copy', onClick: () => { duplicateTrip(trip.id); ui.toast('Trip duplicated'); } },
            { label: trip.archived ? 'Restore from archive' : 'Archive', icon: 'archive', onClick: () => { setArchived(trip.id, !trip.archived); ui.toast(trip.archived ? 'Trip restored' : 'Trip archived'); } },
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => ui.confirm({ title: 'Delete trip?', text: `“${trip.name}” and all ${plural(acts.length, 'activity', 'activities')} will be permanently deleted.`, ok: 'Delete', onOk: () => { deleteTrip(trip.id); go('#/trips'); ui.toast('Trip deleted'); } }) },
          ]} />
        </div>
      </div>

      <div className="sticky top-[env(safe-area-inset-top,0px)] z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 mt-5 mb-6 bg-cream/90 backdrop-blur-md border-b border-line flex items-center justify-between gap-3">
        <Segmented value={tab} onChange={t => go(`#/trip/${trip.id}/${t}`)} options={[
          { value: 'timeline', label: 'Timeline', icon: 'list' },
          { value: 'calendar', label: 'Calendar', icon: 'calendar' },
          { value: 'documents', label: `Documents${docCount ? ` (${docCount})` : ''}`, icon: 'file' },
        ]} />
        <button onClick={() => ui.newActivity(trip.id)} className="hidden md:inline-flex btn btn-primary h-10"><Icon name="plus" />Activity</button>
      </div>

      {tab === 'timeline' && <div className="max-w-3xl"><Timeline trip={trip} acts={acts} entries={entries} /></div>}
      {tab === 'calendar' && <CalendarView entries={entries} initialDate={td >= trip.start && td <= trip.end ? td : trip.start} ranges={[trip]} />}
      {tab === 'documents' && (
        <div className="max-w-3xl">
          <div className="rounded-2xl bg-pale px-4 py-3 text-[13.5px] text-petrol flex gap-2.5 mb-6"><Icon name="clip" size={16} className="mt-0.5" /><span>Uploading, PDF viewing and offline access come in <strong>Phase 3</strong>. This shows how booking confirmations are collected per activity.</span></div>
          {!docs.length ? <Empty icon="file" title="No documents" text="Documents are attached to individual activities and collected here." /> : (
            <div className="space-y-5">
              {docs.map((a: Activity) => (
                <div key={a.id}>
                  <button onClick={() => ui.openActivity(a.id)} className="flex flex-wrap items-center gap-2 text-[13px] mb-2 hover:underline text-left">
                    <span className="text-cognac font-bold tabular-nums">{fmtShort(a.start.slice(0, 10))} · {a.start.slice(11, 16)}</span><span className="text-heading font-semibold">{a.title}</span>
                  </button>
                  <div className="space-y-2">{a.attachments.map(f => <DocRow key={f.id} f={f} />)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab !== 'documents' && (
        <button onClick={() => ui.newActivity(trip.id)} aria-label="Add activity" className="md:hidden fixed right-5 bottom-[calc(env(safe-area-inset-bottom,0px)+84px)] z-30 h-14 w-14 rounded-full bg-primary text-white grid place-items-center shadow-lift active:scale-95 transition"><Icon name="plus" size={24} stroke={2} /></button>
      )}
    </div>
  );
}

function DocRow({ f }: { f: Attachment }) {
  const ui = useUI();
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-card border border-line px-3.5 py-3">
      <div className="h-10 w-10 rounded-xl bg-cognac/12 text-cognac grid place-items-center shrink-0"><Icon name="file" size={18} /></div>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-ink truncate">{f.name}</div>
        <div className="text-[12px] text-muted">{f.name.split('.').pop()!.toUpperCase()} · {Math.round(f.size / 1000)} KB</div>
      </div>
      <button onClick={() => ui.toast('Document viewing comes in Phase 3.')} className="btn btn-primary h-9 px-3.5 text-[13px]"><Icon name="eye" size={15} /><span className="hidden sm:inline">View document</span><span className="sm:hidden">View</span></button>
    </div>
  );
}

function CalendarPage() {
  const { data } = useStore();
  const entries = useMemo(() => buildEntries(data.activities), [data.activities]);
  const names: Record<string, string> = {};
  data.trips.forEach((t: Trip) => { names[t.id] = t.name; });
  return (
    <div>
      <PageHead eyebrow="All trips" title="Calendar" />
      <CalendarView entries={entries} initialDate={todayStr()} ranges={data.trips} tripNames={names} />
    </div>
  );
}

function ContactsPage() {
  const { data, importContacts } = useStore();
  const ui = useUI();
  const [q, setQ] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const ql = q.trim().toLowerCase();
  const list = data.contacts
    .filter((c: Contact) => !ql || [c.name, c.company, c.city, c.country, c.position].join(' ').toLowerCase().includes(ql))
    .sort((a: Contact, b: Contact) => a.name.localeCompare(b.name));
  const meetings = (id: string) => data.activities.filter((a: Activity) => a.contactIds.includes(id)).length;

  const onFile = async (e: any) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    const contacts = csvToContacts(parseCsv(await file.text()));
    if (!contacts.length) { ui.toast('No contacts found. Check the column headers.'); return; }
    importContacts(contacts);
    ui.toast(`${plural(contacts.length, 'contact', 'contacts')} imported`);
  };

  return (
    <div>
      <PageHead eyebrow={plural(data.contacts.length, 'contact', 'contacts')} title="Contacts" action={
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}><Icon name="upload" size={16} />Import CSV</button>
          <button className="btn btn-primary" onClick={() => ui.editContact(null)}><Icon name="plus" />Contact</button>
          <input id="csv-file" ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
        </div>
      } />
      <div className="relative mb-6 max-w-md">
        <Icon name="search" size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
        <input id="contact-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, company or city" className="inp pl-10 rounded-full" />
      </div>
      {!list.length ? <Empty icon="users" title={q ? 'No matches' : 'No contacts yet'} text={q ? 'Try a different search.' : 'Add contacts or import them from a CSV file.'} /> : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((c: Contact, i: number) => (
            <div key={c.id} onClick={() => ui.openContact(c.id)} className="anim-in cursor-pointer rounded-3xl bg-card p-4 sm:p-5 shadow-soft border border-line hover:shadow-lift hover:border-petrol/40 transition flex gap-4" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
              <div className="h-12 w-12 rounded-2xl bg-primary text-white grid place-items-center font-display text-[16px] shrink-0">{initials(c.name)}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-[16px] text-ink">{c.name}</div>
                <div className="text-[13.5px] text-muted truncate">{[c.position, c.company].filter(Boolean).join(' · ')}</div>
                <div className="text-[12.5px] text-muted mt-1 flex items-center gap-1.5"><Icon name="pin" size={13} />{[c.city, c.country].filter(Boolean).join(', ') || '—'}{meetings(c.id) > 0 && <span className="ml-2 flex items-center gap-1"><Icon name="briefcase" size={13} />{meetings(c.id)}</span>}</div>
                <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
                  {c.phone && <a href={`tel:${c.phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-1.5 rounded-full bg-pale text-petrol px-3 py-1.5 text-[13px] font-semibold hover:bg-petrol-fill hover:text-white transition"><Icon name="phone" size={13} />Call</a>}
                  {c.email && <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1.5 rounded-full bg-pale text-petrol px-3 py-1.5 text-[13px] font-semibold hover:bg-petrol-fill hover:text-white transition"><Icon name="mail" size={13} />Email</a>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-8 text-[12.5px] text-muted max-w-xl">CSV import: the first row holds the column names, e.g. <code className="text-ink/80">Name;Company;Position;Phone;Email;Country;City;Notes</code>. Comma or semicolon separated.</p>
    </div>
  );
}

function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const head = text.split(/\r?\n/)[0] || '';
  const delim = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : ',';
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const CSV_KEYS: Record<string, string> = {
  'name': 'name', 'full name': 'name', 'vollständiger name': 'name', 'first name': 'first', 'vorname': 'first', 'last name': 'last', 'nachname': 'last',
  'company': 'company', 'organization': 'company', 'organisation': 'company', 'firma': 'company', 'unternehmen': 'company',
  'position': 'position', 'title': 'position', 'job title': 'position', 'funktion': 'position',
  'phone': 'phone', 'telephone': 'phone', 'mobile': 'phone', 'telefon': 'phone', 'mobil': 'phone',
  'email': 'email', 'e-mail': 'email', 'mail': 'email', 'email address': 'email',
  'country': 'country', 'land': 'country', 'city': 'city', 'stadt': 'city', 'ort': 'city',
  'notes': 'notes', 'note': 'notes', 'notizen': 'notes',
};
function csvToContacts(rows: string[][]): Contact[] {
  if (rows.length < 2) return [];
  const keys = rows[0].map(h => CSV_KEYS[h.trim().toLowerCase()] || '');
  return rows.slice(1).map(r => {
    const o: any = {};
    keys.forEach((k, i) => { if (k) o[k] = (r[i] || '').trim(); });
    const name = o.name || [o.first, o.last].filter(Boolean).join(' ');
    return { id: uid(), name, company: o.company || '', position: o.position || '', phone: o.phone || '', email: o.email || '', country: o.country || '', city: o.city || '', notes: o.notes || '' };
  }).filter(c => c.name);
}

function syncLabel(s: any) {
  if (!s.connected) return 'Not connected';
  const t = s.lastSync ? new Date(s.lastSync) : null;
  const when = t ? (t.toDateString() === new Date().toDateString() ? `${pad(t.getHours())}:${pad(t.getMinutes())}` : `${t.getDate()} ${t.toLocaleString(LOCALE, { month: 'short' })}`) : '';
  switch (s.status) {
    case 'syncing': return 'Syncing…';
    case 'offline': return s.pending ? 'Offline · changes saved on this device' : 'Offline · showing saved copy';
    case 'needs-auth': return s.pending ? 'Changes waiting · tap to sync' : 'Tap to sync';
    case 'error': return 'Sync problem · tap to retry';
    default: return s.pending ? 'Changes waiting…' : when ? `Synced ${when}` : 'Synced';
  }
}

function SyncBadge({ dark = false }: { dark?: boolean }) {
  const { sync } = useStore();
  const ok = sync.connected && sync.status === 'idle' && !sync.pending;
  const warn = sync.status === 'error';
  const onClick = () => { if (!sync.connected) go('#/settings'); else sync.syncNow(); };
  return (
    <button onClick={onClick} title={sync.error || 'Google Drive sync'}
      className={`flex items-center gap-2 rounded-full text-left font-semibold transition ${dark ? 'w-full px-2.5 py-2 text-[12px] text-white/65 hover:text-white hover:bg-white/5' : 'px-2 py-1 text-[11px] text-muted hover:text-heading'}`}>
      {sync.status === 'syncing'
        ? <Icon name="refresh" size={dark ? 14 : 12} className="animate-spin" />
        : <span className={`h-2 w-2 rounded-full shrink-0 ${warn ? 'bg-danger' : ok ? 'bg-dot' : dark ? 'bg-[#E8BB91]' : 'bg-cognac'}`} />}
      <span className="truncate">{sync.connected ? syncLabel(sync) : dark ? 'Saved on this device · Connect Drive' : 'This device'}</span>
    </button>
  );
}

function SyncPrompts() {
  const { sync } = useStore();
  const ui = useUI();
  useEffect(() => { if (sync.notice) { ui.toast(sync.notice); sync.clearNotice(); } }, [sync.notice]);
  if (!sync.choice) return null;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-5" role="alertdialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 anim-fade" />
      <div className="relative w-full max-w-md rounded-3xl bg-card border border-line p-6 shadow-lift anim-in">
        <div className="h-11 w-11 rounded-2xl bg-pale text-petrol grid place-items-center"><Icon name="cloud" size={20} /></div>
        <h3 className="font-display text-[21px] text-heading mt-4">Your Google Drive is connected</h3>
        <p className="text-[14.5px] text-muted mt-2">The app has created the folder “My Travel Planner” in your Drive. This device only has the sample trips. What should go into Drive?</p>
        <div className="flex flex-col gap-2 mt-6">
          <button className="btn btn-primary" onClick={() => sync.choice('empty')}>Start with an empty planner</button>
          <button className="btn btn-ghost" onClick={() => sync.choice('upload')}>Keep the sample trips</button>
        </div>
      </div>
    </div>
  );
}

function SettingsPage({ theme, setTheme }: { theme: string; setTheme: (t: string) => void }) {
  const { data, reset, sync } = useStore();
  const ui = useUI();
  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2))
      .then(() => ui.toast('Data copied as JSON'))
      .catch(() => ui.toast('Copying isn’t supported here'));
  };
  const Card = ({ title, icon, children }: any) => (
    <section className="rounded-3xl bg-card p-5 sm:p-6 shadow-soft border border-line">
      <SectionTitle icon={icon}>{title}</SectionTitle>{children}
    </section>
  );
  return (
    <div className="max-w-2xl">
      <PageHead title="Settings" />
      <div className="space-y-4">
        <Card title="Appearance" icon="moon">
          <Segmented value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark', icon: 'moon' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'system', label: 'System', icon: 'monitor' }]} />
        </Card>
        <Card title="Google Drive" icon="cloud">
          {!sync.connected ? (
            <div className="flex items-start gap-3">
              <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-cognac shrink-0" />
              <div className="min-w-0">
                <div className="font-semibold text-ink">Not connected · stored on this device only</div>
                <p className="text-[14px] text-muted mt-0.5">Connect your Google Drive to keep all trips in the folder “My Travel Planner” and sync them between your laptop and iPhone. This device keeps a full copy for offline use.</p>
                <button className="btn btn-primary mt-3" onClick={sync.connect}><Icon name="cloud" size={16} />Connect Google Drive</button>
                {sync.error && <p className="text-[13px] text-danger mt-2">{sync.error}</p>}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <span className={`mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ${sync.status === 'error' ? 'bg-danger' : sync.status === 'idle' && !sync.pending ? 'bg-dot' : 'bg-cognac'}`} />
              <div className="min-w-0">
                <div className="font-semibold text-ink">{syncLabel(sync)}</div>
                <p className="text-[14px] text-muted mt-0.5">Your trips are stored in Google Drive › My Travel Planner › travel-data.json, with a daily backup in the Backups folder. Changes sync automatically when you’re online.</p>
                {sync.status === 'error' && sync.error && <p className="text-[13px] text-danger mt-2 break-words">{sync.error}</p>}
                <div className="flex flex-wrap gap-2 mt-3">
                  <button className="btn btn-primary" disabled={sync.status === 'syncing'} onClick={sync.syncNow}><Icon name="refresh" size={16} />Sync now</button>
                  <button className="btn btn-ghost" onClick={() => ui.confirm({ title: 'Disconnect Google Drive?', text: 'Your trips stay in Google Drive and on this device, but this device stops syncing.', ok: 'Disconnect', onOk: () => { sync.disconnect(); ui.toast('Google Drive disconnected'); } })}>Disconnect</button>
                </div>
              </div>
            </div>
          )}
        </Card>
        <Card title="Data" icon="archive">
          <div className="text-[14px] text-muted mb-4">{plural(data.trips.length, 'trip', 'trips')} · {plural(data.activities.length, 'activity', 'activities')} · {plural(data.contacts.length, 'contact', 'contacts')}</div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" onClick={copyJson}><Icon name="copy" size={16} />Copy data as JSON</button>
            {!sync.connected && <button className="btn btn-danger" onClick={() => ui.confirm({ title: 'Restore sample data?', text: 'All your current changes will be replaced by the sample trips.', ok: 'Restore', onOk: () => { reset(); ui.toast('Sample data restored'); } })}><Icon name="undo" size={16} />Restore sample data</button>}
          </div>
        </Card>
        <p className="text-[12.5px] text-muted px-1">My Travel Planner · All times are stored and shown in the local time of each place.</p>
      </div>
    </div>
  );
}

/* =========================================================================
   DETAIL SHEETS
   ========================================================================= */
function ActivityDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, updateActivity, deleteActivity, duplicateActivity } = useStore();
  const ui = useUI();
  const [taskDraft, setTaskDraft] = useState('');
  const a: Activity | undefined = data.activities.find((x: Activity) => x.id === id);
  if (!a) return null;
  const trip = data.trips.find((t: Trip) => t.id === a.tripId);
  const meta = TYPE_META[a.type];
  const d = a.details || {};
  const spec = FORM[a.type];
  const endTz = a.endTz || a.startTz;
  const contacts = a.contactIds.map(cid => data.contacts.find((c: Contact) => c.id === cid)).filter(Boolean) as Contact[];
  const isRoute = a.type === 'flight' || a.type === 'train';

  let when = `${fmtLong(a.start.slice(0, 10))} · ${a.start.slice(11, 16)}`;
  if (a.type === 'hotel' && a.end) {
    const n = daysBetween(a.start.slice(0, 10), a.end.slice(0, 10));
    when = `${fmtShort(a.start.slice(0, 10))} ${a.start.slice(11, 16)} – ${fmtShort(a.end.slice(0, 10))} ${a.end.slice(11, 16)} · ${plural(n, 'night', 'nights')}`;
  } else if (a.end && a.end.slice(0, 10) === a.start.slice(0, 10)) when += `–${a.end.slice(11, 16)}`;

  const facts: [string, string, string?][] = [];
  if (!isRoute) {
    if (a.city) facts.push(['City', a.city]);
    if (a.location) facts.push([spec.location || 'Location', a.location]);
  }
  spec.fields.forEach(fd => {
    if (isRoute && (fd.key === 'from' || fd.key === 'to')) return;
    if (d[fd.key]) facts.push([fd.label, d[fd.key], fd.type]);
  });
  if (!isRoute) facts.push(['Time zone', `${tzCity(a.startTz)} (${gmtLabel(a.startTz, a.start)})`]);

  const toggleTask = (tid: string) => updateActivity(a.id, (x: Activity) => ({ ...x, tasks: x.tasks.map(t => t.id === tid ? { ...t, done: !t.done } : t) }));
  const addTask = () => { if (!taskDraft.trim()) return; updateActivity(a.id, (x: Activity) => ({ ...x, tasks: [...x.tasks, { id: uid(), text: taskDraft.trim(), done: false }] })); setTaskDraft(''); };

  return (
    <Sheet onClose={onClose} label={a.title}>
      <SheetHead onClose={onClose} title={a.title} eyebrow={
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-pale text-petrol grid place-items-center"><Icon name={meta.icon} size={18} /></div>
          <div className="text-[11.5px] font-bold uppercase tracking-[0.13em] text-petrol">{meta.label}{trip ? <span className="text-muted font-medium normal-case tracking-normal"> · {trip.name}</span> : null}</div>
        </div>
      }>
        <div className="mt-1.5 text-[14.5px] font-semibold text-cognac">{when}</div>
      </SheetHead>

      <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-6 space-y-7">
        {isRoute && (
          <div className="rounded-3xl bg-pale p-5">
            <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-[0.13em] text-petrol">Departure</div>
                <div className="font-display text-[32px] leading-none text-heading mt-1.5 tabular-nums">{a.start.slice(11, 16)}</div>
                <div className="text-[13px] text-cognac font-semibold mt-1.5">{fmtShort(a.start.slice(0, 10))}</div>
                <div className="text-[14px] text-ink mt-1 font-semibold">{d.from || '—'}</div>
                <div className="text-[12px] text-muted">Local time · {gmtLabel(a.startTz, a.start)}</div>
              </div>
              <div className="pt-7 flex flex-col items-center text-petrol">
                <Icon name={meta.icon} size={20} />
                {a.end && <div className="text-[11.5px] text-muted mt-1.5 whitespace-nowrap">{durText(toUtc(a.end, endTz) - toUtc(a.start, a.startTz))}</div>}
              </div>
              <div className="text-right min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-[0.13em] text-petrol">Arrival</div>
                <div className="font-display text-[32px] leading-none text-heading mt-1.5 tabular-nums">{a.end ? a.end.slice(11, 16) : '—'}</div>
                <div className="text-[13px] text-cognac font-semibold mt-1.5">{a.end ? fmtShort(a.end.slice(0, 10)) : ''}</div>
                <div className="text-[14px] text-ink mt-1 font-semibold">{d.to || '—'}</div>
                <div className="text-[12px] text-muted">{a.end ? `Local time · ${gmtLabel(endTz, a.end)}` : ''}</div>
              </div>
            </div>
          </div>
        )}

        {facts.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
            {facts.map(([k, val, type]) => (
              <div key={k} className={val.length > 28 || type === 'textarea' ? 'col-span-2' : ''}>
                <dt className="lbl !mb-1">{k}</dt>
                <dd className="text-[15px] text-ink whitespace-pre-line break-words select-text">
                  {type === 'tel' ? <a className="text-petrol font-semibold hover:underline" href={`tel:${val.replace(/\s/g, '')}`}>{val}</a>
                    : type === 'email' ? <a className="text-petrol font-semibold hover:underline" href={`mailto:${val}`}>{val}</a>
                    : val}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {contacts.length > 0 && (
          <section>
            <SectionTitle icon="user">Contact person</SectionTitle>
            <div className="space-y-2">
              {contacts.map(c => (
                <div key={c.id} className="flex items-center gap-3 rounded-2xl bg-card border border-line p-3">
                  <button onClick={() => ui.openContact(c.id)} className="h-11 w-11 rounded-xl bg-primary text-white grid place-items-center font-display text-[15px] shrink-0">{initials(c.name)}</button>
                  <button onClick={() => ui.openContact(c.id)} className="min-w-0 flex-1 text-left">
                    <div className="font-semibold text-ink">{c.name}</div>
                    <div className="text-[13px] text-muted truncate">{[c.position, c.company].filter(Boolean).join(' · ')}</div>
                    {c.phone && <div className="text-[12.5px] text-muted tabular-nums">{c.phone}</div>}
                  </button>
                  {c.phone && <a aria-label={`Call ${c.name}`} href={`tel:${c.phone.replace(/\s/g, '')}`} className="h-10 w-10 rounded-full bg-pale text-petrol grid place-items-center hover:bg-petrol-fill hover:text-white"><Icon name="phone" size={16} /></a>}
                  {c.email && <a aria-label={`Email ${c.name}`} href={`mailto:${c.email}`} className="h-10 w-10 rounded-full bg-pale text-petrol grid place-items-center hover:bg-petrol-fill hover:text-white"><Icon name="mail" size={16} /></a>}
                </div>
              ))}
            </div>
          </section>
        )}

        {a.type === 'meeting' && (
          <section>
            <SectionTitle icon="check">Follow-up tasks</SectionTitle>
            <div className="space-y-1.5">
              {a.tasks.map(t => (
                <div key={t.id} className="group flex items-center gap-3 rounded-xl px-1 py-1.5">
                  <button onClick={() => toggleTask(t.id)} aria-label={t.done ? 'Mark as open' : 'Mark as done'} className={`h-6 w-6 rounded-lg border-2 grid place-items-center shrink-0 transition ${t.done ? 'bg-primary border-primary text-white' : 'border-line hover:border-primary'}`}>{t.done && <Icon name="check" size={14} stroke={2.5} />}</button>
                  <span className={`flex-1 text-[15px] ${t.done ? 'line-through text-muted' : 'text-ink'}`}>{t.text}</span>
                  <button onClick={() => updateActivity(a.id, (x: Activity) => ({ ...x, tasks: x.tasks.filter(y => y.id !== t.id) }))} aria-label="Delete task" className="opacity-60 sm:opacity-0 group-hover:opacity-100 h-8 w-8 grid place-items-center rounded-full text-muted hover:text-danger"><Icon name="x" size={15} /></button>
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <input id="new-task" value={taskDraft} onChange={e => setTaskDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addTask(); }} placeholder="New task" className="inp" />
                <button onClick={addTask} className="btn btn-ghost h-[46px] px-4" aria-label="Add task"><Icon name="plus" /></button>
              </div>
            </div>
          </section>
        )}

        <NotesSection a={a} />

        <section>
          <SectionTitle icon="clip" action={<button onClick={() => ui.toast('Document upload comes in Phase 3.')} className="text-[13px] font-semibold text-petrol flex items-center gap-1 hover:underline"><Icon name="upload" size={14} />Upload</button>}>Documents</SectionTitle>
          {a.attachments.length ? <div className="space-y-2">{a.attachments.map(f => <DocRow key={f.id} f={f} />)}</div>
            : <div className="text-[14px] text-muted">No documents attached yet.</div>}
        </section>
      </div>

      <SheetFoot>
        <button className="btn btn-primary flex-1" onClick={() => ui.editActivity(a)}><Icon name="pencil" size={16} />Edit</button>
        <button className="btn btn-ghost" onClick={() => { duplicateActivity(a.id); ui.toast('Activity duplicated'); }}><Icon name="copy" size={16} /><span className="hidden sm:inline">Duplicate</span></button>
        <button className="btn btn-danger" onClick={() => ui.confirm({ title: 'Delete activity?', text: `“${a.title}” will be permanently deleted.`, ok: 'Delete', onOk: () => { deleteActivity(a.id); onClose(); ui.toast('Activity deleted'); } })}><Icon name="trash" size={16} /><span className="hidden sm:inline">Delete</span></button>
      </SheetFoot>
    </Sheet>
  );
}

function NotesSection({ a }: { a: Activity }) {
  const { updateActivity } = useStore();
  const ui = useUI();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const add = () => {
    if (!draft.trim()) return;
    updateActivity(a.id, (x: Activity) => ({ ...x, notes: [...x.notes, { id: uid(), text: draft.trim(), createdAt: nowLocal() }] }));
    setDraft('');
  };
  const save = (nid: string) => {
    if (!editText.trim()) return;
    updateActivity(a.id, (x: Activity) => ({ ...x, notes: x.notes.map(n => n.id === nid ? { ...n, text: editText.trim() } : n) }));
    setEditing(null);
  };
  return (
    <section>
      <SectionTitle icon="note">Notes</SectionTitle>
      <div className="space-y-2">
        {a.notes.map(n => (
          <div key={n.id} className="group rounded-2xl bg-card border border-line pl-4 pr-2 py-3 relative">
            <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-petrol/60" />
            {editing === n.id ? (
              <div>
                <textarea id={`note-edit-${n.id}`} autoFocus value={editText} onChange={e => setEditText(e.target.value)} className="inp" />
                <div className="flex justify-end gap-2 mt-2">
                  <button className="btn btn-ghost h-9" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="btn btn-primary h-9" onClick={() => save(n.id)}>Save</button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] text-ink whitespace-pre-line leading-relaxed">{n.text}</div>
                  <div className="text-[11.5px] text-muted mt-1">{fmtShort(n.createdAt.slice(0, 10))} · {n.createdAt.slice(11, 16)}</div>
                </div>
                <div className="flex sm:opacity-0 group-hover:opacity-100 transition">
                  <button onClick={() => { setEditing(n.id); setEditText(n.text); }} aria-label="Edit note" className="h-8 w-8 grid place-items-center rounded-full text-muted hover:text-heading hover:bg-pale"><Icon name="pencil" size={14} /></button>
                  <button onClick={() => ui.confirm({ title: 'Delete note?', text: n.text, ok: 'Delete', onOk: () => updateActivity(a.id, (x: Activity) => ({ ...x, notes: x.notes.filter(y => y.id !== n.id) })) })} aria-label="Delete note" className="h-8 w-8 grid place-items-center rounded-full text-muted hover:text-danger hover:bg-pale"><Icon name="trash" size={14} /></button>
                </div>
              </div>
            )}
          </div>
        ))}
        <div className="rounded-2xl bg-card border border-line p-2.5">
          <textarea id="new-note" value={draft} onChange={e => setDraft(e.target.value)} placeholder="New note, e.g. “Confirm meeting one day before.”" className="w-full bg-transparent resize-none outline-none px-1.5 py-1 text-[16px] min-h-[52px] text-ink placeholder:text-muted/60" />
          <div className="flex justify-end"><button disabled={!draft.trim()} onClick={add} className="btn btn-primary h-9 px-4 disabled:opacity-40 disabled:shadow-none"><Icon name="plus" size={15} />Add note</button></div>
        </div>
      </div>
    </section>
  );
}

function ContactDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, deleteContact } = useStore();
  const ui = useUI();
  const c: Contact | undefined = data.contacts.find((x: Contact) => x.id === id);
  if (!c) return null;
  const linked = buildEntries(data.activities.filter((a: Activity) => a.contactIds.includes(c.id))).filter(e => e.kind === 'main');
  return (
    <Sheet onClose={onClose} label={c.name}>
      <SheetHead onClose={onClose} title={c.name} eyebrow={<div className="h-14 w-14 rounded-2xl bg-primary text-white grid place-items-center font-display text-[19px] mb-2">{initials(c.name)}</div>}>
        <div className="text-[14.5px] text-muted mt-1">{[c.position, c.company].filter(Boolean).join(' · ')}</div>
        <div className="flex gap-2 mt-4">
          {c.phone && <a href={`tel:${c.phone.replace(/\s/g, '')}`} className="btn btn-primary h-10"><Icon name="phone" size={15} />Call</a>}
          {c.email && <a href={`mailto:${c.email}`} className="btn btn-ghost h-10"><Icon name="mail" size={15} />Email</a>}
        </div>
      </SheetHead>
      <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-6 space-y-7">
        <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
          {([['Phone', c.phone, 'tel'], ['Email', c.email, 'email'], ['Company', c.company], ['Position', c.position], ['City', c.city], ['Country', c.country]] as [string, string, string?][]).filter(x => x[1]).map(([k, v, t]) => (
            <div key={k} className={k === 'Email' || k === 'Company' ? 'col-span-2' : ''}>
              <dt className="lbl !mb-1">{k}</dt>
              <dd className="text-[15px] text-ink break-words select-text">{t === 'tel' ? <a className="text-petrol font-semibold" href={`tel:${v.replace(/\s/g, '')}`}>{v}</a> : t === 'email' ? <a className="text-petrol font-semibold" href={`mailto:${v}`}>{v}</a> : v}</dd>
            </div>
          ))}
        </dl>
        {c.notes && <section><SectionTitle icon="note">Notes</SectionTitle><p className="text-[15px] text-ink whitespace-pre-line leading-relaxed">{c.notes}</p></section>}
        <section>
          <SectionTitle icon="briefcase">Meetings</SectionTitle>
          {linked.length ? <div className="space-y-2">{linked.map(e => {
            const trip = data.trips.find((t: Trip) => t.id === e.a.tripId);
            return (
              <button key={e.key} onClick={() => ui.openActivity(e.a.id)} className="w-full text-left flex gap-3 rounded-2xl bg-pale px-4 py-3 hover:shadow-soft transition">
                <div className="text-cognac font-bold text-[13px] tabular-nums w-24 shrink-0 pt-0.5">{fmtShort(e.date)}<div className="text-muted font-normal">{e.time}</div></div>
                <div className="min-w-0"><div className="font-semibold text-ink">{e.a.title}</div><div className="text-[13px] text-muted truncate">{trip?.name}</div></div>
              </button>
            );
          })}</div> : <div className="text-[14px] text-muted">Not linked to any meeting yet.</div>}
        </section>
      </div>
      <SheetFoot>
        <button className="btn btn-primary flex-1" onClick={() => ui.editContact(c)}><Icon name="pencil" size={16} />Edit</button>
        <button className="btn btn-danger" onClick={() => ui.confirm({ title: 'Delete contact?', text: `${c.name} will be deleted and removed from all meetings.`, ok: 'Delete', onOk: () => { deleteContact(c.id); onClose(); ui.toast('Contact deleted'); } })}><Icon name="trash" size={16} /><span className="hidden sm:inline">Delete</span></button>
      </SheetFoot>
    </Sheet>
  );
}

/* =========================================================================
   FORMS
   ========================================================================= */
function TzSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const opts = TIMEZONES.some(t => t.id === value) ? TIMEZONES : [...TIMEZONES, { id: value, label: value, city: value }];
  return <select id={id} value={value} onChange={e => onChange(e.target.value)} className="inp">{opts.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>;
}

function ActivityForm({ init, onClose }: { init: { tripId: string; activity?: Activity; date?: string }; onClose: () => void }) {
  const { data, saveActivity } = useStore();
  const ui = useUI();
  const trip: Trip = data.trips.find((t: Trip) => t.id === init.tripId);
  const [f, setF] = useState<Activity>(() => {
    if (init.activity) return clone(init.activity);
    const others = data.activities.filter((a: Activity) => a.tripId === init.tripId).sort((a: Activity, b: Activity) => toUtc(a.start, a.startTz) - toUtc(b.start, b.startTz));
    const td = todayStr();
    const date = init.date || (trip && td >= trip.start && td <= trip.end ? td : trip ? trip.start : td);
    // Default zone: where you are on that day (first activity of the day, else where the previous day ended)
    const sameDay = others.find((a: Activity) => a.start.slice(0, 10) === date);
    const prior = others.filter((a: Activity) => a.start.slice(0, 10) < date).pop();
    const tz = sameDay ? sameDay.startTz : prior ? (prior.endTz || prior.startTz) : others[0] ? others[0].startTz : 'Europe/Berlin';
    return { id: uid(), tripId: init.tripId, type: 'meeting', title: '', start: date + 'T09:00', startTz: tz, end: '', endTz: tz, city: (sameDay || prior)?.city || '', location: '', details: {}, contactIds: [], notes: [], tasks: [], attachments: [] };
  });
  const [firstNote, setFirstNote] = useState('');
  const [err, setErr] = useState('');
  const spec = FORM[f.type];
  const set = (p: Partial<Activity>) => setF(x => ({ ...x, ...p }));
  const setD = (k: string, v: string) => setF(x => ({ ...x, details: { ...x.details, [k]: v } }));

  const submit = () => {
    if (!f.start) { setErr('Enter a start date and time.'); return; }
    if (f.type === 'hotel' && !f.title.trim()) { setErr('Enter the hotel name.'); return; }
    const endTz = spec.endTz ? (f.endTz || f.startTz) : f.startTz;
    if (f.end && toUtc(f.end, endTz) < toUtc(f.start, f.startTz)) { setErr('The end is before the start. Check the times and time zones.'); return; }
    const out: Activity = { ...f, title: f.title.trim() || autoTitle(f), end: f.end || undefined, endTz };
    if (firstNote.trim()) out.notes = [...out.notes, { id: uid(), text: firstNote.trim(), createdAt: nowLocal() }];
    saveActivity(out);
    ui.toast(init.activity ? 'Changes saved' : 'Activity added');
    onClose();
  };

  const available = data.contacts.filter((c: Contact) => !f.contactIds.includes(c.id)).sort((a: Contact, b: Contact) => a.name.localeCompare(b.name));

  return (
    <Sheet onClose={onClose} label="Activity">
      <SheetHead onClose={onClose} title={init.activity ? 'Edit activity' : 'New activity'} eyebrow={trip && <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-cognac">{trip.name}</div>} />
      <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-6 space-y-6">
        <div>
          <span className="lbl">Type</span>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {(Object.keys(TYPE_META) as ActivityType[]).map(t => (
              <button key={t} onClick={() => set({ type: t })} aria-pressed={f.type === t}
                className={`flex flex-col items-center gap-1.5 rounded-2xl py-3 text-[12.5px] font-semibold border transition ${f.type === t ? 'bg-petrol-fill text-white border-transparent shadow-soft' : 'bg-card border-line text-muted hover:text-petrol hover:border-petrol/50'}`}>
                <Icon name={TYPE_META[t].icon} size={20} />{TYPE_META[t].label}
              </button>
            ))}
          </div>
        </div>

        <Field label={spec.title}><input id="act-title" className="inp" value={f.title} placeholder={spec.titlePh} onChange={e => set({ title: e.target.value })} /></Field>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label={spec.start}><input id="act-start" type="datetime-local" className="inp" value={f.start} onChange={e => set({ start: e.target.value })} /></Field>
          <Field label="Time zone"><TzSelect id="act-start-tz" value={f.startTz} onChange={v => set({ startTz: v, endTz: spec.endTz ? f.endTz : v })} /></Field>
          <Field label={spec.end}><input id="act-end" type="datetime-local" className="inp" value={f.end || ''} onChange={e => set({ end: e.target.value })} /></Field>
          {spec.endTz ? <Field label="Arrival time zone"><TzSelect id="act-end-tz" value={f.endTz || f.startTz} onChange={v => set({ endTz: v })} /></Field> : <div className="hidden sm:block" />}
        </div>
        {spec.endTz && f.end && f.start && toUtc(f.end, f.endTz || f.startTz) > toUtc(f.start, f.startTz) && (
          <div className="-mt-3 text-[13px] text-petrol flex items-center gap-1.5"><Icon name="clock" size={14} />Travel time: {durText(toUtc(f.end, f.endTz || f.startTz) - toUtc(f.start, f.startTz))}</div>
        )}

        <div className="grid sm:grid-cols-2 gap-4">
          {spec.city && <Field label="City"><input id="act-city" className="inp" value={f.city || ''} placeholder="e.g. Shanghai" onChange={e => set({ city: e.target.value })} /></Field>}
          {spec.location && <Field label={spec.location} wide={!spec.city}><input id="act-location" className="inp" value={f.location || ''} onChange={e => set({ location: e.target.value })} /></Field>}
          {spec.fields.map(fd => (
            <Field key={fd.key} label={fd.label} wide={fd.wide}>
              {fd.type === 'textarea'
                ? <textarea id={`act-${fd.key}`} className="inp" value={f.details[fd.key] || ''} placeholder={fd.ph} onChange={e => setD(fd.key, e.target.value)} />
                : <input id={`act-${fd.key}`} className="inp" type={fd.type || 'text'} value={f.details[fd.key] || ''} placeholder={fd.ph} onChange={e => setD(fd.key, e.target.value)} />}
            </Field>
          ))}
        </div>

        {f.type === 'meeting' && (
          <div>
            <span className="lbl">Contacts</span>
            <div className="flex flex-wrap gap-2 mb-2">
              {f.contactIds.map(id => {
                const c = data.contacts.find((x: Contact) => x.id === id);
                return c ? (
                  <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-pale text-petrol pl-3 pr-1 py-1 text-[13.5px] font-semibold">
                    {c.name}<button aria-label={`Remove ${c.name}`} onClick={() => set({ contactIds: f.contactIds.filter(x => x !== id) })} className="h-6 w-6 grid place-items-center rounded-full hover:bg-petrol/20"><Icon name="x" size={13} /></button>
                  </span>
                ) : null;
              })}
            </div>
            {available.length > 0 && (
              <select id="act-contact" className="inp" value="" onChange={e => { if (e.target.value) set({ contactIds: [...f.contactIds, e.target.value] }); }}>
                <option value="">+ Link a contact …</option>
                {available.map((c: Contact) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` – ${c.company}` : ''}</option>)}
              </select>
            )}
          </div>
        )}

        {!init.activity && <Field label="Note (optional)"><textarea id="act-note" className="inp" value={firstNote} placeholder="e.g. Bring product samples." onChange={e => setFirstNote(e.target.value)} /></Field>}

        {err && <div className="rounded-xl bg-danger/10 text-danger px-4 py-3 text-[14px]">{err}</div>}
      </div>
      <SheetFoot>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary flex-1" onClick={submit}><Icon name="check" size={16} />Save</button>
      </SheetFoot>
    </Sheet>
  );
}

function TripForm({ trip, onClose }: { trip: Trip | null; onClose: () => void }) {
  const { saveTrip } = useStore();
  const ui = useUI();
  const td = todayStr();
  const [f, setF] = useState(() => trip ? { ...trip, countriesText: trip.countries.join(', '), citiesText: trip.cities.join(', ') }
    : { id: uid(), name: '', kind: 'business', countries: [], cities: [], start: td, end: addDays(td, 3), archived: false, countriesText: '', citiesText: '' });
  const [err, setErr] = useState('');
  const set = (p: any) => setF((x: any) => ({ ...x, ...p }));
  const split = (s: string) => s.split(/[,→>]/).map(x => x.trim()).filter(Boolean);
  const submit = () => {
    if (!f.name.trim()) { setErr('Enter a name for the trip.'); return; }
    if (!f.start || !f.end || f.end < f.start) { setErr('The end date must be on or after the start date.'); return; }
    const { countriesText, citiesText, ...rest } = f as any;
    saveTrip({ ...rest, name: f.name.trim(), countries: split(countriesText), cities: split(citiesText) });
    ui.toast(trip ? 'Trip saved' : 'Trip created');
    onClose();
    if (!trip) go(`#/trip/${f.id}`);
  };
  return (
    <Sheet onClose={onClose} label="Trip">
      <SheetHead onClose={onClose} title={trip ? 'Edit trip' : 'New trip'} />
      <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-6 space-y-5">
        <Field label="Trip name"><input id="trip-name" autoFocus className="inp" value={f.name} placeholder="e.g. China Business Trip – October 2026" onChange={e => set({ name: e.target.value })} /></Field>
        <div><span className="lbl">Trip type</span><Segmented value={f.kind} onChange={v => set({ kind: v })} options={[{ value: 'business', label: 'Business', icon: 'briefcase' }, { value: 'private', label: 'Private', icon: 'compass' }]} /></div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Start"><input id="trip-start" type="date" className="inp" value={f.start} onChange={e => set({ start: e.target.value, end: f.end < e.target.value ? e.target.value : f.end })} /></Field>
          <Field label="End"><input id="trip-end" type="date" className="inp" value={f.end} onChange={e => set({ end: e.target.value })} /></Field>
        </div>
        <Field label="Countries"><input id="trip-countries" className="inp" value={f.countriesText} placeholder="e.g. China" onChange={e => set({ countriesText: e.target.value })} /></Field>
        <Field label="Cities (in order)"><input id="trip-cities" className="inp" value={f.citiesText} placeholder="e.g. Shanghai, Xiamen, Guangzhou" onChange={e => set({ citiesText: e.target.value })} /></Field>
        {err && <div className="rounded-xl bg-danger/10 text-danger px-4 py-3 text-[14px]">{err}</div>}
      </div>
      <SheetFoot>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary flex-1" onClick={submit}><Icon name="check" size={16} />{trip ? 'Save' : 'Create trip'}</button>
      </SheetFoot>
    </Sheet>
  );
}

function ContactForm({ contact, onClose }: { contact: Contact | null; onClose: () => void }) {
  const { saveContact } = useStore();
  const ui = useUI();
  const [f, setF] = useState<Contact>(() => contact ? { ...contact } : { id: uid(), name: '', company: '', position: '', phone: '', email: '', country: '', city: '', notes: '' });
  const [err, setErr] = useState('');
  const set = (k: keyof Contact, v: string) => setF(x => ({ ...x, [k]: v }));
  const submit = () => {
    if (!f.name.trim()) { setErr('Enter a name.'); return; }
    saveContact({ ...f, name: f.name.trim() });
    ui.toast(contact ? 'Contact saved' : 'Contact created');
    onClose();
  };
  const fields: [keyof Contact, string, string, boolean][] = [
    ['name', 'Full name', 'text', true], ['company', 'Company', 'text', false], ['position', 'Position', 'text', false],
    ['phone', 'Phone', 'tel', false], ['email', 'Email', 'email', false], ['city', 'City', 'text', false], ['country', 'Country', 'text', false],
  ];
  return (
    <Sheet onClose={onClose} label="Contact">
      <SheetHead onClose={onClose} title={contact ? 'Edit contact' : 'New contact'} />
      <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-6">
        <div className="grid sm:grid-cols-2 gap-4">
          {fields.map(([k, label, type, wide]) => <Field key={k} label={label} wide={wide}><input id={`contact-${k}`} className="inp" type={type} value={f[k]} onChange={e => set(k, e.target.value)} /></Field>)}
          <Field label="Notes" wide><textarea id="contact-notes" className="inp" value={f.notes} onChange={e => set('notes', e.target.value)} /></Field>
        </div>
        {err && <div className="mt-4 rounded-xl bg-danger/10 text-danger px-4 py-3 text-[14px]">{err}</div>}
      </div>
      <SheetFoot>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary flex-1" onClick={submit}><Icon name="check" size={16} />Save</button>
      </SheetFoot>
    </Sheet>
  );
}

function ConfirmDialog({ state, onClose }: { state: any; onClose: () => void }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-5" role="alertdialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 anim-fade" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-3xl bg-card border border-line p-6 shadow-lift anim-in">
        <h3 className="font-display text-[21px] text-heading">{state.title}</h3>
        <p className="text-[14.5px] text-muted mt-2 whitespace-pre-line line-clamp-4">{state.text}</p>
        <div className="flex gap-2 mt-6">
          <button className="btn btn-ghost flex-1" onClick={onClose}>Cancel</button>
          <button className="btn flex-1 bg-danger text-white hover:opacity-90" onClick={() => { state.onOk(); onClose(); }}>{state.ok || 'OK'}</button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   SHELL
   ========================================================================= */
const NAV = [
  { key: 'trips', label: 'Trips', icon: 'globe', href: '#/trips' },
  { key: 'calendar', label: 'Calendar', icon: 'calendar', href: '#/calendar' },
  { key: 'contacts', label: 'Contacts', icon: 'users', href: '#/contacts' },
  { key: 'settings', label: 'Settings', icon: 'sliders', href: '#/settings' },
];

function useTheme() {
  const [theme, setThemeState] = useState(() => { try { return localStorage.getItem('mtp:theme:v2') || 'dark'; } catch (e) { return 'dark'; } });
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0E1412' : '#193D35');
    };
    apply(); mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  const setTheme = (t: string) => { setThemeState(t); try { localStorage.setItem('mtp:theme:v2', t); } catch (e) {} };
  return [theme, setTheme] as const;
}

export function App() {
  const route: any = useRoute();
  const [theme, setTheme] = useTheme();
  const [activityId, setActivityId] = useState<string | null>(null);
  const [actForm, setActForm] = useState<any>(null);
  const [tripForm, setTripForm] = useState<any>(undefined);
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState<any>(undefined);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<any>(null);
  const toastTimer = useRef<any>(null);

  const ui = useMemo(() => ({
    openActivity: (id: string) => setActivityId(id),
    newActivity: (tripId: string, date?: string) => setActForm({ tripId, date }),
    editActivity: (a: Activity) => setActForm({ tripId: a.tripId, activity: a }),
    editTrip: (t: Trip | null) => setTripForm(t),
    openContact: (id: string) => setContactId(id),
    editContact: (c: Contact | null) => setContactForm(c),
    confirm: (s: any) => setConfirmState(s),
    toast: (m: string) => { setToastMsg(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(null), 2600); },
  }), []);

  const active = route.page === 'trip' ? 'trips' : route.page;

  return (
    <UICtx.Provider value={ui}>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-64 bg-nav text-white flex-col z-30 border-r border-white/5">
        <a href="#/trips" className="px-6 pt-8 pb-10 block">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-white/10 grid place-items-center text-[#E8BB91]"><Icon name="compass" size={19} /></div>
            <div>
              <div className="font-display text-[17px] leading-none">My Travel Planner</div>
              <div className="text-[10.5px] uppercase tracking-[0.18em] text-white/50 mt-1.5 font-semibold">Travel organizer</div>
            </div>
          </div>
        </a>
        <nav className="px-3 space-y-1">
          {NAV.map(n => (
            <a key={n.key} href={n.href} aria-current={active === n.key ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14.5px] font-semibold transition ${active === n.key ? 'bg-white/10 text-white' : 'text-white/60 hover:text-white hover:bg-white/5'}`}>
              <Icon name={n.icon} size={18} />{n.label}
              {active === n.key && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#E8BB91]" />}
            </a>
          ))}
        </nav>
        <div className="mt-auto px-4 py-5"><SyncBadge dark /></div>
      </aside>

      {/* Mobile brand bar */}
      <div className="lg:hidden flex items-center justify-between px-4 pt-[14px] pb-1">
        <a href="#/trips" className="flex items-center gap-2 text-heading">
          <Icon name="compass" size={18} className="text-cognac" />
          <span className="font-display text-[16px]">My Travel Planner</span>
        </a>
        <SyncBadge />
      </div>

      <main className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-10 pt-5 lg:pt-12 pb-32 lg:pb-16">
          {route.page === 'trips' && <TripsPage />}
          {route.page === 'trip' && <TripPage id={route.id} tab={route.tab} />}
          {route.page === 'calendar' && <CalendarPage />}
          {route.page === 'contacts' && <ContactsPage />}
          {route.page === 'settings' && <SettingsPage theme={theme} setTheme={setTheme} />}
        </div>
      </main>

      {/* Mobile bottom navigation */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-nav text-white pb-[env(safe-area-inset-bottom,0px)] border-t border-white/5 shadow-[0_-8px_30px_rgb(0_0_0/.3)]">
        <div className="grid grid-cols-4 h-[66px]">
          {NAV.map(n => (
            <a key={n.key} href={n.href} aria-current={active === n.key ? 'page' : undefined} className={`flex flex-col items-center justify-center gap-1 text-[11px] font-semibold transition ${active === n.key ? 'text-white' : 'text-white/55'}`}>
              <span className={`grid place-items-center h-8 w-12 rounded-full transition ${active === n.key ? 'bg-white/10' : ''}`}><Icon name={n.icon} size={20} /></span>
              {n.label}
            </a>
          ))}
        </div>
      </nav>

      {activityId && <ActivityDetail id={activityId} onClose={() => setActivityId(null)} />}
      {contactId && <ContactDetail id={contactId} onClose={() => setContactId(null)} />}
      {actForm && <ActivityForm init={actForm} onClose={() => setActForm(null)} />}
      {tripForm !== undefined && <TripForm trip={tripForm} onClose={() => setTripForm(undefined)} />}
      {contactForm !== undefined && <ContactForm contact={contactForm} onClose={() => setContactForm(undefined)} />}
      {confirmState && <ConfirmDialog state={confirmState} onClose={() => setConfirmState(null)} />}
      <SyncPrompts />

      {toastMsg && (
        <div className="fixed z-[70] inset-x-0 flex justify-center px-4 pointer-events-none bottom-[calc(env(safe-area-inset-bottom,0px)+86px)] lg:bottom-8 lg:pl-64">
          <div className="anim-in rounded-full bg-nav text-white border border-white/10 px-5 py-3 text-[14px] font-semibold shadow-lift flex items-center gap-2"><Icon name="check" size={16} className="text-[#E8BB91]" />{toastMsg}</div>
        </div>
      )}
    </UICtx.Provider>
  );
}

