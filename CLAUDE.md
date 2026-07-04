# Project notes for Claude Code

## Third-party API currency (IMPORTANT)

Before writing or editing ANY code that calls a third-party API (especially Spotify
and AudD), verify the endpoints, scopes, and auth flow against the provider's CURRENT
official documentation. Do not rely on training data for these - they change often.
Fetch the live docs and reconcile before implementing.

## Spotify Web API - 2026 changes (already in effect)

Spotify made breaking changes starting 2026-02-11, with further changelogs in March
and May 2026. This project's Spotify Client ID was created after 2026-02-11, so it is
subject to ALL the new rules - the postponement only covered pre-existing integrations.

When touching Spotify code, re-check the current docs and confirm at least these:

- Create playlist: use `POST /me/playlists`. The old `POST /users/{user_id}/playlists`
  was REMOVED.
- Add / remove / update playlist tracks: endpoints were renamed from `/tracks` to
  `/items`. Use `POST /playlists/{id}/items` (not `/tracks`).
- Save to library ("Add to Library"): the content-specific save/remove calls were
  consolidated. Use `PUT` / `DELETE /me/library` (verify the exact current shape)
  rather than the old `PUT /me/tracks`.
- Access requires a Spotify Premium account.
- Development Mode is capped at 5 authorized users and one Client ID per developer.
- Always re-read the changelog before relying on any endpoint, since changes are
  ongoing (February, March, and May 2026 so far).

References:
- Migration guide: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- Changelog: https://developer.spotify.com/documentation/web-api/references/changes/february-2026
