# cmux-remote push relay

A tiny service we run. A user's server posts a push event here; the relay forwards it to the
[Expo push API](https://docs.expo.dev/push-notifications/sending-notifications/). Zero npm
dependencies, plain Node 22.

**What it carries:** a session id, a kind and a short title. Never terminal text or transcript
content. The outgoing message is built from those three fields only; any other field in the request
body is dropped.

## Run

```
RELAY_ENROL_SECRET=... node relay/server.js
```

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `RELAY_DATA` | `./relay-data.json` | store file |
| `RELAY_ENROL_SECRET` | unset | secret that allows a new serverKey to register. Unset means no new key can enrol |
| `EXPO_ACCESS_TOKEN` | unset | optional Expo bearer token |

## API

| Route | Body | Result |
|---|---|---|
| `GET /healthz` | | `200 {ok:true}` |
| `POST /v1/register` | `{serverKey, deviceToken, platform}` (`platform` is `ios` or `android`) | `200`; `401` if the key is new and the enrolment secret is missing or wrong |
| `POST /v1/push` | `{serverKey, deviceToken?, sessionId, kind, title}` | `200 {ok, sent}`; `401` unknown serverKey; `400` bad field; `404` no such device; `429` rate limited; `502` Expo failed |

`kind` is one of `needs-you`, `done`, `handover`, `context`, `resources`, `custom`. Omit
`deviceToken` to push to every device registered under the key.

## Enrolment

The first `/v1/register` for an unknown serverKey is accepted only when it carries the relay
enrolment secret, in the header `X-Relay-Enrol: <RELAY_ENROL_SECRET>`. After that the serverKey
alone is enough: further `/v1/register` calls (more devices) and every `/v1/push`. If
`RELAY_ENROL_SECRET` is unset the relay enrols nobody. `/v1/push` with an unknown serverKey is
refused with `401`.

## Store

One JSON file, written to a temp file then renamed. Keys are `sha256(serverKey)` mapped to
`{deviceTokens: [{token, platform, addedAt}]}`. The raw serverKey is never stored. A token Expo
reports as `DeviceNotRegistered` is removed.

## Limits

| Limit | Value | Behaviour |
|---|---|---|
| Expo request timeout | 10 s | request aborted, `502`, logged; no retries in v1 |
| Push rate | 60 per minute per serverKey | sliding window, in memory; over it returns `429` with `Retry-After` |
| Title length | 120 chars | longer titles are truncated |
| Session id length | 200 chars | longer is rejected with `400` |
| Request body | 4096 bytes | larger is rejected with `413` |
