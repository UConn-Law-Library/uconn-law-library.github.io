/* Boolean search-query engine shared by the app and the full-text worker.
 *
 * Loaded as a classic script by index.html and via importScripts() by
 * ft-worker.js, so everything here is plain globals — no modules.
 *
 * Query language: terms are ANDed by default; AND / OR / NOT (capitals) and a
 * leading "-" combine them; "double quotes" match exact phrases; parentheses
 * group. Lowercase and/or/not stay literal words so legal phrases like
 * "aiding and abetting" search naturally.
 */

"use strict";

function parseQuery(raw) {
  const toks = raw.match(/"[^"]*"?|\(|\)|[^\s()"]+/g) || [];
  let i = 0;

  function parseOr() {
    let left = parseAnd();
    while (i < toks.length && toks[i] === "OR") {
      i++;
      const right = parseAnd();
      if (right) left = left ? { type: "or", a: left, b: right } : right;
    }
    return left;
  }

  function parseAnd() {
    const kids = [];
    while (i < toks.length && toks[i] !== ")" && toks[i] !== "OR") {
      if (toks[i] === "AND") { i++; continue; }
      const t = parseTerm();
      if (t) kids.push(t);
    }
    if (!kids.length) return null;
    return kids.length === 1 ? kids[0] : { type: "and", kids };
  }

  function parseTerm() {
    let tok = toks[i];
    if (tok === ")") return null; // parseAnd's loop ends on this token
    if (tok === "NOT") {
      i++;
      const kid = parseTerm();
      return kid ? { type: "not", kid } : null;
    }
    if (tok === "(") {
      i++;
      const e = parseOr();
      if (toks[i] === ")") i++;
      return e;
    }
    i++;
    let negate = false;
    if (tok.length > 1 && tok[0] === "-" && tok[1] !== '"') {
      negate = true;
      tok = tok.slice(1);
    }
    tok = tok.replace(/^"|"$/g, "").toLowerCase().trim();
    if (!tok) return null;
    const term = { type: "term", text: tok };
    return negate ? { type: "not", kid: term } : term;
  }

  return parseOr();
}

function evalQuery(node, hay) {
  switch (node.type) {
    case "term": return hay.includes(node.text);
    case "not": return !evalQuery(node.kid, hay);
    case "and": return node.kids.every((k) => evalQuery(k, hay));
    case "or": return evalQuery(node.a, hay) || evalQuery(node.b, hay);
  }
  return false;
}

// non-negated terms, used for highlighting and snippets
function collectPositive(node, negated = false, out = []) {
  if (!node) return out;
  if (node.type === "term") {
    if (!negated) out.push(node.text);
  } else if (node.type === "not") {
    collectPositive(node.kid, !negated, out);
  } else if (node.type === "and") {
    node.kids.forEach((k) => collectPositive(k, negated, out));
  } else {
    collectPositive(node.a, negated, out);
    collectPositive(node.b, negated, out);
  }
  return out;
}

// Scan one parsed title file for sections matching the query AST. Returns
// compact rows; the caller turns them into result cards (and, in the worker,
// the title object is garbage-collected as soon as this returns).
function scanTitleForQuery(titleObj, ast, posTerms, max) {
  const rows = [];
  for (const c of titleObj.chapters || []) {
    for (const s of c.sections || []) {
      if (!s.section_key) continue;
      const text = s.content && s.content.text ? String(s.content.text) : "";
      if (!text) continue;
      const hay = text.toLowerCase();
      if (!evalQuery(ast, hay)) continue;
      let idx = -1, hitLen = 0;
      for (const t of posTerms) {
        idx = hay.indexOf(t);
        if (idx !== -1) { hitLen = t.length; break; }
      }
      if (idx === -1) idx = 0; // e.g. purely negative query
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + hitLen + 110);
      rows.push({
        t: titleObj.title_key,
        c: c.chapter_key,
        cLabel: `${c.label}${c.name ? " — " + c.name : ""}`,
        s: s.section_key,
        label: s.label || s.section_key,
        snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
      if (rows.length >= max) return rows;
    }
  }
  return rows;
}
