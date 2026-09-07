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

## Reading a ticket back — `GET /api/v4/improvement`

Everything the API can tell you about an improvement AFTER it is raised —
the stage it reached, who is investigating it, when it is due — comes from
here. None of it can be posted: the module data table marks Current Stage,
Investigator, To be completed by, Create Date, Close Date, the four root
causes, Corrective/Preventative Action, Improvement Summary and Potential
Severity as **GET only**.

Returns an array. Fields, verbatim from the RETURNS table (page 78–79):

| Field | What it is |
| --- | --- |
| `id` | the improvement's id |
| `number` | its number |
| `briefDescription` | Brief Description |
| `typeOfImprovement` · `source` · `name` | as posted |
| `region` · `branch` · `department` · `other` | where it happened |
| `details` | Details of Improvement and/or Proposed Action |
| **`currentStage`** | **Current Stage** |
| **`investigator`** | **Assign to Investigation** |
| **`dueDate`** | **"To be completed by"** |
| `dateOfOccurrence` · `dateCreated` · `dateClosed` | the three dates |
| `type` · `code` · `causeA`…`causeD` | classification and root causes |
| `additionalInformation` | Additional Information |
| `correctiveAction` · `preventativeAction` | what was done |
| `improvementSummary` · `improvement` · `itemProduct` · `cost` | outcome |
| `potentialSeverity` · `plantEquipment` · `risk` · `coordinator` | |

Dates come back as strings; the search filters beside them are documented as
`yyyy-mm-dd` while the create body takes full ISO 8601, so **both shapes turn
up** and PMD renders either.

> **The document contradicts itself on names.** The RETURNS *table* says
> `briefDescription` and `Investigator`; the JSON sample printed directly
> beside it says `briefDecription` (sic) and `investigator`. `parseImpwRecord`
> matches keys case-insensitively and accepts the sample's misspelling, because
> a missed field would show a blank Stage — which reads as "nobody has touched
> it", the one wrong answer this must never give.

### `GET /api/v4/improvement/{id}` — one improvement, with a caveat

**The document's page for this endpoint is a copy-paste of the Compliance
one.** Its URL line reads `https://api.Mangolive.com/api/v4/compliance/{id}`
and its RETURNS table lists compliance fields (`typeOfDocument`, `status`,
region/branch/department/other) — none of which answer "where has the ticket
got to". Only the EXAMPLE line names the improvement path. So what this
endpoint really returns is **not documented**.

PMD therefore asks it first (one small call beats pulling the whole register)
and then checks what came back: if the response carries improvement fields it
is used; if it is the eight-field stub the document describes, or a 400/404,
PMD falls back to `GET /api/v4/improvement` and matches on the id — or on the
ticket number, for tickets raised before PMD stored ids. Any other status is
a real failure and stops there rather than repeating the problem on a heavier
call.

Errors: **400** invalid id · **401** unauthorised.

## Other Improvement endpoints (not used by PMD)

- `POST /api/v4/improvement/search` — the same rows, filtered and sorted.
  Its filter object has no `id` key (only the example shows `number`), so the
  plain list plus a client-side match is the reliable lookup.
- `GET /api/v4/improvement/open`, `GET /api/v4/improvement/closed` and their
  `/search` variants — subsets of the same rows.

PMD keeps no register of its own: it reads a ticket back only when someone
presses its number, and stores just the stage, investigator and due date on
the decision, with the time they were read.
