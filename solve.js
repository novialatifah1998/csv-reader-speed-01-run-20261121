// Fast drop-in for make.fun's csv-reader 1.0.0.
//
// run({ text, header }) -> { columns, rows, errors }
//
// Parsing rules (from the competition spec):
// - Text read once, left to right. A U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled:
//   "" inside is one quote; each CRLF or lone CR inside reads as LF; what
//   follows the closing quote up to the next comma or line break is appended
//   as it stands (quote_junk, when the field ends); a quote that never closes
//   is a literal character and the text after it is read again as unquoted
//   (unterminated_quote). A quote inside an unquoted field is literal.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds the
//   records after it (every record when header is false), each padded with
//   empty strings (short_row, with fields: its field count) or cut (long_row,
//   with extra: the cut fields) to the first record's width.
// - Each error is { code, line, row } in the order met; line is the 1-based
//   line the record starts on (counting every LF, CRLF and lone CR inside
//   quotes); row is the record's index in rows, null for the header.
//
// Speed strategy: lines with no quote and no stray CR are split with the
// engine's native split(','); quoted / broken lines go through an
// indexOf-driven scanner that slices fields instead of accumulating chars.
// Delimiter positions are tracked with forward-only pointers (next comma,
// LF, CR, quote at or after the scan position), so no scan ever re-covers
// ground: total scanning is linear in the text size. The whole parse is one
// flat loop with no per-field function calls, so the hot path stays tight.

export function run(input) {
  const text = input.text;
  const header = input.header === true;
  const n = text.length;

  let i = 0;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) i = 1; // drop leading BOM

  let line = 1;
  const errors = [];
  const records = [];
  let width = -1;

  // Row index in `rows` for the record currently being parsed
  // (null for the header record).
  const rowOf = (recIdx) => (header ? (recIdx === 0 ? null : recIdx - 1) : recIdx);

  // Forward-only pointers: next occurrence of each delimiter at or after
  // the current scan position (-1 when none remains). A pointer goes stale
  // only when the scan passes it; refreshing it re-scans from the new
  // position, so the four scans together cover the text once.
  let qPos = text.indexOf('"', i);
  let rPos = text.indexOf('\r', i);
  let cPos = text.indexOf(',', i);
  let nPos = text.indexOf('\n', i);

  while (i < n) {
    const startLine = line;
    // Refresh the LF pointer and find this line's end.
    if (nPos !== -1 && nPos < i) nPos = text.indexOf('\n', i);
    const nl = nPos;
    const lineEnd = nl === -1 ? n : nl;
    if (qPos !== -1 && qPos < i) qPos = text.indexOf('"', i);
    if (rPos !== -1 && rPos < i) rPos = text.indexOf('\r', i);
    if ((qPos === -1 || qPos >= lineEnd) && (rPos === -1 || rPos >= lineEnd)) {
      // Clean line: no quotes, no CR. Native split.
      if (lineEnd === i) {
        if (nl === -1) break;
        i = nl + 1;
        line++;
        continue; // empty line: no record
      }
      const fields = text.slice(i, lineEnd).split(',');
      const row = rowOf(records.length);
      if (width === -1) width = fields.length;
      else if (fields.length < width) {
        errors.push({ code: 'short_row', line: startLine, row, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: startLine, row, extra: fields.slice(width) });
        fields.length = width;
      }
      records.push(fields);
      if (nl === -1) break;
      i = nl + 1;
      line++;
      continue;
    }
    if (qPos === -1 || qPos >= lineEnd) {
      // No quote in the line, but a CR is present. Only fast path left is
      // a single CR as the line's last char before LF (CRLF ending).
      if (nl !== -1 && rPos === lineEnd - 1) {
        if (lineEnd - 1 === i) {
          i = nl + 1;
          line++;
          continue; // empty CRLF line: no record
        }
        const fields = text.slice(i, lineEnd - 1).split(',');
        const row = rowOf(records.length);
        if (width === -1) width = fields.length;
        else if (fields.length < width) {
          errors.push({ code: 'short_row', line: startLine, row, fields: fields.length });
          while (fields.length < width) fields.push('');
        } else if (fields.length > width) {
          errors.push({ code: 'long_row', line: startLine, row, extra: fields.slice(width) });
          fields.length = width;
        }
        records.push(fields);
        i = nl + 1;
        line++;
        continue;
      }
    }

    // ---- Slow path: parse one record starting at i. ----
    // Lone CRs at the very start of a record: dropped, error each.
    while (i < n && text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) !== 10) {
      errors.push({ code: 'stray_cr', line, row: rowOf(records.length) });
      i++;
    }
    if (i >= n) break;
    if (text.charCodeAt(i) === 10) {
      i++;
      line++;
      continue; // line left with no characters: no record
    }
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) {
      i += 2;
      line++;
      continue; // same
    }
    const fields = [];
    for (;;) {
      // Parse one field into fv, ending fe: 0 comma, 1 break, 2 eof.
      let fv;
      let fe;
      if (text.charCodeAt(i) === 34) {
        // ---- Quoted field. ----
        let pos = i + 1;
        let closedAt = -1;
        for (;;) {
          if (qPos !== -1 && qPos < pos) qPos = text.indexOf('"', pos);
          const q = qPos;
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            pos = q + 2; // doubled quote: skip the pair, keep scanning
            continue;
          }
          closedAt = q;
          break;
        }
        if (closedAt === -1) {
          // No closing quote: the quote is literal, re-read the rest
          // unquoted. The lookahead above may have advanced qPos past
          // i+1 (or to -1); the re-read starts back at i+1, so recompute
          // it from there or a later quoted field would wrongly read as
          // unterminated.
          qPos = text.indexOf('"', i + 1);
          let acc = null;
          let s = i + 1;
          for (;;) {
            if (cPos !== -1 && cPos < s) cPos = text.indexOf(',', s);
            if (nPos !== -1 && nPos < s) nPos = text.indexOf('\n', s);
            if (rPos !== -1 && rPos < s) rPos = text.indexOf('\r', s);
            let idx = -1;
            let kind = 0;
            if (cPos !== -1 && (idx === -1 || cPos < idx)) { idx = cPos; kind = 1; }
            if (nPos !== -1 && (idx === -1 || nPos < idx)) { idx = nPos; kind = 2; }
            if (rPos !== -1 && (idx === -1 || rPos < idx)) { idx = rPos; kind = 3; }
            if (idx === -1) {
              fv = '"' + (acc ? acc.join('') + text.slice(s) : text.slice(s));
              i = n;
              fe = 2;
              break;
            }
            if (kind === 1) {
              fv = '"' + (acc ? acc.join('') + text.slice(s, idx) : text.slice(s, idx));
              i = idx + 1;
              fe = 0;
              break;
            }
            if (kind === 2) {
              fv = '"' + (acc ? acc.join('') + text.slice(s, idx) : text.slice(s, idx));
              i = idx + 1;
              line++;
              fe = 1;
              break;
            }
            if (text.charCodeAt(idx + 1) === 10) {
              fv = '"' + (acc ? acc.join('') + text.slice(s, idx) : text.slice(s, idx));
              i = idx + 2;
              line++;
              fe = 1;
              break;
            }
            errors.push({ code: 'stray_cr', line, row: rowOf(records.length) });
            if (!acc) acc = [];
            acc.push(text.slice(s, idx));
            s = idx + 1;
          }
          errors.push({ code: 'unterminated_quote', line, row: rowOf(records.length) });
        } else {
          let content = text.slice(i + 1, closedAt);
          // Line breaks inside the quotes, from the delimiter pointers
          // (no re-scan of the content): an LF or CR before the close.
          if (nPos !== -1 && nPos < i + 1) nPos = text.indexOf('\n', i + 1);
          if (rPos !== -1 && rPos < i + 1) rPos = text.indexOf('\r', i + 1);
          const hasLF = nPos !== -1 && nPos < closedAt;
          const hasCR = rPos !== -1 && rPos < closedAt;
          if (hasCR) {
            let nb = 0;
            for (let k = 0; k < content.length; k++) {
              const c = content.charCodeAt(k);
              if (c === 10) nb++;
              else if (c === 13) {
                nb++;
                if (content.charCodeAt(k + 1) === 10) k++;
              }
            }
            line += nb;
            content = content.replace(/\r\n?/g, '\n');
          } else if (hasLF) {
            let nb = 0;
            for (let k = nPos - (i + 1); k < content.length; k++) {
              if (content.charCodeAt(k) === 10) nb++;
            }
            line += nb;
          }
          // Resolve doubled quotes in one pass (only when any present).
          if (content.indexOf('""') !== -1) content = content.replace(/""/g, '"');
          const j = closedAt + 1;
          if (j >= n) {
            i = n;
            fv = content;
            fe = 2;
          } else {
            const cj = text.charCodeAt(j);
            if (cj === 44) {
              i = j + 1;
              fv = content;
              fe = 0;
            } else if (cj === 10) {
              i = j + 1;
              line++;
              fv = content;
              fe = 1;
            } else if (cj === 13 && text.charCodeAt(j + 1) === 10) {
              i = j + 2;
              line++;
              fv = content;
              fe = 1;
            } else {
              // Junk after the closing quote: appended as it stands.
              // quote_junk fires only when junk text was actually
              // appended (a region holding nothing but dropped stray
              // CRs appends nothing).
              let acc = null;
              let s = j;
              let jv;
              let je;
              for (;;) {
                if (cPos !== -1 && cPos < s) cPos = text.indexOf(',', s);
                if (nPos !== -1 && nPos < s) nPos = text.indexOf('\n', s);
                if (rPos !== -1 && rPos < s) rPos = text.indexOf('\r', s);
                let idx = -1;
                let kind = 0;
                if (cPos !== -1 && (idx === -1 || cPos < idx)) { idx = cPos; kind = 1; }
                if (nPos !== -1 && (idx === -1 || nPos < idx)) { idx = nPos; kind = 2; }
                if (rPos !== -1 && (idx === -1 || rPos < idx)) { idx = rPos; kind = 3; }
                if (idx === -1) {
                  jv = acc ? acc.join('') + text.slice(s) : text.slice(s);
                  i = n;
                  je = 2;
                  break;
                }
                if (kind === 1) {
                  jv = acc ? acc.join('') + text.slice(s, idx) : text.slice(s, idx);
                  i = idx + 1;
                  je = 0;
                  break;
                }
                if (kind === 2) {
                  jv = acc ? acc.join('') + text.slice(s, idx) : text.slice(s, idx);
                  i = idx + 1;
                  line++;
                  je = 1;
                  break;
                }
                if (text.charCodeAt(idx + 1) === 10) {
                  jv = acc ? acc.join('') + text.slice(s, idx) : text.slice(s, idx);
                  i = idx + 2;
                  line++;
                  je = 1;
                  break;
                }
                errors.push({ code: 'stray_cr', line, row: rowOf(records.length) });
                if (!acc) acc = [];
                acc.push(text.slice(s, idx));
                s = idx + 1;
              }
              if (jv !== '') {
                errors.push({ code: 'quote_junk', line, row: rowOf(records.length) });
              }
              fv = content + jv;
              fe = je;
            }
          }
        }
      } else {
        // ---- Unquoted field. ----
        let acc = null;
        let s = i;
        for (;;) {
          if (cPos !== -1 && cPos < s) cPos = text.indexOf(',', s);
          if (nPos !== -1 && nPos < s) nPos = text.indexOf('\n', s);
          if (rPos !== -1 && rPos < s) rPos = text.indexOf('\r', s);
          let idx = -1;
          let kind = 0;
          if (cPos !== -1 && (idx === -1 || cPos < idx)) { idx = cPos; kind = 1; }
          if (nPos !== -1 && (idx === -1 || nPos < idx)) { idx = nPos; kind = 2; }
          if (rPos !== -1 && (idx === -1 || rPos < idx)) { idx = rPos; kind = 3; }
          if (idx === -1) {
            fv = acc ? acc.join('') + text.slice(s) : text.slice(s);
            i = n;
            fe = 2;
            break;
          }
          if (kind === 1) {
            fv = acc ? acc.join('') + text.slice(s, idx) : text.slice(s, idx);
            i = idx + 1;
            fe = 0;
            break;
          }
          if (kind === 2) {
            fv = acc ? acc.join('') + text.slice(s, idx) : text.slice(s, idx);
            i = idx + 1;
            line++;
            fe = 1;
            break;
          }
          if (text.charCodeAt(idx + 1) === 10) {
            fv = acc ? acc.join('') + text.slice(s, idx) : text.slice(s, idx);
            i = idx + 2;
            line++;
            fe = 1;
            break;
          }
          errors.push({ code: 'stray_cr', line, row: rowOf(records.length) });
          if (!acc) acc = [];
          acc.push(text.slice(s, idx));
          s = idx + 1;
        }
      }
      fields.push(fv);
      if (fe === 0) continue;
      break;
    }
    const row = rowOf(records.length);
    if (width === -1) width = fields.length;
    else if (fields.length < width) {
      errors.push({ code: 'short_row', line: startLine, row, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: startLine, row, extra: fields.slice(width) });
      fields.length = width;
    }
    records.push(fields);
  }

  let columns = null;
  let rows;
  if (header) {
    columns = records.length ? records[0] : null;
    rows = records.slice(1);
  } else {
    rows = records;
  }
  return { columns, rows, errors };
}
