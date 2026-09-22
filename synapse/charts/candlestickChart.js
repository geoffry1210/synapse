/**
 * candlestickChart.js
 * -----------------------------------------------------------------------
 * Renders a candlestick chart as a PNG buffer (via node-canvas) with the
 * OB zone shaded, fib entry/SL/TP levels drawn as labeled horizontal
 * lines, and a title showing symbol/direction/status. This is the
 * "full visuals" piece for Telegram — output is a Buffer ready to pass
 * straight to grammY's `ctx.replyWithPhoto({ source: buffer })`.
 * -----------------------------------------------------------------------
 */

const { createCanvas } = require('canvas');

const COLORS = {
  background: '#131722',
  grid: '#1e222d',
  bullishCandle: '#26a69a',
  bearishCandle: '#ef5350',
  obZone: 'rgba(120, 123, 134, 0.25)',
  entry: '#2196f3',
  sl: '#ef5350',
  tp1: '#66bb6a',
  tp2: '#43a047',
  tpFull: '#2e7d32',
  text: '#d1d4dc',
  axisText: '#787b86',
};

/**
 * @param {import('../core/swings').Candle[]} candles - full history, oldest to newest
 * @param {import('../core/setupManager').SetupManager['activeSetup']} setup
 * @param {{ width?: number, height?: number, candlesToShow?: number, title?: string, format?: 'png'|'jpeg', quality?: number }} opts
 *   format/quality: use 'jpeg' with a lower quality (e.g. 0.6) for bandwidth-sensitive
 *   contexts like Telegram notifications on a free hosting tier — a compact JPEG
 *   is a fraction of the size of a PNG for a chart like this. Defaults to lossless PNG.
 * @returns {Buffer} image buffer (PNG or JPEG per opts.format)
 */
function renderSetupChart(candles, setup, opts = {}) {
  const width = opts.width ?? 900;
  const height = opts.height ?? 500;
  const candlesToShow = opts.candlesToShow ?? 60;
  const padding = { top: 50, right: 90, bottom: 30, left: 10 };

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const window = candles.slice(-candlesToShow);
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // --- Price range: candles in view + OB zone + fib levels, so nothing
  // --- of interest gets clipped off the top/bottom.
  const levelPrices = setup
    ? [setup.ob.low, setup.ob.high, setup.fib.entry, setup.fib.sl, setup.fib.tp1, setup.fib.tp2, setup.fib.tpFull]
    : [];
  const allPrices = window.flatMap((c) => [c.high, c.low]).concat(levelPrices);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const priceRange = maxPrice - minPrice || 1;
  const pricePad = priceRange * 0.08;
  const yMin = minPrice - pricePad;
  const yMax = maxPrice + pricePad;

  const priceToY = (price) => padding.top + chartHeight * (1 - (price - yMin) / (yMax - yMin));
  const indexToX = (i) => padding.left + (chartWidth * (i + 0.5)) / window.length;
  const candleWidth = Math.max(2, (chartWidth / window.length) * 0.6);

  // --- Background ---
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // --- Grid lines (5 horizontal) ---
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartHeight * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  // --- OB zone (shaded rectangle spanning the chart width) ---
  if (setup) {
    const obTop = priceToY(setup.ob.high);
    const obBottom = priceToY(setup.ob.low);
    ctx.fillStyle = COLORS.obZone;
    ctx.fillRect(padding.left, obTop, chartWidth, obBottom - obTop);
  }

  // --- Candles ---
  window.forEach((c, i) => {
    const x = indexToX(i);
    const isBullish = c.close >= c.open;
    ctx.strokeStyle = ctx.fillStyle = isBullish ? COLORS.bullishCandle : COLORS.bearishCandle;

    // wick
    ctx.beginPath();
    ctx.moveTo(x, priceToY(c.high));
    ctx.lineTo(x, priceToY(c.low));
    ctx.stroke();

    // body
    const bodyTop = priceToY(Math.max(c.open, c.close));
    const bodyBottom = priceToY(Math.min(c.open, c.close));
    ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, Math.max(1, bodyBottom - bodyTop));
  });

  // --- Fib level lines ---
  if (setup) {
    const levels = [
      { label: 'Entry', price: setup.fib.entry, color: COLORS.entry },
      { label: 'SL', price: setup.fib.sl, color: COLORS.sl },
      { label: 'TP1', price: setup.fib.tp1, color: COLORS.tp1 },
      { label: 'TP2', price: setup.fib.tp2, color: COLORS.tp2 },
      { label: 'Full TP', price: setup.fib.tpFull, color: COLORS.tpFull },
    ];

    for (const level of levels) {
      const y = priceToY(level.price);
      ctx.strokeStyle = level.color;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = level.color;
      ctx.font = '13px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${level.label} ${level.price.toFixed(2)}`, width - padding.right + 6, y);
    }
  }

  // --- Title ---
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 16px sans-serif';
  ctx.textBaseline = 'top';
  const title = opts.title ?? (setup ? `${setup.direction.toUpperCase()} — ${setup.status}` : 'No active setup');
  ctx.fillText(title, padding.left, 16);

  if (opts.format === 'jpeg') {
    return canvas.toBuffer('image/jpeg', { quality: opts.quality ?? 0.7 });
  }
  return canvas.toBuffer('image/png');
}

module.exports = { renderSetupChart, COLORS };
