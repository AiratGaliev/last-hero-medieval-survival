# Platform Adapter architecture

**Status:** normative target architecture for the first Pikabu Games release.
**Implementation status at baseline `dev` SHA `0f6fd7dafdae7baeffa0389c3bcda63016a4472f`: not implemented yet. The current `src/platform/` modules are a Yandex-specific integration layer and must not be described as provider-neutral.

## 1. Product decision

- **Pikabu Games is the first release target.**
- Yandex Games remains a possible secondary distribution channel. Preserve its implementation, but its Console/Sandbox, IAP and Metrica checks do not block Pikabu v1.
- Keep Phaser 4 + TypeScript as the game runtime. Do not wait for Codogma Engine or its editor and do not introduce engine abstractions into this work.
- The initial Pikabu release does not require IAP or a portal leaderboard. Ads are an optional capability and remain disabled until the corresponding UX and provider flow are explicitly accepted.

## 2. Current state and migration boundary

The current repository already groups integration code under `src/platform/`:

- `sdk.ts` declares `YandexSdk`, `YandexPlayer`, `YandexPayments` and loads the Yandex SDK.
- `player.ts`, `ads.ts`, `payments.ts`, `leaderboard.ts`, `lifecycle.ts` and parts of `analytics.ts` depend directly on Yandex APIs, event names or Player Data.
- Game code already uses some service-level functions, but the provider boundary is incomplete: the current modules are not reusable adapters.

The migration must preserve existing behavior behind a Yandex provider rather than delete it. Provider-specific SDK types, script URLs, event names, host checks and error mappings belong only inside the matching provider implementation.

## 3. Target layout

This is a target structure, not a claim that these folders already exist:

```text
src/platform/
  contracts/
    PlatformAdapter.ts
    PlatformLifecycle.ts
    PlatformPlayer.ts
    PlatformStorage.ts
    PlatformAds.ts
    PlatformAnalytics.ts
    PlatformLeaderboard.ts       # optional capability
    PlatformPayments.ts          # optional capability
  providers/
    pikabu/
      PikabuPlatform.ts
      ...
    yandex/
      YandexPlatform.ts
      ...
    web/
      WebPlatform.ts             # local browser fallback
  PlatformRegistry.ts
```

Names may follow the existing project's conventions, but the ownership boundary must remain explicit.

## 4. Contract rules

### 4.1 Provider and capability discovery

- A provider exposes a stable platform identifier, an asynchronous initializer and the capabilities it actually supports.
- Provider selection occurs once at the composition/bootstrap boundary. Game scenes and domain systems must not inspect hostnames, query strings or global SDK objects to select a platform.
- The selected provider may be Pikabu, Yandex or the local Web provider. Tests can inject a deterministic mock.
- Optional capabilities are represented as optional services or explicit capability metadata. An unavailable feature must return an unavailable result; it must never report a fake success.
- Initialization has a bounded timeout and a recoverable error result. Failure to initialize an optional capability must not prevent the core game from starting.

### 4.2 Lifecycle

The contract covers the game-ready signal, application gameplay start/stop and optional host pause/resume notifications. Host lifecycle events are capability-specific; the adapter must not invent events a provider does not expose. Browser visibility and focus are handled independently of provider events.

Pause ownership must be composable: a host pause, a hidden browser tab and an ad overlay are independent pause sources. One source must not resume the game while another source remains active. Audio muting is part of the lifecycle behavior and must be restored only when all mute sources are cleared.

### 4.3 Player identity

Expose a provider-neutral snapshot containing only the data the game needs (stable provider-scoped player ID, display name, avatar and authorization state). Authorization is an optional operation/capability.

Identity can change after authorization on some providers. Consumers must be notified or must refresh the snapshot; cached provider identity must not be assumed permanent. Raw player IDs must not be sent to analytics.

### 4.4 Cloud storage

The game-facing contract supports typed reads/writes/removals and an explicit asynchronous flush result, even when a provider's underlying API mutates local state synchronously.

- A successful local `set` is not proof that data reached the provider's server.
- Flush returns an explicit success/failure result with a normalized reason; retryability is provider-specific.
- Do not blindly retry after revision conflicts or quota/rate-limit errors.
- Keep the game's save envelope/versioning and migration logic provider-neutral.
- Document and enforce each provider's quotas, rate limits and concurrency restrictions in its adapter.

**Pikabu-specific constraints:** `sdk.storage.get/set/remove` are synchronous and changes are automatically queued, but server persistence is confirmed only by awaiting `sdk.storage.flush()`. Storage quota is 200 KB; the documented limit is 100 server save requests per 5 minutes. `REVISION_CONFLICT` means another game instance changed the data; a reload/re-hydration flow is required, and retrying `flush()` against the stale revision does not resolve it. Keep saves compact and coalesce writes rather than flushing on every small mutation.

### 4.5 Ads

Ads are optional. The contract distinguishes support/availability from the result of a show request. A rewarded grant is allowed only after an explicit provider result confirming the reward.

The application owns pause/resume orchestration around overlays, using the lifecycle contract. Every exit path (success, unavailable, close, error, timeout) must restore the game and audio exactly once. Pikabu supports preloader, fullscreen and rewarded formats; the initial Pikabu release may ship without invoking ads.

### 4.6 Analytics

Keep a provider-neutral game event model and local/debug capture. Connect delivery only to a documented destination. Do not assume that a portal's aggregate Studio statistics imply a custom event API.

Pikabu Studio currently documents aggregate unique players, sessions, average session duration, time per player, ad and payment reports. These are useful for the first release, but are not a documented substitute for custom event delivery or D1/D7/D30 cohort reports. Do not claim those cohort metrics are available unless an approved analytics destination actually provides them.

### 4.7 Optional capabilities

Leaderboards and payments are separate optional capabilities. Their absence must preserve local records and the core game loop. Pikabu v1 does not require either capability. Do not build a backend or payment verification flow merely to preserve a feature that is not in the first-release scope.

## 5. Provider-specific implementation notes

### Pikabu Games — first provider

- Load and initialize the Pikabu SDK only in the Pikabu game page or the Studio test environment. Official documentation explicitly says the SDK does not work when loaded on an arbitrary local website.
- Local development and automated browser tests use the Web/mock provider; they must not wait for or fetch the Pikabu SDK.
- Load the SDK once with `PkbSDK.init()` and call `sdk.gameStarted()` only after core resources are loaded and the first screen is ready. The documented Pikabu Events API currently lists `userAuthorized` and `storageSaveError`; it does **not** document Yandex-style host pause/resume events. Do not invent or subscribe to them.
- Map `sdk.player` to the player snapshot. Re-read the ID after authorization because the SDK documents that a guest ID may change after account authorization.
- Wrap `sdk.storage` including explicit `flush()`, save errors and the conflict/reload path.
- Ads are optional and disabled by default for the initial validation release. If enabled later, check `isSupported` / `canShow()`, await `show()` and grant a reward only when its result says `reward: true`. Pause gameplay/audio before the overlay and restore them in a guaranteed cleanup path.
- Use Pikabu Studio reports for aggregate first-release statistics. Do not invent a custom analytics endpoint.
- Wrap game-initiated authorization/payment overlays with application-owned pause/resume handling where applicable. The SDK's documented event list does not provide generic overlay-open/close callbacks; verify platform-initiated overlays in Studio QA and use browser visibility/focus signals where they occur.
- Do not implement IAP or portal leaderboards in v1 unless the owner changes the scope explicitly.
- Host the static `dist/` bundle on a controlled HTTPS origin. Pikabu's technical requirements currently say that uploading a game build to Pikabu's servers is not supported; a game-hosting service such as GamePush is an alternative if self-hosting is not available. This does not imply that the game needs an application backend.

### Yandex Games — preserved secondary provider

Keep the current Yandex behavior behind a Yandex provider: SDK init, Player Data, Yandex ads callbacks, Yandex Payments, leaderboards, server time and Yandex-specific lifecycle events. Its external sandbox acceptance remains deferred until Yandex is selected as a release channel again.

### Web/local provider

The Web provider supports local development, browser preview and deterministic automated tests without portal globals. It uses local persistence where possible and reports portal-only features as unsupported. This provider is not a production substitute for Pikabu cloud storage.

## 6. Release and verification order

1. Define and test the provider-neutral contracts and registry.
2. Move the current Yandex code behind its provider without changing gameplay behavior.
3. Implement the Pikabu provider against the contracts.
4. Verify SDK initialization, identity changes, storage flush/failure/conflict, lifecycle and any enabled ads in the Pikabu Studio test environment.
5. Produce a static production build and host it over HTTPS.
6. Complete desktop/mobile, content and moderation acceptance for Pikabu.
7. Publish Pikabu v1. Consider Yandex as a second channel only after a separate release decision.

## 7. Acceptance invariants

- Game/domain code contains no imports from concrete provider SDKs or provider implementations.
- Provider selection is centralized and explicit.
- Missing provider/capability does not prevent local game boot or core gameplay.
- Save completion is never reported before the provider confirms it when confirmation is available.
- Pause/resume and audio behavior remain correct with overlapping host, browser and ad pause sources.
- Provider errors, timeouts, quota/rate limits and identity changes are observable and tested.
- The current Yandex implementation is preserved as a secondary provider, not silently removed.
- No Codogma Engine, editor, IAP or generic plugin framework is introduced by this work.

## 8. Work tracking

- [LAS-22 — Platform Adapter and Pikabu first release](https://linear.app/last-hero/issue/LAS-22/platform-introduce-provider-based-platform-adapter-and-make-pikabu-the)
- [LAS-23 — Platform contracts and Yandex provider isolation](https://linear.app/last-hero/issue/LAS-23/architecture-define-platform-contracts-and-isolate-the-existing-yandex)
- [LAS-24 — Pikabu provider](https://linear.app/last-hero/issue/LAS-24/platform-implement-pikabu-provider-for-first-release)
- [LAS-25 — Pikabu v1 submission and QA](https://linear.app/last-hero/issue/LAS-25/release-prepare-and-accept-the-pikabu-games-v1-submission)
- [LAS-20 — Final Pikabu v1 acceptance gate](https://linear.app/last-hero/issue/LAS-20/release-complete-final-gameplay-and-pikabu-v1-acceptance-gate)

## 9. Official Pikabu documentation

- [SDK initialization](https://games.pikabu.ru/sdk/docs/sdk/init)
- [Player and authorization](https://games.pikabu.ru/sdk/docs/sdk/player)
- [Cloud storage](https://games.pikabu.ru/sdk/docs/sdk/storage)
- [Ads](https://games.pikabu.ru/sdk/docs/sdk/ads)
- [Technical requirements](https://games.pikabu.ru/sdk/docs/requirements/tech)
- [Content requirements](https://games.pikabu.ru/sdk/docs/requirements/content)
- [Moderation and publication](https://games.pikabu.ru/sdk/docs/studio/moderation)
- [Studio statistics](https://games.pikabu.ru/sdk/docs/studio/stats)
- [SDK events](https://games.pikabu.ru/sdk/docs/sdk/events)
