/**
 * setupManager.js
 * -----------------------------------------------------------------------
 * Owns the single active setup for one instrument and enforces the rule:
 * only one direction's setup may be active at a time. When a new
 * structure event produces an OB in the opposite direction of whatever
 * is currently active, the old setup is cancelled (if still waiting for
 * confluence) or closed (if already in a trade), and the new one takes
 * over. A new same-direction OB also supersedes the old one, since it's
 * a fresher, more relevant structure read.
 *
 * This module owns the state machine:
 *
 *   WATCHING_STRUCTURE
 *     -> OB_IDENTIFIED                 (on structure event + OB found)
 *     -> IN_ZONE_AWAITING_CONFLUENCE   (price enters the OB zone)
 *     -> IN_TRADE                      (confluence engine fires entry)
 *     -> MANAGING_EXITS                (TP1/TP2 hit, SL moved, etc.)
 *
 *   [any state] -- opposing OB detected --> superseded/closed, restart
 *   [any state] -- OB invalidated (wick through, pre-entry only) --> cancelled
 *
 * The confluence engine and trade execution are separate modules (not
 * built yet) — this class exposes hook points (`onPriceUpdate`,
 * `onConfluenceHit`, `onTradeEvent`) for them to call into, and emits a
 * flat event log suitable for feeding straight into the Postgres journal
 * later.
 * -----------------------------------------------------------------------
 */

const { findOrderBlock, checkInvalidation, isPriceInZone } = require('./orderblock');

const STATUS = {
  OB_IDENTIFIED: 'OB_IDENTIFIED',
  IN_ZONE_AWAITING_CONFLUENCE: 'IN_ZONE_AWAITING_CONFLUENCE',
  IN_TRADE: 'IN_TRADE',
  MANAGING_EXITS: 'MANAGING_EXITS',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
};

class SetupManager {
  /**
   * @param {string} symbol - instrument identifier, e.g. "BTCUSDT"
   */
  constructor(symbol) {
    this.symbol = symbol;
    this.activeSetup = null; // the one live setup, or null
    this.log = []; // flat chronological event log (journal-ready)
    // Structure events are confirmed with an inherent lag (a swing needs
    // future candles to be recognized as a swing at all), so "is this
    // event new" can't be checked via breakIndex === latestCandleIndex.
    // Track the highest breakIndex already processed instead.
    this.lastProcessedBreakIndex = -1;
  }

  _emit(type, data = {}) {
    const entry = { symbol: this.symbol, type, time: Date.now(), ...data };
    this.log.push(entry);
    return entry;
  }

  /**
   * Call this whenever detectStructure() produces a new BOS/CHoCH event.
   * Handles the full override logic.
   *
   * @param {import('./swings').Candle[]} candles
   * @param {import('./structure').StructureEvent} structureEvent
   * @param {number} fib - precomputed fib levels for this event (from computeFibLevels)
   */
  onStructureEvent(candles, structureEvent, fib) {
    const ob = findOrderBlock(candles, structureEvent);
    if (!ob) {
      this._emit('ob_not_found', { structureEvent });
      return;
    }

    if (this.activeSetup && this.activeSetup.status !== STATUS.CLOSED && this.activeSetup.status !== STATUS.CANCELLED) {
      this._supersedeActiveSetup(structureEvent.direction);
    }

    this.activeSetup = {
      direction: structureEvent.direction,
      ob,
      fib,
      status: STATUS.OB_IDENTIFIED,
      confluences: { mandatory: {}, optional: {} }, // filled in by the confluence engine later
      trade: null,
      createdAtIndex: structureEvent.breakIndex,
      sourceEvent: structureEvent,
    };

    this._emit('setup_created', {
      direction: structureEvent.direction,
      obRange: [ob.low, ob.high],
      fib,
    });
  }

  /**
   * Cancels (if awaiting confluence) or closes (if already in a trade)
   * whatever setup is currently active, because a newer structure event
   * has arrived — whether opposing or same-direction.
   */
  _supersedeActiveSetup(newDirection) {
    const setup = this.activeSetup;
    const isOpposing = setup.direction !== newDirection;
    const reason = isOpposing ? 'opposing_setup_override' : 'superseded_by_newer_setup';

    if (setup.status === STATUS.IN_TRADE || setup.status === STATUS.MANAGING_EXITS) {
      setup.status = STATUS.CLOSED;
      this._emit('trade_closed', { reason, direction: setup.direction, trade: setup.trade });
    } else {
      setup.status = STATUS.CANCELLED;
      this._emit('setup_cancelled', { reason, direction: setup.direction });
    }
  }

  /**
   * Call this on every new candle to check OB invalidation (pre-entry)
   * and zone entry. Should run before the confluence engine checks its
   * indicators for this candle.
   *
   * @param {import('./swings').Candle} candle
   * @param {number} index
   * @returns {boolean} true if the setup is still alive after this check
   */
  onPriceUpdate(candle, index) {
    const setup = this.activeSetup;
    if (!setup || setup.status === STATUS.CLOSED || setup.status === STATUS.CANCELLED) {
      return false;
    }

    // OB invalidation only matters before we've entered a trade.
    if (setup.status === STATUS.OB_IDENTIFIED || setup.status === STATUS.IN_ZONE_AWAITING_CONFLUENCE) {
      checkInvalidation(setup.ob, candle, index);
      if (!setup.ob.valid) {
        setup.status = STATUS.CANCELLED;
        this._emit('setup_cancelled', { reason: 'ob_invalidated', direction: setup.direction, atIndex: index });
        return false;
      }
    }

    if (setup.status === STATUS.OB_IDENTIFIED && isPriceInZone(setup.ob, candle)) {
      setup.status = STATUS.IN_ZONE_AWAITING_CONFLUENCE;
      this._emit('entered_zone', { direction: setup.direction, atIndex: index });
    }

    return true;
  }

  /**
   * Hook for the confluence engine to report a flag firing (e.g.
   * "waveTrendDot", "mfi", "vwap", "rsi", ...). Once 3 mandatory + 2
   * optional are true, call `enterTrade()` to transition to IN_TRADE.
   *
   * @param {'mandatory'|'optional'} bucket
   * @param {string} flagName
   */
  onConfluenceFlag(bucket, flagName) {
    const setup = this.activeSetup;
    if (!setup || setup.status !== STATUS.IN_ZONE_AWAITING_CONFLUENCE) return;

    setup.confluences[bucket][flagName] = true;
    this._emit('confluence_flag', { bucket, flagName, direction: setup.direction });
  }

  /**
   * @returns {boolean} whether the mandatory trio + 2-of-4 optional rule is satisfied
   */
  hasFullConfluence() {
    const setup = this.activeSetup;
    if (!setup) return false;

    const mandatoryKeys = ['waveTrendDot', 'mfi', 'vwap'];
    const mandatoryMet = mandatoryKeys.every((k) => setup.confluences.mandatory[k]);

    const optionalCount = Object.values(setup.confluences.optional).filter(Boolean).length;

    return mandatoryMet && optionalCount >= 2;
  }

  /**
   * Transition into an active trade once confluence is satisfied.
   * Execution layer would call this after actually placing the order.
   */
  enterTrade(entryPrice, size) {
    const setup = this.activeSetup;
    if (!setup) return;

    setup.status = STATUS.IN_TRADE;
    setup.trade = {
      entryPrice,
      size,
      remainingSize: size,
      sl: setup.fib.sl,
      slMovedToEntry: false,
      tp1Hit: false,
      tp2Hit: false,
    };

    this._emit('trade_entered', { direction: setup.direction, entryPrice, size, fib: setup.fib });
  }

  /**
   * Generic hook for trade lifecycle events (TP1/TP2/full close/SL hit)
   * once the execution layer is built. Kept intentionally simple here —
   * full position math lives in the execution/risk modules.
   */
  onTradeEvent(eventName, data = {}) {
    const setup = this.activeSetup;
    if (!setup || !setup.trade) return;

    if (eventName === 'tp1_hit') {
      setup.trade.tp1Hit = true;
      setup.trade.slMovedToEntry = true;
      setup.status = STATUS.MANAGING_EXITS;
    } else if (eventName === 'tp2_hit') {
      setup.trade.tp2Hit = true;
    } else if (eventName === 'full_close' || eventName === 'sl_hit') {
      setup.status = STATUS.CLOSED;
    }

    this._emit(eventName, { direction: setup.direction, ...data });
  }
}

module.exports = { SetupManager, STATUS };
