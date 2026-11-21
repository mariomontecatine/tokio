/**
 * The wordmark: "tokio" built from square blocks — one block, one token — with
 * the sun from the application icon standing in for the dot on the i.
 *
 * It is drawn on a 10-unit grid (290 × 100), so it is crisp at any height that
 * is a whole multiple of 10px; the masthead uses 20. Every block is in a single
 * path on purpose: drawn as separate shapes, each one was anti-aliased on its
 * own and the edges they share showed as faint lines between the rows. The
 * masters, icon included, are in `docs/brand/`.
 */
const BLOCKS =
  'M0 40h50v20h-50zM10 10h20v30h-20zM10 60h20v20h-20zM10 80h40v10h-40zM20 90h30v10h-30z' +
  'M60 50h60v10h-60zM60 60h20v20h-20zM60 80h60v10h-60zM70 40h40v10h-40zM70 90h40v10h-40zM100 60h20v20h-20z' +
  'M130 0h20v60h-20zM130 60h40v20h-40zM130 80h20v20h-20zM160 50h20v10h-20zM160 80h20v10h-20z' +
  'M170 40h20v10h-20zM170 90h20v10h-20z' +
  'M200 40h20v60h-20z' +
  'M230 50h60v10h-60zM230 60h20v20h-20zM230 80h60v10h-60zM240 40h40v10h-40zM240 90h40v10h-40zM270 60h20v20h-20z';

export function Wordmark() {
  return (
    <svg className="wordmark" viewBox="0 0 290 100" role="img" aria-label="tokio">
      <path d={BLOCKS} fill="currentColor" shapeRendering="crispEdges" />
      <circle className="wordmark-sun" cx="210" cy="20" r="12" />
    </svg>
  );
}
