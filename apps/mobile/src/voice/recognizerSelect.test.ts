// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
  orderRecognizerCandidates,
  resolveEffectivePkg,
  isPinnedRecognizer,
  DEFAULT_RECOGNIZER_PKGS,
  SYSTEM_DEFAULT_RECOGNIZER,
} from './recognizerSelect';

const label = (pkg: string) => `label:${pkg}`;
const pkgs = (opts: { pkg: string }[]) => opts.map((o) => o.pkg);
// Build a `hasFailed` predicate from a set of already-failed packages.
const failed = (...f: string[]) => (pkg: string) => f.includes(pkg);
const [PINNED_1, PINNED_2] = DEFAULT_RECOGNIZER_PKGS; // tts, as

describe('orderRecognizerCandidates', () => {
  it('regression: a rogue third-party recognizer never shoulders out Google', () => {
    // The bug: getSpeechRecognitionServices() enumerates only the Claude app's
    // RecognitionService (and NOT Google's on-device engine), Android reports it
    // as the default, so carnet picked it and STT died. Google must still appear,
    // ranked ahead of the third-party service.
    const result = orderRecognizerCandidates(
      ['com.anthropic.claude'],
      'com.anthropic.claude',
      label,
    );
    const order = pkgs(result);
    expect(order).toContain('com.google.android.tts');
    expect(order).toContain('com.google.android.as');
    // Pinned Google recognizers come before the third-party one.
    expect(order.indexOf('com.google.android.tts')).toBeLessThan(order.indexOf('com.anthropic.claude'));
    expect(order.indexOf('com.google.android.as')).toBeLessThan(order.indexOf('com.anthropic.claude'));
  });

  it('injects the pinned recognizers even when Android enumerates none', () => {
    const order = pkgs(orderRecognizerCandidates([], '', label));
    expect(order.slice(0, DEFAULT_RECOGNIZER_PKGS.length)).toEqual([...DEFAULT_RECOGNIZER_PKGS]);
  });

  it('ranks pinned recognizers first, in their listed order', () => {
    // Android enumerates `as` first, but `tts` is pinned first → tts leads.
    const order = pkgs(orderRecognizerCandidates(['com.google.android.as'], 'com.google.android.as', label));
    expect(order[0]).toBe('com.google.android.tts');
    expect(order[1]).toBe('com.google.android.as');
  });

  it('ranks the OS default above other third-party recognizers', () => {
    const order = pkgs(
      orderRecognizerCandidates(['com.vendor.zeta', 'com.vendor.alpha'], 'com.vendor.zeta', label),
    );
    // pinned Google pkgs first, then the OS default (zeta), then alpha.
    expect(order.indexOf('com.vendor.zeta')).toBeLessThan(order.indexOf('com.vendor.alpha'));
    expect(order.indexOf('com.google.android.tts')).toBeLessThan(order.indexOf('com.vendor.zeta'));
  });

  it('dedups and appends System Default last', () => {
    const result = orderRecognizerCandidates(['com.google.android.tts'], '', label);
    const order = pkgs(result);
    // tts only once despite being both pinned and enumerated.
    expect(order.filter((p) => p === 'com.google.android.tts')).toHaveLength(1);
    expect(result[result.length - 1]).toEqual(SYSTEM_DEFAULT_RECOGNIZER);
  });

  it('labels every option via the provided labeler', () => {
    const result = orderRecognizerCandidates(['com.anthropic.claude'], '', label);
    const claude = result.find((o) => o.pkg === 'com.anthropic.claude');
    expect(claude?.label).toBe('label:com.anthropic.claude');
  });

  it('keeps pinned recognizers first even when the OS default is itself pinned', () => {
    // defaultPkg = a pinned pkg must not double-count or reorder the pinned block.
    const order = pkgs(orderRecognizerCandidates(['com.google.android.as'], 'com.google.android.tts', label));
    expect(order.slice(0, DEFAULT_RECOGNIZER_PKGS.length)).toEqual([...DEFAULT_RECOGNIZER_PKGS]);
    expect(order.filter((p) => p === 'com.google.android.tts')).toHaveLength(1);
  });

  it('preserves enumeration order among equal-rank third-party services', () => {
    // Two non-default third-party services tie on rank; stable sort keeps input order.
    const order = pkgs(orderRecognizerCandidates(['com.vendor.beta', 'com.vendor.alpha'], '', label));
    expect(order.indexOf('com.vendor.beta')).toBeLessThan(order.indexOf('com.vendor.alpha'));
  });
});

describe('resolveEffectivePkg', () => {
  it('resolves null ("try defaults") to the first pinned recognizer', () => {
    expect(resolveEffectivePkg(null, failed())).toBe(PINNED_1);
  });

  it('resolves "" ("system default") to the first pinned recognizer — never a bare start', () => {
    expect(resolveEffectivePkg('', failed())).toBe(PINNED_1);
  });

  it('honors an explicit package that has not failed (pinned or third-party)', () => {
    expect(resolveEffectivePkg(PINNED_2, failed())).toBe(PINNED_2);
    expect(resolveEffectivePkg('com.vendor.zeta', failed())).toBe('com.vendor.zeta');
  });

  it('swaps a failed explicit package for the first available pinned recognizer', () => {
    expect(resolveEffectivePkg('com.anthropic.claude', failed('com.anthropic.claude'))).toBe(PINNED_1);
  });

  it('falls through to the next pinned recognizer when the first pinned one failed', () => {
    expect(resolveEffectivePkg(PINNED_1, failed(PINNED_1))).toBe(PINNED_2);
  });

  it('returns null when every pinned recognizer has failed (null/"" requests)', () => {
    const allPinnedFailed = failed(...DEFAULT_RECOGNIZER_PKGS);
    expect(resolveEffectivePkg(null, allPinnedFailed)).toBeNull();
    expect(resolveEffectivePkg('', allPinnedFailed)).toBeNull();
  });

  it('returns null when a failed explicit package has no pinned recognizer left to fall back to', () => {
    const allPinnedFailed = failed(...DEFAULT_RECOGNIZER_PKGS, 'com.vendor.zeta');
    expect(resolveEffectivePkg('com.vendor.zeta', allPinnedFailed)).toBeNull();
  });

  it('still honors a working explicit third-party even when all pinned recognizers failed', () => {
    // Device without Google engines: an explicit, non-failed third-party is used as-is.
    const allPinnedFailed = failed(...DEFAULT_RECOGNIZER_PKGS);
    expect(resolveEffectivePkg('com.vendor.zeta', allPinnedFailed)).toBe('com.vendor.zeta');
  });
});

describe('isPinnedRecognizer', () => {
  it('recognizes the pinned Google packages', () => {
    expect(isPinnedRecognizer('com.google.android.tts')).toBe(true);
    expect(isPinnedRecognizer('com.google.android.as')).toBe(true);
  });
  it('rejects third-party recognizers', () => {
    expect(isPinnedRecognizer('com.anthropic.claude')).toBe(false);
    expect(isPinnedRecognizer('')).toBe(false);
  });
});
