import { describe, expect, it } from 'vitest';

import { metadataForVisitor, metadataFromCurrentVisitor, mergeMetadata } from '../../src/node/stripe.js';
import { runWithVisitorId } from '../../src/node/visitor-context.js';

describe('Stripe metadata', () => {
  it('validates and trims explicit visitors', () => {
    expect(metadataForVisitor(' visitor_A-1 ')).toEqual({ cekat_visitor_id: 'visitor_A-1' });
    expect(metadataForVisitor('a')).toEqual({ cekat_visitor_id: 'a' });
    expect(metadataForVisitor('a'.repeat(128))).toEqual({ cekat_visitor_id: 'a'.repeat(128) });
    expect(metadataForVisitor('a'.repeat(129))).toEqual({});
    expect(metadataForVisitor('invalid visitor')).toEqual({});
  });

  it('reads only a valid current visitor and returns fresh metadata', () => {
    expect(runWithVisitorId(' scoped ', metadataFromCurrentVisitor)).toEqual({ cekat_visitor_id: 'scoped' });
    expect(metadataFromCurrentVisitor()).toEqual({});
    expect(metadataForVisitor('visitor')).not.toBe(metadataForVisitor('visitor'));
  });

  it('merges without mutating the merchant metadata', () => {
    const merchant = { merchant: 'keep', cekat_visitor_id: 'replace' };
    const merged = mergeMetadata(merchant, ' visitor_2 ');
    expect(merged).toEqual({ merchant: 'keep', cekat_visitor_id: 'visitor_2' });
    expect(merged).not.toBe(merchant);
    expect(merchant).toEqual({ merchant: 'keep', cekat_visitor_id: 'replace' });
    expect(mergeMetadata(merchant, 'invalid visitor')).toEqual(merchant);
    expect(mergeMetadata(merchant, 'invalid visitor')).not.toBe(merchant);
  });
});
