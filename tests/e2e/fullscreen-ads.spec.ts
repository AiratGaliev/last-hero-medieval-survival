import { expect, test } from '@playwright/test';

type AdCallbacks = {
  onClose?: (wasShown: boolean) => void;
  onRewarded?: () => void;
};
type AdsHarness = {
  showInterstitial: () => Promise<boolean>;
  showRewarded: () => Promise<{ rewarded: boolean; available: boolean }>;
  state: { calls: string[]; callbacks: AdCallbacks[] };
};
type HarnessWindow = Window & { __adsHarness: AdsHarness };

async function openHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/tests/fixtures/ads-harness.html');
  await expect(page.locator('html')).toHaveAttribute('data-ads-ready', 'true');
}

test('duplicate interstitial requests start only one fullscreen ad', async ({ page }) => {
  await openHarness(page);

  const result = await page.evaluate(async () => {
    const harness = (window as HarnessWindow).__adsHarness;
    const first = harness.showInterstitial();
    const second = harness.showInterstitial();
    const callsBeforeClose = [...harness.state.calls];

    for (const callbacks of harness.state.callbacks) callbacks.onClose?.(true);
    const outcomes = await Promise.all([first, second]);

    return { callsBeforeClose, outcomes };
  });

  expect(result.callsBeforeClose).toEqual(['interstitial']);
  expect(result.outcomes).toEqual([true, false]);
});

test('rewarded ad cannot overlap an in-flight interstitial', async ({ page }) => {
  await openHarness(page);

  const result = await page.evaluate(async () => {
    const harness = (window as HarnessWindow).__adsHarness;
    const interstitial = harness.showInterstitial();
    const rewarded = harness.showRewarded();
    const callsBeforeClose = [...harness.state.calls];

    harness.state.callbacks[0]?.onClose?.(true);
    return {
      callsBeforeClose,
      interstitial: await interstitial,
      rewarded: await rewarded,
    };
  });

  expect(result.callsBeforeClose).toEqual(['interstitial']);
  expect(result.interstitial).toBe(true);
  expect(result.rewarded).toEqual({ rewarded: false, available: false });
});

test('interstitial cannot overlap an in-flight rewarded ad', async ({ page }) => {
  await openHarness(page);

  const result = await page.evaluate(async () => {
    const harness = (window as HarnessWindow).__adsHarness;
    const rewarded = harness.showRewarded();
    const interstitial = harness.showInterstitial();
    const callsBeforeClose = [...harness.state.calls];

    harness.state.callbacks[0]?.onRewarded?.();
    harness.state.callbacks[0]?.onClose?.(true);
    return {
      callsBeforeClose,
      rewarded: await rewarded,
      interstitial: await interstitial,
    };
  });

  expect(result.callsBeforeClose).toEqual(['rewarded']);
  expect(result.rewarded).toEqual({ rewarded: true, available: true });
  expect(result.interstitial).toBe(false);
});
