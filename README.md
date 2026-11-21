# csv-reader-speed-01 — fast drop-in for csv-reader 1.0.0

`run({ text, header })` in `solve.js` returns csv-reader 1.0.0's reading of
the input as `{ columns, rows, errors }`, exactly per the competition spec
(BOM drop, LF/CRLF record ends, stray-CR errors, quoted fields with doubled
quotes, CRLF/lone-CR inside quotes read as LF, quote junk, unterminated
quotes re-read as unquoted, short/long row padding and cutting to the first
record's width, errors in the order met).

`main.ts` is the harness entry point: it reads cases from
`$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), answers each case with
`run()`, and writes the answers to `$MAKEFUN_OUTPUT_DIR` (default `/output`).

## Speed

Lines with no quote and no stray CR are split with the engine's native
`split(',')`. Quoted / broken lines go through an indexOf-driven scanner
that slices fields instead of accumulating characters, with forward-only
delimiter pointers so total scanning is linear in the text size. Measured
locally against a literal char-by-char reference parser (same spec):

- clean 200k lines: ~2.2x faster
- broken 30k lines: ~2.1x faster
- quoted 50k short-field lines: ~1.1x faster
- quoted 10k long-field lines (~9 MB): ~93x faster
