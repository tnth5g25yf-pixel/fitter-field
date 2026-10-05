/*
 * FitterField voice commands — server helpers.
 *
 * The model turns a spoken sentence into a list of app actions. Nothing the
 * model returns is trusted: sanitizeVoicePlan() keeps only known action types,
 * known screens/fields, and length-limited text. The browser validates again
 * before it touches the page.
 *
 * Deliberately NOT available by voice: ticking inspection checklist items,
 * emailing, printing, clearing, or deleting. Those stay as manual taps.
 */

const VIEWS = {
  dashboard: 'Dashboard',
  tools: 'Field Tools',
  reference: 'Reference',
  notes: 'Job Notes',
  safety: 'Safety Forms',
  workbook: 'Workbook',
  challenges: 'Challenges',
  progress: 'Progress'
};
const SAFETY_TABS = ['jsa', 'equipment', 'saved'];
const EQUIPMENT_TYPES = ['Scissor Lift', 'Boom Lift', 'Forklift', 'Other Powered Equipment'];
const NOTE_CATEGORIES = ['Measurements', 'Materials', 'Issue', 'Follow-up', 'General'];
const JSA_HAZARDS = [
  'Falls / elevated work',
  'Struck-by / falling objects',
  'Caught-between / pinch points',
  'Electrical',
  'Mobile equipment / traffic',
  'Lifting / material handling',
  'Hot work / fire',
  'Chemicals / hazardous materials',
  'Noise / dust',
  'Other'
];
const LESSON_COUNT = 5;

// Max characters per field. 'date' means YYYY-MM-DD.
const FIELD_LIMITS = {
  jsa: { company: 120, job: 160, date: 'date', supervisor: 120, location: 200, task: 1500, controls: 1500, ppe: 300, emergency: 300, notes: 1500 },
  equipment: { unitId: 80, date: 'date', inspector: 120, hours: 60, location: 200, defects: 1500, action: 1500 },
  note: { jobName: 160, text: 2000 }
};

const VOICE_SYSTEM_PROMPT = `You are the voice-command router for FitterField, a field app for fire sprinkler professionals. The user speaks; you translate what they said into app actions. You do not chat.

Reply with ONE JSON object and nothing else:
{"say":"<confirmation, max 12 words>","actions":[ ... ]}

SCREENS ("view"): dashboard (home and stats), tools (feet+inches converter, fraction to decimal, decimal to inches, pipe run total), reference (fittings, field checklist, trade terms), notes (job notes), safety (safety and inspection forms), workbook (5 lessons), challenges (quiz questions), progress.
The safety screen has three tabs: jsa (Job Safety Analysis), equipment (equipment pre-use inspection), saved (saved forms).
Lessons: 1 Field Measurements, 2 Fittings & Components, 3 Job Documentation, 4 Field Math, 5 Worksite Readiness.

ACTIONS:
- {"type":"navigate","view":"<screen>"}
- {"type":"safety_tab","tab":"jsa|equipment|saved"}
- {"type":"fill","form":"jsa","fields":{"company","job","date","supervisor","location","task","controls","ppe","emergency","notes","hazards":[...]}}
- {"type":"fill","form":"equipment","fields":{"equipment":"Scissor Lift|Boom Lift|Forklift|Other Powered Equipment","unitId","date","inspector","hours","location","defects","action","outOfService":true}}
- {"type":"fill","form":"note","fields":{"jobName","category":"Measurements|Materials|Issue|Follow-up|General","text"}}
- {"type":"calc","tool":"length","feet":n,"inches":n}
- {"type":"calc","tool":"fraction","fraction":"3/8"}
- {"type":"calc","tool":"decimal","decimal":n}
- {"type":"calc","tool":"pipe","pieces":n,"length":n}   (length in inches)
- {"type":"save","what":"note|jsa|equipment"}
- {"type":"complete_lesson","lesson":1-5}
- {"type":"ask","question":"<clear question>"}
- {"type":"help"}

JSA hazards must be chosen only from: ${JSA_HAZARDS.map(h => `"${h}"`).join(', ')}.

RULES:
- Chain actions in order when the user asks for several things. "Start a JSA for Warehouse 12, second floor" -> safety_tab jsa, then fill jsa with job "Warehouse 12" and location "Second floor".
- Include a field only if the user actually said it. Never invent names, dates, IDs, hazards, measurements, or inspection results.
- Dates are YYYY-MM-DD, resolved from "Today" in the input ("yesterday", "Friday").
- For dictated notes and descriptions, remove filler words but keep the meaning. Do not add facts.
- Use a calc action for conversions and pipe totals. Do NOT state numeric results in "say" (the app calculates them); say something like "Running that conversion."
- Knowledge questions, explanations, how-to, or anything that needs a real answer -> one "ask" action with the question rewritten clearly. "say" can be empty.
- Not available by voice: ticking inspection checks, emailing, printing, clearing, deleting. If asked, return no action for it and say to do it on screen.
- If you cannot tell what they want, return "actions":[] and put a short clarifying question in "say".
- Output valid JSON only. No markdown, no commentary.`;

function cleanText(value, max) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) < 1e7 ? n : null;
}

function sanitizeFill(action) {
  const form = action.form;
  const limits = FIELD_LIMITS[form];
  if (!limits) return null;
  const src = action.fields && typeof action.fields === 'object' ? action.fields : {};
  const fields = {};

  for (const [key, max] of Object.entries(limits)) {
    const raw = src[key];
    if (raw === null || raw === undefined) continue;
    if (max === 'date') {
      const d = String(raw);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d))) fields[key] = d;
    } else {
      const t = cleanText(raw, max);
      if (t) fields[key] = t;
    }
  }

  if (form === 'jsa' && Array.isArray(src.hazards)) {
    const hazards = [...new Set(src.hazards.filter(h => JSA_HAZARDS.includes(h)))];
    if (hazards.length) fields.hazards = hazards;
  }
  if (form === 'equipment') {
    if (EQUIPMENT_TYPES.includes(src.equipment)) fields.equipment = src.equipment;
    if (src.outOfService === true) fields.outOfService = true; // voice can raise the flag, never lower it
  }
  if (form === 'note' && NOTE_CATEGORIES.includes(src.category)) fields.category = src.category;

  return Object.keys(fields).length ? { type: 'fill', form, fields } : null;
}

function sanitizeCalc(action) {
  switch (action.tool) {
    case 'length': {
      const feet = finiteNumber(action.feet);
      const inches = finiteNumber(action.inches);
      if (feet === null && inches === null) return null;
      return { type: 'calc', tool: 'length', feet: feet ?? 0, inches: inches ?? 0 };
    }
    case 'fraction':
      return /^\d{1,4}\/\d{1,4}$/.test(String(action.fraction || '')) && Number(String(action.fraction).split('/')[1]) !== 0
        ? { type: 'calc', tool: 'fraction', fraction: String(action.fraction) }
        : null;
    case 'decimal': {
      const decimal = finiteNumber(action.decimal);
      return decimal === null ? null : { type: 'calc', tool: 'decimal', decimal };
    }
    case 'pipe': {
      const pieces = finiteNumber(action.pieces);
      const length = finiteNumber(action.length);
      return pieces === null || length === null ? null : { type: 'calc', tool: 'pipe', pieces, length };
    }
    default:
      return null;
  }
}

function sanitizeAction(action) {
  if (!action || typeof action !== 'object') return null;
  switch (action.type) {
    case 'navigate':
      return VIEWS[action.view] ? { type: 'navigate', view: action.view } : null;
    case 'safety_tab':
      return SAFETY_TABS.includes(action.tab) ? { type: 'safety_tab', tab: action.tab } : null;
    case 'fill':
      return sanitizeFill(action);
    case 'calc':
      return sanitizeCalc(action);
    case 'save':
      return ['note', 'jsa', 'equipment'].includes(action.what) ? { type: 'save', what: action.what } : null;
    case 'complete_lesson': {
      const lesson = finiteNumber(action.lesson);
      return Number.isInteger(lesson) && lesson >= 1 && lesson <= LESSON_COUNT ? { type: 'complete_lesson', lesson } : null;
    }
    case 'ask': {
      const question = cleanText(action.question, 400);
      return question ? { type: 'ask', question } : null;
    }
    case 'help':
      return { type: 'help' };
    default:
      return null;
  }
}

function sanitizeVoicePlan(raw) {
  const plan = { say: '', actions: [] };
  if (!raw || typeof raw !== 'object') return plan;
  plan.say = cleanText(raw.say, 160);
  const list = Array.isArray(raw.actions) ? raw.actions.slice(0, 8) : [];
  for (const item of list) {
    const clean = sanitizeAction(item);
    if (clean) plan.actions.push(clean);
  }
  return plan;
}

function parseJsonLoose(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { /* fall through */ }
  }
  return null;
}

function buildVoiceInput(transcript, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const view = VIEWS[ctx.view] ? ctx.view : 'dashboard';
  const tab = view === 'safety' && SAFETY_TABS.includes(ctx.formTab) ? ` (tab: ${ctx.formTab})` : '';
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.today || '')) ? ctx.today : new Date().toISOString().slice(0, 10);
  const equipment = EQUIPMENT_TYPES.includes(ctx.equipmentType) ? `\nEquipment type currently selected: ${ctx.equipmentType}` : '';
  return `Current screen: ${view}${tab}\nToday: ${today}${equipment}\nThe user said: """${cleanText(transcript, 600)}"""\nReturn the JSON object.`;
}

module.exports = {
  VIEWS,
  VOICE_SYSTEM_PROMPT,
  sanitizeVoicePlan,
  parseJsonLoose,
  buildVoiceInput
};