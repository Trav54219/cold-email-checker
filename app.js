import { check, convert, detectDialect, sampleVariant } from "./checker.js";

const $ = (id) => document.getElementById(id);
const NAMES = { smartlead: "Smartlead", instantly: "Instantly", plusvibe: "PlusVibe" };
const STORE = "cold-email-checker:v1";

const EXAMPLE = {
  subject: "Quick question - FREE audit!",
  body: `I hope this email finds you well! My name is Dan and I wanted to reach out because I came across {{company_name}}.

{Hi {{first_name}},|Hey {{first_name}},|Hello,} we help companies leverage cutting-edge AI to streamline their outbound. It's not just software, it's a game-changing way to grow — and it's 100% free to try.

Check out https://example.com/demo and https://example.com/pricing to learn more.

Let me know!`,
};

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}

let last = null;

function currentDialect() {
  const v = $("dialect").value;
  return v === "auto" ? detectDialect(`${$("subject").value}\n${$("body").value}`) : v;
}

function run() {
  const subject = $("subject").value;
  const body = $("body").value;
  localStorage.setItem(STORE, JSON.stringify({ subject, body, dialect: $("dialect").value }));
  if (!subject.trim() && !body.trim()) {
    $("score").replaceChildren(el("p", { class: "muted" }, "Paste an email on the left, or load the example."));
    $("findings").replaceChildren();
    $("variants").replaceChildren();
    $("combos").textContent = "";
    $("detected").textContent = "";
    last = null;
    return;
  }
  const dialect = currentDialect();
  last = check({ subject, body, dialect });
  $("detected").textContent = $("dialect").value === "auto" ? `Reading this as ${NAMES[dialect]} syntax.` : "";

  const n = (lvl) => last.findings.filter((f) => f.level === lvl).length;
  const fails = n("fail");
  const warns = n("warn");
  const verdict = fails ? "Fix before sending" : warns ? "Sendable, with notes" : "Ready to send";
  $("score").replaceChildren(
    el("div", { class: `verdict ${fails ? "fail" : warns ? "warn" : "pass"}` }, verdict),
    el("div", { class: "counts" },
      el("span", { class: "fail" }, el("b", {}, String(fails)), " to fix"),
      el("span", { class: "warn" }, el("b", {}, String(warns)), " to consider"),
      el("span", { class: "muted" }, `${last.stats.words[0] === last.stats.words[1] ? last.stats.words[0] : last.stats.words.join(" to ")} words`)));
  $("findings").replaceChildren(...last.findings.map((f) =>
    el("li", { class: f.level },
      el("span", { class: `pill ${f.level === "pass" ? "pass" : f.level}` }, f.level === "fail" ? "Fix" : f.level === "warn" ? "Consider" : "OK"),
      el("span", { class: "where" }, f.where),
      el("span", { class: "msg" }, f.message, f.detail ? el("span", { class: "detail" }, ` ${f.detail}`) : null))));
  renderVariants();
  if (!$("convert-out").hidden && lastTarget) renderConvert(lastTarget);
}

function renderVariants() {
  if (!last) return;
  const combos = last.stats.combinations;
  $("combos").textContent = combos > 1 ? `${combos.toLocaleString()} possible versions` : "1 version (no spintax)";
  const shown = Math.min(combos, 4);
  const seen = new Set();
  const cards = [];
  for (let tries = 0; cards.length < shown && tries < 40; tries++) {
    const s = sampleVariant(last.nodes.subject);
    const b = sampleVariant(last.nodes.body);
    if (seen.has(s + b)) continue;
    seen.add(s + b);
    cards.push(el("div", { class: "variant" }, el("div", { class: "v-subject" }, s || "(no subject)"), el("div", { class: "v-body" }, b)));
  }
  $("variants").replaceChildren(...cards);
}

let lastTarget = null;
function renderConvert(to) {
  lastTarget = to;
  const from = currentDialect();
  const s = convert($("subject").value, from, to);
  const b = convert($("body").value, from, to);
  $("conv-subject").textContent = s.text;
  $("conv-body").textContent = b.text;
  const notes = [...new Set([...s.errors, ...b.errors].map((e) => `Source has broken syntax: ${e}`).concat(s.warnings, b.warnings))];
  $("conv-warn").classList.toggle("ok", !notes.length);
  $("conv-warn").replaceChildren(...(notes.length ? notes : [`Converted from ${NAMES[from]} to ${NAMES[to]} with nothing lost.`]).map((w) => el("li", {}, w)));
  document.querySelectorAll("#targets button").forEach((x) => x.classList.toggle("active", x.dataset.to === to));
  $("convert-out").hidden = false;
}

let timer;
["subject", "body"].forEach((id) => $(id).addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(run, 150);
}));
$("dialect").addEventListener("change", run);
$("shuffle").addEventListener("click", renderVariants);
$("example").addEventListener("click", () => {
  $("subject").value = EXAMPLE.subject;
  $("body").value = EXAMPLE.body;
  $("dialect").value = "auto";
  run();
});
document.querySelectorAll("#targets button").forEach((b) => b.addEventListener("click", () => renderConvert(b.dataset.to)));
document.querySelectorAll("button.copy").forEach((b) => b.addEventListener("click", async () => {
  await navigator.clipboard.writeText($(b.dataset.copy).textContent);
  b.textContent = "Copied";
  setTimeout(() => (b.textContent = "Copy"), 1500);
}));

try {
  const saved = JSON.parse(localStorage.getItem(STORE) || "null");
  if (saved) {
    $("subject").value = saved.subject || "";
    $("body").value = saved.body || "";
    $("dialect").value = saved.dialect || "auto";
  }
} catch {}
run();
