import { describe, it, expect } from "vitest";
import {
  cleanExcerptText,
  snapToSentenceEnd,
  insertCitationMarkers,
  validateSelfManagedCitations,
  renumberCitations,
} from "./citations.mjs";

// ---------------------------------------------------------------------------
// cleanExcerptText
// ---------------------------------------------------------------------------

describe("cleanExcerptText", () => {
  it("collapses multiple whitespace into a single space", () => {
    expect(cleanExcerptText("foo   bar", 200)).toBe("foo bar");
  });

  it("converts \\r\\n, \\n, and \\t to spaces", () => {
    expect(cleanExcerptText("foo\r\nbar\nbaz\tqux", 200)).toBe("foo bar baz qux");
  });

  it("normalizes bullet unicode and non-breaking space", () => {
    expect(cleanExcerptText("\u2022item\u00a0here", 200)).toBe("- item here");
  });

  it("collapses 4+ dots to exactly '...'", () => {
    expect(cleanExcerptText("see....here", 200)).toBe("see...here");
  });

  it("trims leading/trailing whitespace", () => {
    expect(cleanExcerptText("  hello world  ", 200)).toBe("hello world");
  });

  it("truncates at maxLen and appends '...'", () => {
    const result = cleanExcerptText("hello world foo bar baz", 15);
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(15 + 3); // original slice + "..."
  });

  it("word-boundary truncation: snaps to last space when it's past 70% of maxLen", () => {
    // maxLen=15 → substring(0,15)="hello world foo", lastSpace=11, 11>10.5 → snaps to "hello world"
    const result = cleanExcerptText("hello world foo bar baz", 15);
    expect(result).toBe("hello world...");
  });

  it("no truncation when text is exactly maxLen", () => {
    const text = "abcde";
    expect(cleanExcerptText(text, 5)).toBe("abcde");
  });
});

// ---------------------------------------------------------------------------
// snapToSentenceEnd
// ---------------------------------------------------------------------------

describe("snapToSentenceEnd", () => {
  it("returns text.length when rawOffset >= text.length", () => {
    const text = "Hello.";
    expect(snapToSentenceEnd(text, 100)).toBe(text.length);
  });

  it("snaps to after a period followed by a space", () => {
    const text = "First sentence. Second sentence.";
    // rawOffset at 'F' of "First" → scans forward → hits '.' at index 14, next is ' '
    expect(snapToSentenceEnd(text, 0)).toBe(15); // right after '.'
  });

  it("snaps to after '!' followed by space", () => {
    const text = "Watch out! Be careful.";
    expect(snapToSentenceEnd(text, 0)).toBe(10);
  });

  it("snaps to after '?' followed by space", () => {
    const text = "Is it done? Yes.";
    expect(snapToSentenceEnd(text, 0)).toBe(11);
  });

  it("snaps to before a newline", () => {
    const text = "First line\nSecond line";
    expect(snapToSentenceEnd(text, 2)).toBe(10); // index of '\n'
  });

  it("period at end of text (no next char) is a valid boundary", () => {
    const text = "Final sentence.";
    expect(snapToSentenceEnd(text, 0)).toBe(15);
  });

  it("falls back to end of current word when no sentence boundary in 500 chars", () => {
    // 600 chars with no sentence boundary — rawOffset in middle of a word
    const word = "a".repeat(50);
    const text = word + " " + word;
    // rawOffset=10 (mid-word): should advance to end of word at index 50
    expect(snapToSentenceEnd(text, 10)).toBe(50);
  });

  it("does not snap period followed by a digit (e.g. version numbers)", () => {
    // "v1.2 done." — period at index 3 is followed by '2' (digit), not whitespace
    const text = "v1.2 done. Next.";
    // rawOffset=0 → should not snap at '.' in "v1.2", but should snap after "done."
    expect(snapToSentenceEnd(text, 0)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// insertCitationMarkers
// ---------------------------------------------------------------------------

describe("insertCitationMarkers", () => {
  it("returns text unchanged when citations array is empty", () => {
    const text = "No citations here.";
    expect(insertCitationMarkers(text, [], {}, [])).toBe(text);
  });

  it("returns text unchanged when citations is null/undefined", () => {
    const text = "No citations.";
    expect(insertCitationMarkers(text, null, {}, [])).toBe(text);
  });

  it("inserts a single marker after the sentence boundary", () => {
    const text = "The contract ends in December. See schedule.";
    const sources = [{ chunkIndex: 1, cited: false }];
    const docIndexMap = { 0: sources[0] };
    const citations = [{
      textOffset: 5,
      citation: { document_index: 0, end_char_index: 28 },
    }];
    const result = insertCitationMarkers(text, citations, docIndexMap, sources);
    // end_char_index=28 lands right after "December." → snapToSentenceEnd snaps to 30 (after '.')
    expect(result).toContain("[1]");
    expect(sources[0].cited).toBe(true);
  });

  it("deduplicates markers at the same offset", () => {
    const text = "Both sources say this. Next sentence.";
    const src1 = { chunkIndex: 1, cited: false };
    const src2 = { chunkIndex: 2, cited: false };
    const docIndexMap = { 0: src1, 1: src2 };
    const citations = [
      { textOffset: 0, citation: { document_index: 0, end_char_index: 21 } },
      { textOffset: 0, citation: { document_index: 1, end_char_index: 21 } },
    ];
    const result = insertCitationMarkers(text, citations, docIndexMap, [src1, src2]);
    // Both should be at the same offset; expect "[1][2]" together
    expect(result).toContain("[1][2]");
  });

  it("marks sources not mentioned in citations as cited=false", () => {
    const text = "Source one is cited.";
    const src1 = { chunkIndex: 1, cited: false };
    const src2 = { chunkIndex: 2, cited: false };
    const docIndexMap = { 0: src1 };
    const citations = [{ textOffset: 0, citation: { document_index: 0, end_char_index: 20 } }];
    insertCitationMarkers(text, citations, docIndexMap, [src1, src2]);
    expect(src1.cited).toBe(true);
    expect(src2.cited).toBe(false);
  });

  it("skips citations where docIndexMap has no entry", () => {
    const text = "Some text here.";
    const result = insertCitationMarkers(
      text,
      [{ textOffset: 0, citation: { document_index: 99 } }],
      {},
      []
    );
    expect(result).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// validateSelfManagedCitations
// ---------------------------------------------------------------------------

describe("validateSelfManagedCitations", () => {
  it("keeps valid [N] markers", () => {
    const sources = [{ chunkIndex: 1 }, { chunkIndex: 2 }];
    const result = validateSelfManagedCitations("See [1] and [2].", sources);
    expect(result).toBe("See [1] and [2].");
  });

  it("removes markers whose index has no matching source", () => {
    const sources = [{ chunkIndex: 1 }];
    const result = validateSelfManagedCitations("See [1] and [99].", sources);
    expect(result).toBe("See [1] and .");
  });

  it("marks cited sources correctly", () => {
    const s1 = { chunkIndex: 1, cited: false };
    const s2 = { chunkIndex: 2, cited: false };
    validateSelfManagedCitations("Text [1].", [s1, s2]);
    expect(s1.cited).toBe(true);
    expect(s2.cited).toBe(false);
  });

  it("handles text with no markers — all sources uncited", () => {
    const s1 = { chunkIndex: 1, cited: false };
    validateSelfManagedCitations("No citations here.", [s1]);
    expect(s1.cited).toBe(false);
  });

  it("ignores sources with null chunkIndex", () => {
    const sources = [{ chunkIndex: null }];
    const result = validateSelfManagedCitations("Text [1].", sources);
    // [1] is invalid because null is not in validIndices
    expect(result).toBe("Text .");
  });
});

// ---------------------------------------------------------------------------
// renumberCitations
// ---------------------------------------------------------------------------

describe("renumberCitations", () => {
  it("renumbers non-sequential markers to 1, 2, 3 in order of appearance", () => {
    const src3 = { chunkIndex: 3, cited: true };
    const src7 = { chunkIndex: 7, cited: true };
    const { text, sources } = renumberCitations("See [7] and [3].", [src3, src7]);
    expect(text).toBe("See [1] and [2].");
    expect(sources[0].chunkIndex).toBe(1); // [7] appeared first → becomes 1
    expect(sources[1].chunkIndex).toBe(2); // [3] appeared second → becomes 2
  });

  it("returns text unchanged and filters cited when no markers present", () => {
    const cited = { chunkIndex: 1, cited: true };
    const uncited = { chunkIndex: 2, cited: false };
    const { text, sources } = renumberCitations("No markers.", [cited, uncited]);
    expect(text).toBe("No markers.");
    // No markers in text → orderedOld is empty → falls back to filter(s => s.cited)
    expect(sources).toEqual([cited]);
  });

  it("removes uncited sources from the returned array", () => {
    const s1 = { chunkIndex: 1, cited: true };
    const s2 = { chunkIndex: 5, cited: false };
    const { sources } = renumberCitations("Text [1].", [s1, s2]);
    expect(sources.map(s => s.chunkIndex)).toEqual([1]);
  });

  it("handles repeated references to the same chunk", () => {
    const src = { chunkIndex: 3, cited: true };
    const { text, sources } = renumberCitations("A [3] then B [3].", [src]);
    expect(text).toBe("A [1] then B [1].");
    expect(sources[0].chunkIndex).toBe(1);
  });

  it("avoids partial-match corruption when a high-number marker contains a lower one (e.g. [12] vs [1])", () => {
    const s1 = { chunkIndex: 1, cited: true };
    const s12 = { chunkIndex: 12, cited: true };
    const { text } = renumberCitations("See [12] and [1].", [s1, s12]);
    // [12] → [1], [1] → [2] — sentinel prevents [12] turning into "[1]2"
    expect(text).toBe("See [1] and [2].");
  });

  it("sorts returned sources by new chunkIndex", () => {
    const s2 = { chunkIndex: 2, cited: true };
    const s1 = { chunkIndex: 1, cited: true };
    const { sources } = renumberCitations("See [2] then [1].", [s2, s1]);
    expect(sources[0].chunkIndex).toBe(1);
    expect(sources[1].chunkIndex).toBe(2);
  });
});
