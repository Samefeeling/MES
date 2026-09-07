# Mango Public API v4 — what PMD uses

Extracted from *Mango Public API V4 for HTTP Developers* (2025-12-01), the
vendor PDF. **This file is the authority for `src/ui/mango-api.ts` and the
API half of `src/core/impw.ts` — nothing there is inferred from the web
form.** Only the parts PMD actually calls are reproduced; the document also
covers Accident/Incident, Audit, Compliance, Position, Employee, Employee
Skill and Employee Training.

## Hosts

| Account region | Base URL |
| --- | --- |
| Default | `https://api.mangolive.com` |
| UK | `https://api-uk.mangolive.com` |

Paths are case-insensitive and **must not end with a slash or whitespace**.
All requests and responses are JSON.

## Dates

All dates are **UTC, ISO 8601 combined date and time**:
`2021-02-28T00:00:00Z`. (The web form shows `dd/mm/yyyy`; the API does not
take that format.)

## Setting up

- The company must have API access enabled.
- API access must be enabled on the specific Mango user account, from
  inside Mango. A normal login is not automatically an API login.

## Auth — `POST /api/auth/authenticate`

Request:

```json
{ "username": "user", "password": "password" }
```

Both are `String(min_length=8, required)`.

Response:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs…",
  "message": null,
  "username": "username",
  "lastName": "One",
  "firstName": "User",
  "emailAddress": "email@email.com",
  "guid": "ABCDEFGH-1234-5678-9012-ABCDEFGHIK"
}
```

Errors: **400** — `{"message": "Username or password is incorrect"}`.

Every other call sends:

```
Content-Type: application/json
Authorization: Bearer <TOKEN>
```

> **The token is only valid for the same IP address that acquired it.**
> A tablet that changes network (Wi-Fi → 4G) must authenticate again. PMD
> caches the token in memory only and re-authenticates on a 401.

Related: `POST /api/auth/logout`, `GET /api/auth` (user details),
`GET /api/auth/validate` (401 if the token is invalid).

## Improvement lookups — `GET /api/v4/improvement/new`

Returns the tenant's own option lists. **This is a GET, and it is not the
endpoint that creates anything** — the name is misleading.

```json
{
  "coordinator": [
    { "id": "Wk4WBM7TxTMCZNrJzxxEkT7RMyDTo3y-roEkucrpLHnO4ir2y", "name": "Felicity Kidwell" }
  ],
  "typeOfImprovement": [
    { "id": "GfuUaXy_yPcB-HzmCZ4rZLvUHbG7oMI", "name": "Audit finding" },
    { "id": "Wk4WBM11lZ2EbMmvY4CR9J37U5r0", "name": "Customer complaint" }
  ]
}
```

Errors: **401**.

This is why PMD never invents a Type of Improvement or a Coordinator — the
plant's real list comes back from here, and both are picked from it.

## Create an improvement — `POST /api/v4/improvement`

```json
{
  "description": "string",
  "typeOfImprovement": { "id": "…", "name": "Customer Contact" },
  "originatorName": "string",
  "improvementDate": "2021-04-13T23:46:19.861Z",
  "improvementDetails": "string",
  "branch": "New Zealand",
  "department": "HR",
  "region": "Canterbury",
  "other": "",
  "coordinator": { "id": "…", "name": "Felicity Kidwell" }
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `description` | String, max **255** | **yes** | Brief Description — what the register lists |
| `typeOfImprovement` | Object `{id,name}` | **yes** | must be one returned by `/improvement/new` |
| `originatorName` | String, max 255 | **yes** | who raised it |
| `improvementDate` | date | **yes** | when it happened, ISO 8601 UTC |
| `improvementDetails` | String, max **4096** | **yes** | the full explanation |
| `branch` | String, max 255 | no | must already exist in Mango; may be blank |
| `department` | String, max 255 | no | must already exist in Mango; may be blank |
| `region` | String, max 255 | no | must already exist in Mango; may be blank |
| `other` | String, max 255 | no | must already exist in Mango; may be blank |
| `coordinator` | Object `{id,name}` | **yes** | must be one returned by `/improvement/new` |

Response:

```json
{
  "id": "GfuUaXy_yPcB-H_Wk4WBMyfYsdlyDw0D8_LgHhRywPI",
  "formTitle": "Improvement",
  "abbreviation": "IMP",
  "number": "0123"
}
```

PMD shows `abbreviation + ' ' + number` (e.g. `IMP 0123`) as the ticket
reference and keeps `id` alongside it.

Errors: **400** Bad Request · **401** Unauthorised · **422** one or more
parameters invalid.

## The web form has fields the API does not

The IMPW page in Mango asks for 26 things. `POST /api/v4/improvement`
accepts 10. These form fields have **no POST equivalent** and cannot be
sent, whatever they are marked on the form:

Source*, Email, Phone, Fax, Send copy to customer, Additional information,
Authorities have been notified, Customer notified?, Procedures have been
reviewed, Process to be changed?, Training reviewed?, Investigation
Details, Attachments, Type*, Plant/Equipment involved, Risks involved,
Related documents, Related files.

Several are starred as required *on the form*; the API's own parameter table
does not list them at all, and the module data table shows them as GET-only.
So PMD folds the ones it actually knows something about (the press, the
orders, the breakdown causes, the numbers behind the trigger) into
`improvementDetails`, which has 4096 characters to hold them, and drops the
rest rather than inventing values. The same three fields the form stars —
Region, Branch, Other — are explicitly optional here ("Can leave it blank"),
but must name something that already exists in the tenant.

## Other Improvement endpoints (not used by PMD)

- `GET /api/v4/improvement` — all improvements
- `POST /api/v4/improvement/search` — filtered/sorted list
- `GET /api/v4/improvement/open`, `GET /api/v4/improvement/closed` and their
  `/search` variants
- `GET /api/v4/improvement/{id}` — one improvement

PMD deliberately reads none of these: Mango is the system of record and PMD
does not keep a second copy of the register.
