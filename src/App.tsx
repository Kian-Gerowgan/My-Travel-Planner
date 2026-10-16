import React, { useState, useEffect, useMemo, useRef, useCallback, createContext, useContext } from 'react';
import { useDriveSync } from './sync';
import { useFileSync } from './files';
import { renderPdf } from './pdf';
import { useUpdateCheck } from './updates';

/* =========================================================================
   TYPES
   ========================================================================= */
type ActivityType = 'flight' | 'train' | 'hotel' | 'meeting' | 'transfer' | 'personal';
interface Note { id: string; text: string; createdAt: string; }
interface Task { id: string; text: string; done: boolean; due?: string /** YYYY-MM-DD */; }
/** Price of a booking; `paidAmount` < `amount` means something is still to be paid (by `due`). */
interface Cost { amount: number; currency: string; paidAmount: number; due?: string; }
interface Activity {
  id: string; tripId: string; type: ActivityType; title: string;
  start: string; startTz: string;          // local wall time "YYYY-MM-DDTHH:mm" + IANA zone
  end?: string; endTz?: string;
  city?: string; location?: string;
  details: Record<string, string>;
  contactIds: string[]; notes: Note[]; tasks: Task[];
  status?: BookingStatus;   // confirmed (default) · pending · planned (not booked yet)
  travellers?: string[];    // subset of the trip's travellers; absent = everyone
  cost?: Cost;
}
interface Trip { id: string; name: string; kind: 'business' | 'private'; countries: string[]; cities: string[]; start: string; end: string; archived: boolean; art?: string /** built-in illustration to show instead of the first city's */; travellers?: string[]; }
interface Contact { id: string; name: string; company: string; position: string; phone: string; email: string; country: string; city: string; notes: string; }
/** A file belonging to a trip. Uploaded once; linked to any number of the trip's stages (none = general). */
interface Doc { id: string; tripId: string; name: string; mime: string; size: number; activityIds: string[]; addedAt: string; driveId?: string; cover?: boolean; }
interface Data { version: number; trips: Trip[]; activities: Activity[]; contacts: Contact[]; documents: Doc[]; sample?: boolean; deleted?: Record<string, string>; }
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
  { id: 'Asia/Ho_Chi_Minh', label: 'Vietnam (Ho Chi Minh City)', city: 'Vietnam' },
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
    { key: 'address', label: 'Address', wide: true }, { key: 'nameLocal', label: 'Hotel name in local language', ph: 'e.g. 新锦江大酒店' }, { key: 'addressLocal', label: 'Address in local language (for taxi)', ph: 'e.g. 上海市黄浦区长乐路161号', wide: true }, { key: 'phone', label: 'Phone', type: 'tel' },
    { key: 'bookingRef', label: 'Booking number' }, { key: 'room', label: 'Room', wide: true } ] },
  meeting: { title: 'Title', titlePh: 'e.g. Supplier meeting', start: 'Start', end: 'End', city: true, location: 'Location / address', fields: [
    { key: 'company', label: 'Company' }, { key: 'addressLocal', label: 'Address in local language (for taxi)', wide: true }, { key: 'contactPhone', label: 'Phone', type: 'tel' },
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
/** Brings older saved data up to the current shape. */
function migrate(d: any): Data {
  return {
    ...d,
    documents: d.documents || [],
    activities: (d.activities || []).map(({ attachments, ...a }: any) => a),
  };
}

/* Colour family per stage: transport (blue), hotel (cognac), meeting (magenta), personal (neutral). */
type Tone = 'transport' | 'hotel' | 'meeting' | 'personal';
const toneOf = (t: ActivityType): Tone => t === 'flight' || t === 'train' || t === 'transfer' ? 'transport' : t === 'hotel' ? 'hotel' : t === 'meeting' ? 'meeting' : 'personal';

const isImage = (d: { mime: string }) => d.mime.startsWith('image/');
const guessMime = (name: string) => /\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : /\.(jpe?g)$/i.test(name) ? 'image/jpeg' : /\.heic$/i.test(name) ? 'image/heic' : 'application/octet-stream';
function docName(f: File) {
  // Camera photos arrive as "image.jpg" or "IMG_1234.JPG"; give them a readable name.
  if (/^(image|img_?\d*|photo)(\.\w+)?$/i.test(f.name.replace(/\.\w+$/, '')) || /^image\.\w+$/i.test(f.name)) {
    const n = new Date();
    return `Photo ${todayStr()} ${pad(n.getHours())}-${pad(n.getMinutes())}.${(f.name.split('.').pop() || 'jpg').toLowerCase()}`;
  }
  return f.name;
}
const fileSize = (b: number) => b < 1e6 ? `${Math.max(1, Math.round(b / 1000))} KB` : `${(b / 1e6).toFixed(1)} MB`;

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
  const A = (tripId: string, type: ActivityType, title: string, start: string, startTz: string, end: string | undefined, endTz: string | undefined, extra: Partial<Activity> = {}): Activity =>
    ({ id: uid(), tripId, type, title, start, startTz, end, endTz: endTz || startTz, city: '', location: '', details: {}, contactIds: [], notes: [], tasks: [], ...extra });
  const B = 'Europe/Berlin', SH = 'Asia/Shanghai', DX = 'Asia/Dubai', BA = 'Asia/Makassar';

  const contacts: Contact[] = [
    { id: 'c1', name: 'Zhang Wei', company: 'Shanghai Huaxin Electronics Co., Ltd.', position: 'Sales Director', phone: '+86 21 5888 1234', email: 'zhang.wei@huaxin-electronics.example', country: 'China', city: 'Shanghai', notes: 'Speaks excellent English. Prefers WeChat for short-notice coordination.' },
    { id: 'c2', name: 'Chen Li', company: 'BMS Xiamen Manufacturing', position: 'Plant Manager', phone: '+86 592 6012 345', email: 'chen.li@bms-xiamen.example', country: 'China', city: 'Xiamen', notes: 'Contact for quality and capacity planning.' },
    { id: 'c3', name: 'Huang Jun', company: 'Xiamen Seaport Logistics', position: 'Key Account Manager', phone: '+86 592 5550 188', email: 'huang.jun@xsl-logistics.example', country: 'China', city: 'Xiamen', notes: '' },
    { id: 'c4', name: 'Liu Yang', company: 'Guangzhou Homeware Co.', position: 'Export Manager', phone: '+86 20 8336 7799', email: 'liu.yang@gz-homeware.example', country: 'China', city: 'Guangzhou', notes: 'We met at the Canton Fair 2024.' },
  ];

  const trips: Trip[] = [
    { id: 'cn', name: 'China Business Trip – October 2026', kind: 'business', countries: ['China'], cities: ['Shanghai', 'Xiamen', 'Guangzhou'], start: '2026-10-18', end: '2026-10-27', archived: false },
  ];

  const activities: Activity[] = [
    A('cn', 'transfer', 'Transfer to the airport', '2026-10-18T11:30', B, undefined, undefined, { city: 'Frankfurt', details: { mode: 'Taxi', provider: 'Taxi Frankfurt', from: 'Home', to: 'Frankfurt Airport, Terminal 1', phone: '+49 69 230001' } }),
    A('cn', 'flight', 'Flight Frankfurt → Shanghai', '2026-10-18T14:40', B, '2026-10-19T08:30', SH, { details: { airline: 'Lufthansa', flightNo: 'LH 728', from: 'Frankfurt (FRA)', to: 'Shanghai Pudong (PVG)', terminal: '1', gate: 'Z25', seat: '4K', bookingRef: 'LH9QX2' }, notes: [n('Do online check-in 23 h before departure.')] }),
    A('cn', 'transfer', 'Transfer to the hotel', '2026-10-19T10:00', SH, '2026-10-19T10:50', SH, { city: 'Shanghai', details: { mode: 'Private driver', provider: 'Mr. Li (arranged by Huaxin)', from: 'Pudong Airport (PVG), arrivals hall', to: 'JW Marriott Tomorrow Square', phone: '+86 139 1234 5678' }, notes: [n('Driver waits with a name sign at exit B.')] }),
    A('cn', 'hotel', 'JW Marriott Hotel Shanghai at Tomorrow Square', '2026-10-19T11:00', SH, '2026-10-20T07:15', SH, { city: 'Shanghai', details: { address: '399 Nanjing West Road, Huangpu, Shanghai', phone: '+86 21 5359 4969', bookingRef: 'MAR-77412093', room: 'Deluxe King, Executive Lounge' }, notes: [n('Early check-in confirmed.')] }),
    A('cn', 'meeting', 'Supplier meeting – Supplier A', '2026-10-19T14:30', SH, '2026-10-19T16:00', SH, { city: 'Shanghai', location: 'Huaxin Showroom, 1888 Century Avenue, Pudong', contactIds: ['c1'], details: { company: 'Shanghai Huaxin Electronics', agenda: 'Pricing for Q1 2027 shipment\nNew product samples\nDelivery times' }, tasks: [t('Request Q1 price list'), t('Reserve samples for the trade fair')], notes: [n('Discuss pricing for next shipment.'), n('Bring product samples.')] }),
    A('cn', 'personal', 'Dinner on the Bund', '2026-10-19T19:00', SH, '2026-10-19T21:00', SH, { city: 'Shanghai', location: 'Lost Heaven, 17 Yan’an East Road', details: { description: 'Table for two booked.' } }),
    A('cn', 'transfer', 'Transfer to Hongqiao Airport', '2026-10-20T07:30', SH, '2026-10-20T08:15', SH, { city: 'Shanghai', details: { mode: 'Taxi', from: 'Hotel', to: 'Hongqiao Airport (SHA), Terminal 2' } }),
    A('cn', 'flight', 'Flight Shanghai → Xiamen', '2026-10-20T09:15', SH, '2026-10-20T11:10', SH, { details: { airline: 'Xiamen Airlines', flightNo: 'MF 8506', from: 'Shanghai Hongqiao (SHA)', to: 'Xiamen Gaoqi (XMN)', terminal: '2', seat: '12A', bookingRef: 'MF3KD8' } }),
    A('cn', 'hotel', 'Conrad Xiamen', '2026-10-20T12:30', SH, '2026-10-22T08:30', SH, { city: 'Xiamen', details: { address: '398 Hubin North Road, Siming, Xiamen', phone: '+86 592 572 8888', bookingRef: 'HH-49283311', room: 'King Deluxe, sea view' } }),
    A('cn', 'meeting', 'Factory visit – BMS Xiamen', '2026-10-20T15:00', SH, '2026-10-20T17:00', SH, { city: 'Xiamen', location: 'BMS Plant 2, Xiang’an Industrial Park', contactIds: ['c2'], details: { company: 'BMS Xiamen Manufacturing', agenda: 'Production walk-through\nQuality assurance\nCapacity planning 2027' }, notes: [n('Bring safety shoes.')] }),
    A('cn', 'meeting', 'Quality audit', '2026-10-21T09:30', SH, '2026-10-21T12:00', SH, { city: 'Xiamen', location: 'BMS Plant 2, meeting room 3', contactIds: ['c2'], details: { company: 'BMS Xiamen Manufacturing' }, tasks: [t('Request audit report')] }),
    A('cn', 'meeting', 'Logistics alignment', '2026-10-21T14:00', SH, '2026-10-21T15:30', SH, { city: 'Xiamen', location: 'Xiamen Seaport Logistics, Haicang', contactIds: ['c3'], details: { company: 'Xiamen Seaport Logistics' }, notes: [n('Ask about lead times from Xiamen port.')] }),
    A('cn', 'train', 'Train Xiamen → Guangzhou', '2026-10-22T10:05', SH, '2026-10-22T13:52', SH, { details: { operator: 'China Railway', trainNo: 'G 1612', from: 'Xiamen North', to: 'Guangzhou South', seat: 'Coach 3, seat 7F (Business)', bookingRef: 'E482190563' }, notes: [n('Keep passport ready for the ticket check.')] }),
    A('cn', 'transfer', 'Transfer to the hotel', '2026-10-22T14:15', SH, '2026-10-22T15:10', SH, { city: 'Guangzhou', details: { mode: 'DiDi', from: 'Guangzhou South station', to: 'The Ritz-Carlton, Guangzhou' } }),
    A('cn', 'hotel', 'The Ritz-Carlton, Guangzhou', '2026-10-22T15:30', SH, '2026-10-26T18:00', SH, { city: 'Guangzhou', details: { address: '3 Xing An Road, Pearl River New City, Tianhe', phone: '+86 20 3813 6888', bookingRef: 'MAR-77413580', room: 'Deluxe Room, river view' }, notes: [n('Late check-out until 18:00 confirmed.')] }),
    A('cn', 'personal', 'Canton Fair – Phase 2', '2026-10-23T09:00', SH, '2026-10-23T17:00', SH, { city: 'Guangzhou', location: 'Canton Fair Complex, Pazhou', details: { description: 'Halls 11–13: homeware & gifts' } }),
    A('cn', 'meeting', 'Trade fair meeting', '2026-10-23T10:30', SH, '2026-10-23T11:30', SH, { city: 'Guangzhou', location: 'Canton Fair, booth 11.2 C18', contactIds: ['c4'], details: { company: 'Guangzhou Homeware Co.' } }),
    A('cn', 'meeting', 'Product development & samples', '2026-10-24T10:00', SH, '2026-10-24T12:00', SH, { city: 'Guangzhou', location: 'Guangzhou Homeware showroom, Haizhu', contactIds: ['c4'], details: { company: 'Guangzhou Homeware Co.', agenda: 'Sample approval\nPackaging\nFirst-order timeline' }, tasks: [t('Bring packaging draft', true)] }),
    A('cn', 'personal', 'Shamian Island & tea house', '2026-10-24T15:00', SH, '2026-10-24T18:00', SH, { city: 'Guangzhou', location: 'Shamian Island' }),
    A('cn', 'transfer', 'Transfer to the airport', '2026-10-26T20:30', SH, '2026-10-26T21:20', SH, { city: 'Guangzhou', details: { mode: 'Hotel limousine', provider: 'The Ritz-Carlton', from: 'Hotel', to: 'Baiyun Airport (CAN), Terminal 2', phone: '+86 20 3813 6888' } }),
    A('cn', 'flight', 'Flight Guangzhou → Frankfurt', '2026-10-26T23:55', SH, '2026-10-27T05:55', B, { details: { airline: 'China Southern', flightNo: 'CZ 331', from: 'Guangzhou Baiyun (CAN)', to: 'Frankfurt (FRA)', terminal: '2', seat: '14A', bookingRef: 'CZ8PL4' } }),
    A('cn', 'transfer', 'Transfer home', '2026-10-27T07:00', B, undefined, undefined, { city: 'Frankfurt', details: { mode: 'Taxi', from: 'Frankfurt Airport', to: 'Home' } }),

  ];
  return { version: 2, trips, activities, contacts, documents: [], sample: true };
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
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
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
    try { const raw = localStorage.getItem(STORE_KEY); if (raw) return migrate(JSON.parse(raw)); } catch (e) {}
    return sampleData();
  });
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {} }, [data]);

  const api = useMemo(() => {
    const upsert = (list: any[], item: any) => list.some(x => x.id === item.id) ? list.map(x => x.id === item.id ? item : x) : [...list, item];
    // Any edit turns the sample trips into the user's own data.
    // Removed items are remembered with the date, so sync can't resurrect them from an older device.
    const edit = (f: (d: Data) => Data) => setData(d => {
      const n = f(d);
      if (n === d) return d;
      const deleted = { ...(n.deleted || {}) };
      const day = todayStr();
      (['trips', 'activities', 'contacts', 'documents'] as const).forEach(k => {
        const now = new Set((n[k] as { id: string }[]).map(x => x.id));
        (d[k] as { id: string }[]).forEach(x => { if (!now.has(x.id)) deleted[x.id] = day; });
      });
      return { ...n, sample: false, deleted };
    });
    return {
      saveTrip: (t: Trip) => edit(d => ({ ...d, trips: upsert(d.trips, t) })),
      duplicateTrip: (id: string) => edit(d => {
        const t = d.trips.find(x => x.id === id); if (!t) return d;
        const nid = uid();
        const acts = d.activities.filter(a => a.tripId === id).map(a => ({ ...clone(a), id: uid(), tripId: nid }));
        return { ...d, trips: [...d.trips, { ...t, id: nid, name: t.name + ' (copy)', archived: false }], activities: [...d.activities, ...acts] };
      }),
      setArchived: (id: string, archived: boolean) => edit(d => ({ ...d, trips: d.trips.map(t => t.id === id ? { ...t, archived } : t) })),
      saveActivity: (a: Activity) => edit(d => ({ ...d, activities: upsert(d.activities, a) })),
      updateActivity: (id: string, fn: (a: Activity) => Activity) => edit(d => ({ ...d, activities: d.activities.map(a => a.id === id ? fn(a) : a) })),
      deleteActivity: (id: string) => edit(d => ({ ...d, activities: d.activities.filter(a => a.id !== id), documents: d.documents.map(x => x.activityIds.includes(id) ? { ...x, activityIds: x.activityIds.filter(y => y !== id) } : x) })),
      setDocStages: (docIds: string[], activityIds: string[]) => edit(d => ({ ...d, documents: d.documents.map(x => docIds.includes(x.id) ? { ...x, activityIds } : x) })),
      linkDocs: (docIds: string[], activityId: string) => edit(d => ({ ...d, documents: d.documents.map(x => docIds.includes(x.id) && !x.activityIds.includes(activityId) ? { ...x, activityIds: [...x.activityIds, activityId] } : x) })),
      unlinkDoc: (docId: string, activityId: string) => edit(d => ({ ...d, documents: d.documents.map(x => x.id === docId ? { ...x, activityIds: x.activityIds.filter(y => y !== activityId) } : x) })),
      setDocDriveId: (docId: string, driveId: string) => edit(d => ({ ...d, documents: d.documents.map(x => x.id === docId ? { ...x, driveId } : x) })),
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
      edit,
    };
  }, []);
  const replaceData = useCallback((d: any) => setData(migrate(d)), []);
  const sync = useDriveSync(data, replaceData);
  const files = useFileSync(data.documents, data.trips, sync, api.setDocDriveId);
  const dataRef = useRef(data);
  dataRef.current = data;

  const docApi = useMemo(() => ({
    /** Stores the files on this device and adds them to the trip; uploading to Drive happens in the background. */
    addDocuments: async (tripId: string, list: File[], activityIds: string[] = []): Promise<Doc[]> => {
      const docs: Doc[] = list.map(f => ({ id: uid(), tripId, name: docName(f), mime: f.type || guessMime(f.name), size: f.size, activityIds, addedAt: nowLocal() }));
      for (let i = 0; i < docs.length; i++) await files.saveLocal(docs[i].id, list[i]);
      api.edit(d => ({ ...d, documents: [...d.documents, ...docs] }));
      return docs;
    },
    deleteDoc: (id: string) => {
      const doc = dataRef.current.documents.find(x => x.id === id);
      if (doc) files.removeLocal(doc);
      api.edit(d => ({ ...d, documents: d.documents.filter(x => x.id !== id) }));
    },
    /** Replaces the trip's cover photo (resized before storing); null removes it. */
    setCover: async (tripId: string, file: File | null) => {
      dataRef.current.documents.filter(x => x.tripId === tripId && x.cover).forEach(files.removeLocal);
      api.edit(d => ({ ...d, documents: d.documents.filter(x => !(x.tripId === tripId && x.cover)) }));
      if (!file) return;
      const blob = await shrinkImage(file);
      const doc: Doc = { id: uid(), tripId, name: 'Cover photo.jpg', mime: blob.type || 'image/jpeg', size: blob.size, activityIds: [], addedAt: nowLocal(), cover: true };
      await files.saveLocal(doc.id, blob);
      api.edit(d => ({ ...d, documents: [...d.documents, doc] }));
    },
    deleteTrip: (id: string) => {
      dataRef.current.documents.filter(x => x.tripId === id).forEach(files.removeLocal);
      api.edit(d => ({ ...d, trips: d.trips.filter(t => t.id !== id), activities: d.activities.filter(a => a.tripId !== id), documents: d.documents.filter(x => x.tripId !== id) }));
    },
  }), [api, files.saveLocal, files.removeLocal]);

  return <StoreCtx.Provider value={{ data, sync, files, ...api, ...docApi }}>{children}</StoreCtx.Provider>;
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
      <div className="relative w-full md:w-[540px] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-12px)] md:max-h-none md:h-full bg-cream rounded-t-[28px] md:rounded-none md:rounded-l-[28px] shadow-lift flex flex-col overflow-hidden anim-sheet border-t md:border-t-0 md:border-l border-line">
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
/** Text for the event cards: a time line, a title that may wrap, and a detail line. */
function compactView(e: Entry, contacts: Contact[] = []) {
  const a = e.a, d = a.details || {};
  const icon = TYPE_META[a.type].icon;
  const withCode = (s?: string) => (s ? (code(s) !== place(s) ? `${place(s)} ${code(s)}` : place(s)) : '');
  const range = e.time + (e.endTime ? `–${e.endTime}` : '');
  const names = a.contactIds.map(id => contacts.find(c => c.id === id)?.name).filter(Boolean) as string[];
  if (e.kind === 'arrival') return { icon: 'landing', time: e.time, title: `Arrival ${withCode(d.to)}`.trim(), sub: [d.flightNo || d.trainNo, d.from ? 'from ' + place(d.from) : ''].filter(Boolean).join(' · '), badge: '' };
  if (e.kind === 'checkout') return { icon: 'logout', time: e.time, title: `Check-out · ${a.title}`, sub: d.address || '', badge: '' };
  switch (a.type) {
    case 'flight': case 'train': {
      const shift = a.end ? daysBetween(a.start.slice(0, 10), a.end.slice(0, 10)) : 0;
      const time = a.end ? `${e.time} → ${a.end.slice(11, 16)}${shift > 0 ? ` +${shift}` : ''}` : e.time;
      const dur = a.end ? durText(toUtc(a.end, a.endTz || a.startTz) - e.ms) : '';
      return { icon, time, title: d.from && d.to ? `${withCode(d.from)} → ${withCode(d.to)}` : a.title, sub: [d.airline || d.operator, dur, d.seat].filter(Boolean).join(' · '), badge: d.flightNo || d.trainNo || '' };
    }
    case 'hotel': {
      const n = a.end ? daysBetween(a.start.slice(0, 10), a.end.slice(0, 10)) : 0;
      return { icon, time: e.time, title: `Check-in · ${a.title}`, sub: d.address || '', badge: n ? plural(n, 'night', 'nights') : '' };
    }
    case 'meeting': return { icon, time: range, title: a.title, sub: [d.company && d.company !== a.title ? d.company : '', names.join(', '), a.location].filter(Boolean).join(' · '), badge: '' };
    case 'transfer': return { icon, time: range, title: a.title, sub: [d.from && d.to ? `${place(d.from)} → ${place(d.to)}` : '', d.mode].filter(Boolean).join(' · '), badge: '' };
    default: return { icon, time: range, title: a.title, sub: a.location || '', badge: '' };
  }
}

/** One event as a colour-coded card: time line, wrapping title, detail line. */
function EntryCard({ e, highlight, showTrip }: { e: Entry; highlight?: boolean; showTrip?: string }) {
  const ui = useUI();
  const { data } = useStore();
  const v = compactView(e, data.contacts);
  const a = e.a;
  const docCount = e.kind === 'main' ? data.documents.filter((x: Doc) => x.activityIds.includes(a.id) && !x.cover).length : 0;
  const sub = [showTrip, v.sub].filter(Boolean).join(' · ');
  return (
    <button onClick={() => ui.openActivity(a.id)}
      className={`tone-press w-full flex items-start gap-3 rounded-[18px] p-3 text-left tone-${toneOf(a.type)} ${highlight ? 'tone-card-strong' : 'tone-card'} ${e.kind !== 'main' && !highlight ? 'opacity-85' : ''}`}>
      <span className="tone-icon h-9 w-9 rounded-full grid place-items-center shrink-0 mt-0.5"><Icon name={v.icon} size={17} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="tone-ink text-[14px] font-semibold tabular-nums">{v.time}</span>
          {e.kind === 'main' && <StatusPill s={a.status} />}
          <TravellerDots a={a} trip={data.trips.find((t: Trip) => t.id === a.tripId)} />
          {(docCount > 0 || (a.notes.length > 0 && e.kind === 'main')) && (
            <span className="flex items-center gap-2 text-[11.5px] text-ink/55">
              {docCount > 0 && <span className="flex items-center gap-0.5" title="Documents"><Icon name="clip" size={12} />{docCount}</span>}
              {a.notes.length > 0 && e.kind === 'main' && <span className="flex items-center gap-0.5" title="Notes"><Icon name="note" size={12} />{a.notes.length}</span>}
            </span>
          )}
          {v.badge && <span className="ml-auto text-[12.5px] font-medium text-ink/85 tabular-nums shrink-0">{v.badge}</span>}
        </span>
        <span className="block text-[15px] font-medium leading-snug text-ink mt-0.5">{v.title}</span>
        {sub && <span className="block text-[12.5px] leading-snug tone-ink opacity-90 mt-0.5">{sub}</span>}
      </span>
      <Icon name="right" size={16} className="text-ink/50 shrink-0 self-center" />
    </button>
  );
}

/** A timeline row: category dot on a thin connecting line, then the event card. */
function EntryRow({ e, next, last, showTrip }: { e: Entry; next?: Entry; last?: boolean; showTrip?: string }) {
  const isNext = !!next && next.key === e.key;
  const past = e.ms < Date.now() && !isNext && (!e.endMs || e.endMs < Date.now());
  return (
    <div className={`relative flex gap-3 ${past ? 'opacity-55' : ''}`}>
      <div className="relative w-3 shrink-0 flex justify-center">
        <div className={`absolute top-0 ${last ? 'h-7' : 'bottom-0'} border-l border-dashed border-white/20`} />
        <div className={`relative ${isNext ? 'mt-[46px]' : 'mt-[25px]'} h-2.5 w-2.5 rounded-full tone-${toneOf(e.a.type)} ${isNext ? 'tone-dot-fill' : 'tone-dot'}`} />
      </div>
      <div className="flex-1 min-w-0 pb-2.5">
        {isNext && (
          <div className={`mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] tone-ink tone-${toneOf(e.a.type)}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current pulse-dot" />{nextLabel(e)}
          </div>
        )}
        <EntryCard e={e} highlight={isNext} showTrip={showTrip} />
      </div>
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

/** Several days in a row with nothing planned, e.g. a beach week: one line instead of a header per day. */
function QuietDays({ trip, acts, from, to, i }: { trip: Trip; acts: Activity[]; from: string; to: string; i: number }) {
  const ui = useUI();
  const n = daysBetween(from, to) + 1;
  const td = todayStr();
  const hotels = Array.from({ length: n }, (_, k) => hotelFor(acts, addDays(from, k)));
  const hotel = hotels[0] && hotels.every(h => h?.id === hotels[0]!.id) ? hotels[0] : undefined;
  const short = (s: string) => fmt(s, { day: 'numeric', month: 'short' });
  return (
    <section className="anim-in">
      <div className="mb-3 pb-3 border-b border-cognac/30">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-[12px] font-bold uppercase tracking-[0.16em] text-cognac">{fmt(from, { weekday: 'short' })} – {fmt(to, { weekday: 'short' })}</span>
            <span className="font-display text-[21px] leading-none text-cognac">{short(from)} – {short(to)}</span>
            {td >= from && td <= to && <span className="rounded-full bg-cognac text-[#1a120b] text-[11px] font-bold px-2 py-0.5 uppercase tracking-wider">Today</span>}
          </div>
          <span className="text-[12px] text-muted font-semibold">Days {i + 1}–{i + n}</span>
        </div>
        {hotel && (
          <button onClick={() => ui.openActivity(hotel.id)} className="mt-1.5 block text-left text-[13px] text-muted hover:text-petrol">
            <Icon name="bed" size={14} className="inline -mt-0.5 mr-1.5" />Overnight: <span className="text-ink/85">{hotel.title}</span>
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-line px-4 py-3.5 text-[14px] text-muted">
        <span>{plural(n, 'day', 'days')} without plans{hotel ? ' · free time' : ''}</span>
        <button onClick={() => ui.newActivity(trip.id, from)} className="flex items-center gap-1 text-petrol font-semibold hover:underline shrink-0"><Icon name="plus" size={15} />Add</button>
      </div>
    </section>
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

  // Runs of two or more consecutive days without plans are shown as one compact block.
  const blocks: { from: string; to: string; i: number }[] = [];
  sorted.forEach((date, i) => {
    const last = blocks[blocks.length - 1];
    if (!(byDate[date] || []).length && last && !(byDate[last.from] || []).length && addDays(last.to, 1) === date) last.to = date;
    else blocks.push({ from: date, to: date, i });
  });

  return (
    <div className="space-y-9">
      {blocks.map(({ from, to, i }) => {
        if (from !== to) return <QuietDays key={from} trip={trip} acts={acts} from={from} to={to} i={i} />;
        const date = from;
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
                    <button key={e.key} onClick={ev => { ev.stopPropagation(); ui.openActivity(e.a.id); }} className={`w-full flex items-center gap-1 truncate text-left text-[11.5px] rounded-md px-1.5 py-[3px] transition tone-${toneOf(e.a.type)} ${next && next.key === e.key ? 'tone-card-strong text-white' : 'tone-card tone-ink hover:brightness-125'}`}>
                      <span className="tabular-nums font-bold">{e.time}</span><span className="truncate">{entryView(e).title}</span>
                    </button>
                  ))}
                  {evs.length > 3 && <div className="text-[11px] text-muted px-1.5">+{evs.length - 3} more</div>}
                </div>
                <div className="md:hidden flex flex-wrap justify-center gap-[3px] mt-1">
                  {evs.slice(0, 4).map(e => <span key={e.key} className={`h-1.5 w-1.5 rounded-full tone-dot tone-${toneOf(e.a.type)}`} />)}
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
                  <button key={e.key} onClick={() => ui.openActivity(e.a.id)} className={`w-full text-left rounded-xl px-2.5 py-2 transition tone-${toneOf(e.a.type)} ${next && next.key === e.key ? 'tone-card-strong text-white' : 'tone-card hover:brightness-125'}`}>
                    <div className={`flex items-center gap-1.5 text-[11.5px] font-bold tabular-nums ${next && next.key === e.key ? '' : 'tone-ink'}`}><Icon name={entryView(e).icon} size={13} />{e.time}{e.endTime ? '–' + e.endTime : ''}</div>
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
    <div className="mb-7">
      {eyebrow && <div className="text-[10px] sm:text-[12.5px] -mt-[5px] sm:mt-0 font-bold uppercase tracking-[0.16em] text-cognac mb-[36px] sm:mb-1.5">{eyebrow}</div>}
      {/* Title and page action share one row: buttons as tall as the title line, bottom-aligned, with a thin blue rule below */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pb-[17px] border-b border-petrol/60">
        <h1 className="font-display text-[32px] sm:text-[38px] leading-[34px] sm:leading-[41px] text-heading">{title}</h1>
        {action && <div className="[&_.btn]:h-[34px] sm:[&_.btn]:h-[41px] [&_.btn]:px-3.5 [&_.btn]:text-[13.5px]">{action}</div>}
      </div>
    </div>
  );
}

/** "18 – 27 OCT 2026" */
function rangeCaps(a: string, b: string) {
  const mon = (s: string) => fmt(s, { month: 'short' }).toUpperCase();
  if (a.slice(0, 7) === b.slice(0, 7)) return `${+a.slice(8)} – ${+b.slice(8)} ${mon(a)} ${a.slice(0, 4)}`;
  if (a.slice(0, 4) === b.slice(0, 4)) return `${+a.slice(8)} ${mon(a)} – ${+b.slice(8)} ${mon(b)} ${a.slice(0, 4)}`;
  return `${+a.slice(8)} ${mon(a)} ${a.slice(0, 4)} – ${+b.slice(8)} ${mon(b)} ${b.slice(0, 4)}`;
}

/** Destination tile in place of a photo: city code over a dusk gradient tinted by trip type. */
const coverUrls: Record<string, string> = {};
/** Object URL of a trip's cover photo, from this device or Google Drive ('' when none or unavailable). */
function useCoverUrl(tripId: string) {
  const { data, files } = useStore();
  const doc: Doc | undefined = data.documents.find((d: Doc) => d.tripId === tripId && d.cover);
  const [url, setUrl] = useState(doc ? coverUrls[doc.id] || '' : '');
  useEffect(() => {
    if (!doc) { setUrl(''); return; }
    if (coverUrls[doc.id]) { setUrl(coverUrls[doc.id]); return; }
    let alive = true;
    files.getBlob(doc).then((b: Blob) => { coverUrls[doc.id] = URL.createObjectURL(b); if (alive) setUrl(coverUrls[doc.id]); }).catch(() => {});
    return () => { alive = false; };
  }, [doc?.id, doc?.driveId, files.localIds]);
  return url;
}

/** Scales a photo down to at most 1400 px and re-encodes it as JPEG, so covers stay small. */
async function shrinkImage(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.82));
    return out || file;
  } catch { return file; }
}

/** Illustrated Shanghai skyline at dusk across the Huangpu: Oriental Pearl Tower, Jin Mao, Shanghai Tower, SWFC. */
function ShanghaiArt() {
  const id = React.useId().replace(/:/g, '');
  const u = (n: string) => `url(#${id}${n})`;
  // Lit windows: deterministic scatter over the tower faces
  const lights = Array.from({ length: 70 }, (_, i) => {
    const towers = [[100, 112, 70, 150], [131, 147, 60, 150], [158, 174, 52, 150], [2, 48, 128, 150], [78, 100, 126, 150], [178, 198, 124, 150]];
    const [x0, x1, y0, y1] = towers[i % towers.length];
    const r = (k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
    return { x: x0 + r(1) * (x1 - x0), y: y0 + r(2) * (y1 - y0), o: 0.35 + r(3) * 0.55 };
  });
  const front = (
    <>
      {/* Oriental Pearl Tower */}
      <polygon points="51,152 58.5,117 61,117 55.5,152" />
      <polygon points="73,152 65.5,117 63,117 68.5,152" />
      <rect x="60.6" y="58" width="2.8" height="94" />
      <rect x="61.4" y="20" width="1.2" height="34" />
      {/* Jin Mao */}
      <polygon points="103,152 103,72 105,72 105,63 107,63 107,55 109,55 109,47 110.6,47 110.6,33 111.4,26 112.4,33 112.4,47 114,47 114,55 116,55 116,63 118,63 118,72 120,72 120,152" />
      {/* Shanghai Tower */}
      <path d="M129 152 C129.5 110 132 70 136.2 30 L138.4 20 L141 27 C145.5 68 149 110 150 152 Z" />
      {/* Shanghai World Financial Center */}
      <polygon points="156,152 160.5,40 168,35.5 172.5,40 177,152" />
      {/* Lower blocks along the Bund side */}
      <rect x="0" y="134" width="20" height="18" /><rect x="20" y="139" width="15" height="13" /><rect x="35" y="130" width="13" height="22" />
      <rect x="76" y="127" width="13" height="25" /><rect x="89" y="133" width="12" height="19" /><rect x="121" y="124" width="7" height="28" />
      <rect x="151" y="129" width="6" height="23" /><rect x="178" y="122" width="22" height="30" />
    </>
  );
  return (
    <svg viewBox="38 14 152 152" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b2550" /><stop offset=".40" stopColor="#5c467a" /><stop offset=".62" stopColor="#c9705f" /><stop offset=".76" stopColor="#f6b670" />
        </linearGradient>
        <radialGradient id={`${id}sun`} cx=".66" cy=".74" r=".42">
          <stop offset="0" stopColor="#ffe0a8" stopOpacity=".95" /><stop offset=".35" stopColor="#ffc078" stopOpacity=".35" /><stop offset="1" stopColor="#ffc078" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}water`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6a4a62" /><stop offset=".35" stopColor="#2c2848" /><stop offset="1" stopColor="#0b1120" />
        </linearGradient>
        <radialGradient id={`${id}pearl`} cx=".35" cy=".3" r=".8">
          <stop offset="0" stopColor="#ff9fbd" /><stop offset=".6" stopColor="#c0477a" /><stop offset="1" stopColor="#5a1e46" />
        </radialGradient>
        <clipPath id={`${id}below`}><rect x="0" y="152" width="200" height="48" /></clipPath>
      </defs>
      <rect width="200" height="200" fill={u('sky')} />
      <rect width="200" height="200" fill={u('sun')} />
      {/* Distant skyline */}
      <g fill="#3d3a62" opacity=".85">
        <rect x="0" y="122" width="12" height="30" /><rect x="12" y="114" width="10" height="38" /><rect x="24" y="126" width="8" height="26" /><rect x="34" y="108" width="12" height="44" />
        <rect x="46" y="118" width="9" height="34" /><rect x="86" y="110" width="10" height="42" /><rect x="96" y="100" width="7" height="52" /><rect x="122" y="112" width="8" height="40" />
        <rect x="150" y="116" width="7" height="36" /><rect x="176" y="104" width="10" height="48" /><rect x="186" y="116" width="14" height="36" />
      </g>
      {/* Main skyline and its reflection in the Huangpu */}
      <g fill="#121830">{front}</g>
      <rect y="152" width="200" height="48" fill={u('water')} />
      <g fill="#0d1226" opacity=".7" clipPath={u('below')} transform="translate(0 304) scale(1 -1)">{front}</g>
      <g fill="#ff8fb4" opacity=".22"><ellipse cx="62" cy="189" rx="9" ry="3" /><ellipse cx="62" cy="228" rx="6" ry="2" /></g>
      <g fill="#ffcf8f">
        {[156, 161, 166, 171, 177, 184, 191].map((y, i) => <rect key={y} x={124 - i * 2} y={y} width={18 + i * 4} height=".9" opacity={0.55 - i * 0.06} />)}
      </g>
      <rect y="151.6" width="200" height=".8" fill="#ffd9a0" opacity=".35" />
      {/* Pearl Tower spheres, SWFC opening and city lights */}
      <circle cx="62" cy="115" r="10.5" fill={u('pearl')} />
      <circle cx="62" cy="76" r="7.5" fill={u('pearl')} />
      <circle cx="62" cy="54" r="3" fill={u('pearl')} />
      <polygon points="162.4,44.5 170.2,42.5 170.2,49 162.4,51" fill="#e9926a" />
      <g fill="#ffd79a">{lights.map((l, i) => <rect key={i} x={l.x} y={l.y} width="1.1" height="1.4" opacity={l.o} />)}</g>
    </svg>
  );
}

/** Illustrated Guangzhou at blue hour across the Pearl River: the glowing Canton Tower, IFC and CTF Finance Centre. */
function GuangzhouArt() {
  const id = React.useId().replace(/:/g, '');
  const u = (n: string) => `url(#${id}${n})`;
  const lights = Array.from({ length: 64 }, (_, i) => {
    const towers = [[113, 123, 46, 150], [136, 154, 50, 150], [160, 176, 92, 150], [86, 100, 104, 150], [2, 30, 120, 150], [178, 198, 112, 150]];
    const [x0, x1, y0, y1] = towers[i % towers.length];
    const r = (k: number) => ((Math.sin(i * 7.31 + k * 51.7) * 24634.6345) % 1 + 1) % 1;
    return { x: x0 + r(1) * (x1 - x0), y: y0 + r(2) * (y1 - y0), o: 0.35 + r(3) * 0.55 };
  });
  const city = (
    <>
      {/* Guangzhou IFC (West Tower) */}
      <polygon points="113,152 113.5,44 118,32 122.5,44 123,152" />
      {/* CTF Finance Centre (East Tower) */}
      <polygon points="136,152 136,52 138,52 138,42 140,42 140,34 150,34 150,42 152,42 152,52 154,52 154,152" />
      <rect x="144.5" y="22" width="1.2" height="12" />
      {/* Surrounding blocks of Zhujiang New Town */}
      <rect x="86" y="102" width="14" height="50" /><rect x="100" y="118" width="11" height="34" /><rect x="125" y="96" width="9" height="56" />
      <rect x="160" y="90" width="16" height="62" /><rect x="176" y="110" width="22" height="42" /><rect x="0" y="118" width="30" height="34" /><rect x="30" y="130" width="14" height="22" />
    </>
  );
  return (
    <svg viewBox="22 10 156 156" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0f1a3e" /><stop offset=".45" stopColor="#2b3a78" /><stop offset=".68" stopColor="#6a5aa0" /><stop offset=".78" stopColor="#e39a7a" />
        </linearGradient>
        <linearGradient id={`${id}water`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b3c6e" /><stop offset=".4" stopColor="#1b2248" /><stop offset="1" stopColor="#0a0f22" />
        </linearGradient>
        <linearGradient id={`${id}tower`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff8fd0" /><stop offset=".45" stopColor="#c45cff" /><stop offset="1" stopColor="#3fa9ff" />
        </linearGradient>
        <radialGradient id={`${id}glow`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#d77bff" stopOpacity=".55" /><stop offset="1" stopColor="#d77bff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}below`}><rect x="0" y="152" width="200" height="48" /></clipPath>
      </defs>
      <rect width="200" height="200" fill={u('sky')} />
      <g fill="#33356a" opacity=".85">
        <rect x="40" y="112" width="10" height="40" /><rect x="74" y="108" width="12" height="44" /><rect x="128" y="104" width="8" height="48" /><rect x="156" y="100" width="6" height="52" /><rect x="186" y="98" width="14" height="54" />
      </g>
      <g fill="#10142c">{city}</g>
      {/* Canton Tower: twisted hourglass lattice with antenna */}
      <ellipse cx="62" cy="80" rx="22" ry="52" fill={u('glow')} />
      <path d="M50 152 C55 122 58 98 59.6 80 C58.6 66 57.2 54 56.6 44 L67.4 44 C66.8 54 65.4 66 64.4 80 C66 98 69 122 74 152 Z" fill={u('tower')} />
      <g stroke="#2a1640" strokeWidth=".55" opacity=".55">
        {Array.from({ length: 12 }, (_, i) => <line key={i} x1={50 + i * 2} y1="152" x2={56.6 + i} y2="44" />)}
        {[60, 76, 92, 108, 124, 140].map(y => <line key={y} x1="40" y1={y} x2="84" y2={y} />)}
      </g>
      <rect x="56" y="41.5" width="12" height="3" rx="1" fill="#ffb3e3" />
      <rect x="61.4" y="10" width="1.2" height="32" fill="#ffb3e3" />
      <circle cx="62" cy="10" r="1.3" fill="#ff5f8a" />
      {/* Pearl River with reflections */}
      <rect y="152" width="200" height="48" fill={u('water')} />
      <g fill="#10142c" opacity=".65" clipPath={u('below')} transform="translate(0 304) scale(1 -1)">{city}</g>
      <path d="M50 152 C55 182 58 206 59.6 224 L64.4 224 C66 206 69 182 74 152 Z" fill={u('tower')} opacity=".28" clipPath={u('below')} />
      <g fill="#ffd2f0">{[158, 164, 171, 179, 188].map((y, i) => <rect key={y} x={56 - i * 2} y={y} width={12 + i * 4} height=".8" opacity={0.45 - i * 0.07} />)}</g>
      <rect y="151.6" width="200" height=".8" fill="#9fc6ff" opacity=".35" />
      <g fill="#ffe1a8">{lights.map((l, i) => <rect key={i} x={l.x} y={l.y} width="1.1" height="1.4" opacity={l.o} />)}</g>
    </svg>
  );
}

/** Illustrated Dubai at sunset across Burj Lake: the Burj Khalifa with Downtown towers and the fountain. */
function DubaiArt() {
  const id = React.useId().replace(/:/g, '');
  const u = (n: string) => `url(#${id}${n})`;
  const lights = Array.from({ length: 60 }, (_, i) => {
    const towers = [[58, 72, 78, 150], [122, 132, 66, 150], [136, 146, 76, 150], [30, 46, 112, 150], [150, 172, 108, 150], [74, 82, 120, 150]];
    const [x0, x1, y0, y1] = towers[i % towers.length];
    const r = (k: number) => ((Math.sin(i * 9.17 + k * 63.1) * 31871.27) % 1 + 1) % 1;
    return { x: x0 + r(1) * (x1 - x0), y: y0 + r(2) * (y1 - y0), o: 0.35 + r(3) * 0.55 };
  });
  const city = (
    <>
      {/* The Address Downtown: tall slab with a sloped crown */}
      <polygon points="58,152 58,84 66,74 72,80 72,152" />
      {/* Emirates Towers: twin triangular tops */}
      <polygon points="122,152 122,74 127,62 132,74 132,152" />
      <polygon points="136,152 136,84 141,74 146,84 146,152" />
      {/* Downtown blocks */}
      <rect x="30" y="110" width="16" height="42" /><rect x="46" y="122" width="12" height="30" /><rect x="74" y="118" width="8" height="34" />
      <rect x="112" y="116" width="10" height="36" /><rect x="150" y="106" width="22" height="46" /><rect x="172" y="120" width="28" height="32" /><rect x="0" y="124" width="30" height="28" />
    </>
  );
  // Burj Khalifa: spiralling setbacks, a little different on each side
  const burj = 'M84 152 V128 H86 V110 H88 V93 H89.6 V77 H91 V63 H92.4 V51 H93.6 V41 H94.6 V31 L95.5 30 L95.8 11 L96.2 11 L96.5 29 L97.4 33 V44 H98.6 V55 H99.8 V68 H101.2 V84 H102.8 V101 H104.6 V119 H106.4 V152 Z';
  return (
    <svg viewBox="22 8 156 156" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a1f4a" /><stop offset=".38" stopColor="#4b3f7a" /><stop offset=".6" stopColor="#c76a5a" /><stop offset=".78" stopColor="#f7b267" />
        </linearGradient>
        <radialGradient id={`${id}sun`} cx=".28" cy=".76" r=".45">
          <stop offset="0" stopColor="#ffe3a6" stopOpacity=".95" /><stop offset=".3" stopColor="#ffbe6e" stopOpacity=".4" /><stop offset="1" stopColor="#ffbe6e" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}burj`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#3d4a74" /><stop offset=".45" stopColor="#c9d4ec" /><stop offset=".55" stopColor="#8e9cc4" /><stop offset="1" stopColor="#2b3560" />
        </linearGradient>
        <linearGradient id={`${id}water`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b4a66" /><stop offset=".4" stopColor="#2a2848" /><stop offset="1" stopColor="#0b1020" />
        </linearGradient>
        <linearGradient id={`${id}jet`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".85" /><stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}below`}><rect x="0" y="152" width="200" height="48" /></clipPath>
      </defs>
      <rect width="200" height="200" fill={u('sky')} />
      <rect width="200" height="200" fill={u('sun')} />
      <circle cx="58" cy="140" r="7" fill="#ffd38a" opacity=".85" />
      {/* Distant skyline in the haze */}
      <g fill="#4a3c6a" opacity=".8">
        <rect x="20" y="116" width="10" height="36" /><rect x="48" y="104" width="8" height="48" /><rect x="108" y="100" width="8" height="52" /><rect x="150" y="96" width="9" height="56" /><rect x="164" y="104" width="12" height="48" /><rect x="180" y="110" width="12" height="42" />
      </g>
      <g fill="#141832">{city}</g>
      {/* Burj Khalifa catching the last light */}
      <path d={burj} fill={u('burj')} />
      <path d="M95.6 40 V150" stroke="#f3e2c4" strokeWidth=".5" opacity=".6" />
      <circle cx="96" cy="11" r="1.1" fill="#ff6b6b" />
      {/* Burj Lake with reflections and the fountain */}
      <rect y="152" width="200" height="48" fill={u('water')} />
      <g fill="#10142c" opacity=".65" clipPath={u('below')} transform="translate(0 304) scale(1 -1)">{city}</g>
      <path d={burj} fill={u('burj')} opacity=".25" clipPath={u('below')} transform="translate(0 304) scale(1 -1)" />
      <g fill="#ffcf8f">{[157, 163, 170, 178, 187].map((y, i) => <rect key={y} x={50 - i * 2} y={y} width={16 + i * 4} height=".8" opacity={0.5 - i * 0.08} />)}</g>
      <g fill={u('jet')}>
        {[[70, 18], [76, 24], [82, 16], [110, 20], [116, 26], [122, 17], [128, 22]].map(([x, h]) => <rect key={x} x={x} y={152 - h} width="1.4" height={h} rx=".7" />)}
      </g>
      <rect y="151.6" width="200" height=".8" fill="#ffd9a0" opacity=".4" />
      <g fill="#ffd79a">{lights.map((l, i) => <rect key={i} x={l.x} y={l.y} width="1.1" height="1.4" opacity={l.o} />)}</g>
    </svg>
  );
}

/** Illustrated Singapore at night across Marina Bay: Marina Bay Sands, the ArtScience Museum and the Supertrees. */
function SingaporeArt() {
  const id = React.useId().replace(/:/g, '');
  const u = (n: string) => `url(#${id}${n})`;
  const lights = Array.from({ length: 72 }, (_, i) => {
    const towers = [[104, 112, 72, 150], [118, 126, 72, 150], [132, 140, 72, 150], [24, 40, 88, 150], [42, 54, 70, 150], [58, 70, 96, 150]];
    const [x0, x1, y0, y1] = towers[i % towers.length];
    const r = (k: number) => ((Math.sin(i * 5.73 + k * 41.9) * 19341.83) % 1 + 1) % 1;
    return { x: x0 + r(1) * (x1 - x0), y: y0 + r(2) * (y1 - y0), o: 0.4 + r(3) * 0.55 };
  });
  const city = (
    <>
      {/* Marina Bay Sands: three towers with flared legs under the SkyPark */}
      <polygon points="101,152 104,70 114,70 114,152" />
      <polygon points="116,152 118,70 128,70 129,152" />
      <polygon points="131,152 132,70 142,70 145,152" />
      <path d="M98 65 H151 C155 65 157 67 157 70 H98 Z" />
      {/* CBD towers behind the bay */}
      <rect x="24" y="86" width="16" height="66" /><polygon points="42,152 42,68 48,60 54,68 54,152" /><rect x="58" y="94" width="12" height="58" />
      <rect x="0" y="108" width="24" height="44" /><rect x="70" y="112" width="10" height="40" />
      {/* ArtScience Museum: the lotus on the water */}
      <path d="M80 152 L76 138 L82 146 L83 134 L86 145 L89 132 L91 145 L95 135 L94 147 L99 139 L96 152 Z" />
    </>
  );
  const trees = [[160, 122, 9], [170, 116, 11], [181, 126, 8], [190, 120, 10]];
  return (
    <svg viewBox="40 10 156 156" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0c1838" /><stop offset=".45" stopColor="#1f3b6e" /><stop offset=".66" stopColor="#3d6f8f" /><stop offset=".8" stopColor="#d48ba0" />
        </linearGradient>
        <linearGradient id={`${id}water`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f4f72" /><stop offset=".4" stopColor="#152a46" /><stop offset="1" stopColor="#081120" />
        </linearGradient>
        <linearGradient id={`${id}tree`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff7ad9" /><stop offset="1" stopColor="#7a5cff" />
        </linearGradient>
        <radialGradient id={`${id}glow`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ffd7a0" stopOpacity=".45" /><stop offset="1" stopColor="#ffd7a0" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}below`}><rect x="0" y="152" width="200" height="48" /></clipPath>
      </defs>
      <rect width="200" height="200" fill={u('sky')} />
      <circle cx="74" cy="36" r="5" fill="#f4ecd6" opacity=".9" />
      <g fill="#2b4670" opacity=".85">
        <rect x="16" y="100" width="10" height="52" /><rect x="36" y="78" width="8" height="74" /><rect x="64" y="86" width="8" height="66" /><rect x="88" y="104" width="10" height="48" /><rect x="144" y="108" width="12" height="44" />
      </g>
      <ellipse cx="127" cy="80" rx="34" ry="28" fill={u('glow')} />
      <g fill="#0f1830">{city}</g>
      {/* SkyPark edge lights */}
      <rect x="98" y="69.2" width="58" height=".8" fill="#ffd79a" opacity=".85" />
      {/* Supertrees at Gardens by the Bay */}
      {trees.map(([x, top, w]) => (
        <g key={x}>
          <polygon points={`${x - 1.4},152 ${x + 1.4},152 ${x + 0.7},${top + 6} ${x - 0.7},${top + 6}`} fill="#4a3478" />
          <path d={`M${x - w / 2} ${top} Q${x} ${top - 2.5} ${x + w / 2} ${top} L${x + 1} ${top + 7} L${x - 1} ${top + 7} Z`} fill={u('tree')} />
          {[-0.3, 0, 0.3].map(k => <circle key={k} cx={x + k * w} cy={top - 0.2 + Math.abs(k) * 1.2} r=".5" fill="#ffe6ff" />)}
        </g>
      ))}
      {/* Marina Bay with reflections */}
      <rect y="152" width="200" height="48" fill={u('water')} />
      <g fill="#0f1830" opacity=".6" clipPath={u('below')} transform="translate(0 304) scale(1 -1)">{city}</g>
      <g fill="#ffd79a">{[158, 165, 173, 182].map((y, i) => <rect key={y} x={114 - i * 3} y={y} width={26 + i * 6} height=".8" opacity={0.45 - i * 0.08} />)}</g>
      <g fill="#ff9ae0">{[160, 168].map((y, i) => <rect key={y} x={164 - i * 2} y={y} width={22 + i * 4} height=".7" opacity={0.35 - i * 0.1} />)}</g>
      <rect y="151.6" width="200" height=".8" fill="#9fd0ff" opacity=".35" />
      <g fill="#ffe1a8">{lights.map((l, i) => <rect key={i} x={l.x} y={l.y} width="1.1" height="1.4" opacity={l.o} />)}</g>
    </svg>
  );
}

/** Illustrated Bali at sunset: Tanah Lot sea temple on its rock, framed by palms. */
function BaliArt() {
  const id = React.useId().replace(/:/g, '');
  const u = (n: string) => `url(#${id}${n})`;
  // Meru tower: stacked thatched roofs, narrowing towards the top
  const roofs = [24, 20, 16.5, 13, 10, 7].map((w, i) => ({ w, y: 104 - i * 6.2 }));
  const palm = (x: number, y: number, s: number, lean: number) => (
    <g>
      <path d={`M${x} 170 C${x + lean * 0.3} ${150} ${x + lean * 0.8} ${y + 30} ${x + lean} ${y}`} stroke="#140d1c" strokeWidth={2.2 * s} fill="none" strokeLinecap="round" />
      {[[-16, 6], [-11, -4], [-2, -9], [8, -6], [15, 4], [6, 10], [-8, 11]].map(([dx, dy], i) => (
        <path key={i} d={`M${x + lean} ${y} Q${x + lean + dx * 0.6 * s} ${y + dy * 0.4 * s - 5 * s} ${x + lean + dx * s} ${y + dy * s + 4 * s}`} stroke="#140d1c" strokeWidth={1.5 * s} fill="none" strokeLinecap="round" />
      ))}
    </g>
  );
  return (
    <svg viewBox="22 10 156 156" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a1f55" /><stop offset=".35" stopColor="#8a3f74" /><stop offset=".58" stopColor="#e2685a" /><stop offset=".72" stopColor="#ffb25e" />
        </linearGradient>
        <radialGradient id={`${id}sun`} cx=".68" cy=".66" r=".4">
          <stop offset="0" stopColor="#ffe9b0" stopOpacity="1" /><stop offset=".25" stopColor="#ffc56e" stopOpacity=".55" /><stop offset="1" stopColor="#ffc56e" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}sea`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c86a5e" /><stop offset=".35" stopColor="#5a2e5a" /><stop offset="1" stopColor="#140f26" />
        </linearGradient>
      </defs>
      <rect width="200" height="200" fill={u('sky')} />
      <rect width="200" height="200" fill={u('sun')} />
      <circle cx="136" cy="124" r="9" fill="#ffe3a0" />
      {/* Distant volcano on the horizon */}
      <path d="M150 132 L170 112 L174 110 L178 112 L200 128 V132 Z" fill="#7a3a64" opacity=".6" />
      {/* Sea with the sun's path */}
      <rect y="132" width="200" height="68" fill={u('sea')} />
      <g fill="#ffd89a">{[136, 141, 147, 154, 162].map((y, i) => <rect key={y} x={130 - i * 3} y={y} width={12 + i * 6} height=".9" opacity={0.75 - i * 0.12} />)}</g>
      <g stroke="#ffc9a0" strokeWidth=".6" opacity=".35">{[[40, 150, 22], [64, 158, 18], [150, 156, 20], [30, 164, 16]].map(([x, y, w]) => <line key={x} x1={x} y1={y} x2={x + w} y2={y} />)}</g>
      {/* Tanah Lot: the rock, its trees and the meru temple */}
      <g fill="#1a1022">
        <path d="M64 150 C66 140 70 132 74 124 C77 118 82 114 90 112 L112 111 C118 112 122 116 124 122 C128 130 131 140 134 150 Z" />
        <circle cx="76" cy="118" r="6" /><circle cx="82" cy="112" r="6.5" /><circle cx="120" cy="114" r="5.5" /><circle cx="114" cy="109" r="4.5" />
        <rect x="97.4" y="68" width="1.2" height="44" />
        {roofs.map(({ w, y }) => <path key={y} d={`M${98 - w / 2} ${y} L${98 - w / 2 + 3} ${y - 4.2} H${98 + w / 2 - 3} L${98 + w / 2} ${y} Z`} />)}
        <rect x="93" y="104" width="10" height="7" />
        <path d="M97 70 L98 63 L99 70 Z" />
      </g>
      <path d="M64 150 C66 140 70 132 74 124" stroke="#ff9b6a" strokeWidth=".6" fill="none" opacity=".4" />
      {/* Surf around the rock */}
      <path d="M58 151 C70 148 84 152 98 150 C112 148 126 152 140 150" stroke="#ffe0c0" strokeWidth=".9" fill="none" opacity=".55" />
      {/* Palms framing the scene */}
      {palm(30, 54, 1.25, 14)}
      {palm(48, 82, .9, 6)}
      {palm(176, 70, 1.05, -10)}
    </svg>
  );
}

/** Built-in illustrations for destinations, used when a trip has no cover photo. */
const CITY_ART: Record<string, () => JSX.Element> = { shanghai: ShanghaiArt, guangzhou: GuangzhouArt, dubai: DubaiArt, singapore: SingaporeArt, bali: BaliArt };

/** Rendered destination pictures (public/covers, made with tools/cover-renderer.html); preferred over the illustrations. */
const CITY_PHOTO: Record<string, string> = { shanghai: 'covers/shanghai.jpg', dubai: 'covers/dubai.jpg', bali: 'covers/bali.jpg' };

function DestinationTile({ trip }: { trip: Trip }) {
  const cover = useCoverUrl(trip.id);
  const key = (trip.art || trip.cities[0] || '').trim().toLowerCase();
  const photo = cover || (CITY_PHOTO[key] ? import.meta.env.BASE_URL + CITY_PHOTO[key] : '');
  if (photo) return <img src={photo} alt="" className="h-[92px] w-[92px] sm:h-[104px] sm:w-[104px] shrink-0 rounded-2xl object-cover border border-white/10" />;
  const Art = CITY_ART[key];
  if (Art) return <div className="relative h-[92px] w-[92px] sm:h-[104px] sm:w-[104px] shrink-0 overflow-hidden rounded-2xl border border-white/10"><Art /></div>;
  const city = trip.cities[0] || trip.countries[0] || trip.name;
  const tint = trip.kind === 'private' ? '217 154 96' : '50 159 255';
  return (
    <div className="relative h-[92px] w-[92px] sm:h-[104px] sm:w-[104px] shrink-0 overflow-hidden rounded-2xl border border-white/10"
      style={{ background: `radial-gradient(120% 90% at 80% 10%, rgb(${tint} / .55), transparent 60%), linear-gradient(165deg, #1b3340 0%, #13242a 45%, #0b1513 100%)` }}>
      <svg viewBox="0 0 100 40" className="absolute bottom-0 left-0 w-full opacity-60" aria-hidden="true" preserveAspectRatio="none">
        <path d="M0 40 V30 h6 v-8 h4 v8 h5 V18 h3 v-6 h2 v6 h3 v12 h6 V24 h5 v6 h4 V14 h2 V6 h2 v8 h2 v16 h6 v-9 h5 v9 h4 V20 h4 v10 h6 v-6 h5 v6 h5 V26 h4 v4 h3 V40 Z" fill="#06100e" />
      </svg>
      <div className="absolute left-2.5 top-2 text-[19px] font-bold tracking-[0.06em] text-white/90">{city.slice(0, 3).toUpperCase()}</div>
      <div className="absolute left-2.5 top-[30px] text-[10.5px] font-semibold uppercase tracking-[0.12em] text-white/55 truncate max-w-[80px]">{trip.countries[0] || ''}</div>
    </div>
  );
}

function TripCard({ trip, count, idx }: { trip: Trip; count: number; idx: number }) {
  const ui = useUI();
  const { data, duplicateTrip, setArchived, deleteTrip } = useStore();
  const days = daysBetween(trip.start, trip.end) + 1;
  const open = () => go(`#/trip/${trip.id}`);
  const status = tripStatus(trip);
  return (
    <article onClick={open} role="link" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') open(); }} className="tone-press anim-in min-w-0 overflow-hidden cursor-pointer rounded-[24px] bg-card/90 border border-line p-3.5 sm:p-4 transition hover:border-white/15" style={{ animationDelay: `${idx * 50}ms` }}>
      <div className="flex gap-4">
        <button onClick={open} aria-label={`Open ${trip.name}`}><DestinationTile trip={trip} /></button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <button onClick={open} className="text-left min-w-0 pt-1">
              <div className="text-[12px] font-bold tracking-[0.14em] text-cognac tabular-nums">{rangeCaps(trip.start, trip.end)}</div>
              <h3 className="text-[19px] sm:text-[21px] font-medium leading-tight tracking-[-0.01em] text-heading mt-1">{trip.name}</h3>
            </button>
            <div className="-mr-1 -mt-0.5 shrink-0">
              <Menu items={[
                { label: 'Edit', icon: 'pencil', onClick: () => ui.editTrip(trip) },
                { label: 'Cover photo', icon: 'image', onClick: () => ui.editTrip(trip) },
                { label: 'Duplicate', icon: 'copy', onClick: () => { duplicateTrip(trip.id); ui.toast('Trip duplicated'); } },
                { label: trip.archived ? 'Restore from archive' : 'Archive', icon: 'archive', onClick: () => { setArchived(trip.id, !trip.archived); ui.toast(trip.archived ? 'Trip restored' : 'Trip archived'); } },
                { label: 'Delete', icon: 'trash', danger: true, onClick: () => ui.confirm({ title: 'Delete trip?', text: `“${trip.name}” and all ${plural(count, 'activity', 'activities')} will be permanently deleted.`, ok: 'Delete', onOk: () => { deleteTrip(trip.id); ui.toast('Trip deleted'); } }) },
              ]} />
            </div>
          </div>
          <button onClick={open} className="block text-left w-full">
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[14px] text-muted">
              {trip.cities.map((c, i) => <React.Fragment key={c + i}>{i > 0 && <Icon name="arrow" size={12} className="opacity-60" />}<span>{c}</span></React.Fragment>)}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
              <span className="flex items-center gap-1.5"><Icon name="globe" size={14} />{trip.countries.join(', ')}</span>
              <span className="flex items-center gap-1.5"><Icon name="calendar" size={14} />{plural(days, 'day', 'days')}</span>
              <span className="flex items-center gap-1.5"><Icon name="list" size={14} />{plural(count, 'activity', 'activities')}</span>
              {status === 'ongoing' && <span className="flex items-center gap-1.5 text-cognac font-semibold"><span className="h-1.5 w-1.5 rounded-full bg-cognac pulse-dot" />Ongoing</span>}
              {trip.archived && <span className="font-semibold">Archived</span>}
            </div>
          </button>
        </div>
      </div>
    </article>
  );
}

/** The next upcoming event, as a large card in its category colour. */
function NextUp() {
  const { data } = useStore();
  const ui = useUI();
  const live = data.trips.filter((t: Trip) => !t.archived && tripStatus(t) !== 'completed').map((t: Trip) => t.id);
  const entries = buildEntries(data.activities.filter((a: Activity) => live.includes(a.tripId)));
  const e = findNext(entries);
  if (!e) return null;
  const v = compactView(e);
  const trip = data.trips.find((t: Trip) => t.id === e.a.tripId);
  const tone = toneOf(e.a.type);
  const where = [e.a.city || (e.a.type === 'flight' || e.a.type === 'train' ? place(e.a.details.from) : ''), trip?.countries[0]].filter(Boolean).join(' · ');
  const when = e.ms <= Date.now() ? 'Happening now' : relText(e) === 'tomorrow' ? 'Tomorrow' : relText(e).replace(/^in /, 'In ');
  return (
    <button onClick={() => ui.openActivity(e.a.id)} className={`tone-press anim-in relative w-full overflow-hidden text-left rounded-[26px] p-5 tone-${tone} tone-card tone-hero`}>
      <Icon name={TYPE_META[e.a.type].icon} size={150} stroke={1} className="absolute -right-6 -top-5 opacity-[0.10] text-white pointer-events-none" />
      <div className="relative text-[12px] font-bold uppercase tracking-[0.24em] tone-ink">{when}</div>
      <div className="relative mt-2.5 flex items-center gap-4">
        <span className="tone-icon h-14 w-14 rounded-full grid place-items-center shrink-0"><Icon name={v.icon} size={24} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[21px] sm:text-[23px] font-medium leading-tight tracking-[-0.01em] text-white">{v.title}</div>
          <div className="text-[14.5px] text-white/75 mt-1">{fmtShort(e.date)} · {e.time}{e.endTime ? '–' + e.endTime : ''}</div>
          {where && <div className="text-[14.5px] text-white/75">{where}</div>}
        </div>
        <span className="self-end h-10 w-10 rounded-full grid place-items-center tone-icon shrink-0"><Icon name="right" size={18} /></span>
      </div>
    </button>
  );
}

function TripsPage() {
  const { data } = useStore();
  const ui = useUI();
  const [filter, setFilter] = useState<'upcoming' | 'past' | 'all'>(() => { try { return (localStorage.getItem('mtp:trip-filter') as any) || 'upcoming'; } catch { return 'upcoming'; } });
  const [kind, setKind] = useState<'all' | 'business' | 'private'>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  useEffect(() => { try { localStorage.setItem('mtp:trip-filter', filter); } catch { /* ignore */ } }, [filter]);

  const counts: Record<string, number> = {};
  data.activities.forEach((a: Activity) => { counts[a.tripId] = (counts[a.tripId] || 0) + 1; });
  const ql = q.trim().toLowerCase();
  const list: Trip[] = data.trips
    .filter((t: Trip) => showArchived || !t.archived)
    .filter((t: Trip) => filter === 'all' || (filter === 'past' ? tripStatus(t) === 'completed' : tripStatus(t) !== 'completed'))
    .filter((t: Trip) => kind === 'all' || t.kind === kind)
    .filter((t: Trip) => !ql || [t.name, ...t.cities, ...t.countries].join(' ').toLowerCase().includes(ql))
    .sort((a: Trip, b: Trip) => filter === 'past' ? b.end.localeCompare(a.end) : a.start.localeCompare(b.start));
  const filtersActive = kind !== 'all' || showArchived;

  return (
    <div>
      <section className="mb-8">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-[12.5px] font-bold uppercase tracking-[0.24em] text-muted">Next up</h2>
          <span className="text-[14px] text-muted">{fmt(todayStr(), { weekday: 'short', day: 'numeric', month: 'long' })}</span>
        </div>
        <NextUp />
      </section>

      <div className="flex items-center justify-between gap-3 mb-4">
        <h1 className="text-[32px] sm:text-[36px] font-semibold tracking-[-0.02em] leading-none text-heading">My Trips</h1>
        <button className="btn btn-cognac h-11 px-5" onClick={() => ui.editTrip(null)}><Icon name="plus" size={18} />New trip</button>
      </div>

      <div className="flex items-center gap-2 mb-5">
        <div className="inline-flex rounded-full bg-card border border-line p-1">
          {([['upcoming', 'Upcoming'], ['past', 'Past'], ['all', 'All trips']] as const).map(([k, label], i) => (
            <React.Fragment key={k}>
              {i > 0 && filter !== k && filter !== (['upcoming', 'past', 'all'] as const)[i - 1] && <span className="w-px my-2 bg-line" />}
              <button onClick={() => setFilter(k)} aria-pressed={filter === k} className={`h-9 px-3.5 sm:px-4 rounded-full text-[14px] font-semibold whitespace-nowrap transition ${filter === k ? 'bg-primary text-white shadow-sm' : 'text-muted hover:text-ink'}`}>{label}</button>
            </React.Fragment>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { setSearching(s => !s); if (searching) setQ(''); }} aria-label="Search trips" aria-pressed={searching} className={`h-11 w-11 rounded-full grid place-items-center border transition ${searching ? 'bg-primary border-primary text-white' : 'bg-card border-line text-ink hover:border-white/20'}`}><Icon name="search" size={18} /></button>
          <div className="relative">
            <button onClick={() => setFilterOpen(o => !o)} aria-label="Filter trips" aria-expanded={filterOpen} className={`h-11 w-11 rounded-full grid place-items-center border transition ${filtersActive ? 'bg-primary border-primary text-white' : 'bg-card border-line text-ink hover:border-white/20'}`}><Icon name="sliders" size={18} /></button>
            {filterOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setFilterOpen(false)} />
                <div className="absolute right-0 top-12 z-40 w-56 rounded-2xl bg-card border border-line shadow-lift p-2 anim-fade">
                  <div className="px-2 pt-1 pb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Trip type</div>
                  {([['all', 'All trips'], ['business', 'Business'], ['private', 'Private']] as const).map(([k, label]) => (
                    <button key={k} onClick={() => setKind(k)} className="w-full flex items-center justify-between px-2.5 py-2 rounded-xl text-[14px] text-ink hover:bg-pale">{label}{kind === k && <Icon name="check" size={16} className="text-petrol" />}</button>
                  ))}
                  <div className="my-1.5 border-t border-line" />
                  <button onClick={() => setShowArchived(s => !s)} className="w-full flex items-center justify-between px-2.5 py-2 rounded-xl text-[14px] text-ink hover:bg-pale">Show archived{showArchived && <Icon name="check" size={16} className="text-petrol" />}</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {searching && (
        <div className="relative mb-5 anim-fade">
          <Icon name="search" size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input id="trip-search" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search trips, cities or countries" className="inp pl-10 rounded-full" />
        </div>
      )}

      {!data.trips.length ? (
        <Empty icon="globe" title="No trips yet" text="Create your first trip, then add flights, hotels and meetings." action={<button className="btn btn-cognac" onClick={() => ui.editTrip(null)}><Icon name="plus" />New trip</button>} />
      ) : !list.length ? (
        <Empty icon="search" title={ql ? 'No matching trips' : filter === 'past' ? 'No past trips' : 'No upcoming trips'} text={ql ? 'Try a different search.' : 'Switch to “All trips” or create a new one.'} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {list.map((t, i) => <TripCard key={t.id} trip={t} count={counts[t.id] || 0} idx={i} />)}
        </div>
      )}
    </div>
  );
}

function TripPage({ id, tab }: { id: string; tab: string }) {
  const { data, duplicateTrip, setArchived, deleteTrip } = useStore();
  const ui = useUI();
  const trip: Trip | undefined = data.trips.find((t: Trip) => t.id === id);
  const [who, setWho] = useState('');
  const allActs = useMemo(() => data.activities.filter((a: Activity) => a.tripId === id), [data.activities, id]);
  const acts = useMemo(() => allActs.filter((a: Activity) => goesWith(a, who)), [allActs, who]);
  const entries = useMemo(() => buildEntries(acts), [acts]);
  if (!trip) return <Empty icon="globe" title="Trip not found" text="This trip no longer exists." action={<button className="btn btn-primary" onClick={() => go('#/trips')}>Back to all trips</button>} />;
  const status = tripStatus(trip);
  const days = daysBetween(trip.start, trip.end) + 1;
  const docCount = data.documents.filter((d: Doc) => d.tripId === trip.id && !d.cover).length;
  const todoCount = tripTodos(trip, allActs).count;
  // "Today" and "Calendar" were folded into the timeline; old links land there.
  if (tab === 'today' || tab === 'calendar') tab = 'timeline';

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
        <div className="min-w-0 overflow-x-auto no-scrollbar"><Segmented value={tab} onChange={t => go(`#/trip/${trip.id}/${t}`)} options={[
          { value: 'timeline', label: 'Timeline', icon: 'list' },
          { value: 'documents', label: `Docs${docCount ? ` ${docCount}` : ''}`, icon: 'file' },
          { value: 'todos', label: `To-dos${todoCount ? ` ${todoCount}` : ''}`, icon: 'check' },
          { value: 'costs', label: 'Costs', icon: 'wallet' },
        ]} /></div>
        <button onClick={() => ui.newActivity(trip.id)} className="hidden md:inline-flex btn btn-primary h-10"><Icon name="plus" />Activity</button>
      </div>

      {tab === 'timeline' && <TravellerFilter trip={trip} who={who} onChange={setWho} />}
      {tab === 'timeline' && <div className="max-w-3xl"><Timeline trip={trip} acts={acts} entries={entries} /></div>}
      {tab === 'documents' && <TripDocuments trip={trip} acts={allActs} entries={buildEntries(allActs)} />}
      {tab === 'todos' && <TripTodos trip={trip} acts={allActs} entries={buildEntries(allActs)} />}
      {tab === 'costs' && <TripCosts trip={trip} acts={allActs} />}

      {tab === 'timeline' && (
        <button onClick={() => ui.newActivity(trip.id)} aria-label="Add activity" className="md:hidden fixed right-5 bottom-[calc(env(safe-area-inset-bottom,0px)+84px)] z-30 h-14 w-14 rounded-full bg-primary text-white grid place-items-center shadow-lift active:scale-95 transition"><Icon name="plus" size={24} stroke={2} /></button>
      )}
    </div>
  );
}

/* =========================================================================
   BOOKING STATUS · TAXI CARD · TODAY · TO-DOS
   ========================================================================= */
type BookingStatus = 'confirmed' | 'pending' | 'planned';
const BOOKING: Record<BookingStatus, { label: string; cls: string }> = {
  confirmed: { label: 'Confirmed', cls: 'bg-dot/15 text-dot' },
  pending: { label: 'Pending', cls: 'bg-cognac/20 text-cognac' },
  planned: { label: 'Not booked', cls: 'bg-danger/15 text-danger' },
};
/** Small badge on cards; confirmed bookings stay quiet. */
function StatusPill({ s, always = false }: { s?: BookingStatus; always?: boolean }) {
  if (!s || (s === 'confirmed' && !always)) return null;
  return <span className={`rounded-full px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-wide whitespace-nowrap ${BOOKING[s].cls}`}>{BOOKING[s].label}</span>;
}

/** Where a driver should take you for this stage, preferring the local-language name and address. */
function taxiTarget(a: Activity) {
  const d = a.details || {};
  const chinese = (s?: string) => (s || '').match(/\(([^)]*[㐀-鿿][^)]*)\)/)?.[1] || '';
  if (a.type === 'train' || a.type === 'flight') {
    if (!d.from) return null;
    const local = chinese(d.from);
    return { title: a.type === 'train' ? 'Departure station' : 'Departure airport', name: place(d.from), nameLocal: local ? (a.type === 'train' && !/站$/.test(local) ? local + '站' : local) : '', address: '', addressLocal: '', phone: '' };
  }
  if (a.type === 'transfer') {
    if (!d.to) return null;
    return { title: 'Destination', name: place(d.to), nameLocal: chinese(d.to), address: '', addressLocal: '', phone: d.phone || '' };
  }
  const address = d.address || a.location || '';
  if (!address && !d.addressLocal) return null;
  return { title: a.type === 'hotel' ? 'Hotel' : 'Destination', name: a.title, nameLocal: d.nameLocal || '', address, addressLocal: d.addressLocal || chinese(address), phone: d.phone || d.contactPhone || '' };
}

/** Full-screen, high-contrast card to show a taxi driver; opens the address in Apple Maps or Amap. */
function TaxiCard({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useStore();
  const ui = useUI();
  const a: Activity | undefined = data.activities.find((x: Activity) => x.id === id);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    scrollLocks++; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', h); scrollLocks--; if (!scrollLocks) document.body.style.overflow = ''; };
  }, []);
  const t = a ? taxiTarget(a) : null;
  if (!a || !t) return null;
  const query = t.addressLocal || t.nameLocal || [t.name, t.address].filter(Boolean).join(', ');
  const q = encodeURIComponent(query);
  const copy = () => navigator.clipboard.writeText([t.nameLocal, t.addressLocal, t.name, t.address].filter(Boolean).join('\n')).then(() => ui.toast('Address copied')).catch(() => ui.toast('Copying isn’t supported here'));
  return (
    <div className="fixed inset-0 z-[85] flex flex-col bg-[#FBFAF6] text-[#141414] anim-fade" role="dialog" aria-modal="true" aria-label="Show to driver">
      <div className="flex items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-2">
        <button onClick={onClose} aria-label="Close" className="h-11 w-11 grid place-items-center rounded-full bg-black/5 text-[#141414]"><Icon name="x" /></button>
        <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-black/45">Please take me to · 请带我去</div>
      </div>
      <div className="flex-1 overflow-auto px-6 py-6 flex flex-col justify-center gap-5">
        <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-[#9a6230]">{t.title}</div>
        {t.nameLocal && <div className="text-[40px] leading-[1.15] font-bold">{t.nameLocal}</div>}
        {t.addressLocal && <div className="text-[30px] leading-[1.3] font-semibold">{t.addressLocal}</div>}
        <div className="h-px bg-black/10" />
        <div className="text-[20px] font-semibold">{t.name}</div>
        {t.address && <div className="text-[17px] text-black/65 leading-snug">{t.address}</div>}
        {t.phone && <a href={`tel:${t.phone.replace(/\s/g, '')}`} className="text-[17px] font-semibold text-[#1170b8]">☎ {t.phone}</a>}
        {!t.nameLocal && !t.addressLocal && <p className="text-[14px] text-black/50">No Chinese address saved yet. Add it under Edit → “Address in local language”.</p>}
      </div>
      <div className="grid grid-cols-3 gap-2 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+14px)] border-t border-black/10">
        <a href={`https://maps.apple.com/?q=${q}`} target="_blank" rel="noopener" className="btn h-12 bg-[#141414] text-white text-[14px]">Apple Maps</a>
        <a href={`https://uri.amap.com/search?keyword=${q}&callnative=1`} target="_blank" rel="noopener" className="btn h-12 bg-[#1170b8] text-white text-[14px]">Amap 高德</a>
        <button onClick={copy} className="btn h-12 bg-black/5 text-[#141414] text-[14px]">Copy</button>
      </div>
    </div>
  );
}

/* ---------- Travellers, money and due dates ---------- */
/** True when the stage includes this traveller (no traveller chosen = everyone). */
const goesWith = (a: Activity, who: string) => !who || !a.travellers?.length || a.travellers.includes(who);
const sharesTraveller = (a: Activity, b: Activity) => !a.travellers?.length || !b.travellers?.length || a.travellers.some(x => b.travellers!.includes(x));
const isTransport = (a: Activity) => a.type === 'flight' || a.type === 'train' || a.type === 'transfer';

function fmtMoney(amount: number, currency: string) {
  try { return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: currency || 'EUR', currencyDisplay: 'narrowSymbol' }).format(amount); }
  catch { return `${currency} ${amount.toFixed(2)}`; }
}
const openAmount = (c?: Cost) => (c ? Math.max(0, c.amount - (c.paidAmount || 0)) : 0);

/** Short human label for a due date relative to today. */
function dueLabel(due: string) {
  const n = daysBetween(todayStr(), due);
  if (n < 0) return `Overdue · ${fmtShort(due)}`;
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n < 7) return `${fmtShort(due)} · in ${n} days`;
  return fmtShort(due);
}
const dueTone = (due?: string) => {
  if (!due) return 'text-muted border-line border-dashed';
  const n = daysBetween(todayStr(), due);
  return n < 0 ? 'text-danger border-danger/50 bg-danger/10' : n <= 7 ? 'text-cognac border-cognac/50 bg-cognac/10' : 'text-petrol border-line';
};

/** Date pill that opens the native date picker; used to give a task a deadline. */
function DueChip({ due, onChange }: { due?: string; onChange: (d?: string) => void }) {
  return (
    <label className={`relative inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11.5px] font-semibold whitespace-nowrap cursor-pointer ${dueTone(due)}`} onClick={e => e.stopPropagation()}>
      <Icon name="calendar" size={12} />{due ? dueLabel(due) : 'Add date'}
      <input type="date" value={due || ''} onChange={e => onChange(e.target.value || undefined)} aria-label="Due date" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
    </label>
  );
}

/** Small initials for the people on a stage, shown only when not everyone travels. */
function TravellerDots({ a, trip }: { a: Activity; trip?: Trip }) {
  if (!trip?.travellers || trip.travellers.length < 2 || !a.travellers?.length || a.travellers.length >= trip.travellers.length) return null;
  return (
    <span className="flex -space-x-1" title={a.travellers.join(', ')}>
      {a.travellers.map(n => <span key={n} className="h-[18px] min-w-[18px] px-1 rounded-full bg-ink/15 border border-white/10 text-ink/90 text-[9.5px] font-bold grid place-items-center">{n.slice(0, 2)}</span>)}
    </span>
  );
}

/** Filter chips above a family trip: everyone or one person's view. */
function TravellerFilter({ trip, who, onChange }: { trip: Trip; who: string; onChange: (w: string) => void }) {
  if (!trip.travellers || trip.travellers.length < 2) return null;
  const opts = ['', ...trip.travellers];
  return (
    <div className="mb-5 flex gap-2 overflow-x-auto no-scrollbar">
      {opts.map(o => (
        <button key={o || 'all'} onClick={() => onChange(o)} aria-pressed={who === o}
          className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold border transition ${who === o ? 'bg-petrol-fill text-white border-transparent' : 'bg-card border-line text-muted hover:text-ink'}`}>
          {o ? o : <span className="inline-flex items-center gap-1.5"><Icon name="users" size={14} />Everyone</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------- Trip check ---------- */
type Deadline = { key: string; date: string; a: Activity; kind: 'task' | 'payment'; text: string; t?: Task };
type Issue = { key: string; icon: string; title: string; text: string; a?: Activity; date?: string };

/** Everything still open for a trip: deadlines, missing nights, schedule problems, unconfirmed bookings, tasks and warnings. */
function tripTodos(trip: Trip, acts: Activity[]) {
  const ms = (a: Activity) => toUtc(a.start, a.startTz);
  const endMs = (a: Activity) => (a.end ? toUtc(a.end, a.endTz || a.startTz) : ms(a));
  const sorted = [...acts].sort((a, b) => ms(a) - ms(b));

  // Nights without a hotel (sleeping on a plane or train counts as covered) – checked for each traveller
  const people = trip.travellers && trip.travellers.length > 1 ? trip.travellers : [''];
  const covered = (d: string, who: string) => {
    const mine = acts.filter(a => goesWith(a, who));
    // Before this person's first stage or after their last one they are at home.
    if (who && mine.length && (d < mine.reduce((m, a) => a.start < m ? a.start : m, '9').slice(0, 10) || d >= mine.reduce((m, a) => (a.end || a.start) > m ? (a.end || a.start) : m, '').slice(0, 10))) return true;
    return !!hotelFor(mine, d) || mine.some(a => (a.type === 'flight' || a.type === 'train') && a.end && a.start.slice(0, 10) <= d && a.end.slice(0, 10) > d);
  };
  const gapDays: string[] = [];
  for (let d = trip.start; d < trip.end; d = addDays(d, 1)) if (people.some(p => !covered(d, p))) gapDays.push(d);
  const gaps: { from: string; to: string }[] = [];
  gapDays.forEach(d => { const last = gaps[gaps.length - 1]; if (last && addDays(last.to, 1) === d) last.to = d; else gaps.push({ from: d, to: d }); });

  // Schedule: journey there and back, overlaps, tight connections
  const issues: Issue[] = [];
  if (acts.length) {
    const travelOn = (d: string) => acts.some(a => isTransport(a) && (a.start.slice(0, 10) === d || a.end?.slice(0, 10) === d));
    if (!travelOn(trip.start)) issues.push({ key: 'out', icon: 'plane', title: 'No outbound journey', text: `Nothing booked to get there on ${fmtShort(trip.start)}.`, date: trip.start });
    if (!travelOn(trip.end)) issues.push({ key: 'back', icon: 'plane', title: 'No journey home', text: `Nothing booked for the way back on ${fmtShort(trip.end)}.`, date: trip.end });
  }
  const timed = sorted.filter(a => a.type !== 'hotel' && a.status !== 'planned');
  timed.forEach((a, i) => {
    for (const b of timed.slice(i + 1)) {
      if (ms(b) >= endMs(a)) break;
      if (!sharesTraveller(a, b) || endMs(a) === ms(a)) continue;
      issues.push({ key: `ov${a.id}${b.id}`, icon: 'alert', title: 'Overlap', text: `“${a.title}” runs until ${(a.end || '').slice(11, 16)}, but “${b.title}” starts at ${b.start.slice(11, 16)}.`, a: b, date: b.start.slice(0, 10) });
    }
  });
  const rides = sorted.filter(a => (a.type === 'flight' || a.type === 'train') && a.end && a.status !== 'planned');
  rides.forEach((a, i) => {
    const b = rides.slice(i + 1).find(x => sharesTraveller(a, x));
    if (!b) return;
    const gap = (ms(b) - endMs(a)) / 60000;
    const need = b.type === 'flight' ? 90 : 30;
    if (gap >= 0 && gap < need) issues.push({ key: `cx${a.id}`, icon: 'clock', title: 'Tight connection', text: `Only ${Math.round(gap)} min between arriving with ${a.details.flightNo || a.details.trainNo || a.title} and departing with ${b.details.flightNo || b.details.trainNo || b.title}.`, a: b, date: b.start.slice(0, 10) });
  });

  // Deadlines: dated tasks and outstanding payments
  const deadlines: Deadline[] = [];
  sorted.forEach(a => {
    a.tasks.forEach(t => { if (t.due && !t.done) deadlines.push({ key: t.id, date: t.due, a, kind: 'task', text: t.text, t }); });
    if (a.cost && openAmount(a.cost) > 0 && a.cost.due) deadlines.push({ key: a.id + ':pay', date: a.cost.due, a, kind: 'payment', text: `${fmtMoney(openAmount(a.cost), a.cost.currency)} to be paid` });
  });
  deadlines.sort((x, y) => x.date.localeCompare(y.date));

  const unconfirmed = sorted.filter(a => a.status === 'planned' || a.status === 'pending');
  const tasks = sorted.flatMap(a => a.tasks.filter(t => !t.due || t.done).map(t => ({ a, t })));
  const warnings = sorted.flatMap(a => a.notes.filter(n => n.text.trim().startsWith('⚠')).map(n => ({ a, n })));
  const count = deadlines.length + gaps.length + issues.length + unconfirmed.length + tasks.filter(x => !x.t.done).length;
  return { deadlines, gaps, issues, unconfirmed, tasks, warnings, count };
}

function TripTodos({ trip, acts, entries }: { trip: Trip; acts: Activity[]; entries: Entry[] }) {
  const { updateActivity } = useStore();
  const ui = useUI();
  const [showDone, setShowDone] = useState(false);
  const { deadlines, gaps, issues, unconfirmed, tasks, warnings } = tripTodos(trip, acts);
  const open = tasks.filter(x => !x.t.done), done = tasks.filter(x => x.t.done);
  // Where you are that night: the destination of the last flight/train that arrived by then, else the day's last city.
  const cityFor = (d: string) => {
    const arrived = acts.filter(a => (a.type === 'flight' || a.type === 'train') && a.end && a.end.slice(0, 10) <= d && a.details.to)
      .sort((a, b) => toUtc(a.end!, a.endTz || a.startTz) - toUtc(b.end!, b.endTz || b.startTz)).pop();
    return arrived ? place(arrived.details.to) : dayCities(acts, entries.filter(e => e.date === d), d).slice(-1)[0] || '';
  };
  const ActRef = ({ a }: { a: Activity }) => (
    <button onClick={() => ui.openActivity(a.id)} className={`tone-${toneOf(a.type)} flex items-center gap-1.5 text-[12.5px] tone-ink hover:underline text-left`}>
      <Icon name={TYPE_META[a.type].icon} size={12} />{fmtShort(a.start.slice(0, 10))} · {a.title}
    </button>
  );
  const patchTask = (a: Activity, tid: string, p: Partial<Task>) => updateActivity(a.id, (x: Activity) => ({ ...x, tasks: x.tasks.map(t => t.id === tid ? { ...t, ...p } : t) }));
  const toggle = (a: Activity, t: Task) => patchTask(a, t.id, { done: !t.done });
  const markPaid = (a: Activity) => { updateActivity(a.id, (x: Activity) => ({ ...x, cost: x.cost ? { ...x.cost, paidAmount: x.cost.amount } : x.cost })); ui.toast('Marked as paid'); };
  const Section = ({ title, icon, children }: any) => (
    <section>
      <h3 className="text-[12px] font-bold uppercase tracking-[0.14em] text-heading mb-3 flex items-center gap-2"><Icon name={icon} size={15} />{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
  const Check = ({ onClick, on }: { onClick: () => void; on?: boolean }) => (
    <button onClick={onClick} aria-label={on ? 'Mark as open' : 'Mark as done'} className={`mt-0.5 h-6 w-6 rounded-lg border-2 grid place-items-center shrink-0 ${on ? 'bg-primary border-primary text-white' : 'border-line hover:border-primary'}`}>{on && <Icon name="check" size={14} stroke={2.5} />}</button>
  );
  const problems = gaps.length + issues.length + unconfirmed.length;
  if (!deadlines.length && !problems && !open.length && !warnings.length) {
    return <div className="max-w-3xl"><Empty icon="check" title="All set" text="No deadlines, no missing hotels, no schedule problems and no open tasks for this trip." /></div>;
  }
  return (
    <div className="max-w-3xl space-y-8">
      <div className={`flex items-center gap-3 rounded-2xl px-4 py-3 border ${problems ? 'border-cognac/40 bg-cognac/10' : 'border-dot/40 bg-dot/10'}`}>
        <Icon name={problems ? 'alert' : 'check'} size={20} className={problems ? 'text-cognac' : 'text-dot'} />
        <div className="text-[14px] text-ink">
          <span className="font-semibold">Trip check:</span>{' '}
          {problems ? [gaps.length && plural(gaps.length, 'gap in accommodation', 'gaps in accommodation'), issues.length && plural(issues.length, 'schedule issue', 'schedule issues'), unconfirmed.length && `${unconfirmed.length} not confirmed`].filter(Boolean).join(' · ') : 'no gaps or conflicts found'}
          {deadlines.length > 0 && <span className="text-muted"> · {plural(deadlines.length, 'deadline', 'deadlines')}</span>}
        </div>
      </div>

      {deadlines.length > 0 && (
        <Section title="Deadlines" icon="flag">
          {deadlines.map(d => (
            <div key={d.key} className={`flex items-start gap-3 rounded-2xl border px-3.5 py-3 ${daysBetween(todayStr(), d.date) < 0 ? 'border-danger/40 bg-danger/10' : 'bg-card border-line'}`}>
              {d.kind === 'task' ? <Check onClick={() => toggle(d.a, d.t!)} /> : <span className="mt-0.5 h-6 w-6 grid place-items-center text-cognac shrink-0"><Icon name="wallet" size={18} /></span>}
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] text-ink">{d.text}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {d.kind === 'task' ? <DueChip due={d.date} onChange={v => patchTask(d.a, d.t!.id, { due: v })} /> : <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11.5px] font-semibold ${dueTone(d.date)}`}><Icon name="calendar" size={12} />{dueLabel(d.date)}</span>}
                  <ActRef a={d.a} />
                </div>
              </div>
              {d.kind === 'payment' && <button onClick={() => markPaid(d.a)} className="text-[13px] font-semibold text-petrol hover:underline shrink-0">Paid</button>}
            </div>
          ))}
        </Section>
      )}

      {gaps.length > 0 && (
        <Section title="No accommodation" icon="bed">
          {gaps.map(g => (
            <div key={g.from} className="flex items-center gap-3 rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3">
              <Icon name="bed" size={18} className="text-danger shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-semibold text-ink">{g.from === g.to ? `Night of ${fmtShort(g.from)}` : `Nights ${fmtShort(g.from)} – ${fmtShort(g.to)}`}{cityFor(g.from) ? ` · ${cityFor(g.from)}` : ''}</div>
                <div className="text-[12.5px] text-muted">{plural(daysBetween(g.from, g.to) + 1, 'night', 'nights')} without a hotel</div>
              </div>
              <button onClick={() => ui.newActivity(trip.id, g.from)} className="text-[13px] font-semibold text-petrol hover:underline shrink-0">Add hotel</button>
            </div>
          ))}
        </Section>
      )}

      {issues.length > 0 && (
        <Section title="Schedule" icon="alert">
          {issues.map(i => (
            <div key={i.key} className="flex items-start gap-3 rounded-2xl border border-cognac/40 bg-cognac/10 px-4 py-3">
              <Icon name={i.icon} size={18} className="text-cognac shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-semibold text-ink">{i.title}</div>
                <div className="text-[13px] text-ink/80 leading-snug">{i.text}</div>
                {i.a && <div className="mt-1"><ActRef a={i.a} /></div>}
              </div>
              {!i.a && i.date && <button onClick={() => ui.newActivity(trip.id, i.date)} className="text-[13px] font-semibold text-petrol hover:underline shrink-0">Add</button>}
            </div>
          ))}
        </Section>
      )}

      {unconfirmed.length > 0 && (
        <Section title="Not confirmed yet" icon="clock">
          {unconfirmed.map(a => (
            <button key={a.id} onClick={() => ui.openActivity(a.id)} className={`tone-${toneOf(a.type)} tone-card w-full flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left`}>
              <span className="tone-icon h-9 w-9 rounded-full grid place-items-center shrink-0"><Icon name={TYPE_META[a.type].icon} size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-semibold text-ink">{a.title}</span>
                <span className="block text-[12.5px] tone-ink">{fmtShort(a.start.slice(0, 10))} · {a.start.slice(11, 16)}</span>
              </span>
              <StatusPill s={a.status as BookingStatus} />
            </button>
          ))}
        </Section>
      )}

      {(open.length > 0 || done.length > 0) && (
        <Section title={`Tasks · ${open.length} open`} icon="check">
          {open.map(({ a, t }) => (
            <div key={t.id} className="flex items-start gap-3 rounded-2xl bg-card border border-line px-3.5 py-3">
              <Check onClick={() => toggle(a, t)} />
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] text-ink">{t.text}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1"><DueChip due={t.due} onChange={v => patchTask(a, t.id, { due: v })} /><ActRef a={a} /></div>
              </div>
            </div>
          ))}
          {done.length > 0 && <button onClick={() => setShowDone(s => !s)} className="text-[13px] text-muted hover:text-ink px-1">{showDone ? 'Hide' : 'Show'} {plural(done.length, 'completed task', 'completed tasks')}</button>}
          {showDone && done.map(({ a, t }) => (
            <div key={t.id} className="flex items-start gap-3 rounded-2xl bg-card/60 border border-line px-3.5 py-3 opacity-70">
              <Check onClick={() => toggle(a, t)} on />
              <div className="min-w-0"><div className="text-[14.5px] text-muted line-through">{t.text}</div><ActRef a={a} /></div>
            </div>
          ))}
        </Section>
      )}

      {warnings.length > 0 && (
        <Section title="Watch out" icon="note">
          {warnings.map(({ a, n }) => (
            <div key={n.id} className="rounded-2xl border border-cognac/40 bg-cognac/10 px-4 py-3">
              <div className="text-[14px] text-ink leading-relaxed">{n.text}</div>
              <div className="mt-1"><ActRef a={a} /></div>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

/* ---------- Costs ---------- */
const COST_GROUPS: { title: string; icon: string; types: ActivityType[] }[] = [
  { title: 'Transport', icon: 'plane', types: ['flight', 'train', 'transfer'] },
  { title: 'Accommodation', icon: 'bed', types: ['hotel'] },
  { title: 'Other', icon: 'wallet', types: ['meeting', 'personal'] },
];

/** What the trip costs: totals per currency, every priced booking, and bookings still without a price. */
function TripCosts({ trip, acts }: { trip: Trip; acts: Activity[] }) {
  const ui = useUI();
  const priced = acts.filter(a => a.cost && a.cost.amount > 0).sort((a, b) => toUtc(a.start, a.startTz) - toUtc(b.start, b.startTz));
  const missing = acts.filter(a => !a.cost && a.status !== 'planned' && (isTransport(a) || a.type === 'hotel')).sort((a, b) => a.start.localeCompare(b.start));
  const totals: Record<string, { total: number; paid: number }> = {};
  priced.forEach(a => { const c = a.cost!; const t = (totals[c.currency] = totals[c.currency] || { total: 0, paid: 0 }); t.total += c.amount; t.paid += Math.min(c.amount, c.paidAmount || 0); });
  const currencies = Object.keys(totals).sort((x, y) => totals[y].total - totals[x].total);

  if (!priced.length) return (
    <div className="max-w-3xl"><Empty icon="wallet" title="No prices yet" text="Add the price to a booking under Edit → Price. Totals per currency appear here." action={missing[0] ? <button className="btn btn-primary" onClick={() => ui.editActivity(missing[0])}><Icon name="plus" />Add a price</button> : undefined} /></div>
  );
  return (
    <div className="max-w-3xl space-y-8">
      <div className="grid gap-3 sm:grid-cols-2">
        {currencies.map(cur => {
          const t = totals[cur], open = t.total - t.paid;
          return (
            <div key={cur} className="rounded-2xl bg-card border border-line p-4">
              <div className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-muted">Total · {cur}</div>
              <div className="font-display text-[30px] leading-tight text-heading tabular-nums mt-1">{fmtMoney(t.total, cur)}</div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 text-[13px] tabular-nums">
                <span className="text-dot">Paid {fmtMoney(t.paid, cur)}</span>
                {open > 0.004 && <span className="text-cognac">Open {fmtMoney(open, cur)}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {COST_GROUPS.map(g => {
        const list = priced.filter(a => g.types.includes(a.type));
        if (!list.length) return null;
        return (
          <section key={g.title}>
            <h3 className="text-[12px] font-bold uppercase tracking-[0.14em] text-heading mb-3 flex items-center gap-2"><Icon name={g.icon} size={15} />{g.title}</h3>
            <div className="rounded-2xl bg-card border border-line divide-y divide-line">
              {list.map(a => {
                const c = a.cost!, open = openAmount(c);
                return (
                  <button key={a.id} onClick={() => ui.openActivity(a.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03]">
                    <span className={`tone-${toneOf(a.type)} tone-ink shrink-0`}><Icon name={TYPE_META[a.type].icon} size={16} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] text-ink truncate">{a.title}</span>
                      <span className="block text-[12.5px] text-muted">{fmtShort(a.start.slice(0, 10))}{open > 0 ? ` · ${fmtMoney(open, c.currency)} open${c.due ? ` – due ${fmtShort(c.due)}` : ''}` : ' · paid'}</span>
                    </span>
                    <span className={`text-[15px] font-semibold tabular-nums shrink-0 ${open > 0 ? 'text-cognac' : 'text-ink'}`}>{fmtMoney(c.amount, c.currency)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {missing.length > 0 && (
        <section>
          <h3 className="text-[12px] font-bold uppercase tracking-[0.14em] text-heading mb-3 flex items-center gap-2"><Icon name="note" size={15} />Price not entered yet</h3>
          <div className="space-y-2">
            {missing.map(a => (
              <div key={a.id} className="flex items-center gap-3 rounded-2xl border border-dashed border-line px-4 py-2.5">
                <span className="min-w-0 flex-1 text-[14px] text-muted truncate">{fmtShort(a.start.slice(0, 10))} · {a.title}</span>
                <button onClick={() => ui.editActivity(a)} className="text-[13px] font-semibold text-petrol hover:underline shrink-0">Add price</button>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="text-[12.5px] text-muted">Totals are kept per currency – no exchange rates are applied.</p>
    </div>
  );
}

/* =========================================================================
   DOCUMENTS
   ========================================================================= */
const MAX_FILE = 50 * 1024 * 1024;
const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

/** "Upload" and (on phones) "Take photo" buttons. Files are added to the trip and linked to `activityIds`. */
function UploadButtons({ tripId, activityIds = [], onAdded, compact = false }: { tripId: string; activityIds?: string[]; onAdded?: (docs: Doc[]) => void; compact?: boolean }) {
  const { addDocuments } = useStore();
  const ui = useUI();
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const onPick = async (e: any) => {
    const list: File[] = Array.from(e.target.files || []);
    e.target.value = '';
    if (!list.length) return;
    const tooBig = list.filter(f => f.size > MAX_FILE);
    const ok = list.filter(f => f.size <= MAX_FILE);
    if (tooBig.length) ui.toast(`${tooBig[0].name} is larger than 50 MB and was skipped`);
    if (!ok.length) return;
    const docs = await addDocuments(tripId, ok, activityIds);
    ui.toast(`${plural(docs.length, 'document', 'documents')} added`);
    onAdded?.(docs);
  };
  const cls = compact ? 'text-[13px] font-semibold text-petrol flex items-center gap-1 hover:underline' : 'btn btn-primary h-10';
  const cls2 = compact ? cls : 'btn btn-ghost h-10';
  return (
    <div className={`flex items-center ${compact ? 'gap-3.5' : 'gap-2'}`}>
      <button className={cls} onClick={() => fileRef.current?.click()}><Icon name="upload" size={compact ? 14 : 16} />Upload</button>
      {isTouch() && <button className={cls2} onClick={() => camRef.current?.click()}><Icon name="camera" size={compact ? 14 : 16} />Photo</button>}
      <input ref={fileRef} type="file" multiple accept="application/pdf,image/*" className="hidden" onChange={onPick} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} />
    </div>
  );
}

function DocStatus({ d }: { d: Doc }) {
  const { files, sync } = useStore();
  const busy = files.busy[d.id];
  if (busy) return <span className="flex items-center gap-1 text-petrol"><Icon name="refresh" size={11} className="animate-spin" />{busy === 'up' ? 'Uploading…' : 'Downloading…'}</span>;
  if (!d.driveId) return <span className="text-cognac">{!sync.connected ? 'Only on this device' : sync.status === 'needs-auth' ? 'Waiting – tap the cloud icon to upload' : sync.status === 'offline' ? 'Waiting – uploads when online' : 'Waiting to upload'}</span>;
  return files.localIds.has(d.id) ? <span className="flex items-center gap-1"><Icon name="check" size={11} />Offline</span> : <span>In Google Drive</span>;
}

function DocRow({ d, activityId, showStages = true }: { d: Doc; activityId?: string; showStages?: boolean }) {
  const { data, deleteDoc, unlinkDoc } = useStore();
  const ui = useUI();
  const stages = showStages ? d.activityIds.map(id => data.activities.find((a: Activity) => a.id === id)).filter(Boolean) as Activity[] : [];
  const menu = [
    { label: 'Link to stages', icon: 'link', onClick: () => ui.chooseStages(d.tripId, [d.id], d.activityIds) },
    ...(activityId ? [{ label: 'Remove from this stage', icon: 'x', onClick: () => { unlinkDoc(d.id, activityId); ui.toast('Removed from this stage. It’s still in the trip’s documents.'); } }] : []),
    { label: 'Delete document', icon: 'trash', danger: true, onClick: () => ui.confirm({ title: 'Delete document?', text: `“${d.name}” is removed from the trip and all its stages, and moved to the Google Drive trash.`, ok: 'Delete', onOk: () => { deleteDoc(d.id); ui.toast('Document deleted'); } }) },
  ];
  return (
    <div className="rounded-2xl bg-card border border-line px-3.5 py-3">
      <div className="flex items-center gap-3">
        <button onClick={() => ui.viewDoc(d.id)} className="h-10 w-10 rounded-xl bg-cognac/12 text-cognac grid place-items-center shrink-0" aria-label={`View ${d.name}`}><Icon name={isImage(d) ? 'image' : 'file'} size={18} /></button>
        <button onClick={() => ui.viewDoc(d.id)} className="min-w-0 flex-1 text-left">
          <div className="text-[14px] font-semibold text-ink truncate">{d.name}</div>
          <div className="text-[12px] text-muted flex flex-wrap items-center gap-x-1.5">{isImage(d) ? 'Photo' : 'PDF'} · {fileSize(d.size)} · <DocStatus d={d} /></div>
        </button>
        <button onClick={() => ui.viewDoc(d.id)} className="btn btn-primary h-9 px-3.5 text-[13px]"><Icon name="eye" size={15} />View</button>
        <Menu items={menu} />
      </div>
      {stages.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 pl-[52px]">
          {stages.map(a => (
            <button key={a.id} onClick={() => ui.openActivity(a.id)} className={`tone-${toneOf(a.type)} tone-card inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold text-ink max-w-full`}>
              <Icon name={TYPE_META[a.type].icon} size={12} className="tone-ink" /><span className="truncate">{fmtShort(a.start.slice(0, 10))} · {a.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TripDocuments({ trip, acts, entries }: { trip: Trip; acts: Activity[]; entries: Entry[] }) {
  const { data, sync } = useStore();
  const ui = useUI();
  const docs: Doc[] = data.documents.filter((d: Doc) => d.tripId === trip.id && !d.cover);
  const actMs = (id: string) => { const a = acts.find(x => x.id === id); return a ? toUtc(a.start, a.startTz) : Infinity; };
  const firstMs = (d: Doc) => Math.min(...d.activityIds.map(actMs));

  // Documents for whatever happens in the next 24 hours (or is happening now)
  const now = Date.now();
  const soonIds = new Set(entries.filter(e => (e.ms >= now - 3600e3 && e.ms <= now + 24 * 3600e3) || (e.endMs && e.ms <= now && e.endMs >= now)).map(e => e.a.id));
  const soon = docs.filter(d => d.activityIds.some(id => soonIds.has(id)));

  const linked = docs.filter(d => d.activityIds.some(id => acts.some(a => a.id === id))).sort((a, b) => firstMs(a) - firstMs(b));
  const general = docs.filter(d => !linked.includes(d));
  const byDay: Record<string, Doc[]> = {};
  linked.forEach(d => {
    const a = acts.filter(x => d.activityIds.includes(x.id)).sort((x, y) => toUtc(x.start, x.startTz) - toUtc(y.start, y.startTz))[0];
    const day = a.start.slice(0, 10);
    (byDay[day] = byDay[day] || []).push(d);
  });

  const askStages = (added: Doc[]) => { if (acts.length) ui.chooseStages(trip.id, added.map(d => d.id), []); };

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <p className="text-[13.5px] text-muted max-w-md">
          {plural(docs.length, 'document', 'documents')}. Upload each file once and link it to its stages.{sync.connected ? ' Saved in Google Drive › My Travel Planner › Trips.' : ' Connect Google Drive in Settings to back them up.'}
        </p>
        <UploadButtons tripId={trip.id} onAdded={askStages} />
      </div>

      {!docs.length ? <Empty icon="file" title="No documents yet" text="Add tickets, boarding passes and hotel confirmations. Each file is uploaded once and can be linked to one or more stages." /> : (
        <div className="space-y-8">
          {soon.length > 0 && (
            <section>
              <h3 className="text-[12px] font-bold uppercase tracking-[0.14em] text-cognac mb-3 flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-cognac pulse-dot" />Next 24 hours</h3>
              <div className="space-y-2">{soon.map(d => <DocRow key={d.id} d={d} />)}</div>
            </section>
          )}
          {Object.keys(byDay).sort().map(day => (
            <section key={day}>
              <h3 className="mb-3 flex items-baseline gap-2.5"><span className="text-[12px] font-bold uppercase tracking-[0.14em] text-cognac">{fmt(day, { weekday: 'long' })}</span><span className="font-display text-[19px] text-cognac">{fmtDM(day)}</span></h3>
              <div className="space-y-2">{byDay[day].map(d => <DocRow key={d.id} d={d} />)}</div>
            </section>
          ))}
          {general.length > 0 && (
            <section>
              <h3 className="text-[12px] font-bold uppercase tracking-[0.14em] text-heading mb-1">General</h3>
              <p className="text-[12.5px] text-muted mb-3">Not linked to a stage, e.g. visa, insurance or passport copy.</p>
              <div className="space-y-2">{general.map(d => <DocRow key={d.id} d={d} />)}</div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** Pick which stages a document belongs to (none = general trip document). */
function StagePicker({ tripId, docIds, initial, onClose }: { tripId: string; docIds: string[]; initial: string[]; onClose: () => void }) {
  const { data, setDocStages } = useStore();
  const ui = useUI();
  const [sel, setSel] = useState<string[]>(initial);
  const acts = buildEntries(data.activities.filter((a: Activity) => a.tripId === tripId)).filter(e => e.kind === 'main').map(e => e.a);
  const names = data.documents.filter((d: Doc) => docIds.includes(d.id)).map((d: Doc) => d.name);
  const toggle = (id: string) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  return (
    <Sheet onClose={onClose} label="Link to stages">
      <SheetHead onClose={onClose} title="Which stages is this for?" eyebrow={<div className="text-[12px] font-bold uppercase tracking-[0.14em] text-cognac truncate">{names.length === 1 ? names[0] : plural(names.length, 'document', 'documents')}</div>}>
        <p className="text-[13.5px] text-muted mt-1.5">Select one or more stages. Leave all unselected for a general trip document.</p>
      </SheetHead>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-1.5">
        {acts.map(a => {
          const on = sel.includes(a.id);
          return (
            <button key={a.id} onClick={() => toggle(a.id)} aria-pressed={on} className={`w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left border transition tone-${toneOf(a.type)} ${on ? 'tone-card' : 'border-transparent hover:bg-pale/60'}`}>
              <span className={`h-6 w-6 rounded-lg border-2 grid place-items-center shrink-0 ${on ? 'bg-primary border-primary text-white' : 'border-line'}`}>{on && <Icon name="check" size={14} stroke={2.5} />}</span>
              <span className="h-8 w-8 rounded-lg grid place-items-center tone-tile shrink-0"><Icon name={TYPE_META[a.type].icon} size={15} /></span>
              <span className="min-w-0">
                <span className="block text-[14.5px] font-semibold text-ink truncate">{a.title}</span>
                <span className="block text-[12.5px] text-cognac font-semibold">{fmtShort(a.start.slice(0, 10))} · {a.start.slice(11, 16)}</span>
              </span>
            </button>
          );
        })}
        {!acts.length && <p className="text-muted text-[14px] px-2">This trip has no stages yet.</p>}
      </div>
      <SheetFoot>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary flex-1" onClick={() => { setDocStages(docIds, sel); ui.toast(sel.length ? `Linked to ${plural(sel.length, 'stage', 'stages')}` : 'Saved as a general document'); onClose(); }}><Icon name="check" size={16} />Save</button>
      </SheetFoot>
    </Sheet>
  );
}

/** Link documents already in the trip to one stage. */
function ExistingDocPicker({ activity, onClose }: { activity: Activity; onClose: () => void }) {
  const { data, linkDocs } = useStore();
  const ui = useUI();
  const [sel, setSel] = useState<string[]>([]);
  const docs: Doc[] = data.documents.filter((d: Doc) => d.tripId === activity.tripId && !d.cover && !d.activityIds.includes(activity.id));
  return (
    <Sheet onClose={onClose} label="Link existing document">
      <SheetHead onClose={onClose} title="Link a trip document" eyebrow={<div className="text-[12px] font-bold uppercase tracking-[0.14em] text-cognac truncate">{activity.title}</div>} />
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-1.5">
        {docs.map(d => {
          const on = sel.includes(d.id);
          return (
            <button key={d.id} onClick={() => setSel(s => on ? s.filter(x => x !== d.id) : [...s, d.id])} aria-pressed={on} className={`w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left border transition ${on ? 'bg-pale border-petrol/40' : 'border-transparent hover:bg-pale/60'}`}>
              <span className={`h-6 w-6 rounded-lg border-2 grid place-items-center shrink-0 ${on ? 'bg-primary border-primary text-white' : 'border-line'}`}>{on && <Icon name="check" size={14} stroke={2.5} />}</span>
              <Icon name={isImage(d) ? 'image' : 'file'} size={18} className="text-cognac" />
              <span className="min-w-0 text-[14.5px] font-semibold text-ink truncate">{d.name}</span>
            </button>
          );
        })}
        {!docs.length && <Empty icon="file" title="Nothing to link" text="All of this trip’s documents are already linked here, or the trip has none yet. Use Upload instead." />}
      </div>
      <SheetFoot>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary flex-1" disabled={!sel.length} onClick={() => { linkDocs(sel, activity.id); ui.toast(`${plural(sel.length, 'document', 'documents')} linked`); onClose(); }}><Icon name="link" size={16} />Link</button>
      </SheetFoot>
    </Sheet>
  );
}

/** Full-screen viewer for PDFs and photos, from this device or Google Drive. */
function DocViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, files } = useStore();
  const d: Doc | undefined = data.documents.find((x: Doc) => x.id === id);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [err, setErr] = useState('');
  const [pages, setPages] = useState(0);
  const [url, setUrl] = useState('');
  const pdfRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    scrollLocks++; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', h); scrollLocks--; if (!scrollLocks) document.body.style.overflow = ''; };
  }, []);
  useEffect(() => { if (d) files.getBlob(d).then(setBlob).catch((e: any) => setErr(e.message)); }, [id]);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob); setUrl(u);
    let cancelled = false;
    if (d && !isImage(d) && pdfRef.current) {
      const el = pdfRef.current;
      el.innerHTML = '';
      renderPdf(blob, el, Math.min(el.clientWidth - 8, 900), () => cancelled).then(setPages).catch(() => setErr('This PDF couldn’t be displayed. Use “Open” to view it in another app.'));
    }
    return () => { cancelled = true; URL.revokeObjectURL(u); };
  }, [blob]);

  if (!d) return null;
  const share = async () => {
    if (!blob) return;
    const file = new File([blob], d.name, { type: d.mime });
    try {
      if ((navigator as any).canShare?.({ files: [file] })) { await (navigator as any).share({ files: [file], title: d.name }); return; }
    } catch { return; }
    const a = document.createElement('a'); a.href = url; a.download = d.name; a.click();
  };

  return (
    <div className="fixed inset-0 z-[80] bg-[#06090a]/95 flex flex-col anim-fade" role="dialog" aria-modal="true" aria-label={d.name}>
      <div className="flex items-center gap-2 px-3 sm:px-5 pt-[calc(env(safe-area-inset-top,0px)+10px)] pb-2.5 border-b border-white/10 text-white">
        <button onClick={onClose} aria-label="Close" className="h-10 w-10 grid place-items-center rounded-full hover:bg-white/10"><Icon name="x" /></button>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold truncate">{d.name}</div>
          <div className="text-[12px] text-white/55">{isImage(d) ? 'Photo' : pages ? plural(pages, 'page', 'pages') : 'PDF'} · {fileSize(d.size)}</div>
        </div>
        {blob && <button onClick={share} className="btn h-9 px-3.5 text-[13px] bg-white/10 text-white hover:bg-white/20"><Icon name="upload" size={15} />{isTouch() ? 'Share / Save' : 'Download'}</button>}
        {blob && !isTouch() && <a href={url} target="_blank" rel="noopener" className="btn h-9 px-3.5 text-[13px] bg-white/10 text-white hover:bg-white/20"><Icon name="eye" size={15} />Open</a>}
      </div>
      <div className="flex-1 overflow-auto px-3 py-4 sm:p-6" style={{ touchAction: 'pan-x pan-y pinch-zoom' }}>
        {err ? (
          <div className="max-w-sm mx-auto mt-20 text-center text-white/80"><Icon name="cloud" size={28} className="mx-auto text-white/50" /><p className="mt-3 text-[15px]">{err}</p></div>
        ) : !blob ? (
          <div className="mt-24 flex flex-col items-center gap-3 text-white/70"><Icon name="refresh" size={24} className="animate-spin" /><span className="text-[14px]">Loading document…</span></div>
        ) : isImage(d) ? (
          <img src={url} alt={d.name} className="mx-auto max-w-full h-auto rounded-md" />
        ) : null}
        <div ref={pdfRef} className={`space-y-4 ${blob && !isImage(d) && !err ? '' : 'hidden'}`} />
      </div>
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

/** Round cognac app mark with a plane. */
function AppLogo({ size = 44 }: { size?: number }) {
  return (
    <span className="rounded-full grid place-items-center shrink-0 text-[#1a1009] shadow-[0_6px_18px_-6px_rgb(185_120_63/.7)]"
      style={{ width: size, height: size, background: 'radial-gradient(circle at 32% 28%, #ECB27A 0%, #C98846 45%, #8C5426 100%)' }}>
      <Icon name="plane" size={Math.round(size * 0.48)} stroke={2.2} />
    </span>
  );
}

const PROFILE_KEY = 'mtp:profile-name';
const profileName = () => { try { return localStorage.getItem(PROFILE_KEY) ?? 'Kian Gerowgan'; } catch { return 'Kian Gerowgan'; } };

/** Pull down at the top of a page to sync with Google Drive and look for a new app version. */
function PullToRefresh({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const st = useRef({ y0: 0, active: false, pull: 0, busy: false });
  const TRIGGER = 72;
  useEffect(() => {
    const s = st.current;
    const start = (e: TouchEvent) => {
      // only at the very top, and not while a sheet or dialog is open
      s.active = !s.busy && window.scrollY <= 0 && document.body.style.overflow !== 'hidden' && e.touches.length === 1;
      s.y0 = e.touches[0].clientY; s.pull = 0;
    };
    const move = (e: TouchEvent) => {
      if (!s.active) return;
      const dy = e.touches[0].clientY - s.y0;
      if (dy <= 0 || window.scrollY > 0) { if (s.pull) { s.pull = 0; setPull(0); } return; }
      s.pull = Math.min(130, dy * 0.55); setPull(s.pull);
    };
    const end = async () => {
      if (!s.active) return;
      s.active = false;
      const go = s.pull >= TRIGGER;
      s.pull = 0; setPull(0);
      if (!go) return;
      s.busy = true; setBusy(true);
      try { await Promise.all([onRefresh(), new Promise(r => setTimeout(r, 700))]); } finally { s.busy = false; setBusy(false); }
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    return () => { window.removeEventListener('touchstart', start); window.removeEventListener('touchmove', move); window.removeEventListener('touchend', end); window.removeEventListener('touchcancel', end); };
  }, [onRefresh]);
  const shown = busy ? TRIGGER : pull;
  if (!shown) return null;
  const ready = busy || pull >= TRIGGER;
  return (
    <div className="lg:hidden fixed inset-x-0 z-[46] flex justify-center pointer-events-none" style={{ top: `calc(env(safe-area-inset-top, 0px) + ${Math.round(shown * 0.6)}px)` }} aria-live="polite">
      <div className={`h-10 w-10 rounded-full grid place-items-center border shadow-lift transition-colors ${ready ? 'bg-primary text-white border-transparent' : 'bg-card text-muted border-line'}`}
        style={{ opacity: Math.min(1, shown / 40) }}>
        <span style={busy ? undefined : { transform: `rotate(${Math.round(pull * 3)}deg)` }} className="grid place-items-center"><Icon name="refresh" size={18} stroke={2} className={busy ? 'animate-spin' : ''} /></span>
        <span className="sr-only">{busy ? 'Refreshing' : ready ? 'Release to refresh' : 'Pull to refresh'}</span>
      </div>
    </div>
  );
}

/** Header button showing Google Drive sync status; tap to sync (or set up). */
function SyncButton() {
  const { sync } = useStore();
  const ok = sync.connected && sync.status === 'idle' && !sync.pending;
  const dot = !sync.connected ? 'bg-cognac' : sync.status === 'error' ? 'bg-danger' : ok ? 'bg-dot' : 'bg-cognac';
  return (
    <button onClick={() => (sync.connected ? sync.syncNow() : go('#/settings'))} aria-label={sync.connected ? syncLabel(sync) : 'Connect Google Drive'} title={sync.connected ? syncLabel(sync) : 'Saved on this device · tap to connect Google Drive'}
      className="relative h-11 w-11 rounded-full grid place-items-center bg-card border border-line text-ink">
      <Icon name={sync.status === 'syncing' ? 'refresh' : 'cloud'} size={19} className={sync.status === 'syncing' ? 'animate-spin' : ''} />
      <span className={`absolute top-2 right-2 h-2.5 w-2.5 rounded-full ring-2 ring-[rgb(var(--card))] ${dot}`} />
    </button>
  );
}

/** Prominent prompt when the Google sign-in has lapsed, so the latest data is fetched with one tap. */
function SyncReminder() {
  const { sync } = useStore();
  if (!sync.connected || (sync.status !== 'needs-auth' && sync.status !== 'error')) return null;
  return (
    <button onClick={sync.syncNow} className="anim-in w-full mb-5 flex items-center gap-3 rounded-2xl border border-petrol/50 bg-petrol/15 px-4 py-3 text-left">
      <span className="h-9 w-9 rounded-full grid place-items-center bg-petrol/25 text-petrol shrink-0"><Icon name="refresh" size={17} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-semibold text-ink">{sync.status === 'error' ? 'Sync problem – tap to retry' : 'Tap to update from Google Drive'}</span>
        <span className="block text-[12.5px] text-muted">{sync.pending ? 'You have changes waiting to be saved.' : 'Shows the latest trips from your other devices.'}</span>
      </span>
      <Icon name="right" size={16} className="text-muted shrink-0" />
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
        <Card title="Profile" icon="user">
          <label className="block max-w-sm"><span className="lbl">Your name (initials appear in the header)</span>
            <input id="profile-name" className="inp" defaultValue={profileName()} onChange={e => { try { localStorage.setItem(PROFILE_KEY, e.target.value); } catch { /* ignore */ } }} />
          </label>
        </Card>
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
  const linkedDocs = data.documents.filter((d: Doc) => d.activityIds.includes(a.id));

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
  if (trip?.travellers && trip.travellers.length > 1) facts.push(['Travellers', a.travellers?.length ? a.travellers.join(', ') : 'Everyone']);
  if (a.cost && a.cost.amount > 0) {
    const open = openAmount(a.cost);
    facts.push(['Price', `${fmtMoney(a.cost.amount, a.cost.currency)} · ${open <= 0 ? 'paid' : a.cost.paidAmount > 0 ? `${fmtMoney(open, a.cost.currency)} still open` : 'not paid yet'}${open > 0 && a.cost.due ? ` – due ${fmtShort(a.cost.due)}` : ''}`]);
  }

  const toggleTask = (tid: string) => updateActivity(a.id, (x: Activity) => ({ ...x, tasks: x.tasks.map(t => t.id === tid ? { ...t, done: !t.done } : t) }));
  const addTask = () => { if (!taskDraft.trim()) return; updateActivity(a.id, (x: Activity) => ({ ...x, tasks: [...x.tasks, { id: uid(), text: taskDraft.trim(), done: false }] })); setTaskDraft(''); };

  return (
    <Sheet onClose={onClose} label={a.title}>
      <SheetHead onClose={onClose} title={a.title} eyebrow={
        <div className="flex items-center gap-2.5">
          <div className={`h-9 w-9 rounded-xl grid place-items-center tone-tile tone-${toneOf(a.type)}`}><Icon name={meta.icon} size={18} /></div>
          <div className={`text-[11.5px] font-bold uppercase tracking-[0.13em] tone-ink tone-${toneOf(a.type)}`}>{meta.label}{trip ? <span className="text-muted font-medium normal-case tracking-normal"> · {trip.name}</span> : null}</div>
        </div>
      }>
        <div className="mt-1.5 text-[14.5px] font-semibold text-cognac">{when}</div>
        {(a.status || taxiTarget(a)) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusPill s={a.status} always />
            {taxiTarget(a) && <button onClick={() => ui.taxi(a.id)} className="btn h-9 px-3.5 text-[13px] bg-cognac text-[#1a1009]"><Icon name="car" size={15} />Show to driver</button>}
          </div>
        )}
      </SheetHead>

      <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-6 space-y-7">
        {isRoute && (
          <div className="rounded-3xl p-5 tone-card tone-transport">
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

        {(
          <section>
            <SectionTitle icon="check">{a.type === 'meeting' ? 'Follow-up tasks' : 'Tasks'}</SectionTitle>
            <div className="space-y-1.5">
              {a.tasks.map(t => (
                <div key={t.id} className="group flex items-start gap-3 rounded-xl px-1 py-1.5">
                  <button onClick={() => toggleTask(t.id)} aria-label={t.done ? 'Mark as open' : 'Mark as done'} className={`h-6 w-6 rounded-lg border-2 grid place-items-center shrink-0 transition ${t.done ? 'bg-primary border-primary text-white' : 'border-line hover:border-primary'}`}>{t.done && <Icon name="check" size={14} stroke={2.5} />}</button>
                  <span className="flex-1 min-w-0">
                    <span className={`block text-[15px] ${t.done ? 'line-through text-muted' : 'text-ink'}`}>{t.text}</span>
                    {!t.done && <span className="mt-1 block"><DueChip due={t.due} onChange={v => updateActivity(a.id, (x: Activity) => ({ ...x, tasks: x.tasks.map(y => y.id === t.id ? { ...y, due: v } : y) }))} /></span>}
                  </span>
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
          <SectionTitle icon="clip">Documents</SectionTitle>
          {linkedDocs.length ? <div className="space-y-2">{linkedDocs.map((d: Doc) => <DocRow key={d.id} d={d} activityId={a.id} showStages={false} />)}</div>
            : <div className="text-[14px] text-muted">No documents for this stage yet.</div>}
          <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <UploadButtons tripId={a.tripId} activityIds={[a.id]} compact />
            <button onClick={() => ui.linkExisting(a)} className="text-[13px] font-semibold text-petrol flex items-center gap-1 hover:underline"><Icon name="link" size={14} />Link from trip documents</button>
          </div>
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
    return { id: uid(), tripId: init.tripId, type: 'meeting', title: '', start: date + 'T09:00', startTz: tz, end: '', endTz: tz, city: (sameDay || prior)?.city || '', location: '', details: {}, contactIds: [], notes: [], tasks: [] };
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

        <div>
          <span className="lbl">Booking status</span>
          <Segmented value={f.status || 'confirmed'} onChange={v => set({ status: v as BookingStatus })} options={[{ value: 'confirmed', label: 'Confirmed' }, { value: 'pending', label: 'Pending' }, { value: 'planned', label: 'Not booked' }]} />
        </div>

        {trip?.travellers && trip.travellers.length > 1 && (
          <div>
            <span className="lbl">Who is travelling</span>
            <div className="flex flex-wrap gap-2">
              {trip.travellers.map(n => {
                const on = !f.travellers?.length || f.travellers.includes(n);
                const toggle = () => {
                  const cur = f.travellers?.length ? f.travellers : trip.travellers!;
                  const next = on ? cur.filter(x => x !== n) : [...cur, n];
                  set({ travellers: next.length && next.length < trip.travellers!.length ? trip.travellers!.filter(x => next.includes(x)) : undefined });
                };
                return <button key={n} onClick={toggle} aria-pressed={on} className={`rounded-full px-3.5 py-1.5 text-[13.5px] font-semibold border transition ${on ? 'bg-petrol-fill text-white border-transparent' : 'bg-card border-line text-muted'}`}>{n}</button>;
              })}
            </div>
            <p className="text-[12.5px] text-muted mt-1.5">{f.travellers?.length ? f.travellers.join(', ') : 'Everyone'}</p>
          </div>
        )}

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

        <div>
          <span className="lbl">Price</span>
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
            <input id="act-cost" className="inp" type="number" inputMode="decimal" step="0.01" min="0" placeholder="e.g. 412.00" value={f.cost?.amount ?? ''}
              onChange={e => { const v = e.target.value === '' ? NaN : +e.target.value; set({ cost: isNaN(v) ? undefined : { currency: 'EUR', ...f.cost, amount: v, paidAmount: !f.cost || f.cost.paidAmount >= f.cost.amount ? v : f.cost.paidAmount } }); }} />
            <input id="act-currency" className="inp uppercase" list="currencies" maxLength={3} value={f.cost?.currency || 'EUR'} disabled={!f.cost}
              onChange={e => f.cost && set({ cost: { ...f.cost, currency: e.target.value.toUpperCase() } })} aria-label="Currency" />
            <datalist id="currencies">{['EUR', 'USD', 'CNY', 'AED', 'SGD', 'IDR', 'GBP', 'CHF', 'HKD'].map(c => <option key={c} value={c} />)}</datalist>
          </div>
          {f.cost && (
            <div className="mt-3 space-y-3">
              <Segmented value={f.cost.paidAmount >= f.cost.amount ? 'paid' : f.cost.paidAmount > 0 ? 'part' : 'open'} onChange={v => set({ cost: { ...f.cost!, paidAmount: v === 'paid' ? f.cost!.amount : v === 'open' ? 0 : Math.min(f.cost!.paidAmount || 0, f.cost!.amount) || +(f.cost!.amount / 2).toFixed(2) } })}
                options={[{ value: 'paid', label: 'Paid' }, { value: 'part', label: 'Partly paid' }, { value: 'open', label: 'Not paid' }]} />
              {f.cost.paidAmount < f.cost.amount && (
                <div className="grid grid-cols-2 gap-3">
                  {f.cost.paidAmount > 0 && <Field label="Already paid"><input id="act-paid" className="inp" type="number" inputMode="decimal" step="0.01" min="0" value={f.cost.paidAmount} onChange={e => set({ cost: { ...f.cost!, paidAmount: Math.max(0, +e.target.value || 0) } })} /></Field>}
                  <Field label="Payment due"><input id="act-pay-due" className="inp" type="date" value={f.cost.due || ''} onChange={e => set({ cost: { ...f.cost!, due: e.target.value || undefined } })} /></Field>
                </div>
              )}
            </div>
          )}
        </div>

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
  const { saveTrip, setCover } = useStore();
  const ui = useUI();
  const td = todayStr();
  const existingCover = useCoverUrl(trip?.id || '');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverRemoved, setCoverRemoved] = useState(false);
  const coverPreview = useMemo(() => (coverFile ? URL.createObjectURL(coverFile) : ''), [coverFile]);
  const coverRef = useRef<HTMLInputElement>(null);
  const shownCover = coverPreview || (coverRemoved ? '' : existingCover);
  const [f, setF] = useState(() => trip ? { ...trip, countriesText: trip.countries.join(', '), citiesText: trip.cities.join(', '), travellersText: (trip.travellers || []).join(', ') }
    : { id: uid(), name: '', kind: 'business', countries: [], cities: [], start: td, end: addDays(td, 3), archived: false, countriesText: '', citiesText: '', travellersText: '' });
  const [err, setErr] = useState('');
  const set = (p: any) => setF((x: any) => ({ ...x, ...p }));
  const split = (s: string) => s.split(/[,→>]/).map(x => x.trim()).filter(Boolean);
  const submit = () => {
    if (!f.name.trim()) { setErr('Enter a name for the trip.'); return; }
    if (!f.start || !f.end || f.end < f.start) { setErr('The end date must be on or after the start date.'); return; }
    const { countriesText, citiesText, travellersText, ...rest } = f as any;
    const travellers = split(travellersText);
    saveTrip({ ...rest, name: f.name.trim(), countries: split(countriesText), cities: split(citiesText), travellers: travellers.length > 1 ? travellers : undefined });
    if (coverFile) setCover(f.id, coverFile);
    else if (coverRemoved) setCover(f.id, null);
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
        <div>
          <Field label="Travellers (optional)"><input id="trip-travellers" className="inp" value={(f as any).travellersText} placeholder="e.g. Kian, Leila, Minoo" onChange={e => set({ travellersText: e.target.value })} /></Field>
          <p className="text-[12.5px] text-muted mt-1.5">For trips with several people: you can then mark who is on each flight or hotel and filter the timeline per person.</p>
        </div>
        <div>
          <span className="lbl">Cover photo</span>
          <div className="flex items-center gap-4">
            {shownCover
              ? <img src={shownCover} alt="Cover photo" className="h-20 w-20 rounded-2xl object-cover border border-line" />
              : <div className="h-20 w-20 rounded-2xl border border-dashed border-line grid place-items-center text-muted"><Icon name="image" size={22} /></div>}
            <div className="flex flex-col items-start gap-1.5">
              <button className="btn btn-ghost h-10" onClick={() => coverRef.current?.click()}><Icon name="camera" size={16} />{shownCover ? 'Change photo' : 'Choose photo'}</button>
              {shownCover && <button className="text-[13px] font-semibold text-danger hover:underline px-1" onClick={() => { setCoverFile(null); setCoverRemoved(true); }}>Remove photo</button>}
            </div>
            <input id="trip-cover" ref={coverRef} type="file" accept="image/*" className="hidden" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) { setCoverFile(file); setCoverRemoved(false); } }} />
          </div>
          <p className="text-[12.5px] text-muted mt-2">Shown on the trip card. Saved with the trip in Google Drive.</p>
        </div>
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
  { key: 'trips', label: 'Trips', icon: 'plane', href: '#/trips' },
  { key: 'calendar', label: 'Calendar', icon: 'calendar', href: '#/calendar' },
  { key: 'contacts', label: 'Contacts', icon: 'users', href: '#/contacts' },
  { key: 'settings', label: 'Settings', icon: 'gear', href: '#/settings' },
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
  const [viewDocId, setViewDocId] = useState<string | null>(null);
  const [taxiId, setTaxiId] = useState<string | null>(null);
  const appUpdate = useUpdateCheck();
  const [stagePick, setStagePick] = useState<any>(null);
  const [existingFor, setExistingFor] = useState<Activity | null>(null);
  const toastTimer = useRef<any>(null);

  const ui = useMemo(() => ({
    openActivity: (id: string) => setActivityId(id),
    newActivity: (tripId: string, date?: string) => setActForm({ tripId, date }),
    editActivity: (a: Activity) => setActForm({ tripId: a.tripId, activity: a }),
    editTrip: (t: Trip | null) => setTripForm(t),
    openContact: (id: string) => setContactId(id),
    viewDoc: (id: string) => setViewDocId(id),
    taxi: (id: string) => setTaxiId(id),
    chooseStages: (tripId: string, docIds: string[], initial: string[]) => setStagePick({ tripId, docIds, initial }),
    linkExisting: (a: Activity) => setExistingFor(a),
    editContact: (c: Contact | null) => setContactForm(c),
    confirm: (s: any) => setConfirmState(s),
    toast: (m: string) => { setToastMsg(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(null), 2600); },
  }), []);

  const active = route.page === 'trip' ? 'trips' : route.page;
  const { sync } = useStore();
  // Pull-to-refresh: get the latest data from Drive and install a new app version if there is one.
  const refresh = useCallback(async () => {
    const [found] = await Promise.all([appUpdate.checkNow(), sync.connected ? sync.syncNow() : null]);
    if (!found) ui.toast(navigator.onLine ? (sync.connected ? 'Up to date' : 'App is up to date') : 'Offline – showing saved data');
  }, [appUpdate, sync, ui]);

  return (
    <UICtx.Provider value={ui}>
      <PullToRefresh onRefresh={refresh} />
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-64 bg-nav text-white flex-col z-30 border-r border-white/5">
        <a href="#/trips" className="px-5 pt-8 pb-10 block">
          <div className="flex items-center gap-3">
            <AppLogo size={42} />
            <div>
              <div className="font-display text-[18.7px] leading-tight">My Travel Planner</div>
              <div className="text-[12px] text-white/55 mt-0.5">Plan. Organize. Explore.</div>
            </div>
          </div>
        </a>
        <nav className="px-3 space-y-1">
          {NAV.map(n => (
            <a key={n.key} href={n.href} aria-current={active === n.key ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14.5px] font-semibold transition ${active === n.key ? 'bg-primary/60 text-white' : 'text-white/60 hover:text-white hover:bg-white/5'}`}>
              <Icon name={n.icon} size={18} />{n.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto px-4 py-5"><SyncBadge dark /></div>
      </aside>

      {/* Solid strip behind the iPhone status bar (clock, battery) so scrolling content doesn't run under it */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-[45] bg-cream h-[env(safe-area-inset-top,0px)]" aria-hidden="true" />
      {/* Mobile header: logo, name and tagline; sync status and profile on the right */}
      <header className="lg:hidden flex items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top,0px)+14px)] pb-3">
        <a href="#/trips" className="flex items-center gap-3 min-w-0">
          <AppLogo size={46} />
          <span className="min-w-0">
            <span className="block text-[20px] font-medium leading-tight tracking-[-0.01em] text-heading truncate">My Travel Planner</span>
            <span className="block text-[12.5px] text-muted">Plan. Organize. Explore.</span>
          </span>
        </a>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <SyncButton />
          <a href="#/settings" aria-label="Settings" className="h-11 w-11 rounded-full grid place-items-center bg-card border border-line text-[14px] font-semibold text-ink">{initials(profileName()) || <Icon name="user" size={18} />}</a>
        </div>
      </header>

      <main className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-10 pt-[10px] sm:pt-5 lg:pt-12 pb-32 lg:pb-16">
          <SyncReminder />
          {route.page === 'trips' && <TripsPage />}
          {route.page === 'trip' && <TripPage id={route.id} tab={route.tab} />}
          {route.page === 'calendar' && <CalendarPage />}
          {route.page === 'contacts' && <ContactsPage />}
          {route.page === 'settings' && <SettingsPage theme={theme} setTheme={setTheme} />}
        </div>
      </main>

      {/* Mobile bottom navigation: translucent dark green, active tab highlighted */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 rounded-t-[26px] bg-nav/85 backdrop-blur-xl border-t border-white/10 text-white pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-10px_30px_rgb(0_0_0/.35)]">
        <div className="grid grid-cols-4 gap-1 px-3 pt-2.5 pb-2">
          {NAV.map(n => (
            <a key={n.key} href={n.href} aria-current={active === n.key ? 'page' : undefined} className={`flex flex-col items-center justify-center gap-1 text-[12px] font-medium transition ${active === n.key ? 'text-white' : 'text-white/55 hover:text-white/80'}`}>
              <span className={`grid place-items-center h-9 w-full max-w-[86px] rounded-2xl transition ${active === n.key ? 'bg-primary/80' : ''}`}><Icon name={n.icon} size={21} /></span>
              {n.label}
            </a>
          ))}
        </div>
      </nav>

      {activityId && <ActivityDetail id={activityId} onClose={() => setActivityId(null)} />}
      {contactId && <ContactDetail id={contactId} onClose={() => setContactId(null)} />}
      {stagePick && <StagePicker {...stagePick} onClose={() => setStagePick(null)} />}
      {existingFor && <ExistingDocPicker activity={existingFor} onClose={() => setExistingFor(null)} />}
      {viewDocId && <DocViewer id={viewDocId} onClose={() => setViewDocId(null)} />}
      {taxiId && <TaxiCard id={taxiId} onClose={() => setTaxiId(null)} />}
      {actForm && <ActivityForm init={actForm} onClose={() => setActForm(null)} />}
      {tripForm !== undefined && <TripForm trip={tripForm} onClose={() => setTripForm(undefined)} />}
      {contactForm !== undefined && <ContactForm contact={contactForm} onClose={() => setContactForm(undefined)} />}
      {confirmState && <ConfirmDialog state={confirmState} onClose={() => setConfirmState(null)} />}
      <SyncPrompts />

      {appUpdate.available && (
        <div className="fixed z-[65] inset-x-0 flex justify-center px-4 bottom-[calc(env(safe-area-inset-bottom,0px)+80px)] lg:bottom-6 lg:pl-64">
          <button onClick={appUpdate.update} className="anim-in rounded-full bg-primary text-white px-5 py-3 text-[14px] font-semibold shadow-lift flex items-center gap-2"><Icon name="refresh" size={16} />New version available · Update</button>
        </div>
      )}
      {toastMsg && (
        <div className="fixed z-[70] inset-x-0 flex justify-center px-4 pointer-events-none bottom-[calc(env(safe-area-inset-bottom,0px)+86px)] lg:bottom-8 lg:pl-64">
          <div className="anim-in rounded-full bg-nav text-white border border-white/10 px-5 py-3 text-[14px] font-semibold shadow-lift flex items-center gap-2"><Icon name="check" size={16} className="text-[#E8BB91]" />{toastMsg}</div>
        </div>
      )}
    </UICtx.Provider>
  );
}