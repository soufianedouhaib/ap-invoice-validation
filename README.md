# AP Invoice Validation console

A web console for the Opus **AP Invoice Validation** workflow:

- AP Clerks upload Invoice, Purchase Order and Goods Receipt PDFs.
- The workflow runs the 3-way match.
- Clean invoices auto-approve.
- Invoices with exceptions pause at the **Human Task**, and an AP Approver approves or disputes each exception in this console.

The browser only talks to this app's server. The server holds the Opus service key and is the only thing that calls Opus.

## Repository layout

| Path | What it is |
|---|---|
| `server.js` | Express app: every `/api` route, the Human Task webhook and callback |
| `lib/auth.js` | Users, roles, password hashing, signed-cookie sessions |
| `lib/opus.js` | Opus Jobs API client (upload, initiate, execute, status, results, audit) |
| `lib/store.js` | Redis / KV storage (REST or TCP, matched by suffix) |
| `api/index.js` | Vercel entry point. **Without it every `/api` call returns 404.** |
| `vercel.json` | Rewrites `/api/*` to `api/index.js` |
| `package.json` | Dependencies |
| `public/` | The pages: `login`, `index` (cases), `submit`, `case`, `reviews`, `review`, `users`, `settings`, plus `common.js` and `styles.css` |
| `.env.example` | Every environment variable, documented |
| `.gitignore` | Keeps `node_modules` and `.env` out of git |

## Setup, in order

1. **GitHub.** Create a new repo and upload every file, keeping the folder structure. `.env.example` and `.gitignore` start with a dot; make sure they are included.
2. **Vercel.**
   - Click **Add New Project** and import the repo.
   - Framework preset: **Other**.
   - Leave Build Command and Output Directory **empty**. `public/` is served automatically. Don't also set an Output Directory.
3. **Storage.** Go to Vercel → **Storage** → create an **Upstash Redis (KV)** store and connect it to the project. The variables it injects can have a prefix; that's fine.
4. **Environment variables** (Project → Settings → Environment Variables). These are required:
   - `OPUS_SERVICE_KEY`
   - `OPUS_WORKSPACE_ID`
   - `SESSION_SECRET`: 32+ random characters
   - `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`
   - `WEBHOOK_SECRET`: recommended, a random string
   - `OPUS_WORKFLOW_ID`: only if the API id differs from `a4d8bb6a-4dab-4562-8ad9-f034d1d794da`
5. **Redeploy.** Environment changes and newly connected stores never reach an existing build.
6. **First admin.** Open the site and sign in with the bootstrap email and password. The admin account is created on that first sign-in. Then go to **Users** and add your clerks and approvers. Once users exist, the bootstrap pair does nothing.
7. **Opus: switch the Human Task to off-platform.**
   - Open **Settings** in the console and copy the **Human Task webhook** URL. It looks like `https://<your-app>.vercel.app/api/opus-webhook/human-review/<WEBHOOK_SECRET>`.
   - Paste it into the Human Task node in the Opus builder.
   - Opus may regenerate the node's output id when you do this. The app reads it from each dispatch, so nothing needs changing here.
8. **Opus: raise the Human Task timeout.** It is 10 minutes today. Set `REVIEW_TIMEOUT_MINUTES` to the same value so the countdown matches.
9. **Opus: activate the workflow** (it is currently Inactive).
10. **Vercel Deployment Protection.** If it is on, Opus cannot reach the webhook. Turn it off for production, or exempt `/api/opus-webhook`. Don't use a bypass query string on the webhook URL.
11. **Test.** Submit one invoice pack that should match cleanly and one with exceptions. Confirm the second one appears under **Reviews**.

## Sample cases (built in)

**New submission → Try a sample** loads a ready-made Invoice, PO and Goods Receipt into the three slots and fills in the reference. Press **Run validation** to start it.

| Sample | Vendor (from the workflow's vendor master) | What the 3-way match should do |
|---|---|---|
| **A · Clean match** | Dubai Facilities Mgmt LLC, V00388 · PO-SMP-10021 · AED 16,485.00 | Every check passes, so the invoice is **auto-approved** with no review. |
| **B · Exceptions** | Mall Tech Solutions FZE, V00641 · PO-SMP-20488 · AED 64,995.00 | **4 exceptions** go to an approver (see below). |

Sample B's four exceptions:

1. The invoice total is AED 1,995 above the PO total (the tolerance is AED 100).
2. Line 1, laptops: the unit price is 4,390 against the PO's 4,200 (the tolerance is 2% or AED 50).
3. Line 2, monitors: 10 are billed but only 8 were received.
4. Line 2, monitors: the goods receipt is 2 short of the PO.

The PDFs are in `public/samples/`. Every page has a "SAMPLE DOCUMENT" banner.

## Roles

| Role | Can |
|---|---|
| AP Clerk | Submit invoice packs; see only their own cases |
| AP Approver | See all cases; decide on exceptions in Reviews |
| Admin | Everything above, plus Users and the connection details in Settings |

An approver cannot review an invoice they submitted themselves, unless `ALLOW_SELF_REVIEW=true`.

## How the human review works

1. When the match finds exceptions, Opus **POSTs** the Human Task to `/api/opus-webhook/human-review/<secret>`. The dispatch carries:
   - the Exception Brief and the Analyst Presentation;
   - a single-use callback URL and token.
2. The app stores the dispatch in Redis. It survives cold starts and is visible to every serverless instance; the KYC console kept these in memory and lost them.
3. The app links the dispatch to its case. It uses, in order:
   - any job id in the dispatch;
   - the only in-flight case;
   - the cases whose Opus audit shows them sitting at the Human Task;
   - the clerk's reference appearing in the brief. **Entering the invoice number as the reference makes this reliable.**

   If the link can't be made, the review still appears in Reviews and can still be answered.
4. The approver marks each exception Approve or Dispute. The app writes the free-text instruction the workflow expects, for example `approve 1, dispute 2 and 3`. It can be edited by hand.
5. On submit, the app POSTs the decision to the callback URL. The workflow resumes, applies the decisions and writes the payment object, audit trail and justification summary.

## Running locally

```
npm install
cp .env.example .env   # fill it in
npm start              # http://localhost:3000
```

Without Redis it runs on an in-memory store, which is fine for a quick look but not for Vercel. Opus cannot reach `localhost`, so the review webhook only works on the deployed site.
