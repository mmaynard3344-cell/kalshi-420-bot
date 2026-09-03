import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getEthMarketEvidenceDisplayState,
  getEth420OrderHistoryDisplayState,
  getEthPositionDisplayState,
  type Eth420LiveMarketData,
} from './LiveMartingale';

test('ETH 420 order history display distinguishes unreadable storage from an empty ledger', () => {
  assert.deepEqual(getEth420OrderHistoryDisplayState({
    ordersAvailability: { available: false },
  }), {
    kind: 'unavailable',
    detail: 'Recent ETH 420 order history is temporarily unavailable.',
  });
  assert.deepEqual(getEth420OrderHistoryDisplayState({
    ordersAvailability: { available: true },
  }), { kind: 'available', detail: '' });
});

test('ETH position display does not treat absent response data as no position', () => {
  assert.deepEqual(getEthPositionDisplayState(null), {
    kind: 'loading', detail: 'Waiting for the durable position ledger',
  });
});

test('ETH position display preserves durable ledger unavailable state', () => {
  assert.deepEqual(getEthPositionDisplayState({
    availability: { status: 'unavailable', reason: 'active_eth_market_not_observed' },
    market: null,
    evidence: null,
    adjacentMoveAvailability: { status: 'unavailable', reason: 'quote_or_market_evidence_unavailable' },
    candidatePosition: { availability: 'unavailable', reason: 'durable_candidate_ledger_unavailable', position: null },
  }), {
    kind: 'unavailable', detail: 'Position unavailable · durable candidate ledger unavailable',
  });
});

test('ETH position display shows no live position only after an available empty ledger response', () => {
  assert.deepEqual(getEthPositionDisplayState({
    availability: { status: 'unavailable', reason: 'active_eth_market_not_observed' },
    market: null,
    evidence: null,
    adjacentMoveAvailability: { status: 'unavailable', reason: 'quote_or_market_evidence_unavailable' },
    candidatePosition: { availability: 'available', reason: null, position: null },
  }), { kind: 'empty', detail: 'No live ETH position' });
});

const freshEvidence: Eth420LiveMarketData = {
  availability: { status: 'fresh', reason: null, quoteAgeMs: 483 },
  market: {
    ticker: 'KXETH15M-26AUG300115-15',
    exchangeIndex: 2,
    openTime: '2026-08-30T05:00:00Z',
    closeTime: '2026-08-30T05:15:00Z',
    quoteUpdatedAtMs: 1788066044165,
  },
  evidence: {
    yesBid: 61, yesAsk: 63, noBid: 37, noAsk: 39,
    yesSpreadCents: 2, noSpreadCents: 2, floorStrike: 2455.31,
    adjacentMove: 0.000024437429996923095,
  },
  adjacentMoveAvailability: { status: 'fresh', reason: null },
  candidatePosition: { availability: 'available', reason: null, position: null },
};

test('ETH market evidence display preserves the validated adjacent move', () => {
  assert.deepEqual(getEthMarketEvidenceDisplayState(freshEvidence), {
    evidence: freshEvidence.evidence,
    adjacentMove: '0.0024%',
  });
});

test('ETH market evidence display keeps fresh BBO and strike when only adjacent move is unavailable', () => {
  const data: Eth420LiveMarketData = {
    ...freshEvidence,
    evidence: { ...freshEvidence.evidence!, adjacentMove: null },
    adjacentMoveAvailability: { status: 'unavailable', reason: 'validated_adjacent_move_not_current' },
  };
  const display = getEthMarketEvidenceDisplayState(data);
  assert.equal(display.evidence?.yesBid, 61);
  assert.equal(display.evidence?.floorStrike, 2455.31);
  assert.equal(display.adjacentMove, 'Unavailable · validated adjacent move not current');
});