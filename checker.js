// Cold email copy checker + spintax converter. Pure, dependency-free; runs in the browser and Node.
//
// parse(text, dialect)      -> { nodes, errors }   dialect: "smartlead" | "instantly" | "plusvibe"
// render(nodes, dialect)    -> { text, warnings }
// convert(text, from, to)   -> { text, warnings, errors }
// detectDialect(text)       -> dialect
// check({ subject, body, dialect }) -> { findings, stats, variants }
//
// Node shapes: { t: "text", v } | { t: "var", name, fallback } | { t: "spin", options: Node[][] }
// Variable names are kept in a canonical snake_case form inside the tree.

// ── Variables ───────────────────────────────────────────────────────────────
const CANON = {
  // canonical      smartlead         instantly                   plusvibe
  first_name: { smartlead: "first_name", instantly: "firstName", plusvibe: "first_name" },
  last_name: { smartlead: "last_name", instantly: "lastName", plusvibe: "last_name" },
  company_name: { smartlead: "company_name", instantly: "companyName", plusvibe: "company_name" },
  email: { smartlead: "email", instantly: "email", plusvibe: "email" },
  phone: { smartlead: "phone_number", instantly: "phone", plusvibe: "phone_number" },
  website: { smartlead: "website", instantly: "website", plusvibe: "custom_website" },
  sender_first_name: { smartlead: "%sender-firstname%", instantly: "sendingAccountFirstName", plusvibe: "sender_first_name" },
  sender_name: { smartlead: "%sender-name%", instantly: "sendingAccountFirstName", plusvibe: "sender_first_name" },
  sender_signature: { smartlead: "%signature%", instantly: null, plusvibe: "sender_signature" },
};
const REVERSE = { smartlead: {}, instantly: {}, plusvibe: {} };
for (const [canon, by] of Object.entries(CANON)) for (const [d, n] of Object.entries(by)) if (n && !(n in REVERSE[d])) REVERSE[d][n] = canon;

const camelToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

function toCanon(name, dialect) {
  const n = name.trim();
  if (REVERSE[dialect][n]) return REVERSE[dialect][n];
  if (dialect === "instantly") return camelToSnake(n);
  if (dialect === "plusvibe" && n.startsWith("custom_")) return n.slice(7);
  return n;
}

function fromCanon(canon, dialect) {
  if (CANON[canon]) return CANON[canon][dialect];
  if (dialect === "instantly") return snakeToCamel(canon);
  if (dialect === "plusvibe") return `custom_${canon}`;
  return canon;
}

// ── Parser ──────────────────────────────────────────────────────────────────
// One recursive-descent parser for all three syntaxes.
export function parse(input, dialect) {
  const s = String(input ?? "");
  const errors = [];
  let i = 0;

  const pushText = (nodes, ch) => {
    const last = nodes[nodes.length - 1];
    if (last && last.t === "text") last.v += ch;
    else nodes.push({ t: "text", v: ch });
  };

  // Read the inside of {{ ... }} up to the matching }}, allowing nested {{ }}.
  function readDouble() {
    const start = i;
    i += 2;
    let depth = 1;
    while (i < s.length) {
      if (s.startsWith("{{", i)) { depth++; i += 2; continue; }
      if (s.startsWith("}}", i)) { depth--; i += 2; if (!depth) return s.slice(start + 2, i - 2); continue; }
      i++;
    }
    errors.push(`"{{" at character ${start + 1} is never closed with "}}".`);
    return null;
  }

  // Split on "|" at the top level only (not inside nested braces).
  function splitTop(inner) {
    const parts = [];
    let depth = 0;
    let cur = "";
    for (let k = 0; k < inner.length; k++) {
      const c = inner[k];
      if (c === "{") depth++;
      if (c === "}") depth--;
      if (c === "|" && depth === 0) { parts.push(cur); cur = ""; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts;
  }

  const sub = (text) => {
    const r = parse(text, dialect);
    errors.push(...r.errors);
    return r.nodes;
  };

  function varNode(inner) {
    const [name, ...rest] = splitTop(inner);
    const fallback = rest.length ? rest.join("|").trim() : null;
    if (!name.trim()) errors.push(`Empty variable "{{${inner}}}".`);
    return { t: "var", name: toCanon(name, dialect), fallback };
  }

  function seq(stopAt) {
    const nodes = [];
    while (i < s.length) {
      const c = s[i];
      if (stopAt && stopAt.includes(c)) return nodes;

      if (dialect === "smartlead") {
        const sender = s.slice(i).match(/^%(sender-name|sender-firstname|sender-first-name|signature)%/i);
        if (sender) {
          const key = { "sender-name": "sender_name", "sender-firstname": "sender_first_name", "sender-first-name": "sender_first_name", signature: "sender_signature" }[sender[1].toLowerCase()];
          nodes.push({ t: "var", name: key, fallback: null });
          i += sender[0].length;
          continue;
        }
        if (s.startsWith("{{", i)) {
          const inner = readDouble();
          if (inner != null) nodes.push(varNode(inner));
          continue;
        }
        if (c === "{") {
          const start = i;
          i++;
          const options = [seq(["|", "}"])];
          while (s[i] === "|") { i++; options.push(seq(["|", "}"])); }
          if (s[i] !== "}") { errors.push(`Spintax "{" at character ${start + 1} is never closed.`); return nodes; }
          i++;
          if (options.length < 2) errors.push(`"{${s.slice(start + 1, i - 1)}}" has braces but no "|": not spintax, and it will print as literal text.`);
          nodes.push({ t: "spin", options });
          continue;
        }
        if (c === "}") { errors.push(`Stray "}" at character ${i + 1}.`); i++; continue; }
        pushText(nodes, c);
        i++;
        continue;
      }

      // Instantly and PlusVibe: everything special lives in {{ }}
      if (s.startsWith("{{", i)) {
        const start = i;
        const inner = readDouble();
        if (inner == null) continue;
        const spin = inner.match(/^\s*random\s*\|([\s\S]*)$/i);
        const fb = dialect === "plusvibe" && inner.match(/^\s*fallback\s*\|\s*\{\{([^{}]+)\}\}\s*\|([\s\S]*)$/i);
        if (spin) {
          const opts = splitTop(spin[1]).map((o) => sub(dialect === "instantly" ? o.trim() : o));
          if (opts.length < 2) errors.push(`RANDOM block at character ${start + 1} has only one option.`);
          nodes.push({ t: "spin", options: opts });
        } else if (fb) {
          nodes.push({ t: "var", name: toCanon(fb[1], dialect), fallback: fb[2].trim() });
        } else {
          nodes.push(varNode(inner));
        }
        continue;
      }
      if (c === "{" || c === "}") errors.push(`Single "${c}" at character ${i + 1}: ${dialect === "instantly" ? "Instantly" : "PlusVibe"} uses double braces, so this prints as-is.`);
      pushText(nodes, c);
      i++;
    }
    return nodes;
  }

  const nodes = seq(null);
  return { nodes, errors };
}

// ── Renderer ────────────────────────────────────────────────────────────────
export function render(nodes, dialect) {
  const warnings = [];
  function varText(n) {
    const name = fromCanon(n.name, dialect);
    if (name == null) {
      warnings.push(`{{${n.name}}} has no ${dialect} equivalent; left as a placeholder to fix by hand.`);
      return `[${n.name}]`;
    }
    if (name.startsWith("%")) {
      if (n.fallback) warnings.push(`Smartlead sender tags take no fallback; dropped "${n.fallback}".`);
      return name;
    }
    if (!n.fallback) return `{{${name}}}`;
    if (dialect === "plusvibe") return `{{fallback|{{${name}}}|${n.fallback}}}`;
    if (dialect === "instantly") return `{{${name} | ${n.fallback}}}`;
    return `{{${name}|${n.fallback}}}`;
  }
  function out(list) {
    return list.map((n) => {
      if (n.t === "text") return n.v;
      if (n.t === "var") return varText(n);
      const opts = n.options.map(out);
      if (dialect === "plusvibe") {
        n.options.forEach((o, k) => {
          const vars = countVars(o);
          if (vars > 1) warnings.push(`Option "${opts[k].trim()}" has ${vars} variables; PlusVibe allows one per spin block. Reword it.`);
        });
        return `{{random|${opts.join("|")}}}`;
      }
      if (dialect === "instantly") return `{{RANDOM | ${opts.map((o) => o.trim()).join(" | ")}}}`;
      return `{${opts.join("|")}}`;
    }).join("");
  }
  return { text: out(nodes), warnings: [...new Set(warnings)] };
}

function countVars(list) {
  return list.reduce((n, x) => n + (x.t === "var" ? 1 : x.t === "spin" ? Math.max(...x.options.map(countVars)) : 0), 0);
}

export function convert(text, from, to) {
  const { nodes, errors } = parse(text, from);
  const r = render(nodes, to);
  return { text: r.text, warnings: r.warnings, errors };
}

export function detectDialect(text) {
  const t = String(text ?? "");
  if (/\{\{\s*RANDOM\s*\|/.test(t) || /\{\{\s*[a-z]+[A-Z]\w*\s*(\||\}\})/.test(t)) return "instantly";
  if (/\{\{random\|/.test(t) || /\{\{fallback\|/i.test(t) || /\{\{custom_/.test(t)) return "plusvibe";
  return "smartlead";
}

// ── Variants ────────────────────────────────────────────────────────────────
export const SAMPLE = {
  first_name: "Sarah", last_name: "Lopez", company_name: "Acme Roofing", email: "sarah@acmeroofing.com",
  phone: "(512) 555-0142", website: "acmeroofing.com", sender_first_name: "Travis", sender_name: "Travis",
  sender_signature: "Travis\nBreezy Growth", title: "Operations Manager", job_title: "Operations Manager", city: "Austin",
};

export function sampleVariant(nodes, rand = Math.random, values = SAMPLE) {
  return nodes.map((n) => {
    if (n.t === "text") return n.v;
    if (n.t === "var") return values[n.name] ?? (n.fallback || `[${n.name}]`);
    return sampleVariant(n.options[Math.floor(rand() * n.options.length)], rand, values);
  }).join("");
}

export function combinations(nodes) {
  return nodes.reduce((p, n) => (n.t === "spin" ? p * n.options.reduce((s, o) => s + combinations(o), 0) : p), 1);
}

/** [min, max] words across every variant. A variable counts as one word. */
function wordRange(nodes) {
  let min = 0;
  let max = 0;
  let carry = "";
  const flush = () => {
    const w = carry.trim() ? carry.trim().split(/\s+/).length : 0;
    min += w;
    max += w;
    carry = "";
  };
  for (const n of nodes) {
    if (n.t === "text") carry += n.v;
    else if (n.t === "var") carry += " X ";
    else {
      flush();
      const r = n.options.map(wordRange);
      min += Math.min(...r.map((x) => x[0]));
      max += Math.max(...r.map((x) => x[1]));
    }
  }
  flush();
  return [min, max];
}

// Every option text, flattened, so phrase checks see words hiding inside spintax.
function allText(nodes) {
  return nodes.map((n) => (n.t === "text" ? n.v : n.t === "var" ? " {var} " : ` ${n.options.map(allText).join(" / ")} `)).join("");
}

// ── Rules ───────────────────────────────────────────────────────────────────
// Phrases spam filters and readers both treat as a pitch. My own list, kept short on purpose:
// single words like "free" or "sales" are judged in context, not banned.
const SPAM_PHRASES = [
  "act now", "act immediately", "limited time", "limited offer", "offer expires", "while supplies last", "risk-free", "risk free",
  "100% free", "no obligation", "no cost", "no catch", "no strings attached", "click here", "click below", "buy now", "order now",
  "special promotion", "exclusive deal", "once in a lifetime", "congratulations", "you have been selected", "you've been selected",
  "winner", "cash bonus", "double your", "earn money", "make money", "extra income", "work from home", "get paid",
  "guaranteed", "100% guaranteed", "money back", "lowest price", "best price", "save big", "apply now", "sign up free",
  "free trial", "free gift", "free access", "instant access", "urgent", "this is not spam", "this isn't spam", "not spam",
  "dear friend", "increase sales", "increase traffic", "million dollars", "miracle", "incredible deal", "what are you waiting for",
  "call now", "don't delete", "do not delete", "as seen on", "100% satisfied", "unlimited", "pure profit",
];

const AI_TELLS = [
  [/\bi hope (this|my) (email|message|note) finds you\b/i, "Opener that delays the point: \"I hope this finds you well\""],
  [/\bhope you('re| are) (doing )?well\b/i, "Opener that delays the point: \"Hope you're doing well\""],
  [/\bi (just )?wanted to (reach out|touch base|follow up|introduce)\b/i, "Opener that delays the point: \"I wanted to reach out\""],
  [/\bi('m| am) reaching out\b/i, "Opener that delays the point: \"I'm reaching out\""],
  [/\bmy name is\b/i, "\"My name is\": they can see who it's from"],
  [/\bi came across\b/i, "\"I came across\": say what you saw instead"],
  [/\bquick question\b/i, "\"Quick question\" is the most-sent cold email phrase there is"],
  [/\bjust (checking in|circling back|following up|bumping)\b/i, "\"Just checking in\": a follow-up should add something new"],
  [/\bhere'?s the (thing|kicker|catch|deal)\b/i, "Reveal setup: \"Here's the thing\""],
  [/\bit'?s not (just )?[^.?!]{1,50}, it'?s\b/i, "\"It's not X, it's Y\": the most recognizable AI sentence shape"],
  [/\bnot just [^.?!]{1,50}, but\b/i, "\"Not just X, but Y\""],
  [/\bimagine (a world|if you could)\b/i, "\"Imagine...\" opener"],
  [/\b(think of it (as|like)|it'?s like a)\b/i, "Analogy setup: \"Think of it as\""],
  [/\b(furthermore|moreover|additionally|in conclusion|in essence|to sum up)\b/i, "Essay transition word"],
  [/\b(leverag\w*|delve|seamless(ly)?|synerg\w*|holistic|myriad|plethora|cutting-edge|game-chang\w*|robust|tapestry|landscape|streamlin\w*|revolutioniz\w*|unlock|empower\w*|elevate)\b/i, "AI or corporate vocabulary"],
  [/\b(quietly|fundamentally|remarkably|truly|incredibly)\b/i, "Filler adverb"],
  [/\bi'?ll take (your )?silence as\b|\bif i don'?t hear back\b/i, "Silence-as-no closeout"],
  [/\b(touch base|circle back|synergy|low-hanging fruit|move the needle|value add|win-win)\b/i, "Business cliché"],
  [/[—]/, "Em dash: the best-known AI tell in 2026. Use a comma or a period"],
];

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return w ? 1 : 0;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function readingGrade(text) {
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) || []).length);
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (!words.length) return 0;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return Math.max(0, Math.round((0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59) * 10) / 10);
}

const toPlain = (html) => String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n\n").replace(/<\/?(p|div|span|b|i|strong|em)[^>]*>/gi, "");

export function check({ subject = "", body = "", dialect = null }) {
  const d = dialect || detectDialect(`${subject}\n${body}`);
  const findings = [];
  const add = (level, where, message, detail = null) => findings.push({ level, where, message, detail });

  const b = parse(toPlain(body), d);
  const sj = parse(subject, d);
  for (const e of b.errors) add("fail", "Body", "Broken template syntax", e);
  for (const e of sj.errors) add("fail", "Subject", "Broken template syntax", e);

  const bodyAll = allText(b.nodes);
  const subjAll = allText(sj.nodes);
  const first = sampleVariant(b.nodes, () => 0);
  const firstSubj = sampleVariant(sj.nodes, () => 0);

  // Leftover single braces in Smartlead copy that parse didn't catch, and unfilled placeholders
  if (/\[(first ?name|company|name|your name|insert[^\]]*)\]/i.test(body + subject)) add("fail", "Body", "Unfilled placeholder in square brackets", (body + subject).match(/\[[^\]]+\]/)[0]);
  if (/\{\{\s*\}\}/.test(body + subject)) add("fail", "Body", "Empty variable {{}}");

  // Length
  const [minW, maxW] = wordRange(b.nodes);
  const range = minW === maxW ? `${minW}` : `${minW} to ${maxW}`;
  if (maxW > 150) add("fail", "Body", `${range} words. Cold emails over 150 words get skimmed and deleted; aim for 50 to 100.`);
  else if (maxW > 110) add("warn", "Body", `${range} words. Most replies come from emails under 100 words.`);
  else if (minW < 25 && minW > 0) add("warn", "Body", `${range} words. Very short can work, but check it still says why you're writing to them.`);
  else if (minW > 0) add("pass", "Body", `${range} words.`);

  // Links, images, attachments
  const links = (body.match(/https?:\/\/|www\.|<a\s/gi) || []).length;
  if (links > 1) add("fail", "Body", `${links} links. More than one link in a cold email is a strong spam signal.`);
  else if (links === 1) add("warn", "Body", "One link. A first email with no link lands in the inbox more often; save it for the reply.");
  else add("pass", "Body", "No links.");
  if (/<img\s/i.test(body)) add("fail", "Body", "Image in the body. Images in cold email hurt deliverability and often show as blocked.");
  if (/\battach(ed|ment)\b/i.test(bodyAll)) add("warn", "Body", "Mentions an attachment. Don't attach files to a first cold email.");

  // Spam phrases
  for (const p of SPAM_PHRASES) {
    const re = new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
    if (re.test(subjAll)) add("fail", "Subject", `Spam phrase "${p}"`);
    else if (re.test(bodyAll)) add("warn", "Body", `Spam phrase "${p}"`);
  }
  if (/\bfree\b/i.test(subjAll)) add("warn", "Subject", "\"Free\" in the subject line");

  // Voice
  for (const [re, why] of AI_TELLS) {
    const m = bodyAll.match(re) || subjAll.match(re);
    if (m) add("warn", m && subjAll.match(re) ? "Subject" : "Body", why, `"${m[0].trim()}"`);
  }

  // Shape
  const excl = (bodyAll.match(/!/g) || []).length;
  if (excl) add("warn", "Body", `${excl} exclamation mark${excl > 1 ? "s" : ""}. Cold emails read calmer without them.`);
  // Acronyms (WCAG, OSHA, HIPAA) are normal. Shouting is a long all-caps word or two in a row.
  const shout = bodyAll.match(/\b[A-Z]{6,}\b|\b[A-Z]{2,}\s+[A-Z]{2,}\b/g);
  if (shout?.length) add("warn", "Body", "Words in all caps", shout.slice(0, 5).join(", "));
  if (!/\?/.test(first)) add("warn", "Body", "No question. A question gives them something easy to reply to.");
  const you = (first.match(/\byou(r|rs|'re|'ll|'ve)?\b/gi) || []).length;
  const me = (first.match(/\b(i|i'm|i've|i'll|me|my|we|we're|our|us)\b/gi) || []).length;
  if (me > you + 2) add("warn", "Body", `About you or about me? ${me} "I/we" to ${you} "you". Lead with them.`);
  const grade = readingGrade(first);
  if (grade > 9) add("warn", "Body", `Reading grade ${grade}. Aim for grade 5 to 8: shorter sentences, shorter words.`);
  else if (first.trim()) add("pass", "Body", `Reading grade ${grade}.`);
  const paras = first.split(/\n\s*\n/).filter((p) => p.trim());
  if (paras.some((p) => p.split(/\s+/).length > 60)) add("warn", "Body", "A paragraph over 60 words. Break it up; most people read cold email on a phone.");

  // Subject
  if (subject.trim()) {
    if (/^\s*(re|fw|fwd)\s*:/i.test(subject)) add("fail", "Subject", "Starts with Re: or Fwd: on a first email. It reads as a trick, and some providers flag it.");
    const len = firstSubj.length;
    if (len > 60) add("warn", "Subject", `${len} characters. Phones cut subjects off around 40.`);
    else add("pass", "Subject", `${len} characters.`);
    if (/!/.test(subject)) add("warn", "Subject", "Exclamation mark in the subject");
    if (/[\u{1F300}-\u{1FAFF}]/u.test(subject)) add("warn", "Subject", "Emoji in the subject");
    if (/\b[A-Z]{6,}\b|\b[A-Z]{2,}\s+[A-Z]{2,}\b/.test(subject)) add("warn", "Subject", "All-caps words in the subject");
  } else add("warn", "Subject", "No subject line to check.");

  // Template
  const combos = combinations(b.nodes) * combinations(sj.nodes);
  const vars = new Set();
  const walk = (ns) => ns.forEach((n) => (n.t === "var" ? vars.add(n.name) : n.t === "spin" ? n.options.forEach(walk) : null));
  walk(b.nodes);
  walk(sj.nodes);
  if (!vars.size) add("warn", "Body", "No merge fields. Every recipient gets the same email.");
  if (combos === 1 && maxW > 0) add("warn", "Body", "No spintax. Every email is identical, which is easier for filters to fingerprint at volume.");

  const order = { fail: 0, warn: 1, pass: 2 };
  findings.sort((a, z) => order[a.level] - order[z.level]);
  return {
    dialect: d,
    findings,
    stats: { words: [minW, maxW], combinations: combos, variables: [...vars], grade, links },
    nodes: { body: b.nodes, subject: sj.nodes },
  };
}
