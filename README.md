# token-radar-01 entry — model radar-2

`main.ts` (Node 22, standard library only) reads the sealed DefiLlama
snapshot, scores every pre-token protocol, and writes the ranked board
(`board.json`), the dashboard data (`data.js`), the static dashboard, the
screenshots, and `dossier.json` (built by the vendored `vendor/makefun-board.ts`,
the kit's file, unchanged).

The model (lib/model.ts): implied value = TVL x category multiple x growth
term x maturity term. A category multiple is the snapshot's own median
market-cap/TVL ratio for that category among protocols that already have a
token — each ratio capped at 3x, the median shrunk toward the global median
(0.2138) by sample size. The dashboard states the method, lists the
multiples, shows each protocol's own multiple and farm plan, and recomputes
every row in the page as a self-check against the board.

Run it against the kit snapshot:

    MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>

The screenshots are carried in the repository as base64 text
(`screenshots/*.png.b64`) because the submission channel moves text only;
the program decodes them back to the exact PNG bytes in the output.
