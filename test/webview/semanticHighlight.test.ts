import { describe, expect, it } from 'vitest';
import { semanticHighlightText } from '../../webview/terminal/semanticHighlight';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';

describe('semanticHighlightText', () => {
  it('colors error, warn and url keywords in small strings', () => {
    expect(semanticHighlightText('error')).toBe(`${RED}error${RESET}`);
    expect(semanticHighlightText('warn')).toBe(`${YELLOW}warn${RESET}`);
    expect(semanticHighlightText('see https://example.com/docs now')).toBe(
      `see ${CYAN}https://example.com/docs${RESET} now`
    );
  });

  it('keeps first-rule-wins for overlapping matches starting at the same position', () => {
    // IP rule (index 4, cyan) and digit rule (index 6, green) both match at position 0.
    expect(semanticHighlightText('10.0.0.1')).toBe(`${CYAN}10.0.0.1${RESET}`);
  });

  it('drops digit matches nested inside an earlier url match', () => {
    const highlighted = semanticHighlightText('visit https://host:8080/v2 ok');
    expect(highlighted).toBe(`visit ${CYAN}https://host:8080/v2${RESET} ${GREEN}ok${RESET}`);
    expect(highlighted).not.toContain(`${GREEN}8080${RESET}`);
  });

  it('returns a 20KB string of digits unchanged (length bypass)', () => {
    const text = '0123456789'.repeat(2048);
    expect(text.length).toBeGreaterThan(16384);
    expect(semanticHighlightText(text)).toBe(text);
  });

  it('returns text with ANSI escapes or control characters unchanged', () => {
    expect(semanticHighlightText('\x1b[31malready colored error\x1b[0m')).toBe(
      '\x1b[31malready colored error\x1b[0m'
    );
    expect(semanticHighlightText('error\x07bell')).toBe('error\x07bell');
  });

  it('caps highlighting at 500 matches and leaves the rest uncolored', () => {
    const numbers = Array.from({ length: 700 }, (_, index) => String(index));
    const text = numbers.join(' ');
    expect(text.length).toBeLessThanOrEqual(16384);

    const highlighted = semanticHighlightText(text);
    const coloredCount = highlighted.split(GREEN).length - 1;
    expect(coloredCount).toBe(500);
    // The tail beyond the cap stays as plain text.
    expect(highlighted.endsWith(' 698 699')).toBe(true);
  });

  it('leaves numbers glued inside words unhighlighted', () => {
    expect(semanticHighlightText('build error500x')).toBe('build error500x');
  });
});
