// The in-app travel assistant: a Claude tool-use loop that runs in the browser with the user's own
// API key (stored only on this device). Claude can read the trip data and Gmail, and it can only
// *propose* changes — the app shows each proposal and applies it when the user taps Apply.
import Anthropic from '@anthropic-ai/sdk';
import * as gmail from './gmail';

const KEY = 'mtp:anthropic-key';
const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 16;

export const getApiKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setApiKey = (k: string) => { try { k ? localStorage.setItem(KEY, k.trim()) : localStorage.removeItem(KEY); } catch { /* ignore */ } };

export type Op =
  | { op: 'upsert_trip'; trip: any }
  | { op: 'upsert_activity'; activity: any }
  | { op: 'upsert_contact'; contact: any }
  | { op: 'delete'; kind: 'trip' | 'activity' | 'contact' | 'document'; id: string }
  | { op: 'attach_email_file'; messageId: string; filename: string; tripId: string; activityIds?: string[]; name?: string };

export interface Proposal { id: string; summary: string; ops: Op[]; status: 'pending' | 'applied' | 'discarded' | 'failed'; error?: string; }
export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'activity'; text: string }
  | { kind: 'proposal'; proposal: Proposal }
  | { kind: 'error'; text: string };

/* ---------- Conversation state (module level, so it survives switching tabs) ---------- */
interface ChatState { items: ChatItem[]; busy: boolean; }
let state: ChatState = { items: [], busy: false };
let messages: Anthropic.Beta.BetaMessageParam[] = [];
let decisions: string[] = []; // proposal outcomes to tell Claude with the next user message
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(f => f());
const set = (p: Partial<ChatState>) => { state = { ...state, ...p }; emit(); };
const push = (it: ChatItem) => set({ items: [...state.items, it] });

export const chatStore = {
  get: () => state,
  subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
  reset: () => { if (state.busy) return; messages = []; decisions = []; set({ items: [] }); },
  /** Records the user's decision on a proposal; Claude hears about it with the next message. */
  decide: (id: string, status: Proposal['status'], error?: string) => {
    set({ items: state.items.map(it => it.kind === 'proposal' && it.proposal.id === id ? { ...it, proposal: { ...it.proposal, status, error } } : it) });
    decisions.push(`Proposal ${id}: ${status === 'applied' ? 'APPLIED by the user' : status === 'discarded' ? 'DISCARDED by the user' : 'FAILED to apply – ' + error}`);
  },
};

/* ---------- System prompt and tools (stable → cached) ---------- */
const SYSTEM = `You are the assistant inside "My Travel Planner", Kian's personal travel app (a PWA on his iPhone). You help him keep his trips up to date: you read his trip data and his Gmail, and you propose changes that he applies with one tap.

Language: answer in the language Kian writes in (mostly German, sometimes English). Keep chat replies short and practical — he is often on the phone. Write the data itself (titles, notes, tasks) in English.

## How you work
- Use read_travel_data before answering questions about trips or proposing changes. Never guess what is in the data.
- Use search_gmail / read_email / read_email_attachment to find bookings. Start with recent mail (newer_than:14d) and widen if needed.
- You cannot change anything directly. Use propose_changes: the app shows the proposal as a card with "Apply" and "Discard". After proposing, give a one- or two-line summary and stop; do not ask "shall I?" — the card is the question. You will be told with Kian's next message whether he applied or discarded it.
- Put everything that belongs together into ONE proposal (e.g. a new trip with its flights and hotel). If something is uncertain, still propose what is clear and say what is missing.
- Before adding, compare with existing entries (same flight number + date, same hotel + dates, same booking code). Update existing items instead of creating duplicates.

## Kian's rules
1. Never store booking PINs, passwords, card numbers or passport numbers. Booking codes, e-ticket numbers and ticket numbers are fine.
2. Kian's family travels as Lufthansa staff (myIDTravel / "My Private Travel Manager"). Standby or waitlist listings (R1, R2, R4, "R4 Extra standby", "GELISTET", "Warteliste") get status "pending". This is normal — never warn about it or add tasks about it. Child fares on the Frankfurt Airport Shuttle are agreed with the provider — never flag them.
3. Don't invent facts. Unknown time/address/code → leave the field empty; if useful add a task (e.g. "Confirm meeting time with …").
4. When a booking still needs action, add a task, e.g. "Buy the e-ticket (“etix kaufen”) in My Private Travel Manager", "Submit Singapore Arrival Card (SGAC) – within 3 days before arrival", "Book hotel in …".
5. Family: Kian, Leila, Minoo, Nima, Alea (Nima and Alea are children, "CHD" in airline mails). Use first names in "travellers".

## Reading booking mails
- myIDTravel (from:myidtravel.com): "Buchungs/Listing Bestätigung" = new listing, "Stornierungsbestätigung" = cancelled. A rebooking usually appears as a cancellation plus a new booking code: update the existing flight (bookingRef, status, note) rather than adding a second one. Read the names table to set "travellers".
- Also: Lufthansa, Emirates, Singapore Airlines, Scoot, Kiwi.com, Booking.com and hotels, Frankfurt Airport Shuttles (BusWorld), Trip.com, train operators.
- PDF tickets and vouchers can be attached to an entry with the attach_email_file operation.

## Data model
Trip: { id, name, kind: "business"|"private", countries: string[], cities: string[], start: "YYYY-MM-DD", end: "YYYY-MM-DD", archived: false, travellers?: string[] }
Activity (one entry on a trip timeline):
{ id, tripId, type: "flight"|"hotel"|"meeting"|"train"|"transfer"|"personal", title,
  start: "YYYY-MM-DDTHH:mm", startTz: IANA zone, end?: "YYYY-MM-DDTHH:mm", endTz?: IANA zone,
  city?, location?, details: { string: string }, contactIds: string[],
  notes: [{ text }], tasks: [{ text, done, due?: "YYYY-MM-DD" }],
  status?: "confirmed"|"pending"|"planned", travellers?: string[],
  cost?: { amount: number, currency: "EUR", paidAmount: number, due?: "YYYY-MM-DD" } }
- Times are LOCAL wall-clock times at that place with the matching IANA zone (Europe/Berlin, Asia/Dubai, Asia/Singapore, Asia/Shanghai, Asia/Makassar for Bali …). A flight's end uses the arrival zone. Never convert to UTC.
- status: confirmed = booked; pending = standby / not yet confirmed; planned = not booked yet.
- travellers: subset of the trip's travellers; omit when everyone on the trip takes part.
- details keys by type:
  flight: airline, flightNo ("LH 780"), from ("Frankfurt (FRA)"), to, terminal, seat, bookingRef ("7756BI (myIDTravel)")
  hotel: address, bookingRef, room, phone, nameLocal, addressLocal (local-script name/address) — start = check-in, end = check-out
  meeting: company, contactPhone, agenda (multi-line)
  train: operator, trainNo, from, to, seat, bookingRef
  transfer: mode, provider, from, to, phone
  personal: description
- Flight title format: "Flight Frankfurt → Singapore". Hotel title: the hotel name.
Contact: { id, name, company, position, phone, email, country, city, notes }

## propose_changes operations
- upsert_trip { trip }: new trip → omit id or give a short slug like "istanbul-2027-03" (activities in the same proposal may reference it). Existing trip → give its id and only the fields that change.
- upsert_activity { activity }: new → omit id, include tripId and all known fields. Existing → give its id and only the changed fields; "details" is merged key by key; "notes" and "tasks", if given, replace the whole list (so include the existing ones you want to keep).
- upsert_contact { contact }: same rules.
- delete { kind, id }: remove a trip (with all its entries), activity, contact or document.
- attach_email_file { messageId, filename, tripId, activityIds, name? }: saves an e-mail attachment as a trip document linked to the given entries. For a new entry in the same proposal you don't know the id yet: give that activity an id yourself (short, e.g. "new-hotel-1") and reference it.`;

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: 'read_travel_data',
    description: 'Returns the current trip data as JSON. Without tripId: all trips, activities, contacts and documents. With tripId: that trip, its activities and documents, and the contacts they reference.',
    input_schema: { type: 'object', properties: { tripId: { type: 'string', description: 'Optional trip id to limit the result.' } } },
  },
  {
    name: 'search_gmail',
    description: 'Searches Kian\'s Gmail (read only) with Gmail search syntax, e.g. "newer_than:14d (flight OR booking OR hotel)", "from:myidtravel.com newer_than:30d". Returns id, date, sender, subject, snippet and attachment names of each match.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer', description: 'Max results, default 15, at most 30.' } }, required: ['query'] },
  },
  {
    name: 'read_email',
    description: 'Returns the full text of one e-mail (headers, body as plain text, list of attachments).',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'read_email_attachment',
    description: 'Reads an attachment of an e-mail by file name. PDFs and images are returned for you to read; text files (.ics, .txt, .csv) as text.',
    input_schema: { type: 'object', properties: { messageId: { type: 'string' }, filename: { type: 'string' } }, required: ['messageId', 'filename'] },
  },
  {
    name: 'propose_changes',
    description: 'Shows Kian a proposal card with the listed changes and Apply / Discard buttons. Nothing changes until he taps Apply. See the system prompt for the operation formats.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One short line in Kian\'s language describing the proposal.' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['upsert_trip', 'upsert_activity', 'upsert_contact', 'delete', 'attach_email_file'] },
              trip: { type: 'object' }, activity: { type: 'object' }, contact: { type: 'object' },
              kind: { type: 'string', enum: ['trip', 'activity', 'contact', 'document'] }, id: { type: 'string' },
              messageId: { type: 'string' }, filename: { type: 'string' }, tripId: { type: 'string' },
              activityIds: { type: 'array', items: { type: 'string' } }, name: { type: 'string' },
            },
            required: ['op'],
          },
        },
      },
      required: ['summary', 'operations'],
    },
  },
];

/* ---------- Tool execution ---------- */
function travelData(data: any, tripId?: string) {
  const { trips, activities, contacts, documents } = data;
  const docs = (documents || []).filter((d: any) => !d.cover).map(({ id, tripId, name, activityIds }: any) => ({ id, tripId, name, activityIds }));
  if (!tripId) return { trips, activities, contacts, documents: docs };
  const trip = trips.find((t: any) => t.id === tripId);
  if (!trip) return { error: `No trip with id "${tripId}". Trips: ${trips.map((t: any) => `${t.id} (${t.name})`).join(', ')}` };
  const acts = activities.filter((a: any) => a.tripId === tripId);
  const cids = new Set(acts.flatMap((a: any) => a.contactIds || []));
  return { trip, activities: acts, documents: docs.filter((d: any) => d.tripId === tripId), contacts: contacts.filter((c: any) => cids.has(c.id)) };
}

let proposalSeq = 0;
async function runTool(name: string, input: any, getData: () => any): Promise<Anthropic.Beta.BetaToolResultBlockParam['content']> {
  switch (name) {
    case 'read_travel_data':
      push({ kind: 'activity', text: 'Reading your trips…' });
      return JSON.stringify(travelData(getData(), input.tripId));
    case 'search_gmail':
      push({ kind: 'activity', text: `Searching Gmail: ${input.query}` });
      return JSON.stringify(await gmail.searchMail(input.query, input.max || 15));
    case 'read_email':
      push({ kind: 'activity', text: 'Reading an e-mail…' });
      return JSON.stringify(await gmail.readMail(input.id));
    case 'read_email_attachment': {
      push({ kind: 'activity', text: `Reading ${input.filename}` });
      const a = await gmail.getAttachment(input.messageId, input.filename);
      if (a.mime === 'application/pdf' || /\.pdf$/i.test(a.filename)) return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.b64 } }];
      if (/^image\/(png|jpeg|gif|webp)$/.test(a.mime)) return [{ type: 'image', source: { type: 'base64', media_type: a.mime as any, data: a.b64 } }];
      return new TextDecoder().decode(Uint8Array.from(atob(a.b64), c => c.charCodeAt(0))).slice(0, 40000);
    }
    case 'propose_changes': {
      const ops = Array.isArray(input.operations) ? input.operations : [];
      if (!ops.length) return 'Error: the proposal has no operations.';
      const proposal: Proposal = { id: `P${++proposalSeq}`, summary: String(input.summary || 'Changes'), ops, status: 'pending' };
      push({ kind: 'proposal', proposal });
      return `Proposal ${proposal.id} is now shown to Kian with Apply / Discard buttons. Do not repeat it; summarize briefly and end your turn.`;
    }
  }
  return `Error: unknown tool ${name}`;
}

/* ---------- The loop ---------- */
function friendlyError(e: any) {
  if (e instanceof Anthropic.AuthenticationError) return 'The Claude API key was rejected. Check it in Settings › Assistant.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'The Claude API key has no access to this model.';
  if (e instanceof Anthropic.RateLimitError) return 'Claude is rate-limited right now. Try again in a minute.';
  if (e instanceof Anthropic.BadRequestError) return 'Claude rejected the request: ' + (e.message || '').slice(0, 300);
  if (e instanceof Anthropic.APIConnectionError) return 'No connection to Claude. Check your internet connection.';
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${(e.message || '').slice(0, 300)}`;
  return e?.message || String(e);
}

const today = () => {
  const n = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${n.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${n.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (${tz})`;
};

export async function send(text: string, getData: () => any) {
  const key = getApiKey();
  if (!key) { push({ kind: 'error', text: 'Add your Claude API key in Settings › Assistant first.' }); return; }
  if (state.busy || !text.trim()) return;
  push({ kind: 'user', text: text.trim() });
  set({ busy: true });

  const context = [`[Now: ${today()}]`, ...decisions.map(d => `[${d}]`)].join('\n');
  const pending = decisions;
  decisions = [];
  const startLen = messages.length;
  messages.push({ role: 'user', content: `${context}\n\n${text.trim()}` });

  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: SYSTEM }],
        tools: TOOLS,
        messages,
      });
      // Keep the full content (incl. thinking blocks) so the history stays append-only.
      messages.push({ role: 'assistant', content: res.content as any });
      const said = res.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n').trim();
      if (said) push({ kind: 'assistant', text: said });

      if (res.stop_reason === 'refusal') { push({ kind: 'error', text: 'Claude declined this request.' }); break; }
      if (res.stop_reason === 'max_tokens') { push({ kind: 'error', text: 'The answer was cut off (too long).' }); break; }
      if (res.stop_reason !== 'tool_use') break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const b of res.content) {
        if (b.type !== 'tool_use') continue;
        try { results.push({ type: 'tool_result', tool_use_id: b.id, content: await runTool(b.name, b.input, getData) }); }
        catch (e: any) {
          const msg = e instanceof gmail.GmailAuthError ? 'Gmail is not connected. Tell Kian to tap "Connect Gmail" in the assistant and then ask again.' : `Error: ${e?.message || e}`;
          if (e instanceof gmail.GmailAuthError) push({ kind: 'error', text: 'Gmail is not connected – tap “Connect Gmail” above.' });
          results.push({ type: 'tool_result', tool_use_id: b.id, content: msg, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
      if (step === MAX_STEPS - 1) push({ kind: 'error', text: 'Stopped after too many steps. Ask again more specifically.' });
    }
  } catch (e) {
    // Drop this whole turn so the conversation can continue cleanly (the history stays a prefix).
    messages.length = startLen;
    decisions = [...pending, ...decisions];
    push({ kind: 'error', text: friendlyError(e) });
  } finally {
    set({ busy: false });
  }
}
