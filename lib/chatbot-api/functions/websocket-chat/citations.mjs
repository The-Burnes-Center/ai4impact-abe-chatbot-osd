export function cleanExcerptText(raw, maxLen) {
  let text = raw
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\.{3,}/g, "...")
    .replace(/\u2022/g, "- ")
    .replace(/\u00a0/g, " ")
    .trim();

  if (text.length > maxLen) {
    text = text.substring(0, maxLen);
    const lastSpace = text.lastIndexOf(" ");
    if (lastSpace > maxLen * 0.7) {
      text = text.substring(0, lastSpace);
    }
    text += "...";
  }
  return text;
}

/**
 * From a raw character offset, snap forward to the nearest sentence boundary
 * so markers never land mid-word ("Liqui[1]d") or mid-number ("72[2]0-3300").
 *
 * Sentence boundaries (in priority order, max 500 chars ahead):
 *   - period / ! / ? followed by whitespace or end-of-text
 *   - newline (markdown paragraph / list boundary)
 * If none found, snap to end of the current word.
 */
export function snapToSentenceEnd(text, rawOffset) {
  const len = text.length;
  if (rawOffset >= len) return len;

  const MAX_SCAN = 500;
  const limit = Math.min(rawOffset + MAX_SCAN, len);

  // Scan for sentence-ending punctuation followed by whitespace / newline / EOT
  for (let i = rawOffset; i < limit; i++) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\n' || next === '\r') {
        return i + 1; // right after the punctuation
      }
    }
    if (ch === '\n') {
      return i; // before the newline
    }
  }

  // No sentence boundary found — at least snap to end of current word
  let pos = rawOffset;
  while (pos < len && text[pos] !== ' ' && text[pos] !== '\n') {
    pos++;
  }
  return pos;
}

/**
 * Convert native citation objects into [N] markers and mark sources as cited.
 * Citations arrive as { textOffset, citation: { document_index, ... } }.
 *
 * Markers are placed at the end of the sentence containing the cited span:
 *   "The contract term is December 2025.[1]"
 */
export function insertCitationMarkers(text, citations, docIndexMap, allSources) {
  if (!citations || citations.length === 0) return text;

  const citedChunkIndices = new Set();

  const insertions = [];
  for (const { textOffset, citation } of citations) {
    const docIdx = citation.document_index ?? citation.document_indices?.[0];
    const source = docIndexMap[docIdx];
    if (!source || source.chunkIndex == null) continue;

    citedChunkIndices.add(source.chunkIndex);

    // Start from the end of the cited span, then snap to the sentence boundary
    let rawEnd = textOffset;
    if (citation.end_char_index != null && citation.end_char_index <= text.length) {
      rawEnd = citation.end_char_index;
    } else if (citation.cited_text) {
      rawEnd = Math.min(textOffset + citation.cited_text.length, text.length);
    }

    const insertAt = snapToSentenceEnd(text, rawEnd);
    insertions.push({ offset: insertAt, chunkIndex: source.chunkIndex });
  }

  // Group by insertion offset, deduplicate chunkIndices, sort ascending within each group
  const byOffset = new Map();
  for (const { offset, chunkIndex } of insertions) {
    if (!byOffset.has(offset)) byOffset.set(offset, new Set());
    byOffset.get(offset).add(chunkIndex);
  }

  // Insert in descending offset order so earlier positions aren't shifted
  const offsets = [...byOffset.keys()].sort((a, b) => b - a);
  for (const offset of offsets) {
    const indices = [...byOffset.get(offset)].sort((a, b) => a - b);
    const marker = indices.map(idx => `[${idx}]`).join("");
    text = text.slice(0, offset) + marker + text.slice(offset);
  }

  for (const src of allSources) {
    src.cited = src.chunkIndex != null && citedChunkIndices.has(src.chunkIndex);
  }

  return text;
}

/**
 * Fallback: validate self-managed [N] markers when native citations aren't available.
 * Strips any [N] that doesn't correspond to a real source.
 */
export function validateSelfManagedCitations(text, allSources) {
  const validIndices = new Set(
    allSources.map(s => s.chunkIndex).filter(i => i != null)
  );
  const cleaned = text.replace(/\[(\d+)\]/g, (match, num) => {
    return validIndices.has(parseInt(num, 10)) ? match : '';
  });
  const citedIndices = new Set();
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    citedIndices.add(parseInt(m[1], 10));
  }
  for (const src of allSources) {
    src.cited = src.chunkIndex != null && citedIndices.has(src.chunkIndex);
  }
  return cleaned;
}

/**
 * Renumber cited sources to sequential [1], [2], [3]... in order of first
 * appearance in the text. Updates chunkIndex on source objects in-place and
 * removes uncited sources from the array.
 *
 * Returns { text, sources } where sources contains only cited items with
 * sequential chunkIndex values.
 */
export function renumberCitations(text, allSources) {
  // Collect unique cited chunkIndices in order of first appearance in text
  const seen = new Set();
  const orderedOld = [];
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = parseInt(m[1], 10);
    if (!seen.has(idx)) {
      seen.add(idx);
      orderedOld.push(idx);
    }
  }

  if (orderedOld.length === 0) {
    return { text, sources: allSources.filter(s => s.cited) };
  }

  // Map old chunkIndex → new sequential number
  const oldToNew = new Map();
  orderedOld.forEach((oldIdx, i) => oldToNew.set(oldIdx, i + 1));

  // Replace markers in text (handle largest numbers first to avoid partial matches)
  let result = text;
  const descending = [...orderedOld].sort((a, b) => b - a);
  for (const oldIdx of descending) {
    const newIdx = oldToNew.get(oldIdx);
    result = result.replaceAll(`[${oldIdx}]`, `[\x00${newIdx}\x00]`);
  }
  // Remove sentinel characters used to prevent double-replacement
  result = result.replaceAll('\x00', '');

  // Update source objects and filter to cited only
  const citedSources = [];
  for (const src of allSources) {
    if (src.chunkIndex != null && oldToNew.has(src.chunkIndex)) {
      src.chunkIndex = oldToNew.get(src.chunkIndex);
      src.cited = true;
      citedSources.push(src);
    }
  }

  // Sort by new chunkIndex
  citedSources.sort((a, b) => a.chunkIndex - b.chunkIndex);

  return { text: result, sources: citedSources };
}
