import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, convert, detectDialect, check, combinations, sampleVariant, readingGrade } from "./checker.js";

test("Smartlead to PlusVibe: spintax, fallbacks, custom fields, sender tags", () => {
  const r = convert("{Hi|Hey} {{first_name|there}}, saw {{company_name}} is hiring a {{title}}. %signature%", "smartlead", "plusvibe");
  assert.equal(r.text, "{{random|Hi|Hey}} {{fallback|{{first_name}}|there}}, saw {{company_name}} is hiring a {{custom_title}}. {{sender_signature}}");
  assert.deepEqual(r.errors, []);
});

test("Smartlead to Instantly: camelCase variables and RANDOM blocks", () => {
  const r = convert("{Hi|Hey} {{first_name|there}} at {{company_name}}", "smartlead", "instantly");
  assert.equal(r.text, "{{RANDOM | Hi | Hey}} {{firstName | there}} at {{companyName}}");
});

test("Instantly back to Smartlead, nested variable inside spintax", () => {
  const r = convert("{{RANDOM | Quick note, {{firstName}} | Hi {{firstName | there}}}}", "instantly", "smartlead");
  assert.equal(r.text, "{Quick note, {{first_name}}|Hi {{first_name|there}}}");
});

test("round trip through all three keeps the meaning", () => {
  const src = "{Hi|Hey|Hello} {{first_name}}, {noticed|saw} {{company_name}} {is hiring|posted a role}.";
  const pv = convert(src, "smartlead", "plusvibe").text;
  const ins = convert(pv, "plusvibe", "instantly").text;
  assert.equal(convert(ins, "instantly", "smartlead").text, src);
});

test("PlusVibe: two variables in one spin option is reported", () => {
  const r = convert("{Hi {{first_name}} at {{company_name}}|Hello}", "smartlead", "plusvibe");
  assert.ok(r.warnings.some((w) => /one per spin block/.test(w)));
});

test("broken syntax is caught, not silently sent", () => {
  assert.ok(parse("{Hi|Hey {{first_name}}", "smartlead").errors.length);
  assert.ok(parse("Hi {{first_name}", "smartlead").errors.length);
  assert.ok(parse("{{RANDOM | Hi | Hey}", "instantly").errors.length);
  assert.ok(parse("Hi {first_name}", "instantly").errors.length);
  assert.ok(parse("{only one option}", "smartlead").errors.length);
});

test("detect dialect", () => {
  assert.equal(detectDialect("{{RANDOM | a | b}} {{firstName}}"), "instantly");
  assert.equal(detectDialect("{{random|a|b}} {{first_name}}"), "plusvibe");
  assert.equal(detectDialect("{a|b} {{first_name}}"), "smartlead");
});

test("combinations and variants", () => {
  const { nodes } = parse("{Hi|Hey|Hello} {{first_name}}, {a|b}", "smartlead");
  assert.equal(combinations(nodes), 6);
  assert.equal(sampleVariant(nodes, () => 0), "Hi Sarah, a");
});

test("a clean, short email passes the important checks", () => {
  const r = check({
    subject: "{{first_name}}, roofing crews",
    body: "{Hi|Hey} {{first_name}},\n\nSaw {{company_name}} is hiring two estimators this month. Most roofers I talk to lose a week of bids while a new estimator ramps up.\n\nI set up the outbound so the leads keep coming while they learn. Want me to send over how that works for a crew your size?\n\nTravis",
    dialect: "smartlead",
  });
  assert.equal(r.findings.filter((f) => f.level === "fail").length, 0, JSON.stringify(r.findings.filter((f) => f.level === "fail")));
  assert.equal(r.stats.combinations, 2);
});

test("a spammy, AI-sounding email gets flagged", () => {
  const r = check({
    subject: "Re: FREE trial - act now!",
    body: "I hope this email finds you well! My name is Bob and I wanted to reach out. It's not just software, it's a game-changing way to leverage your data. Click here: https://a.com and https://b.com",
    dialect: "smartlead",
  });
  const msgs = r.findings.map((f) => `${f.level} ${f.message}`).join("\n");
  assert.match(msgs, /fail Starts with Re:/);
  assert.match(msgs, /fail 2 links/);
  assert.match(msgs, /fail Spam phrase "act now"/);
  assert.match(msgs, /I hope this finds you well/);
  assert.match(msgs, /It's not X, it's Y/);
  assert.match(msgs, /corporate vocabulary/);
  assert.match(msgs, /No question/);
});

test("reading grade is in a sane range", () => {
  const g = readingGrade("Saw you are hiring. Want me to send it over?");
  assert.ok(g >= 0 && g < 6, String(g));
});
