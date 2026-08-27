const RESET = '\x1b[0m';

/** Chunks larger than this are written verbatim; scanning 64KB frames per write is too costly. */
const MAX_HIGHLIGHT_TEXT_LENGTH = 16384;
/** Stop collecting after this many matches; the remaining text is written uncolored. */
const MAX_HIGHLIGHT_MATCHES = 500;

interface HighlightRule {
  readonly pattern: RegExp;
  readonly color: string;
}

interface HighlightMatch {
  readonly start: number;
  readonly end: number;
  readonly color: string;
  readonly ruleIndex: number;
}

const ansiEscapePattern = /\x1b\[[0-?]*[ -/]*[@-~]/;
const unsafeControlPattern = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const rules: HighlightRule[] = [
  { pattern: /\b(?:error|failed|failure|fatal|denied|exception)\b/gi, color: '\x1b[31m' },
  { pattern: /\b(?:warn|warning|deprecated)\b/gi, color: '\x1b[33m' },
  { pattern: /\b(?:success|passed|ok|done)\b/gi, color: '\x1b[32m' },
  { pattern: /https?:\/\/[^\s'"`<>|]+/gi, color: '\x1b[36m' },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, color: '\x1b[36m' },
  { pattern: /(?:^|(?<=[\s:=]))(?:~|\/)[^\s'"`<>|;]+/g, color: '\x1b[34m' },
  { pattern: /\b\d+(?:\.\d+)?\b/g, color: '\x1b[32m' }
];

export function semanticHighlightText(text: string): string {
  if (text.length > MAX_HIGHLIGHT_TEXT_LENGTH || !isHighlightableText(text)) {
    return text;
  }

  const matches = collectMatches(text);
  if (matches.length === 0) {
    return text;
  }

  let highlighted = '';
  let cursor = 0;
  for (const match of matches) {
    highlighted += text.slice(cursor, match.start);
    highlighted += `${match.color}${text.slice(match.start, match.end)}${RESET}`;
    cursor = match.end;
  }
  highlighted += text.slice(cursor);
  return highlighted;
}

function isHighlightableText(text: string): boolean {
  return text.length > 0 && !ansiEscapePattern.test(text) && !unsafeControlPattern.test(text);
}

function collectMatches(text: string): HighlightMatch[] {
  const candidates: HighlightMatch[] = [];
  collect: for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
    const rule = rules[ruleIndex];
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (match.index === undefined || match[0].length === 0) {
        continue;
      }
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        color: rule.color,
        ruleIndex
      });
      if (candidates.length >= MAX_HIGHLIGHT_MATCHES) {
        break collect;
      }
    }
  }

  // Earlier rules win ties at the same position, matching the old first-rule-wins behavior.
  candidates.sort((left, right) => left.start - right.start || left.ruleIndex - right.ruleIndex);

  const kept: HighlightMatch[] = [];
  let lastEnd = 0;
  for (const candidate of candidates) {
    if (candidate.start >= lastEnd) {
      kept.push(candidate);
      lastEnd = candidate.end;
    }
  }
  return kept;
}
